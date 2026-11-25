/**
 * nhatoSG Web AI Chat Advisor Worker (V4.10 — Gemini 4 Hydrogen + Personal Tone Vũ / nhatoSG).
 * Legacy /ai-search and search-bar { query } requests are permanently disabled (HTTP 410).
 * Credentials live solely in Worker secrets (env.GEMINI_API_KEY); no inventory or PII is stored here.
 */
export const MODEL_CHAIN = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
];
const MODEL_ATTEMPT_MS = {
  "gemini-3.1-flash-lite": 4100,
  "gemini-3.5-flash-lite": 5500,
};
const CHAT_BUDGET_MS = 7400;
const SITE_CONFIG_TTL_MS = 60000;
const SITE_CONFIG_TIMEOUT_MS = 950;

const DEFAULT_CONFIG_URL = "https://nhatosg.com.vn/web_chat_config.json";
const MAX_QUESTION_CHARS = 500;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const TOKEN_TTL_SEC = 7 * 86400;
const AUTH_LIMIT = 10;
const MEMBER_CHAT_LIMIT = 60;

const rateBuckets = new Map();
let cachedSiteConfig;
function hasBuiltFeature(text, feature) {
  const pattern = new RegExp("\\b" + feature + "\\b", "g");
  for (const match of text.matchAll(pattern)) {
    const before = text.slice(Math.max(0, match.index - 45), match.index);
    if (!/\b(?:khong|chua|du kien|co the|cho phep|du tinh)(?:\s+(?:co|bo tri|lap|dat|xay|lam|tang)){0,3}\s*$/.test(before)) return true;
  }
  return false;
}
const modelCooldownUntil = new Map();
let chainTimeoutUntil = 0;
const modelsUnsupportedThinking = new Set();

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (origin === "https://nhatosg.com.vn" || origin === "https://www.nhatosg.com.vn") {
    return true;
  }
  try {
    const url = new URL(origin);
    return (
      origin === url.origin &&
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

function takeRate(key, limit) {
  const now = Date.now();
  if (rateBuckets.size >= 4096) {
    for (const [k, arr] of rateBuckets) {
      if (!arr.length || now - arr[arr.length - 1] >= RATE_WINDOW_MS) {
        rateBuckets.delete(k);
      }
    }
  }
  let arr = rateBuckets.get(key);
  if (!arr) {
    arr = [];
    rateBuckets.set(key, arr);
  }
  const cutoff = now - RATE_WINDOW_MS;
  while (arr.length && arr[0] < cutoff) arr.shift();
  if (arr.length >= limit) return false;
  arr.push(now);
  return true;
}

function normalizeLoginId(raw) {
  const compact = String(raw || "").trim().replace(/[\s.\-]+/g, "");
  if (!compact) return "";
  if (compact.startsWith("+84") && /^\d+$/.test(compact.slice(3))) return "0" + compact.slice(3);
  if (compact.startsWith("84") && compact.length >= 10 && /^\d+$/.test(compact.slice(2))) return "0" + compact.slice(2);
  if (/^\d+$/.test(compact)) return compact;
  return compact.toUpperCase();
}

function hexToBytes(hex) {
  const clean = String(hex || "").trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function b64UrlEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64UrlDecode(str) {
  const norm = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function timingSafeEqualStr(a, b) {
  const s1 = String(a || "");
  const s2 = String(b || "");
  if (s1.length !== s2.length) return false;
  let diff = 0;
  for (let i = 0; i < s1.length; i++) diff |= s1.charCodeAt(i) ^ s2.charCodeAt(i);
  return diff === 0;
}

async function derivePbkdf2Hex(loginNorm, code, saltHex, iterations) {
  const enc = new TextEncoder();
  const keyMat = await crypto.subtle.importKey(
    "raw",
    enc.encode(`${loginNorm}:${String(code || "").trim()}`),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(saltHex), iterations: iterations || 120000, hash: "SHA-256" },
    keyMat,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

async function getHmacKey(env) {
  const rawSeed = String(env.CHAT_HMAC_SECRET || "").trim();
  if (rawSeed.length < 32) {
    return null;
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawSeed));
  return crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function signSessionToken(slotId, configRev, env) {
  const key = await getHmacKey(env);
  if (!key) return null;
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC;
  const payload = b64UrlEncode(new TextEncoder().encode(JSON.stringify({ sid: slotId, rev: configRev, exp })));
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return { token: `${payload}.${b64UrlEncode(new Uint8Array(sig))}`, exp };
}

async function verifySessionToken(token, cfg, env) {
  if (!token || !token.includes(".")) return null;
  const [payload, sigB64] = token.split(".", 2);
  try {
    const key = await getHmacKey(env);
    if (!key) return null;
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      b64UrlDecode(sigB64),
      new TextEncoder().encode(payload)
    );
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(b64UrlDecode(payload)));
    if (!claims || Number(claims.exp || 0) <= Date.now() / 1000) return null;
    if (!cfg.config_rev || claims.rev !== cfg.config_rev) return null;
    return String(claims.sid || "").trim() || null;
  } catch {
    return null;
  }
}

async function withinTimeout(ms, operation) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new DOMException("Request deadline exceeded", "TimeoutError");
      reject(error);
      controller.abort(error);
    }, ms);
  });
  try {
    return await Promise.race([timeout, operation(controller.signal)]);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLiveConfig(env) {
  const url = String(env.WEB_CHAT_CONFIG_URL || DEFAULT_CONFIG_URL);
  if (cachedSiteConfig?.url === url && Date.now() < cachedSiteConfig.expiresAt) {
    return cachedSiteConfig.value;
  }
  try {
    const value = await withinTimeout(SITE_CONFIG_TIMEOUT_MS, async (signal) => {
      const response = await fetch(url, { signal, headers: { "Accept": "application/json" } });
      if (!response.ok) {
        response.body?.cancel().catch(() => {});
        throw new Error("Config unavailable");
      }
      const config = await response.json();
      if (!["PUBLIC", "MEMBERS_ONLY", "OFF"].includes(config?.mode)) throw new Error("Invalid config");
      return config;
    });
    cachedSiteConfig = { url, value, expiresAt: Date.now() + SITE_CONFIG_TTL_MS };
    return value;
  } catch {
    return { mode: "OFF", config_rev: "" };
  }
}

const LEGAL_REPLY = "Dạ, thông tin chi tiết về sổ hồng, hoàn công và hiện trạng PCCC của từng tòa được Vũ lưu đối chiếu riêng. Anh/Chị nhắn Zalo Vũ (0916.23.9898) để Vũ kiểm tra đúng căn mình quan tâm và gửi bản chụp thực tế nếu hồ sơ có sẵn ạ.";

function isLegalDocumentQuestion(question) {
  return /\b(?:pccc|phong chay|chua chay|hoan cong|so hong|nghiem thu|giay to phap ly|ho so phap ly|ban ve)\b/.test(foldViSimple(question));
}

function enforceExactMatchCount(answer, exact) {
  if (!(exact > 0) || !answer) return answer;
  const claimedCount = /\d+(?:[.,]\d{3})*\s*(?:\*\*)?\s*(?:căn|tài sản|bất động sản|sản phẩm|tòa|building|hồ sơ)(?=$|[\s.,;:!?*])/iu;
  const inventory = /(?:tổng (?:cộng|số)|toàn kho|cả kho|hiện(?: tại)? (?:đang )?có|trên kho (?:đang )?còn)/iu;
  const body = answer.split("\n").map(line =>
    line.split(/(?<=[.!?])(?=\s+\p{Lu})/u)
      .filter(sentence => !claimedCount.test(sentence) && !inventory.test(sentence)).join("").trim()
  ).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return "Dạ, có **" + exact + " tài sản khớp bộ lọc hiện tại**." + (body ? "\n\n" + body : "");
}

function modelThinkingBudget(model) {
  return model === "gemini-3.1-flash-lite" && !modelsUnsupportedThinking.has(model) ? 0 : null;
}

function rejectsThinking(data) {
  return /think(?:ing)?|reasoning/i.test(String(data?.error?.message || ""));
}

function stripNsgCodes(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/(?:\(\s*)?\*{0,3}\s*(?:id|mã\s*(?:căn|tài\s*sản|số|sp)?|căn)\s*[:#-]?\s*\*{0,3}\s*\[?\s*\bNSG[-_\s]?\d{3,5}\b\s*\]?\s*\*{0,3}(?:\s*\))?/gi, "")
    .replace(/(?:\(\s*)?\*{1,3}\s*\[?\s*\bNSG[-_\s]?\d{3,5}\b\s*\]?\s*\*{1,3}(?:\s*\))?/gi, "")
    .replace(/\bNSG[-_\s]?\d{3,5}\b/gi, "")
    .replace(/\(\s*(?:id|mã\s*(?:căn|tài\s*sản|số|sp)?|căn|\*+)?\s*[:#-]?\s*\)|\[\s*(?:id|mã\s*(?:căn|tài\s*sản|số|sp)?|căn|\*+)?\s*[:#-]?\s*\]|\*{4,}/gi, "")
    .replace(/(?:^|[\s,;—–-])(?:id|mã\s*(?:căn|tài\s*sản)|mã\s*số)\s*[:#-]\s*(?=[.,;!?)\]\n—–-]|$)/gi, "")
    .replace(/(\p{Ll})(?=(?:Anh\/Chị|Anh|Chị|Vũ|Em)(?:[\s.,;:!?)]|$))/gu, "$1 ")
    .replace(/(\p{Ll}\.)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/([,;!?])(\p{L})/gu, "$1 $2")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function throttleRedundantZaloCta(answer, question, recIds, partition, candidates) {
  const ans = String(answer || "").trim();
  if (!ans) return ans;
  const qFold = foldViSimple(question);
  const isGreeting =
    qFold.length <= 75 &&
    !/\b(?:tim|mua|ban|can|nha|mat tien|building|toa nha|van phong|khach san|chdv|biet thu|dat|quan|q\d+|thu duc|binh thanh|tan binh|phu nhuan|go vap|ty|trieu|ngang|ham|dien tich|hop dong thue|dong tien|gia|giam|pccc|hoan cong|so hong)\b/.test(qFold) &&
    /^(?:da\s+)?(?:xin\s+)?(?:chao|alo|hello|hi|hey|em oi|ad oi|co ai|cam on|thank|ok)\b/.test(qFold);
  if (isGreeting) return ans;
  const hasCtaIntent = /\b(?:so hong|phap ly|hoan cong|pccc|nghiem thu|giay to|so nha|dia chi|hen xem|di xem|xem nha|xem thuc te|khao sat|thuong luong|tra gia|gia chot|chot gia|lam viec truc tiep|gap chu|chu nha|lien he|zalo|sdt|so dien thoai|goi vu|alo vu)\b/.test(qFold);
  const recSet = new Set(recIds || []);
  const hasMaskedRec = (candidates || []).some((c) => recSet.has(c.id) && (c.masked || c.cashflowMasked));
  const noExactMatches = recIds.length === 0 || (partition && partition.nearIds && partition.nearIds.size > 0);
  if (hasCtaIntent || hasMaskedRec || noExactMatches) return ans;
  const paras = ans.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paras.length >= 2 && /(?:zalo|0916[\s.]?23[\s.]?9898|gọi\s+trực\s+tiếp\s*\**\s*Vũ)/i.test(paras[paras.length - 1])) {
    paras[paras.length - 1] =
      recIds.length > 1
        ? "Trong mấy phương án trên, Anh/Chị ưu tiên khu vực hay hiệu suất khai thác nào hơn để em lọc chi tiết thêm nhé?"
        : "Anh/Chị xem qua thông số căn này thấy quy mô và tầm tài chính đã sát ý mình chưa ạ?";
    return paras.join("\n\n");
  }
  return ans;
}

function foldViSimple(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[-_/,.;:()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRe(str) {
  return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsTokenBoundary(hay, phrase) {
  const h = " " + String(hay || "") + " ";
  const p = String(phrase || "").trim();
  if (!p) return true;
  return h.includes(" " + p + " ");
}

function canonicalCatBucket(rawCat) {
  const f = foldViSimple(rawCat);
  if (!f) return "";
  if (/\b(?:building|van phong|toa nha|cao oc|office)\b/.test(f)) return "building";
  if (/\b(?:chdv|khach san|hotel|can ho dich vu)\b/.test(f)) return "chdv_hotel";
  if (/\b(?:biet thu|dinh thu|villa|compound)\b/.test(f)) return "villa";
  if (/\b(?:dat|cap 4|nha cu|quy dat|du an)\b/.test(f)) return "land";
  if (/\b(?:nha mat tien|mat tien|nha pho|shophouse|showroom)\b/.test(f)) return "townhouse";
  return f;
}

function canonicalDistrictName(raw) {
  const f = foldViSimple(raw);
  if (!f) return "";
  if (/(?:^|\s)(?:tp\s*)?thu\s*duc(?=\s|$)|(?:^|\s)(?:quan|q)\s*[29](?=\s|$)/.test(f)) return "TP. Thủ Đức";
  if (/(?:^|\s)(?:quan|q)\s*10(?=\s|$)/.test(f)) return "Quận 10";
  if (/(?:^|\s)(?:quan|q)\s*11(?=\s|$)/.test(f)) return "Quận 11";
  if (/(?:^|\s)(?:quan|q)\s*12(?=\s|$)/.test(f)) return "Quận 12";
  if (/(?:^|\s)(?:quan|q)\s*1(?=\s|$)/.test(f)) return "Quận 1";
  const qm = f.match(/(?:^|\s)(?:quan|q)\s*([3-8])(?=\s|$)/);
  if (qm) return `Quận ${qm[1]}`;
  if (/(?:^|\s)(?:binh\s*thanh|qbt)(?=\s|$)/.test(f)) return "Bình Thạnh";
  if (/(?:^|\s)(?:phu\s*nhuan|qpn)(?=\s|$)/.test(f)) return "Phú Nhuận";
  if (/(?:^|\s)(?:tan\s*binh|qtb)(?=\s|$)/.test(f)) return "Tân Bình";
  if (/(?:^|\s)(?:tan\s*phu|qtp)(?=\s|$)/.test(f)) return "Tân Phú";
  if (/(?:^|\s)(?:go\s*vap|qgv)(?=\s|$)/.test(f)) return "Gò Vấp";
  if (/(?:^|\s)binh\s*tan(?=\s|$)/.test(f)) return "Bình Tân";
  if (/(?:^|\s)binh\s*chanh(?=\s|$)/.test(f)) return "Bình Chánh";
  if (/(?:^|\s)nha\s*be(?=\s|$)/.test(f)) return "Nhà Bè";
  if (/(?:^|\s)hoc\s*mon(?=\s|$)/.test(f)) return "Hóc Môn";
  if (/(?:^|\s)cu\s*chi(?=\s|$)/.test(f)) return "Củ Chi";
  if (/(?:^|\s)can\s*gio(?=\s|$)/.test(f)) return "Cần Giờ";
  return String(raw || "").trim();
}

const CHAT_DIST_RULES = [
  { keys: ["quan 1", "q1", "q.1", "ben nghe", "ben thanh", "da kao", "phuong nguyen thai binh", "p nguyen thai binh", "tan dinh"], label: "Quận 1", matchTokens: ["quan 1"] },
  { keys: ["quan 2", "q2", "q.2", "quan 9", "q9", "q.9", "thao dien", "an khanh", "an phu", "thu thiem", "thanh my loi", "thu duc", "tp thu duc"], label: "TP. Thủ Đức", matchTokens: ["tp thu duc", "thu duc"] },
  { keys: ["quan 3", "q3", "q.3", "vo thi sau"], label: "Quận 3", matchTokens: ["quan 3"] },
  { keys: ["quan 4", "q4", "q.4"], label: "Quận 4", matchTokens: ["quan 4"] },
  { keys: ["quan 5", "q5", "q.5"], label: "Quận 5", matchTokens: ["quan 5"] },
  { keys: ["quan 6", "q6", "q.6"], label: "Quận 6", matchTokens: ["quan 6"] },
  { keys: ["quan 7", "q7", "q.7", "phu my hung", "tan phong", "tan hung"], label: "Quận 7", matchTokens: ["quan 7"] },
  { keys: ["quan 8", "q8", "q.8"], label: "Quận 8", matchTokens: ["quan 8"] },
  { keys: ["quan 10", "q10", "q.10", "ba thang hai"], label: "Quận 10", matchTokens: ["quan 10"] },
  { keys: ["quan 11", "q11", "q.11"], label: "Quận 11", matchTokens: ["quan 11"] },
  { keys: ["quan 12", "q12", "q.12"], label: "Quận 12", matchTokens: ["quan 12"] },
  { keys: ["binh thanh", "qbt", "tan cang"], label: "Bình Thạnh", matchTokens: ["binh thanh"] },
  { keys: ["phu nhuan", "qpn"], label: "Phú Nhuận", matchTokens: ["phu nhuan"] },
  { keys: ["tan binh", "qtb", "san bay", "bau cat", "k300"], label: "Tân Bình", matchTokens: ["tan binh"] },
  { keys: ["tan phu", "qtp"], label: "Tân Phú", matchTokens: ["tan phu"] },
  { keys: ["go vap", "qgv", "cityland"], label: "Gò Vấp", matchTokens: ["go vap"] },
  { keys: ["binh tan"], label: "Bình Tân", matchTokens: ["binh tan"] },
];

const CHAT_SUB_AREAS = [
  "thao dien", "thu thiem", "an phu", "an khanh", "thanh my loi",
  "phu my hung", "da kao", "ben nghe", "ben thanh", "tan dinh",
  "bau cat", "cityland", "phan xich long"
];

function parseQueryConstraints(rawQuery) {
  const qRaw = String(rawQuery || "").trim().replace(/(\d)\s*[–—~-]\s*(?=\d)/g, "$1 den ")
    .replace(/(\d[\d.,]*)\s*(?:usd\b|\$)/gi, (_, raw) => {
      const n = raw.replace(/[.,](?=\d{3}(?:[.,]|$))/g, "").replace(",", ".");
      return (Number(n) * 0.0254).toFixed(4) + " trieu";
    });
  if (!qRaw) return null;
  let qNoTone = String(qRaw)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[-_,;()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  qNoTone = qNoTone
    .replace(/\bhdt\b/g, "hop dong thue")
    .replace(/\bchdv\b/g, "can ho dich vu")
    .replace(/\bvp\b/g, "van phong")
    .replace(/\bbt\b/g, "biet thu")
    .replace(/\bks\b/g, "khach san")
    .replace(/\bnmt\b/g, "nha mat tien")
    .replace(/\bmt\b/g, "mat tien");

  const c = {
    requiresContract: /\bhop dong thue\b/.test(qNoTone),
    useMode: /\bhoac\b/.test(qNoTone) ? "any" : /\b(?:ket hop|vua .+ vua|da cong nang)\b/.test(qNoTone) ? "both" : "",
    propCode: null,
    districts: [],
    subAreaTokens: [],
    categories: [],
    minPriceBil: null,
    maxPriceBil: null,
    minPriceStrict: false,
    maxPriceStrict: false,
    minCashflowMil: null,
    maxCashflowMil: null,
    minCashflowStrict: false,
    maxCashflowStrict: false,
    minWidthM: null,
    minWidthStrict: false,
    minAreaM2: null,
    minAreaStrict: false,
    mustHaveElevator: false,
    mustHaveBasement: false,
    _categoriesInherited: false,
    _isAskingMore: false,
    _locationReplaced: false,
  };

  const cm = qNoTone.match(/\bnsg[\s-]?(\d{3,4})\b/);
  if (cm) c.propCode = cm[1];

  const qDistTest = qNoTone.replace(/\./g, " ");
  for (const rule of CHAT_DIST_RULES) {
    if (rule.keys.some((k) => {
      const kNorm = k.replace(/\./g, " ").replace(/\s+/g, " ").trim();
      return new RegExp("(^|[^a-z0-9])" + escapeRe(kNorm) + "(?=[^a-z0-9]|$)", "i").test(qDistTest);
    })) {
      if (!c.districts.some((d) => d.label === rule.label)) c.districts.push(rule);
    }
  }
  for (const sa of CHAT_SUB_AREAS) {
    if (containsTokenBoundary(qNoTone, sa)) c.subAreaTokens.push(sa);
  }
  if (!c.districts.length) {
    let region = [];
    if (/\bloi trung tam\b/.test(qNoTone)) region = ["Quận 1", "Quận 3"];
    else if (/\b(?:khu trung tam|quanh (?:khu )?trung tam|noi thanh)\b/.test(qNoTone)) region = ["Quận 1", "Quận 3", "Phú Nhuận", "Bình Thạnh", "Quận 10"];
    else if (/\b(?:gan san bay|khu san bay)\b/.test(qNoTone)) region = ["Tân Bình", "Phú Nhuận"];
    if (region.length) {
      c.districts = region.map((label) => ({ label, matchTokens: [foldViSimple(label)] }));
    }
  }

  if (/\b(?:toa\s+nha|toa\s+van\s+phong|van\s+phong|building|office|cao\s+oc)\b/.test(qNoTone)) c.categories.push("building");
  if (/\b(?:can\s+ho\s+dich\s+vu|khach\s+san|hotel)\b/.test(qNoTone)) c.categories.push("chdv_hotel");
  if (/\b(?:biet\s+thu|villa|dinh\s+thu|compound)\b/.test(qNoTone)) c.categories.push("villa");
  if (/\b(?:quy\s+dat|dat(?=\s+(?:tp\.?\s+)?thu duc)|dat\s+lon|dat\s+trong|lo\s+dat|cap\s*4|nha\s+cu)\b/.test(qNoTone)) c.categories.push("land");
  if (/\b(?:nha\s+pho|nha\s+mat\s+tien|mat\s+tien|shophouse|showroom)\b/.test(qNoTone)) c.categories.push("townhouse");

  const qRange = qRaw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
  const rangeMatch = qRange.match(/(?:tu\s+|khoang\s+|tam\s+|quanh\s+)?(\d+(?:[.,]\d+)?)\s*(?:ty)?\s*(?:den|-|toi|~)\s*(\d+(?:[.,]\d+)?)\s*ty/);
  if (rangeMatch) {
    let a = parseFloat(rangeMatch[1].replace(",", "."));
    let b = parseFloat(rangeMatch[2].replace(",", "."));
    if (a > b) [a, b] = [b, a];
    c.minPriceBil = a;
    c.maxPriceBil = b;
  } else {
    const underM = qRange.match(/(?:(duoi(?:\s+muc)?|nho\s+hon|<)|(toi\s+da|khong\s+qua|<=))\s*(\d+(?:[.,]\d+)?)\s*ty|(\d+(?:[.,]\d+)?)\s*ty\s*(do\s+lai|tro\s+xuong)/);
    if (underM) {
      c.maxPriceBil = parseFloat((underM[3] || underM[4]).replace(",", "."));
      c.maxPriceStrict = Boolean(underM[1]);
    }
    const overM = qRange.match(/(?:(tren|hon|lon\s+hon|vuot|>)|(tu|>=|it\s+nhat|toi\s+thieu))\s*(\d+(?:[.,]\d+)?)\s*ty|(\d+(?:[.,]\d+)?)\s*ty\s*(tro\s+len)/);
    if (overM) {
      c.minPriceBil = parseFloat((overM[3] || overM[4]).replace(",", "."));
      c.minPriceStrict = Boolean(overM[1]);
    }
    const aroundM = qRange.match(/(?:tam|khoang|quanh|gia)\s*(\d+(?:[.,]\d+)?)\s*ty/);
    if (aroundM && c.minPriceBil === null && c.maxPriceBil === null) {
      const target = parseFloat(aroundM[1].replace(",", "."));
      c.minPriceBil = +(target * 0.85).toFixed(1);
      c.maxPriceBil = +(target * 1.15).toFixed(1);
    }
  }

  const wM = qRange.match(/ngang\s*(?:(tren|hon|lon\s+hon|>)|(>=|tu|it\s+nhat|toi\s+thieu))?\s*(\d+(?:[.,]\d+)?)\s*m?/);
  if (wM) {
    c.minWidthM = parseFloat(wM[3].replace(",", "."));
    c.minWidthStrict = Boolean(wM[1]);
  }
  const aM = qRange.match(/(?:dt|dien tich(?:\s+cong\s+nhan)?|cn|cong\s+nhan)\s*(?:(tren|hon|lon\s+hon|>)|(>=|tu|it\s+nhat|toi\s+thieu))?\s*(\d+(?:[.,]\d+)?)\s*m?/);
  if (aM) {
    c.minAreaM2 = parseFloat(aM[3].replace(",", "."));
    c.minAreaStrict = Boolean(aM[1]);
  }

  const cfUnder = qRange.match(/(?:(duoi(?:\s+muc)?|nho\s+hon|<)|(toi\s+da|khong\s+qua|<=))\s*(\d+(?:[.,]\d+)?)\s*(?:trieu|tr)(?=$|[\s,.;:!?/])/);
  if (cfUnder) {
    c.maxCashflowMil = parseFloat(cfUnder[3].replace(",", "."));
    c.maxCashflowStrict = Boolean(cfUnder[1]);
  } else {
    const cfM = qRange.match(/(?:(tren|hon|lon\s+hon|vuot|>)|(tu|>=|it\s+nhat|toi\s+thieu))?\s*(\d+(?:[.,]\d+)?)\s*(?:trieu|tr)(?:\s*(?:\/\s*thang|\/th|moi\s+thang|thang))?(?=$|[\s,.;:!?/])/);
    if (cfM && (/(?:dong\s+tien|thu\s+nhap|hop\s+dong\s+thue|hd\s+thue|hdt|cho\s+thue|thue|khai\s+thac|\/\s*thang|moi\s+thang|trieu)\b/.test(qRange) || cfM[1] || cfM[2])) {
      const val = parseFloat(cfM[3].replace(",", "."));
      if (val > 0) {
        c.minCashflowMil = val;
        c.minCashflowStrict = Boolean(cfM[1]);
      }
    }
  }
  c.mustHaveElevator = /\bthang may\b/.test(qNoTone);
  if (/\b(?:co ham|1 ham|2 ham|3 ham|co tang ham|ham)\b/.test(qNoTone)) c.mustHaveBasement = true;
  return c;
}

function hasNumericBounds(c) {
  if (!c) return false;
  return c.minPriceBil !== null || c.maxPriceBil !== null || c.minCashflowMil !== null || c.maxCashflowMil !== null || c.minWidthM !== null || c.minAreaM2 !== null;
}

function hasAnyConstraint(c) {
  if (!c) return false;
  return Boolean(
    hasNumericBounds(c) ||
    (c.districts && c.districts.length > 0) ||
    (c.subAreaTokens && c.subAreaTokens.length > 0) ||
    (c.categories && c.categories.length > 0) ||
    c.propCode ||
    c.mustHaveElevator || c.mustHaveBasement
  );
}

function isWorkerGreeting(question) {
  const qFold = foldViSimple(question);
  if (!qFold || qFold.length > 75) return false;
  if (/\b(?:tim|mua|ban|can|nha|mat tien|building|toa nha|van phong|khach san|chdv|biet thu|dat|quan|q\d+|thu duc|binh thanh|tan binh|phu nhuan|go vap|ty|trieu|ngang|ham|dien tich|hop dong thue|dong tien|gia|giam|pccc|hoan cong|so hong)\b/.test(qFold)) {
    return false;
  }
  return /^(?:da\s+)?(?:xin\s+)?(?:chao|alo|hello|hi|hey|em oi|ad oi|co ai|cam on|thank|ok)\b/.test(qFold);
}

function isWorkerSingleIntent(question, c) {
  if (c && (c.propCode || c._isLegalFollowUp)) return true;
  const qFold = foldViSimple(question);
  return /\b(?:can nay|can do|tai san nay|tai san do|toa nay|biet thu nay|khach san nay)\b/.test(qFold);
}

function resolveEffectiveConstraints(question, history) {
  const cur = parseQueryConstraints(question);
  if (!cur) return null;
  const qNoTone = foldViSimple(question);
  const isTopicSwitch = /\b(?:chuyen sang|tim them loai|doi sang|con o quan|tim o|qua quan|sang quan)\b/.test(qNoTone);
  const isNarrow = /\b(?:ha xuong|giam xuong|noi len|len tam|xuong tam|thap hon|cao hon|re hon|tam nay|tam do|muc do|khu do|o do|o tren|may can tren|cac can tren|can nay|can nao|nhu vay)\b/.test(qNoTone);
  const isAskingMore = /\b(?:con can nao|can nao khac|can khac|lua chon khac|phuong an khac|them can|ngoai may can|can nao nua|nha .+ nao nua|building .+ nao nua|xem them)\b/.test(qNoTone);
  const isLegalFollowUp = /\b(?:pccc|hoan cong|so hong|phap ly|lo gioi|quy hoach|so sanh|chi tiet|hien trang|noi that|thang may|hop dong thue)\b/.test(qNoTone) &&
    !hasNumericBounds(cur) && !cur.districts.length && !cur.categories.length;
  cur._isLegalFollowUp = isLegalFollowUp;
  cur._isAskingMore = isAskingMore;
  if (!Array.isArray(history) || !history.length || cur.propCode || isTopicSwitch) return cur;

  const userTurns = history.filter((t) => t && t.role === "user" && typeof t.text === "string" && t.text.trim());
  if (!userTurns.length) return cur;

  let inhDist = [], inhSub = [], inhCats = [], inhBase = false, inhElevator = false;
  let inhMinP = null, inhMaxP = null, inhMinPS = false, inhMaxPS = false;
  let inhMinCf = null, inhMinCfS = false, inhContract = false, inhUseMode = "";
  for (let i = userTurns.length - 1; i >= 0 && i >= userTurns.length - 3; i--) {
    const prev = parseQueryConstraints(userTurns[i].text);
    if (!prev) continue;
    if (!inhDist.length && prev.districts.length) {
      inhDist = prev.districts.slice();
      inhSub = prev.subAreaTokens.slice();
    }
    if (!inhCats.length && prev.categories.length) { inhCats = prev.categories.slice(); inhUseMode = prev.useMode; }
    if (prev.mustHaveElevator) inhElevator = true;
    if (prev.mustHaveBasement) inhBase = true;
    if (inhMinP === null && prev.minPriceBil !== null) { inhMinP = prev.minPriceBil; inhMinPS = prev.minPriceStrict; }
    if (inhMaxP === null && prev.maxPriceBil !== null) { inhMaxP = prev.maxPriceBil; inhMaxPS = prev.maxPriceStrict; }
    if (inhMinCf === null && prev.minCashflowMil !== null) { inhMinCf = prev.minCashflowMil; inhMinCfS = prev.minCashflowStrict; inhContract = prev.requiresContract; }
    if (prev.districts.length && (prev.categories.length || hasNumericBounds(prev))) break;
  }

  const hasNewLoc = cur.districts.length > 0 || cur.subAreaTokens.length > 0;
  if (hasNewLoc && inhDist.length > 0) {
    const prevLabels = new Set(inhDist.map((d) => d.label));
    if (!cur.districts.length || !cur.districts.every((d) => prevLabels.has(d.label))) {
      cur._locationReplaced = true;
    }
  }
  const allowSpecInh = !cur._locationReplaced || isNarrow;
  const shouldInherit = isNarrow || isAskingMore || isLegalFollowUp || (!hasNewLoc && hasNumericBounds(cur));
  if (!hasNewLoc && shouldInherit && inhDist.length) {
    cur.districts = inhDist;
    cur.subAreaTokens = inhSub;
  }
  if (allowSpecInh && !cur.categories.length && inhCats.length && shouldInherit) {
    cur.categories = inhCats.slice();
    cur.useMode = inhUseMode;
    cur._categoriesInherited = true;
  }
  if (allowSpecInh && !cur.mustHaveBasement && inhBase && (isNarrow || isAskingMore || isLegalFollowUp || !hasNewLoc)) {
    cur.mustHaveBasement = true;
  }
  if (allowSpecInh && !cur.mustHaveElevator && inhElevator && (isNarrow || isAskingMore || isLegalFollowUp || !hasNewLoc)) {
    cur.mustHaveElevator = true;
  }
  if (allowSpecInh && cur.minPriceBil === null && cur.maxPriceBil === null && (isLegalFollowUp || (!hasNumericBounds(cur) && (isNarrow || isAskingMore)))) {
    cur.minPriceBil = inhMinP; cur.maxPriceBil = inhMaxP;
    cur.minPriceStrict = inhMinPS; cur.maxPriceStrict = inhMaxPS;
  }
  if (allowSpecInh && cur.minCashflowMil === null && (isLegalFollowUp || isNarrow || isAskingMore)) {
    cur.minCashflowMil = inhMinCf; cur.minCashflowStrict = inhMinCfS;
    cur.requiresContract ||= inhContract;
  }
  return cur;
}

function extractNumFromVi(txt, re) {
  const m = String(txt || "").replace(/,/g, ".").match(re);
  return m ? (parseFloat(m[1]) || 0) : 0;
}

function candidateMetrics(cand, rawMap) {
  const raw = rawMap.get(cand.id) || {};
  const isSold = Boolean(cand.isSold);
  const priceMasked = Boolean(cand.masked) || /liên hệ/i.test(String(cand.priceTxt || ""));
  const cfMasked = Boolean(cand.cashflowMasked) || /liên hệ/i.test(String(cand.cfTxt || ""));
  const priceBil = isSold ? 0 : priceMasked ? cand.maskedAnchor
    : (Number(raw.price || 0) || extractNumFromVi(cand.priceTxt, /(\d+(?:\.\d+)?)\s*(?:tỷ|tỉ|ty)/i));
  const monthlyMil = (!isSold && !cfMasked) ? (Number(raw.monthlyMil || 0) || extractNumFromVi(cand.cfTxt, /(\d+(?:\.\d+)?)\s*(?:tr|triệu|trieu)/i)) : 0;
  const widthM = Number(raw.widthM || 0) || extractNumFromVi(cand.dims, /(\d+(?:\.\d+)?)\s*m/i);
  const areaM2 = Number(raw.area || 0) || extractNumFromVi(cand.area, /(\d+(?:\.\d+)?)\s*m/i);
  return { priceBil, monthlyMil, widthM, areaM2, priceMasked, cfMasked, isSold, bucket: canonicalCatBucket(cand.category) };
}

function candidateMatchesDistricts(cand, c) {
  if (!c || !c.districts || !c.districts.length) return true;
  const dCanon = canonicalDistrictName(cand && cand.district);
  return Boolean(dCanon) && c.districts.some((dr) => dr.label === dCanon || canonicalDistrictName(dr.label) === dCanon);
}

function candidateSatisfiesConstraints(cand, m, c, opts = {}) {
  if (!c) return true;
  const tol = Number(opts.nearPct || 0);
  if (c.propCode && !String(cand.id || "").includes(c.propCode)) return false;
  if (!candidateMatchesDistricts(cand, c)) return false;
  if (!opts.ignoreSubArea && c.subAreaTokens.length) {
    const locStructured = foldViSimple(`${cand.ward} ${cand.street}`);
    const locZone = foldViSimple(`${cand.ward} ${cand.street} ${cand.highlight}`);
    const ZONE_SUBS = new Set(["phu my hung", "cityland", "thu thiem"]);
    if (!c.subAreaTokens.some((sa) => containsTokenBoundary(ZONE_SUBS.has(sa) ? locZone : locStructured, sa))) return false;
  }
  if (c.requiresContract && (!cand.hasLeaseContract || (c.minCashflowMil !== null &&
      (c.minCashflowStrict ? m.monthlyMil <= c.minCashflowMil : m.monthlyMil < c.minCashflowMil)))) return false;
  if (c.useMode && c.categories.includes("building") && c.categories.includes("chdv_hotel")) {
    const office = cand.officeUse || candidateGroupWeight(cand, "building") > 0;
    const lodging = cand.lodgingUse || candidateGroupWeight(cand, "chdv_hotel") > 0;
    if (c.useMode === "both" ? !(office && lodging) : !(office || lodging)) return false;
  } else if (!opts.ignoreCategory && c.categories.length) {
    if (!c.categories.some(group => candidateGroupWeight(cand, group))) return false;
  }
  if (c.minPriceBil !== null || c.maxPriceBil !== null) {
    if (m.isSold || !(m.priceBil > 0)) return false;
    if (c.minPriceBil !== null) {
      const bound = tol > 0 ? c.minPriceBil * (1 - tol) : c.minPriceBil;
      if (tol === 0 && c.minPriceStrict ? !(m.priceBil > bound) : !(m.priceBil >= bound)) return false;
    }
    if (c.maxPriceBil !== null) {
      const bound = tol > 0 ? c.maxPriceBil * (1 + tol) : c.maxPriceBil;
      if (tol === 0 && c.maxPriceStrict ? !(m.priceBil < bound) : !(m.priceBil <= bound)) return false;
    }
  }
  if (c.minCashflowMil !== null || c.maxCashflowMil !== null) {
    if (m.isSold || m.cfMasked || !(m.monthlyMil > 0)) return false;
    if (c.minCashflowMil !== null) {
      const bound = tol > 0 ? c.minCashflowMil * (1 - tol) : c.minCashflowMil;
      if (tol === 0 && c.minCashflowStrict ? !(m.monthlyMil > bound) : !(m.monthlyMil >= bound)) return false;
    }
    if (c.maxCashflowMil !== null) {
      const bound = tol > 0 ? c.maxCashflowMil * (1 + tol) : c.maxCashflowMil;
      if (tol === 0 && c.maxCashflowStrict ? !(m.monthlyMil < bound) : !(m.monthlyMil <= bound)) return false;
    }
  }
  if (c.minWidthM !== null) {
    if (!(m.widthM > 0) || (c.minWidthStrict ? !(m.widthM > c.minWidthM) : !(m.widthM >= c.minWidthM))) return false;
  }
  if (c.minAreaM2 !== null) {
    if (!(m.areaM2 > 0) || (c.minAreaStrict ? !(m.areaM2 > c.minAreaM2) : !(m.areaM2 >= c.minAreaM2))) return false;
  }
  if (c.mustHaveBasement && !cand.hasBasement) return false;
  if (c.mustHaveElevator && !cand.hasElevator) return false;
  return true;
}

function partitionCandidatesByConstraints(candidates, rawCandidates, constraints) {
  const rawMap = new Map();
  for (const rc of (Array.isArray(rawCandidates) ? rawCandidates : [])) {
    if (rc && typeof rc === "object") {
      const id = String(rc.id || rc.property_id || "").trim().toUpperCase();
      if (id) rawMap.set(id, rc);
    }
  }
  const districtPool = (constraints && constraints.districts && constraints.districts.length)
    ? candidates.filter((cand) => candidateMatchesDistricts(cand, constraints))
    : candidates;

  if (!constraints || !hasAnyConstraint(constraints)) {
    return { filtered: districtPool, strictIds: new Set(districtPool.map((c) => c.id)), nearIds: new Set(), hasHardNumeric: false, hasHardConstraint: false };
  }
  if (!districtPool.length) {
    return { filtered: [], strictIds: new Set(), nearIds: new Set(), hasHardNumeric: hasNumericBounds(constraints), hasHardConstraint: true };
  }

  const hasAnySubAreaInfo = !constraints.subAreaTokens.length || districtPool.some((cand) => {
    const locFold = foldViSimple(`${cand.ward} ${cand.street} ${cand.highlight}`);
    return constraints.subAreaTokens.some((sa) => locFold.includes(sa));
  });
  const ignoreSubArea = !hasAnySubAreaInfo;
  const metricsMap = new Map(districtPool.map((cand) => [cand.id, candidateMetrics(cand, rawMap)]));

  let strictList = districtPool.filter((cand) => candidateSatisfiesConstraints(cand, metricsMap.get(cand.id), constraints, { ignoreSubArea }));
  if (!strictList.length && constraints._categoriesInherited) {
    strictList = districtPool.filter((cand) => candidateSatisfiesConstraints(cand, metricsMap.get(cand.id), constraints, { ignoreSubArea, ignoreCategory: true }));
  }
  if (strictList.length > 0) {
    const groupRank = cand => constraints.useMode === "both" && cand.officeUse && cand.lodgingUse ? 110 : Math.max(0, ...constraints.categories.map(group => candidateGroupWeight(cand, group)));
    strictList.sort((a, b) => groupRank(b) - groupRank(a));
    return {
      filtered: strictList,
      strictIds: new Set(strictList.map((c) => c.id)),
      nearIds: new Set(),
      hasHardNumeric: hasNumericBounds(constraints),
      hasHardConstraint: true,
    };
  }
  if (hasNumericBounds(constraints)) {
    const nearList = districtPool
      .filter((cand) => candidateSatisfiesConstraints(cand, metricsMap.get(cand.id), constraints, { ignoreSubArea, ignoreCategory: Boolean(constraints._categoriesInherited), nearPct: 0.0499 }))
      .slice(0, 2);
    return {
      filtered: nearList,
      strictIds: new Set(),
      nearIds: new Set(nearList.map((c) => c.id)),
      hasHardNumeric: true,
      hasHardConstraint: true,
    };
  }
  return {
    filtered: [],
    strictIds: new Set(),
    nearIds: new Set(),
    hasHardNumeric: false,
    hasHardConstraint: true,
  };
}

export function strictPostFilterRecommendedIds(recIds, partition, validIds, opts = {}) {
  const question = String(opts.question || "");
  if (question && isWorkerGreeting(question)) return [];
  const constraints = opts.constraints || null;
  const cands = Array.isArray(opts.candidates) ? opts.candidates : (Array.isArray(partition?.filtered) ? partition.filtered : []);
  const candById = new Map(cands.map((c) => [c.id, c]));
  const isSingle = isWorkerSingleIntent(question, constraints);
  const maxCount = isSingle ? 1 : 3;

  const clean = [];
  const seen = new Set();
  for (const rawX of (Array.isArray(recIds) ? recIds : [])) {
    const id = String(rawX || "").trim().toUpperCase();
    if (!id || seen.has(id) || !validIds.has(id)) continue;
    const item = candById.get(id);
    if (item && constraints && !candidateMatchesDistricts(item, constraints)) continue;
    seen.add(id);
    clean.push(id);
  }

  if (partition.strictIds.size > 0) {
    let filtered = clean.filter((id) => partition.strictIds.has(id));
    if (!isSingle && constraints && constraints._isAskingMore) {
      const unseenStrict = partition.filtered.filter((c) => partition.strictIds.has(c.id) && !c.previouslyShown);
      if (unseenStrict.length >= Math.min(3, partition.strictIds.size)) {
        filtered = filtered.filter((id) => !candById.get(id)?.previouslyShown);
      }
    }
    const targetCount = Math.min(maxCount, partition.strictIds.size);
    const shouldTopUp = !isSingle && (filtered.length > 0 || (constraints && hasAnyConstraint(constraints)));
    if (shouldTopUp && filtered.length < targetCount) {
      const fSet = new Set(filtered);
      const orderedPool = [
        ...partition.filtered.filter((c) => partition.strictIds.has(c.id) && !c.previouslyShown),
        ...partition.filtered.filter((c) => partition.strictIds.has(c.id)),
      ];
      for (const c of orderedPool) {
        if (filtered.length >= targetCount) break;
        if (!fSet.has(c.id)) {
          fSet.add(c.id);
          filtered.push(c.id);
        }
      }
    }
    return filtered.slice(0, maxCount);
  }
  if (partition.nearIds.size > 0) {
    return clean.filter((id) => partition.nearIds.has(id)).slice(0, 2);
  }
  if (partition.hasHardNumeric || partition.hasHardConstraint) return [];
  return clean.slice(0, maxCount);
}

function candidateGroupWeight(candidate, group) {
  const root = canonicalCatBucket(candidate.category);
  const groups = candidate.searchGroups;
  if (!Array.isArray(groups)) return root === group ? 100 : 0;
  const item = groups.find(g => g && g.group === group);
  if (!item) return 0;
  if (group === root) return item.weight === 100 ? 100 : 0;
  if (group === "townhouse" && candidate.streetFront && ["building","villa","land","chdv_hotel"].includes(root)) return item.weight === 85 ? 85 : 0;
  if (group === "building" && ["townhouse","chdv_hotel"].includes(root)) return item.weight === 82 ? 82 : 0;
  if (group === "chdv_hotel" && root === "building") return item.weight === 80 ? 80 : 0;
  if (group === "land" && ["villa","townhouse"].includes(root)) return item.weight === 82 ? 82 : 0;
  return 0;
}

function sanitizeCandidates(rawCandidates) {
  if (!Array.isArray(rawCandidates)) return [];
  const clean = [];
  for (const c of rawCandidates.slice(0, 32)) {
    if (!c || typeof c !== "object") continue;
    const id = String(c.id || c.property_id || "").trim().toUpperCase();
    if (!/^NSG-\d{3,5}$/.test(id)) continue;
    const masked = Boolean(c.masked || c.is_price_masked);
    const cfMasked = Boolean(c.cashflowMasked || c.is_cashflow_masked);
    const amount = Number(c.masked_anchor_price_billion);
    const maskedAnchor = masked && !c.isSold && Number.isFinite(amount) && amount > 0 ? amount : 0;
    const publicRef = maskedAnchor ? `Giá tham chiếu ${maskedAnchor.toLocaleString("vi-VN")} Tỷ · Liên Hệ` : "Liên Hệ (thỏa thuận kín)";
    const priceTxt = c.isSold ? "Đã Bán" : masked ? publicRef : String(c.priceDisplay || (c.price > 0 ? `${c.price} Tỷ` : "Liên Hệ"));
    const cfTxt = cfMasked ? "Liên Hệ" : String(c.yieldFull || c.cashflow || "Liên Hệ");
    let highlight = stripNsgCodes(String(c.sec2 || c.highlight || "").slice(0, 220));
    if (masked || c.isSold) {
      highlight = highlight.replace(/\b\d+(?:[.,]\d+)?\s*(?:tỷ|tỉ|triệu|tr|usd|\$)(?:\/tháng|\/năm)?(?=$|[\s,.;:)\]!?/])/gi, "thỏa thuận");
    }
    const dropNote = (!masked && !c.isSold && c.dropInfo) ? stripNsgCodes(String(c.dropInfo).slice(0, 60)) : "";
    clean.push({
      id,
      street: String(c.streetDisplay || c.street || "").slice(0, 80),
      ward: String(c.ward || "").slice(0, 60),
      district: String(c.district || "").slice(0, 50),
      category: String(c.category || "").slice(0, 60),
      maskedAnchor,
      officeUse: c.officeUse === true, lodgingUse: c.lodgingUse === true,
      hasLeaseContract: !masked && !cfMasked && (c.hasLeaseContract === true || /^HĐT\s*:/iu.test(cfTxt)),
      searchGroups: Array.isArray(c.search_groups) ? c.search_groups.slice(0, 5) : undefined,
      streetFront: c.is_true_street_front === true,
      dims: String(c.dimsShort || c.dimensions || "Liên Hệ").slice(0, 60),
      area: Number(c.area || 0) > 0 ? `${c.area}m²` : "Liên Hệ",
      hasBasement: c.hasBasement ?? hasBuiltFeature(foldViSimple([c.structFull, c.structure, c.sec2].join(" ")), "ham"),
      hasElevator: c.hasElevator ?? hasBuiltFeature(foldViSimple([c.structFull, c.structure, c.sec2].join(" ")), "thang may"),
      structure: String(c.structFull || c.structure || "Liên Hệ").slice(0, 100),
      priceTxt: priceTxt.slice(0, 60),
      cfTxt: cfTxt.slice(0, 80),
      highlight,
      dropNote,
      recentSuggested: Boolean(c.recentSuggested),
      previouslyShown: Boolean(c.previouslyShown),
    });
  }
  return clean;
}

export class GeminiDailyBudget {
  constructor(state) {
    this.sql = state.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS budget(day TEXT PRIMARY KEY, attempts INTEGER NOT NULL)");
  }

  fetch(request) {
    if (request.method !== "POST") return new Response(null, {status: 405});
    const limit = Number(new URL(request.url).searchParams.get("limit"));
    if (!Number.isInteger(limit) || limit < 1 || limit > 100000) return new Response(null, {status: 400});
    const day = new Date().toISOString().slice(0, 10);
    this.sql.exec("DELETE FROM budget WHERE day < ?", day);
    const used = this.sql.exec(
      "INSERT INTO budget(day, attempts) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET attempts=attempts+1 WHERE attempts < ? RETURNING attempts",
      day, limit
    ).toArray();
    return new Response(null, {status: used.length ? 204 : 429});
  }
}

function isPlainCategoryQuery(question, history) {
  if (history.length) return false;
  const normalized = foldViSimple(question).trim().replace(/[?.]+$/, "");
  return /^(?:(?:tim|xem|loc|danh sach)\s+)?(?:building|toa nha van phong|biet thu|khach san|can ho dich vu|nha mat tien|nha pho|dat)(?: (?:quan [0-9]{1,2}|q[0-9]{1,2}|binh thanh|phu nhuan|tan binh|thu duc|go vap|tan phu))?$/.test(normalized);
}

async function reserveGeminiAttempt(env, signal) {
  const limit = Number(env.GEMINI_DAILY_MAX_CALLS ?? 200);
  const ns = env.GEMINI_DAILY_BUDGET;
  if (!ns || !Number.isInteger(limit) || limit <= 0 || limit > 100000) return false;
  try {
    const quota = await ns.get(ns.idFromName("nhatosg-gemini-daily")).fetch(
      "https://gemini-budget.internal/reserve?limit=" + limit,
      {method:"POST", signal}
    );
    return quota.status === 204;
  } catch {
    return false;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = isAllowedOrigin(origin)
      ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        }
      : {};
    const headers = {
      ...cors,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      Vary: "Origin",
    };
    const jsonResp = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });

    if (request.method === "OPTIONS") {
      if (!isAllowedOrigin(origin)) return jsonResp({ ok: false, error: "ORIGIN_NOT_ALLOWED" }, 403);
      return new Response(null, { status: 204, headers });
    }
    if (!isAllowedOrigin(origin)) {
      return jsonResp({ ok: false, error: "ORIGIN_NOT_ALLOWED" }, 403);
    }

    if (url.pathname === "/ai-search") {
      return jsonResp({ ok: false, disabled: true, reason: "SEARCH_LOCAL_ONLY" }, 410);
    }

    const chatDeadline = performance.now() + CHAT_BUDGET_MS;
    const cfg = await fetchLiveConfig(env);
    if (request.method === "GET" && url.pathname === "/api/public/web-chat/status") {
      return jsonResp({
        ok: true,
        mode: cfg.mode,
        enabled: cfg.mode !== "OFF",
        config_rev: cfg.config_rev,
        max_question_chars: MAX_QUESTION_CHARS,
      });
    }

    if (request.method !== "POST") {
      return jsonResp({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
    }
    if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
      return jsonResp({ ok: false, error: "INVALID_CONTENT_TYPE" }, 415);
    }

    let body;
    try {
      const lenHdr = Number(request.headers.get("Content-Length") || 0);
      if (lenHdr > 65536) return jsonResp({ ok: false, error: "REQUEST_TOO_LARGE" }, 413);
      const rawTxt = await withinTimeout(Math.max(1, Math.floor(chatDeadline - performance.now())), () => request.text());
      if (rawTxt.length > 65536) return jsonResp({ ok: false, error: "REQUEST_TOO_LARGE" }, 413);
      body = JSON.parse(rawTxt);
    } catch (error) {
      if (error?.name === "TimeoutError") return jsonResp({ ok: false, error: "REQUEST_TIMEOUT" }, 408);
      return jsonResp({ ok: false, error: "INVALID_JSON" }, 400);
    }
    if (!body || typeof body !== "object") return jsonResp({ ok: false, error: "INVALID_BODY" }, 400);

    // Disable legacy search-bar payload { query: "..." } permanently.
    if (typeof body.query === "string" && typeof body.question !== "string" && url.pathname === "/") {
      return jsonResp({ ok: false, disabled: true, reason: "SEARCH_LOCAL_ONLY" }, 410);
    }

    const clientIp = request.headers.get("CF-Connecting-IP") || "anonymous";

    if (url.pathname === "/api/public/web-chat/auth") {
      if (!takeRate(`auth:${clientIp}`, AUTH_LIMIT)) {
        return jsonResp({ ok: false, error: "AUTH_RATE_LIMITED" }, 429);
      }
      if (cfg.mode === "OFF") return jsonResp({ ok: false, error: "CHAT_OFF" }, 403);
      const hmacKey = await getHmacKey(env);
      let serverVerifiers = [];
      try {
        const parsed = env.MEMBER_VERIFIERS_JSON ? JSON.parse(String(env.MEMBER_VERIFIERS_JSON)) : [];
        if (Array.isArray(parsed)) serverVerifiers = parsed;
      } catch {
        serverVerifiers = [];
      }
      if (!hmacKey || !serverVerifiers.length) {
        return jsonResp({ ok: false, error: "AUTH_UNAVAILABLE" }, 503);
      }
      const ident = normalizeLoginId(body.identifier || "");
      const code = String(body.access_code || "").trim();
      if (!ident || !code) return jsonResp({ ok: false, error: "MISSING_CREDENTIALS" }, 400);

      for (const slot of serverVerifiers) {
        if (!slot || !slot.salt || !slot.verifier || !slot.slot_id) continue;
        if (slot.login_norm && !timingSafeEqualStr(ident, String(slot.login_norm))) continue;
        const candHex = await derivePbkdf2Hex(ident, code, slot.salt, slot.iterations || 120000);
        if (timingSafeEqualStr(candHex, slot.verifier)) {
          const signed = await signSessionToken(slot.slot_id, cfg.config_rev, env);
          if (!signed) return jsonResp({ ok: false, error: "AUTH_UNAVAILABLE" }, 503);
          return jsonResp({ ok: true, token: signed.token, config_rev: cfg.config_rev, expires_at: signed.exp });
        }
      }
      return jsonResp({ ok: false, error: "INVALID_CREDENTIALS" }, 401);
    }

    if (url.pathname !== "/" && url.pathname !== "/api/public/web-chat") {
      return jsonResp({ ok: false, error: "NOT_FOUND" }, 404);
    }

    if (cfg.mode === "OFF") {
      return jsonResp({ ok: false, error: "CHAT_OFF" }, 403);
    }

    let rateKey = `pub:${clientIp}`;
    let limit = Number(cfg.rate_limit_public_per_15m || 20);
    if (cfg.mode === "MEMBERS_ONLY") {
      const hmacKey = await getHmacKey(env);
      if (!hmacKey) {
        return jsonResp({ ok: false, error: "AUTH_UNAVAILABLE" }, 503);
      }
      const authHdr = request.headers.get("Authorization") || "";
      const bearer = authHdr.toLowerCase().startsWith("bearer ") ? authHdr.slice(7).trim() : "";
      const verifiedSid = await verifySessionToken(bearer, cfg, env);
      if (!verifiedSid) {
        return jsonResp({ ok: false, error: "MEMBER_AUTH_REQUIRED" }, 401);
      }
      rateKey = `mem:${verifiedSid}:${clientIp}`;
      limit = MEMBER_CHAT_LIMIT;
    }

    if (!takeRate(rateKey, limit)) {
      return jsonResp({ ok: false, error: "RATE_LIMITED" }, 429);
    }

    const question = String(body.question || "").trim();
    if (!question || question.length > MAX_QUESTION_CHARS) {
      return jsonResp({ ok: false, error: "QUESTION_LENGTH_INVALID" }, 400);
    }
    const legalQuestion = isLegalDocumentQuestion(question);

    const candidates = sanitizeCandidates(body.candidates);
    const histArr = Array.isArray(body.history) ? body.history.slice(-12) : [];
    const constraints = resolveEffectiveConstraints(question, histArr);
    const partition = partitionCandidatesByConstraints(candidates, body.candidates, constraints);
    const activeCandidates = partition.filtered.slice(0, 18);
    const validIds = new Set(activeCandidates.map((c) => c.id));
    const hasExactField = body.total_exact_matches !== undefined && body.total_exact_matches !== null && !Number.isNaN(Number(body.total_exact_matches));
    const totalExactMatches = partition.strictIds.size === 0 && partition.nearIds.size > 0
      ? 0
      : Math.max(partition.strictIds.size, hasExactField ? Number(body.total_exact_matches) : partition.strictIds.size);
    const constrained = hasAnyConstraint(constraints);
    if (legalQuestion) {
      return jsonResp({ ok: true, reply: LEGAL_REPLY, recommended_ids: [], total_exact_matches: totalExactMatches,
        model: "local-policy", source: "local_policy", mode: cfg.mode });
    }
    function degradedReply(reason) {
      const ranked = activeCandidates.filter(c => partition.strictIds.has(c.id)).map(c => c.id);
      const ids = strictPostFilterRecommendedIds(ranked, partition, validIds, {
        question, constraints, candidates: activeCandidates,
      });
      let reply = "Em chưa tìm được căn khớp trong danh sách đang xem. Anh/Chị có thể điều chỉnh khu vực hoặc khoảng giá.";
      if (isWorkerGreeting(question)) {
        reply = "Em chào Anh/Chị. Mình muốn tìm nhà ở khu vực nào và khoảng giá bao nhiêu ạ?";
      } else if (ids.length) {
        reply = "Em gửi Anh/Chị các thẻ nhà từ danh sách đang xem để mình đối chiếu thông tin công khai.";
      }
      return jsonResp({ ok: true, degraded: true, reason, reply, recommended_ids: ids,
        total_exact_matches: totalExactMatches, model: "local-rag", source: "local_rag", mode: cfg.mode });
    }
    if (env.CHAT_RAG_ONLY === "1") return degradedReply("RAG_ONLY");
    if (["0", "false", "off"].includes(String(env.AI_LIVE_ENABLED ?? "true").toLowerCase())) {
      return degradedReply("AI_DISABLED");
    }
    if (isPlainCategoryQuery(question, histArr)) return degradedReply("LOCAL_CATEGORY_FILTER");
    if (!env.GEMINI_API_KEY) return degradedReply("AI_UNAVAILABLE");
    if (Date.now() < chainTimeoutUntil) return degradedReply("AI_TIMEOUT");
    const histLines = histArr
      .filter((t) => t && typeof t.text === "string" && t.text.trim())
      .map((t) => `${t.role === "user" ? "Anh/Chị" : "Em (bên Vũ)"}: ${t.text.trim().slice(0, 450)}`);

    const ragLines = activeCandidates.map((c) => {
      const isNear = partition.nearIds.has(c.id);
      const tags = [
        c.streetFront && candidateGroupWeight(c, "townhouse") === 85 ? "MẶT TIỀN ĐƯỜNG" : "",
        isNear ? "GẦN TIÊU CHÍ - LỆCH NHẸ NGÂN SÁCH" : "",
        c.previouslyShown ? "Đã giới thiệu ở lượt trước" : "",
        !c.previouslyShown && c.recentSuggested ? "Vừa gợi ý ở lượt trước" : "",
        c.dropNote,
      ].filter(Boolean).join(" · ");
      const tail = c.highlight ? ` | Điểm nhấn: ${c.highlight}` : "";
      return `- ID:${c.id}${tags ? ` [${tags}]` : ""} | ${c.category} | Đường ${c.street}, ${c.ward ? c.ward + ", " : ""}${c.district} | KT: ${c.dims} | DTCN: ${c.area} | Kết cấu: ${c.structure} | Giá: ${c.priceTxt} | Khai thác: ${c.cfTxt}${tail}`;
    });
    const catalogOverview = constrained ? "" : String(body.catalog_overview || body.warehouse_summary || "").trim().slice(0, 1500);
    const sysInstruction =
      "Đây là website cá nhân của Vũ (nhatoSG) — 33 tuổi, môi giới thực chiến chuyên nhà mặt tiền, building văn phòng, khách sạn và biệt thự tại TP.HCM & TP. Thủ Đức (KHÔNG phải tập đoàn hay sàn giao dịch lớn). Em là trợ lý giúp khách lọc nhanh sản phẩm và nắm thông số thực tế trên web của Vũ.\n\n" +
      "PHONG CÁCH GIAO TIẾP BẮT BUỘC:\n" +
      "- Nói chuyện chân thành, gần gũi, rõ ràng, tự nhiên; luôn xưng \"em\", gọi khách là \"Anh/Chị\" (xen chữ \"mình\" hợp lý), nhắc tới Vũ tự nhiên là \"Vũ\" hoặc \"bên Vũ\".\n" +
      "- CẤM TUYỆT ĐỐI từ ngữ sáo rỗng, bóng bẩy hoặc sai vai vế: KHÔNG dùng \"quý khách\", \"siêu phẩm\", \"đẳng cấp thượng lưu\", \"tài sản tinh tuyển\", \"cố vấn chiến lược\", \"kiệt tác\", \"cơ hội vàng\", \"thực sự thiện chí\", \"trang cá nhân chính chủ\"; KHÔNG xưng \"bạn\", \"tôi\", \"hệ thống\"; KHÔNG tự bịa tâm lý hay lý do bán của chủ nhà; KHÔNG ghép dính chữ thiếu dấu cách (như \"gìAnh/Chị\").\n" +
      "- Đi thẳng vào thông số thực tế (trục đường, bề ngang, diện tích công nhận, kết cấu/hầm/thang máy, dòng tiền công khai, đơn giá/m² ước tính khi đủ số liệu). Chia đoạn bằng \\n\\n, nhấn đậm nhẹ **tên đường / điểm nổi bật** vừa mắt.\n\n" +
      "KỶ LUẬT ĐỊA GIỚI & BỐ CỤC 3 THẺ GỢI Ý (BẮT BUỘC V4.13):\n" +
      "- KHÓA CỨNG ĐỊA GIỚI QUẬN/HUYỆN: Khi Anh/Chị đã nêu Quận/Huyện cụ thể (như Quận 1, Tân Bình, TP. Thủ Đức...), TUYỆT ĐỐI chỉ lọc và chọn tài sản nằm đúng Quận/Huyện đó. CẤM tuyệt đối lấy căn ở Quận khác (dù giáp ranh, trùng tên đường như đường Nguyễn Thái Bình ở Tân Bình, hay mô tả có cụm \"sát Quận 1\").\n" +
      "- BỐ CỤC ĐÚNG 3 THẺ TIÊU BIỂU: Khi có từ 3 căn khớp tiêu chí trở lên trong DANH SÁCH ỨNG VIÊN, hãy chọn ĐÚNG **3** mã ID tiêu biểu nổi bật nhất đưa vào recommended_ids để phân tích rõ từng căn (chỉ trả <= 1 ID khi khách hỏi đích danh 1 căn/pháp lý riêng lẻ; trả [] khi chào hỏi hoặc không có căn khớp). Nếu khách hỏi \"còn căn nào khác / xem thêm\", hãy ƯU TIÊN chọn các căn CHƯA gắn nhãn [Đã giới thiệu ở lượt trước] / [Vừa gợi ý ở lượt trước].\n" +
      "- TRÍCH DẪN SỐ LƯỢNG TỒN KHO: Khi tổng số căn phù hợp trên kho (xem dòng THỐNG KÊ KHỚP TIÊU CHÍ TRÊN KHO) lớn hơn 3, hãy nêu rõ số lượng căn phù hợp hiện có trên kho và nhắc nhẹ bên dưới 3 thẻ nổi bật này có danh sách các căn khác kèm link bấm xem ngay trên kho.\n\n" +
      "QUY TẮC TIẾT CHẾ LỜI MỜI ZALO (BẮT BUỘC):\n" +
      "- Trên hộp thoại chat đã có sẵn thanh Zalo/SĐT của Vũ và từng thẻ nhà đều có nút \"Nhắn Zalo\". Do đó CẤM lặp lại câu mời nhắn Zalo hoặc đọc số 0916.23.9898 ở cuối các lượt chào hỏi, lọc căn thông thường, thu hẹp ngân sách hay so sánh thông số — và TUYỆT ĐỐI KHÔNG tự thêm câu mào 'nếu cần xem sổ hồng / hẹn đi xem thì nhắn Zalo Vũ...' khi trong tin nhắn khách KHÔNG nhắc tới sổ hồng, PCCC, số nhà hay hẹn xem.\n" +
      "- CHỈ được mời Anh/Chị nhắn Zalo hoặc gọi **Vũ (0916.23.9898)** đúng 4 tình huống: (1) Hỏi kiểm tra sổ hồng, hoàn công, biên bản nghiệm thu PCCC hoặc pháp lý gốc; (2) Hỏi số nhà chính xác hoặc hẹn đi xem thực tế; (3) Cần thương lượng giá chốt, làm việc trực tiếp chủ nhà, hoặc hỏi căn để giá \"Liên Hệ\"; (4) Web có 0 căn khớp hoàn toàn nên cần Vũ rà thêm nguồn bên ngoài.\n\n" +
      "CÁCH XỬ LÝ TỪNG TÌNH HUỐNG:\n" +
      "1. Chào hỏi xã giao hoặc mới mở lời (\"Chào em\", \"Alo\"...): Đáp thân thiện ngắn gọn, hỏi khu vực/loại hình/ngân sách và BẮT BUỘC trả recommended_ids: [].\n" +
      "2. Lọc tìm sản phẩm theo tiêu chí địa giới & số học (Quận, giá, dòng tiền, bề ngang, diện tích): TUYỆT ĐỐI tuân thủ đúng Quận và biên số học của câu hỏi. Nếu có căn khớp 100%, chỉ đưa căn khớp đúng Quận và biên số học vào recommended_ids. Chỉ khi DANH SÁCH ỨNG VIÊN trống hoặc chỉ có mục gắn nhãn [GẦN TIÊU CHÍ - LỆCH NHẸ NGÂN SÁCH], phải nói thẳng \"trong đúng tầm vừa nêu hiện chưa có căn khớp 100%\" rồi mới nêu phương án gần nhất đúng Quận (nếu có) và mời nhắn Zalo **Vũ (0916.23.9898)** kiểm tra thêm nguồn ngoài.\n" +
      "3. Hỏi về PCCC, hoàn công, pháp lý: KHÔNG cam kết hay bảo đảm thay giấy tờ gốc. Chỉ nêu đúng thông tin tin đăng đang ghi (ví dụ tin có ghi đạt chuẩn PCCC hay chưa ghi chi tiết), nói rõ quy trình đối chiếu thực tế (sổ hồng hoàn công, bản vẽ/nghiệm thu PCCC) và mời nhắn Zalo **Vũ (0916.23.9898)** nhận hồ sơ kiểm chứng.\n\n" +
      "Nếu nguồn công khai chưa xác nhận có hồ sơ, không hứa có hoặc gửi ngay sổ hồng, bản vẽ hay biên bản PCCC. Hướng khách đến Vũ để kiểm chứng.\n\n" +
      "Khi có bộ lọc, mọi nhận định về số căn khớp phải lấy đúng SO_LUONG_KHOP_BO_LOC_HIEN_TAI. Tổng kho và số thẻ gợi ý không phải số căn khớp.\n" +
      "Chỉ gọi căn là mặt tiền đường khi có nhãn MẶT TIỀN ĐƯỜNG hoặc thuộc nhóm nhà mặt tiền gốc. Giá tham chiếu của căn che giá chỉ dùng để đối chiếu ngân sách.\n" +
      "QUY TẮC TRUNG THỰC & BẢO MẬT BẤT BIẾN:\n" +
      "- Chỉ dùng số liệu có trong BẢN ĐỒ TOÀN KHO, THỐNG KÊ KHỚP TIÊU CHÍ TRÊN KHO và DANH SÁCH ỨNG VIÊN bên dưới.\n" +
      "- TUYỆT ĐỐI KHÔNG viết mã NSG-XXXX vào trường 'answer' (mã tài sản chỉ nằm trong 'recommended_ids').";

    const distLabels = Array.isArray(constraints?.districts)
      ? constraints.districts.map((d) => (d && typeof d === "object" ? (d.label || "") : String(d || ""))).filter(Boolean)
      : [];
    const statsLine = distLabels.length
      ? `THỐNG KÊ KHỚP TIÊU CHÍ TRÊN KHO (${distLabels.join(", ")}): Hiện có ${totalExactMatches} tài sản phù hợp (hiển thị dưới đây tối đa ${activeCandidates.length} ứng viên tiêu biểu đã khóa đúng Quận).\n\n`
      : `THỐNG KÊ KHỚP TIÊU CHÍ TRÊN KHO: Hiện có ${totalExactMatches} tài sản phù hợp (hiển thị dưới đây tối đa ${activeCandidates.length} ứng viên tiêu biểu).\n\n`;
    const userPrompt =
      (catalogOverview ? `BẢN ĐỒ TOÀN KHO NHATOSG:\n${catalogOverview}\n\n` : "") +
      (histLines.length ? `LỊCH SỬ TRÒ CHUYỆN GẦN ĐÂY:\n${histLines.join("\n")}\n\n` : "") +
      (constrained ? "SO_LUONG_KHOP_BO_LOC_HIEN_TAI: " + totalExactMatches + "\n\n" : "") + statsLine +
      `DANH SÁCH ỨNG VIÊN ĐÃ LỌC THEO BIÊN TIÊU CHÍ VÀ ĐỊA GIỚI (Tối đa 18 căn):\n${ragLines.join("\n") || "(Chưa có căn khớp hoàn toàn trên web)"}\n\nTin nhắn mới nhất của Anh/Chị: ${question}`;

    const remainingBudget = () => Math.floor(chatDeadline - performance.now());
    const timingEnabled = env.NSG_AI_TIMING_DIAG === "1";
    const timing = (model, phase, durationMs, status = null) => {
      if (timingEnabled) console.info(JSON.stringify({ event: "ai_model_attempt", model, phase, durationMs, status }));
    };
    const callModel = async (model, thinkingBudget, signal) => {
      const genConfig = {
        temperature: 0.7,
        topP: 0.92,
        maxOutputTokens: 1200,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          required: ["answer", "recommended_ids"],
          properties: {
            answer: {
              type: "STRING",
              description: "Câu trả lời tiếng Việt tự nhiên, chân thành, đúng Quận và biên số học, không lặp Zalo CTA trừ 4 trường hợp được phép, tuyệt đối không chứa NSG-XXXX.",
            },
            recommended_ids: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "0 đến tối đa 3 mã ID tài sản tiêu biểu nhất khớp đúng địa giới Quận và tiêu chí số học từ DANH SÁCH ỨNG VIÊN (trả [] khi chào hỏi hoặc không có căn khớp; tối đa 1 khi hỏi đích danh 1 căn).",
            },
          },
        },
      };
      if (thinkingBudget !== null) {
        genConfig.thinkingConfig = { thinkingBudget };
      }
      return fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: sysInstruction }] },
            contents: [{ role: "user", parts: [{ text: userPrompt }] }],
            generationConfig: genConfig,
          }),
        }
      );
    };

    let anyTimeout = false;
    for (const model of MODEL_CHAIN) {
      if (remainingBudget() <= 0) {
        anyTimeout = true;
        break;
      }
      const skipUntil = modelCooldownUntil.get(model) || 0;
      if (skipUntil > Date.now()) {
        timing(model, "cooldown", 0);
        continue;
      }
      let fullAttemptBudget = false;
      try {
        const run = async (thinkingBudget) => {
          const start = performance.now();
          const cap = Math.min(MODEL_ATTEMPT_MS[model], remainingBudget());
          if (cap <= 0) throw new DOMException("Chat budget exhausted", "TimeoutError");
          fullAttemptBudget = cap === MODEL_ATTEMPT_MS[model];
          let status = null;
          try {
            const response = await withinTimeout(cap, async (signal) => {
              if (!(await reserveGeminiAttempt(env, signal))) return {budgetDenied: true};
              const res = await callModel(model, thinkingBudget, signal);
              status = res.status;
              timing(model, "headers", Math.round(performance.now() - start), status);
              let data;
              if (res.ok || (status === 400 && thinkingBudget !== null)) {
                data = await res.json();
              } else {
                res.body?.cancel().catch(() => {});
              }
              return { status, ok: res.ok, data };
            });
            timing(model, "complete", Math.round(performance.now() - start), status);
            return response;
          } catch (err) {
            const failed = err?.name === "TimeoutError" ? (status === null ? "headers_timeout" : "body_timeout") : "request_error";
            timing(model, failed, Math.round(performance.now() - start), status);
            throw err;
          }
        };
        const thinkingBudget = modelThinkingBudget(model);
        const resp = await run(thinkingBudget);
        if (resp.budgetDenied) return degradedReply("AI_DAILY_BUDGET");
        if (resp.status === 400 && thinkingBudget !== null && rejectsThinking(resp.data)) {
          modelsUnsupportedThinking.add(model);
        }
        if (resp.status === 404) {
          modelCooldownUntil.set(model, Date.now() + 600000);
          continue;
        }
        if ([429, 500, 502, 503, 504].includes(resp.status)) {
          modelCooldownUntil.set(model, Date.now() + 45000);
          continue;
        }
        if (!resp.ok) continue;
        const { data } = resp;
        const raw = data?.candidates?.[0]?.content?.parts
          ?.filter((p) => !p.thought)
          .map((p) => p.text || "")
          .join("")
          .trim();
        if (!raw) {
          timing(model, "empty_response", 0);
          continue;
        }
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          timing(model, "invalid_json", 0);
          throw err;
        }
        if (
          !parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          typeof parsed.answer !== "string" ||
          Object.keys(parsed).some((k) => k !== "answer" && k !== "recommended_ids") ||
          (parsed.recommended_ids !== undefined && !Array.isArray(parsed.recommended_ids))
        ) {
          continue;
        }
        const recIds = strictPostFilterRecommendedIds(parsed.recommended_ids, partition, validIds, {
          question,
          constraints,
          candidates: activeCandidates,
        });
        const rawAnswer = throttleRedundantZaloCta(stripNsgCodes(parsed.answer), question, recIds, partition, activeCandidates);
        const ans = constrained ? enforceExactMatchCount(rawAnswer, totalExactMatches) : rawAnswer;
        if (ans) {
          chainTimeoutUntil = 0;
          timing(model, "selected", 0);
          return jsonResp({
            ok: true,
            reply: ans,
            recommended_ids: recIds,
            total_exact_matches: totalExactMatches,
            model,
            source: "gemini",
            mode: cfg.mode,
          });
        }
      } catch (err) {
        if (err?.name === "TimeoutError") {
          anyTimeout = true;
          if (fullAttemptBudget) modelCooldownUntil.set(model, Date.now() + 20000);
        }
        continue;
      }
    }
    if (anyTimeout) chainTimeoutUntil = Date.now() + 20000;
    return degradedReply(anyTimeout ? "AI_TIMEOUT" : "MODEL_UNAVAILABLE");
  },
};

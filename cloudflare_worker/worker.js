/**
 * nhatoSG Web AI Chat Advisor Worker (V4.10 — Gemini 4 Hydrogen + Personal Tone Vũ / nhatoSG).
 * Legacy /ai-search and search-bar { query } requests are permanently disabled (HTTP 410).
 * Credentials live solely in Worker secrets (env.GEMINI_API_KEY); no inventory or PII is stored here.
 */
export const MODEL_CHAIN = [
  "gemini-4-hydrogen",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
];

const DEFAULT_CONFIG_URL = "https://nhatosg.com.vn/web_chat_config.json";
const MAX_QUESTION_CHARS = 500;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const TOKEN_TTL_SEC = 7 * 86400;
const AUTH_LIMIT = 10;
const MEMBER_CHAT_LIMIT = 60;

const rateBuckets = new Map();
let cachedSiteConfig = null;
let cachedSiteConfigAt = 0;
const unavailable404Until = new Map();

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

async function fetchLiveConfig(env) {
  const now = Date.now();
  if (cachedSiteConfig && now - cachedSiteConfigAt < 30000) {
    return cachedSiteConfig;
  }
  const url = String(env.WEB_CHAT_CONFIG_URL || DEFAULT_CONFIG_URL);
  try {
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === "object" && ["PUBLIC", "MEMBERS_ONLY", "OFF"].includes(data.mode)) {
        cachedSiteConfig = data;
        cachedSiteConfigAt = now;
        return data;
      }
    }
  } catch {
    // Keep prior cache or safe fallback below.
  }
  return cachedSiteConfig || {
    mode: "PUBLIC",
    config_rev: "default",
    rate_limit_public_per_15m: 20,
    max_question_chars: MAX_QUESTION_CHARS,
  };
}

function stripNsgCodes(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/(?:\(\s*)?\*{1,3}\s*(?:mã\s+|căn\s+)?\[?\s*\bNSG[-_\s]?\d{3,5}\b\s*\]?\s*\*{1,3}(?:\s*\))?/gi, "")
    .replace(/\bNSG[-_\s]?\d{3,5}\b/gi, "")
    .replace(/\(\s*(?:mã|căn|\*+)?\s*\)|\[\s*(?:mã|căn|\*+)?\s*\]|\*{4,}/gi, "")
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

const CHAT_DIST_RULES = [
  { keys: ["quan 1", "q1", "q.1", "ben nghe", "ben thanh", "da kao", "nguyen thai binh", "tan dinh"], label: "Quận 1", matchTokens: ["quan 1"] },
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
  const qRaw = String(rawQuery || "").trim();
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
    mustHaveBasement: false,
    _categoriesInherited: false,
  };

  const cm = qNoTone.match(/\bnsg[\s-]?(\d{3,4})\b/);
  if (cm) c.propCode = cm[1];

  for (const rule of CHAT_DIST_RULES) {
    if (rule.keys.some((k) => new RegExp("(^|\\s|,)" + escapeRe(k.replace(/\./g, "")) + "(\\s|,|$)", "i").test(qNoTone.replace(/\./g, "")))) {
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
  if (/\b(?:quy\s+dat|dat\s+lon|dat\s+trong|lo\s+dat|cap\s*4|nha\s+cu)\b/.test(qNoTone)) c.categories.push("land");
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
  if (/\b(?:co ham|1 ham|2 ham|3 ham|co tang ham|ham)\b/.test(qNoTone)) c.mustHaveBasement = true;
  return c;
}

function hasNumericBounds(c) {
  if (!c) return false;
  return c.minPriceBil !== null || c.maxPriceBil !== null || c.minCashflowMil !== null || c.maxCashflowMil !== null || c.minWidthM !== null || c.minAreaM2 !== null;
}

function resolveEffectiveConstraints(question, history) {
  const cur = parseQueryConstraints(question);
  if (!cur) return null;
  const qNoTone = foldViSimple(question);
  const isTopicSwitch = /\b(?:chuyen sang|tim them loai|doi sang|con o quan|tim o)\b/.test(qNoTone);
  const isNarrow = /\b(?:ha xuong|giam xuong|noi len|len tam|xuong tam|thap hon|cao hon|re hon|tam nay|tam do|muc do|khu do|o do|o tren|may can tren|cac can tren|can nay|can nao|nhu vay)\b/.test(qNoTone);
  const isLegalFollowUp = /\b(?:pccc|hoan cong|so hong|phap ly|lo gioi|quy hoach|so sanh|chi tiet|hien trang|noi that|thang may|hop dong thue)\b/.test(qNoTone) &&
    !hasNumericBounds(cur) && !cur.districts.length && !cur.categories.length;
  cur._isLegalFollowUp = isLegalFollowUp;
  if (!Array.isArray(history) || !history.length || cur.propCode || isTopicSwitch) return cur;

  const userTurns = history.filter((t) => t && t.role === "user" && typeof t.text === "string" && t.text.trim());
  if (!userTurns.length) return cur;

  let inhDist = [], inhSub = [], inhCats = [], inhBase = false;
  let inhMinP = null, inhMaxP = null, inhMinPS = false, inhMaxPS = false;
  let inhMinCf = null, inhMinCfS = false;
  for (let i = userTurns.length - 1; i >= 0 && i >= userTurns.length - 3; i--) {
    const prev = parseQueryConstraints(userTurns[i].text);
    if (!prev) continue;
    if (!inhDist.length && prev.districts.length) {
      inhDist = prev.districts.slice();
      inhSub = prev.subAreaTokens.slice();
    }
    if (!inhCats.length && prev.categories.length) inhCats = prev.categories.slice();
    if (prev.mustHaveBasement) inhBase = true;
    if (inhMinP === null && prev.minPriceBil !== null) { inhMinP = prev.minPriceBil; inhMinPS = prev.minPriceStrict; }
    if (inhMaxP === null && prev.maxPriceBil !== null) { inhMaxP = prev.maxPriceBil; inhMaxPS = prev.maxPriceStrict; }
    if (inhMinCf === null && prev.minCashflowMil !== null) { inhMinCf = prev.minCashflowMil; inhMinCfS = prev.minCashflowStrict; }
    if (prev.districts.length && (prev.categories.length || hasNumericBounds(prev))) break;
  }

  const hasNewLoc = cur.districts.length > 0 || cur.subAreaTokens.length > 0;
  const shouldInherit = isNarrow || isLegalFollowUp || (!hasNewLoc && hasNumericBounds(cur));
  if (!hasNewLoc && shouldInherit && inhDist.length) {
    cur.districts = inhDist;
    cur.subAreaTokens = inhSub;
  }
  if (!cur.categories.length && inhCats.length && shouldInherit) {
    cur.categories = inhCats.slice();
    cur._categoriesInherited = true;
  }
  if (!cur.mustHaveBasement && inhBase && (isNarrow || isLegalFollowUp || !hasNewLoc)) cur.mustHaveBasement = true;
  if (cur.minPriceBil === null && cur.maxPriceBil === null && (isLegalFollowUp || (!hasNumericBounds(cur) && isNarrow))) {
    cur.minPriceBil = inhMinP; cur.maxPriceBil = inhMaxP;
    cur.minPriceStrict = inhMinPS; cur.maxPriceStrict = inhMaxPS;
  }
  if (cur.minCashflowMil === null && (isLegalFollowUp || isNarrow)) {
    cur.minCashflowMil = inhMinCf; cur.minCashflowStrict = inhMinCfS;
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
  const priceBil = (!isSold && !priceMasked) ? (Number(raw.price || 0) || extractNumFromVi(cand.priceTxt, /(\d+(?:\.\d+)?)\s*(?:tỷ|tỉ|ty)/i)) : 0;
  const monthlyMil = (!isSold && !cfMasked) ? (Number(raw.monthlyMil || 0) || extractNumFromVi(cand.cfTxt, /(\d+(?:\.\d+)?)\s*(?:tr|triệu|trieu)/i)) : 0;
  const widthM = Number(raw.widthM || 0) || extractNumFromVi(cand.dims, /(\d+(?:\.\d+)?)\s*m/i);
  const areaM2 = Number(raw.area || 0) || extractNumFromVi(cand.area, /(\d+(?:\.\d+)?)\s*m/i);
  return { priceBil, monthlyMil, widthM, areaM2, priceMasked, cfMasked, isSold, bucket: canonicalCatBucket(cand.category) };
}

function candidateSatisfiesConstraints(cand, m, c, opts = {}) {
  if (!c) return true;
  const tol = Number(opts.nearPct || 0);
  if (c.propCode && !String(cand.id || "").includes(c.propCode)) return false;
  if (c.districts.length) {
    const dFold = foldViSimple(cand.district);
    if (!c.districts.some((dr) => dr.matchTokens.some((tok) => dFold.includes(tok)))) return false;
  }
  if (!opts.ignoreSubArea && c.subAreaTokens.length) {
    const locFold = foldViSimple(`${cand.ward} ${cand.street} ${cand.highlight} ${cand.district}`);
    if (!c.subAreaTokens.some((sa) => containsTokenBoundary(locFold, sa))) return false;
  }
  if (!opts.ignoreCategory && c.categories.length) {
    if (!c.categories.includes(m.bucket)) return false;
  }
  if (c.minPriceBil !== null || c.maxPriceBil !== null) {
    if (m.isSold || m.priceMasked || !(m.priceBil > 0)) return false;
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
  if (c.mustHaveBasement) {
    if (!/\bham\b/.test(foldViSimple(`${cand.structure} ${cand.highlight}`))) return false;
  }
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
  if (!constraints || !hasNumericBounds(constraints)) {
    return { filtered: candidates, strictIds: new Set(candidates.map((c) => c.id)), nearIds: new Set(), hasHardNumeric: false };
  }
  const hasAnySubAreaInfo = !constraints.subAreaTokens.length || candidates.some((cand) => {
    const locFold = foldViSimple(`${cand.ward} ${cand.street} ${cand.highlight} ${cand.district}`);
    return constraints.subAreaTokens.some((sa) => locFold.includes(sa));
  });
  const ignoreSubArea = !hasAnySubAreaInfo;
  const metricsMap = new Map(candidates.map((cand) => [cand.id, candidateMetrics(cand, rawMap)]));

  let strictList = candidates.filter((cand) => candidateSatisfiesConstraints(cand, metricsMap.get(cand.id), constraints, { ignoreSubArea }));
  if (!strictList.length && constraints._categoriesInherited) {
    strictList = candidates.filter((cand) => candidateSatisfiesConstraints(cand, metricsMap.get(cand.id), constraints, { ignoreSubArea, ignoreCategory: true }));
  }
  if (strictList.length > 0) {
    return {
      filtered: strictList,
      strictIds: new Set(strictList.map((c) => c.id)),
      nearIds: new Set(),
      hasHardNumeric: hasNumericBounds(constraints),
    };
  }
  if (hasNumericBounds(constraints)) {
    const nearList = candidates
      .filter((cand) => candidateSatisfiesConstraints(cand, metricsMap.get(cand.id), constraints, { ignoreSubArea, ignoreCategory: Boolean(constraints._categoriesInherited), nearPct: 0.0499 }))
      .slice(0, 2);
    return {
      filtered: nearList,
      strictIds: new Set(),
      nearIds: new Set(nearList.map((c) => c.id)),
      hasHardNumeric: true,
    };
  }
  return {
    filtered: candidates,
    strictIds: new Set(candidates.map((c) => c.id)),
    nearIds: new Set(),
    hasHardNumeric: false,
  };
}

export function strictPostFilterRecommendedIds(recIds, partition, validIds) {
  const clean = (Array.isArray(recIds) ? recIds : [])
    .map((x) => String(x || "").trim().toUpperCase())
    .filter((x) => validIds.has(x));
  if (partition.strictIds.size > 0) {
    return clean.filter((id) => partition.strictIds.has(id)).slice(0, 4);
  }
  if (partition.nearIds.size > 0) {
    return clean.filter((id) => partition.nearIds.has(id)).slice(0, 2);
  }
  if (partition.hasHardNumeric) return [];
  return clean.slice(0, 4);
}

function sanitizeCandidates(rawCandidates) {
  if (!Array.isArray(rawCandidates)) return [];
  const clean = [];
  for (const c of rawCandidates.slice(0, 14)) {
    if (!c || typeof c !== "object") continue;
    const id = String(c.id || c.property_id || "").trim().toUpperCase();
    if (!/^NSG-\d{3,5}$/.test(id)) continue;
    const masked = Boolean(c.masked || c.is_price_masked);
    const cfMasked = Boolean(c.cashflowMasked || c.is_cashflow_masked);
    const priceTxt = c.isSold ? "Đã Bán" : masked ? "Liên Hệ (thỏa thuận kín)" : String(c.priceDisplay || (c.price > 0 ? `${c.price} Tỷ` : "Liên Hệ"));
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
      dims: String(c.dimsShort || c.dimensions || "Liên Hệ").slice(0, 60),
      area: Number(c.area || 0) > 0 ? `${c.area}m²` : "Liên Hệ",
      structure: String(c.structFull || c.structure || "Liên Hệ").slice(0, 100),
      priceTxt: priceTxt.slice(0, 60),
      cfTxt: cfTxt.slice(0, 80),
      highlight,
      dropNote,
      recentSuggested: Boolean(c.recentSuggested),
    });
  }
  return clean;
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
      const rawTxt = await request.text();
      if (rawTxt.length > 65536) return jsonResp({ ok: false, error: "REQUEST_TOO_LARGE" }, 413);
      body = JSON.parse(rawTxt);
    } catch {
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
    if (!env.GEMINI_API_KEY) {
      return jsonResp({ ok: false, fallback: true, reason: "AI_UNAVAILABLE" }, 503);
    }

    const candidates = sanitizeCandidates(body.candidates);
    const validIds = new Set(candidates.map((c) => c.id));
    const histArr = Array.isArray(body.history) ? body.history.slice(-12) : [];
    const constraints = resolveEffectiveConstraints(question, histArr);
    const partition = partitionCandidatesByConstraints(candidates, body.candidates, constraints);
    const activeCandidates = partition.filtered;
    const histLines = histArr
      .filter((t) => t && typeof t.text === "string" && t.text.trim())
      .map((t) => `${t.role === "user" ? "Anh/Chị" : "Em (bên Vũ)"}: ${t.text.trim().slice(0, 450)}`);

    const ragLines = activeCandidates.map((c) => {
      const isNear = partition.nearIds.has(c.id);
      const tags = [isNear ? "GẦN TIÊU CHÍ - LỆCH NHẸ NGÂN SÁCH" : "", c.recentSuggested ? "Vừa gợi ý ở lượt trước" : "", c.dropNote].filter(Boolean).join(" · ");
      const tail = c.highlight ? ` | Điểm nhấn: ${c.highlight}` : "";
      return `- ID:${c.id}${tags ? ` [${tags}]` : ""} | ${c.category} | Đường ${c.street}, ${c.ward ? c.ward + ", " : ""}${c.district} | KT: ${c.dims} | DTCN: ${c.area} | Kết cấu: ${c.structure} | Giá: ${c.priceTxt} | Khai thác: ${c.cfTxt}${tail}`;
    });
    const catalogOverview = String(body.catalog_overview || body.warehouse_summary || "").trim().slice(0, 1500);
    const sysInstruction =
      "Đây là website cá nhân của Vũ (nhatoSG) — 33 tuổi, môi giới thực chiến chuyên nhà mặt tiền, building văn phòng, khách sạn và biệt thự tại TP.HCM & TP. Thủ Đức (KHÔNG phải tập đoàn hay sàn giao dịch lớn). Em là trợ lý giúp khách lọc nhanh sản phẩm và nắm thông số thực tế trên web của Vũ.\n\n" +
      "PHONG CÁCH GIAO TIẾP BẮT BUỘC:\n" +
      "- Nói chuyện chân thành, gần gũi, rõ ràng, tự nhiên; luôn xưng \"em\", gọi khách là \"Anh/Chị\" (xen chữ \"mình\" hợp lý), nhắc tới Vũ tự nhiên là \"Vũ\" hoặc \"bên Vũ\".\n" +
      "- CẤM TUYỆT ĐỐI từ ngữ sáo rỗng, bóng bẩy hoặc sai vai vế: KHÔNG dùng \"quý khách\", \"siêu phẩm\", \"đẳng cấp thượng lưu\", \"tài sản tinh tuyển\", \"cố vấn chiến lược\", \"kiệt tác\", \"cơ hội vàng\", \"thực sự thiện chí\", \"trang cá nhân chính chủ\"; KHÔNG xưng \"bạn\", \"tôi\", \"hệ thống\"; KHÔNG tự bịa tâm lý hay lý do bán của chủ nhà; KHÔNG ghép dính chữ thiếu dấu cách (như \"gìAnh/Chị\").\n" +
      "- Đi thẳng vào thông số thực tế (trục đường, bề ngang, diện tích công nhận, kết cấu/hầm/thang máy, dòng tiền công khai, đơn giá/m² ước tính khi đủ số liệu). Chia đoạn bằng \\n\\n, nhấn đậm nhẹ **tên đường / điểm nổi bật** vừa mắt.\n\n" +
      "QUY TẮC TIẾT CHẾ LỜI MỜI ZALO (BẮT BUỘC):\n" +
      "- Trên hộp thoại chat đã có sẵn thanh Zalo/SĐT của Vũ và từng thẻ nhà đều có nút \"Nhắn Zalo\". Do đó CẤM lặp lại câu mời nhắn Zalo hoặc đọc số 0916.23.9898 ở cuối các lượt chào hỏi, lọc căn thông thường, thu hẹp ngân sách hay so sánh thông số — và TUYỆT ĐỐI KHÔNG tự thêm câu mào 'nếu cần xem sổ hồng / hẹn đi xem thì nhắn Zalo Vũ...' khi trong tin nhắn khách KHÔNG nhắc tới sổ hồng, PCCC, số nhà hay hẹn xem.\n" +
      "- CHỈ được mời Anh/Chị nhắn Zalo hoặc gọi **Vũ (0916.23.9898)** đúng 4 tình huống: (1) Hỏi kiểm tra sổ hồng, hoàn công, biên bản nghiệm thu PCCC hoặc pháp lý gốc; (2) Hỏi số nhà chính xác hoặc hẹn đi xem thực tế; (3) Cần thương lượng giá chốt, làm việc trực tiếp chủ nhà, hoặc hỏi căn để giá \"Liên Hệ\"; (4) Web có 0 căn khớp hoàn toàn nên cần Vũ rà thêm nguồn bên ngoài.\n\n" +
      "CÁCH XỬ LÝ TỪNG TÌNH HUỐNG:\n" +
      "1. Chào hỏi xã giao hoặc mới mở lời (\"Chào em\", \"Alo\"...): Đáp thân thiện ngắn gọn, hỏi khu vực/loại hình/ngân sách và BẮT BUỘC trả recommended_ids: [].\n" +
      "2. Lọc tìm sản phẩm theo tiêu chí số học (giá, dòng tiền, bề ngang, diện tích): TUYỆT ĐỐI tuân thủ đúng biên số học của câu hỏi và DANH SÁCH ỨNG VIÊN. Nếu có căn khớp 100%, chỉ đưa căn khớp đúng biên số học vào recommended_ids. Chỉ khi DANH SÁCH ỨNG VIÊN trống hoặc chỉ có mục gắn nhãn [GẦN TIÊU CHÍ - LỆCH NHẸ NGÂN SÁCH], phải nói thẳng \"trong đúng tầm vừa nêu hiện chưa có căn khớp 100%\" rồi mới nêu phương án gần nhất (nếu có) và mời nhắn Zalo **Vũ (0916.23.9898)** kiểm tra thêm nguồn ngoài.\n" +
      "3. Hỏi về PCCC, hoàn công, pháp lý: KHÔNG cam kết hay bảo đảm thay giấy tờ gốc. Chỉ nêu đúng thông tin tin đăng đang ghi (ví dụ tin có ghi đạt chuẩn PCCC hay chưa ghi chi tiết), nói rõ quy trình đối chiếu thực tế (sổ hồng hoàn công, bản vẽ/nghiệm thu PCCC) và mời nhắn Zalo **Vũ (0916.23.9898)** nhận hồ sơ kiểm chứng.\n\n" +
      "QUY TẮC TRUNG THỰC & BẢO MẬT BẤT BIẾN:\n" +
      "- Chỉ dùng số liệu có trong BẢN ĐỒ TOÀN KHO và DANH SÁCH ỨNG VIÊN bên dưới.\n" +
      "- TUYỆT ĐỐI KHÔNG viết mã NSG-XXXX vào trường 'answer' (mã tài sản chỉ nằm trong 'recommended_ids').";

    const userPrompt =
      (catalogOverview ? `BẢN ĐỒ TOÀN KHO NHATOSG:\n${catalogOverview}\n\n` : "") +
      (histLines.length ? `LỊCH SỬ TRÒ CHUYỆN GẦN ĐÂY:\n${histLines.join("\n")}\n\n` : "") +
      `DANH SÁCH ỨNG VIÊN ĐÃ LỌC THEO BIÊN TIÊU CHÍ (Tối đa 14 căn):\n${ragLines.join("\n") || "(Chưa có căn khớp hoàn toàn trên web)"}\n\nTin nhắn mới nhất của Anh/Chị: ${question}`;

    const callModel = async (model, allowThinking) => {
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
              description: "Câu trả lời tiếng Việt tự nhiên, chân thành, đúng biên số học, không lặp Zalo CTA trừ 4 trường hợp được phép, tuyệt đối không chứa NSG-XXXX.",
            },
            recommended_ids: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "0 đến tối đa 4 mã ID tài sản khớp đúng tiêu chí số học từ DANH SÁCH ỨNG VIÊN; trả [] khi chào hỏi hoặc không có căn khớp.",
            },
          },
        },
      };
      if (allowThinking) {
        genConfig.thinkingConfig = { thinkingBudget: 384 };
      }
      return fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          signal: AbortSignal.timeout(12000),
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
      const skipUntil = unavailable404Until.get(model) || 0;
      if (skipUntil > Date.now()) continue;
      const supportsThinking = model.startsWith("gemini-4-") || model.startsWith("gemini-3.") || model.startsWith("gemini-2.5-");
      try {
        let resp = await callModel(model, supportsThinking);
        if (resp.status === 400 && supportsThinking) {
          await resp.body?.cancel();
          resp = await callModel(model, false);
        }
        if (resp.status === 404) {
          await resp.body?.cancel();
          unavailable404Until.set(model, Date.now() + 10 * 60 * 1000);
          continue;
        }
        if ([403, 429, 500, 502, 503, 504].includes(resp.status)) {
          await resp.body?.cancel();
          continue;
        }
        if (!resp.ok) {
          await resp.body?.cancel();
          continue;
        }
        const data = await resp.json();
        const raw = data?.candidates?.[0]?.content?.parts
          ?.filter((p) => !p.thought)
          .map((p) => p.text || "")
          .join("")
          .trim();
        if (!raw) continue;
        const parsed = JSON.parse(raw);
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
        const recIds = strictPostFilterRecommendedIds(parsed.recommended_ids, partition, validIds);
        const ans = throttleRedundantZaloCta(stripNsgCodes(parsed.answer), question, recIds, partition, activeCandidates);
        if (ans) {
          return jsonResp({
            ok: true,
            reply: ans,
            recommended_ids: recIds,
            model,
            source: "gemini",
            mode: cfg.mode,
          });
        }
      } catch (err) {
        if (err && err.name === "TimeoutError") anyTimeout = true;
        continue;
      }
    }
    return jsonResp({ ok: false, fallback: true, reason: anyTimeout ? "AI_TIMEOUT" : "MODEL_UNAVAILABLE" }, 503);
  },
};

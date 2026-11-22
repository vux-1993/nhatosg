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
    .replace(/\bNSG[-_\s]?\d{3,5}\b/gi, "")
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
    const histLines = (Array.isArray(body.history) ? body.history.slice(-12) : [])
      .filter((t) => t && typeof t.text === "string" && t.text.trim())
      .map((t) => `${t.role === "user" ? "Anh/Chị" : "Em (bên Vũ)"}: ${t.text.trim().slice(0, 450)}`);

    const ragLines = candidates.map((c) => {
      const tags = [c.recentSuggested ? "Vừa gợi ý ở lượt trước" : "", c.dropNote].filter(Boolean).join(" · ");
      const tail = c.highlight ? ` | Điểm nhấn: ${c.highlight}` : "";
      return `- ID:${c.id}${tags ? ` (${tags})` : ""} | ${c.category} | Đường ${c.street}, ${c.ward ? c.ward + ", " : ""}${c.district} | KT: ${c.dims} | DTCN: ${c.area} | Kết cấu: ${c.structure} | Giá: ${c.priceTxt} | Khai thác: ${c.cfTxt}${tail}`;
    });
    const catalogOverview = String(body.catalog_overview || body.warehouse_summary || "").trim().slice(0, 1500);
    const sysInstruction =
      "Đây là website cá nhân của Vũ (nhatoSG) — 33 tuổi, làm môi giới thực chiến chuyên nhà mặt tiền, building văn phòng, khách sạn và biệt thự tại TP.HCM & TP. Thủ Đức (KHÔNG phải tập đoàn hay sàn giao dịch lớn). Em là trợ lý hỗ trợ khách tìm nhanh sản phẩm và nắm thông số thực tế trên web của Vũ.\n\n" +
      "PHONG CÁCH GIAO TIẾP BẮT BUỘC:\n" +
      "- Nói chuyện chân thành, gần gũi, đời thường và dễ mến; luôn xưng \"em\", gọi khách là \"Anh/Chị\" (có thể xen chữ \"mình\" tự nhiên), nhắc tới chủ web tự nhiên là \"Vũ\" hoặc \"bên Vũ\".\n" +
      "- CẤM TUYỆT ĐỐI mọi từ ngữ đao to búa lớn, bóng bẩy hay sáo rỗng: KHÔNG dùng \"quý khách\", \"siêu phẩm\", \"đẳng cấp thượng lưu\", \"tài sản tinh tuyển\", \"cố vấn chiến lược\", \"kiệt tác\", \"cơ hội vàng\"; KHÔNG xưng \"bạn\", \"tôi\", \"hệ thống\" và KHÔNG dùng mẫu câu máy móc như \"Mời bạn bấm Xem chi tiết bên dưới...\".\n" +
      "- Đi thẳng vào thông số thực tế (trục đường, bề ngang, diện tích công nhận, kết cấu/hầm/thang máy, dòng tiền cho thuê nếu công khai, đơn giá/m² ước tính khi có đủ số liệu). Chia đoạn thoáng bằng \\n\\n và nhấn đậm nhẹ **tên đường / điểm nổi bật** vừa mắt.\n\n" +
      "CÁCH XỬ LÝ TỪNG TÌNH HUỐNG:\n" +
      "1. Chào hỏi xã giao hoặc mới mở lời (\"Chào em\", \"Alo\", \"Có ai trực không\"...): Đáp thân thiện, ngắn gọn (VD: \"Dạ chào Anh/Chị 👋 Em hỗ trợ tìm nhanh sản phẩm trên web của Vũ đây ạ. Anh/Chị đang tìm nhà mặt tiền, building hay biệt thự khu nào, tầm tài chính khoảng bao nhiêu để em lọc căn phù hợp gửi mình xem trước nhé?\") và BẮT BUỘC trả recommended_ids: [] (không tự ý gắn thẻ nhà khi khách chưa nói nhu cầu).\n" +
      "2. Hỏi tìm sản phẩm hoặc so sánh căn cụ thể: Lọc 1 đến tối đa 4 căn sát nhu cầu nhất vào recommended_ids, tóm tắt gọn vì sao từng căn hợp tiêu chí thay vì chép nguyên bảng dài dòng. Nếu nhu cầu còn rộng (VD mới nêu quận), gợi ý 2–3 căn tiêu biểu rồi hỏi thêm 1 câu ngắn để lọc kỹ hơn. Nếu web chưa có căn khớp 100%, nói thật lòng nhẹ nhàng, đưa phương án gần nhất và nhắn Anh/Chị gửi Zalo / gọi Vũ (0916.23.9898) để Vũ rà thêm nguồn bên ngoài chưa kịp lên web.\n" +
      "3. Khi Anh/Chị quan tâm sâu 1 căn, hỏi giá thương lượng tốt nhất, pháp lý sổ hồng, tình trạng cập nhật mới nhất trong ngày, căn để giá \"Liên Hệ\", hoặc muốn làm việc trực tiếp chủ nhà: Khéo léo nhắn nhẹ Anh/Chị nhắn Zalo hoặc gọi trực tiếp **Vũ (0916.23.9898)** để Vũ cập nhật tình trạng sát nhất trong ngày và hỗ trợ kết nối làm việc trực tiếp chủ nhà nhanh gọn.\n\n" +
      "QUY TẮC TRUNG THỰC & BẢO MẬT BẤT BIẾN:\n" +
      "- Chỉ nói đúng thông số có trong BẢN ĐỒ TOÀN KHO và DANH SÁCH ỨNG VIÊN bên dưới (không bịa căn ngoài dữ liệu, không đoán mò pháp lý hay giá bí mật của căn Liên Hệ).\n" +
      "- TUYỆT ĐỐI KHÔNG viết mã NSG-XXXX vào trường 'answer' (mã tài sản chỉ nằm trong mảng 'recommended_ids').";

    const userPrompt =
      (catalogOverview ? `BẢN ĐỒ TOÀN KHO NHATOSG:\n${catalogOverview}\n\n` : "") +
      (histLines.length ? `LỊCH SỬ TRÒ CHUYỆN GẦN ĐÂY:\n${histLines.join("\n")}\n\n` : "") +
      `DANH SÁCH ỨNG VIÊN LIÊN QUAN NHẤT (Tối đa 14 căn):\n${ragLines.join("\n") || "(Chưa có căn khớp)"}\n\nTin nhắn mới nhất của Anh/Chị: ${question}`;

    const signal = AbortSignal.timeout(22000);
    const callModel = async (model, allowThinking) => {
      const genConfig = {
        temperature: 0.7,
        topP: 0.92,
        maxOutputTokens: 2048,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          required: ["answer", "recommended_ids"],
          properties: {
            answer: {
              type: "STRING",
              description: "Câu trả lời tiếng Việt tự nhiên, chân thành theo giọng hỗ trợ cá nhân trên web của Vũ (nhatoSG), chia đoạn \\n\\n, nhấn đậm nhẹ **...**, tuyệt đối không chứa mã NSG-XXXX và không dùng từ sáo rỗng.",
            },
            recommended_ids: {
              type: "ARRAY",
              items: { type: "STRING" },
              description: "Danh sách 0 đến tối đa 4 mã ID tài sản phù hợp nhất để hiện thẻ; trả mảng rỗng [] khi chào hỏi xã giao hoặc chưa cần hiện thẻ.",
            },
          },
        },
      };
      if (allowThinking) {
        genConfig.thinkingConfig = { thinkingBudget: 1024 };
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

    try {
      for (const model of MODEL_CHAIN) {
        const supportsThinking = model.startsWith("gemini-4-") || model.startsWith("gemini-2.5-");
        let resp = await callModel(model, supportsThinking);
        if (resp.status === 400 && supportsThinking) {
          await resp.body?.cancel();
          resp = await callModel(model, false);
        }
        if ([403, 404, 429, 503].includes(resp.status)) {
          await resp.body?.cancel();
          continue;
        }
        if (!resp.ok) {
          await resp.body?.cancel();
          return jsonResp({ ok: false, fallback: true, reason: "AI_UNAVAILABLE" }, 502);
        }
        const data = await resp.json();
        const raw = data?.candidates?.[0]?.content?.parts
          ?.filter((p) => !p.thought)
          .map((p) => p.text || "")
          .join("")
          .trim();
        if (!raw) continue;
        try {
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
          const ans = stripNsgCodes(parsed.answer);
          const recIds = (Array.isArray(parsed.recommended_ids) ? parsed.recommended_ids : [])
            .map((x) => String(x || "").trim().toUpperCase())
            .filter((x) => validIds.has(x))
            .slice(0, 4);
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
        } catch {
          continue;
        }
      }
      return jsonResp({ ok: false, fallback: true, reason: "MODEL_UNAVAILABLE" }, 503);
    } catch {
      return jsonResp({ ok: false, fallback: true, reason: signal.aborted ? "AI_TIMEOUT" : "AI_UNAVAILABLE" }, 504);
    }
  },
};

/**
 * nhatoSG AI Search Proxy - Cloudflare Worker
 * 
 * Chức năng: Dịch câu hỏi tìm kiếm ngôn ngữ tự nhiên (tiếng Việt có dấu / không dấu)
 * thành cấu trúc JSON Filter cho nhatosg.com.vn
 * 
 * BẢO MẬT:
 * - CORS giới hạn nguồn truy cập (nhatosg.com.vn & local test)
 * - Rate limiting theo IP (20 requests / phút / IP)
 * - Giới hạn độ dài query <= 200 ký tự (Chống spam / Prompt injection)
 * - KHÔNG gửi kho dữ liệu nội bộ lên Google
 * - Timeout 5 giây & Fallback an toàn (không làm treo web)
 */

// Danh mục chuẩn trong kho nhatoSG
const VALID_CATEGORIES = [
  "Tòa Văn Phòng",
  "Tòa CHDV / Khách Sạn",
  "Biệt Thự / Dinh Thự",
  "Quỹ Đất Xây Cao Tầng",
  "Nhà Phố Mặt Tiền"
];

// Danh sách các quận/huyện TP.HCM chuẩn
const VALID_DISTRICTS = [
  "Quận 1", "Quận 3", "Quận 4", "Quận 5", "Quận 6", "Quận 7", "Quận 8", "Quận 10", "Quận 11", "Quận 12",
  "Bình Thạnh", "Phú Nhuận", "Tân Bình", "Tân Phú", "Gò Vấp", "Bình Tân", "TP. Thủ Đức", "Thủ Đức"
];

// In-memory sliding window rate limiter (per Cloudflare Worker isolate)
const ipRateMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 phút
const RATE_LIMIT_MAX_REQUESTS = 20; // 20 requests/phút

function checkRateLimit(clientIp) {
  const now = Date.now();
  const record = ipRateMap.get(clientIp);
  if (!record || now - record.startTime > RATE_LIMIT_WINDOW_MS) {
    ipRateMap.set(clientIp, { count: 1, startTime: now });
    return true;
  }
  if (record.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }
  record.count += 1;
  return true;
}

// Allowed CORS origins
const ALLOWED_ORIGINS = [
  "https://nhatosg.com.vn",
  "https://www.nhatosg.com.vn",
  "http://127.0.0.1",
  "http://localhost"
];

function getCorsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const isAllowed = ALLOWED_ORIGINS.some(o => origin === o || origin.startsWith(o + ":"));
  const allowOrigin = isAllowed ? origin : "https://nhatosg.com.vn";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Requested-With",
    "Access-Control-Max-Age": "86400"
  };
}

export default {
  async fetch(request, env) {
    const corsHeaders = getCorsHeaders(request);

    // Xử lý Preflight OPTIONS
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Chỉ nhận POST
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ success: false, error: "Method not allowed" }), {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Rate Limiting
    const clientIp = request.headers.get("CF-Connecting-IP") || "anonymous";
    if (!checkRateLimit(clientIp)) {
      return new Response(JSON.stringify({
        success: false,
        fallback: true,
        error: "Quá giới hạn tần suất yêu cầu (Rate limit exceeded). Vui lòng thử lại sau giây lát."
      }), {
        status: 429,
        headers: { ...corsHeaders, "Content-Type": "application/json", "Retry-After": "60" }
      });
    }

    // Parse Body
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ success: false, fallback: true, error: "Invalid JSON" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const rawQuery = String(body.query || "").trim();

    // Giới hạn độ dài truy vấn <= 200 ký tự (Chống spam / Prompt injection)
    if (rawQuery.length > 200) {
      return new Response(JSON.stringify({
        success: false,
        fallback: true,
        error: "Câu hỏi vượt quá giới hạn 200 ký tự cho phép."
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    if (!rawQuery) {
      return new Response(JSON.stringify({
        success: true,
        filter: null,
        message: "Empty query"
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Kiểm tra API Key
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({
        success: false,
        fallback: true,
        error: "GEMINI_API_KEY chưa được cấu hình trên Cloudflare Secret."
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Model ưu tiên: gemini-2.5-flash hoặc gemini-2.5-flash-lite
    const MODEL = env.GEMINI_MODEL || "gemini-2.5-flash";
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

    const systemInstruction = `
Bạn là Trợ lý phân tích câu hỏi bất động sản của nhatoSG (TP.HCM).
Nhiệm vụ: Trích xuất các tiêu chí tìm kiếm từ câu hỏi của người dùng và chuyển đổi thành một đối tượng JSON chuẩn xác.
TUYỆT ĐỐI CHỈ TRẢ VỀ DUY NHẤT 1 ĐỐI TƯỢNG JSON (KHÔNG bọc trong markdown \`\`\`json, KHÔNG giải thích thêm).

Cấu trúc JSON đầu ra bắt buộc:
{
  "prop_code": null, // Chuỗi 4 chữ số nếu người dùng hỏi mã căn cụ thể (VD: "0528", "0716"), ngược lại null
  "districts": [], // Mảng tên các quận/huyện được nhắc tới (VD: ["Quận 1", "Quận 3", "Tân Bình"]). Nếu không nhắc tới quận nào thì để []
  "category": null, // Đúng 1 trong 5 loại hình sau hoặc null:
                    // - "Tòa Văn Phòng" (building, văn phòng, tòa nhà vp)
                    // - "Tòa CHDV / Khách Sạn" (khách sạn, hotel, chdv, căn hộ dịch vụ)
                    // - "Biệt Thự / Dinh Thự" (biệt thự, villa, dinh thự)
                    // - "Quỹ Đất Xây Cao Tầng" (quỹ đất, đất lớn, đất dự án)
                    // - "Nhà Phố Mặt Tiền" (nhà mặt tiền, shophouse, phố kinh doanh)
  "min_price_bil": null, // Số thực (tỷ đồng). VD: "trên 50 tỷ" -> 50
  "max_price_bil": null, // Số thực (tỷ đồng). VD: "dưới 150 tỷ" -> 150, "tài chính 50 ty" -> 50
  "min_area_m2": null, // Số thực diện tích m2 tối thiểu. VD: "trên 200m2" -> 200
  "min_width_m": null, // Số thực bề ngang mét tối thiểu. VD: "ngang 6m trở lên" -> 6
  "min_cashflow_mil": null, // Số thực thu nhập/dòng tiền triệu/tháng. Nếu hỏi chung "có dòng tiền", "đang cho thuê" -> 1
  "must_have_basement": false, // true nếu có yêu cầu hầm ("có hầm", "1 hầm", "2 hầm")
  "only_update": false, // true nếu hỏi "giảm giá", "vừa giảm", "giảm sâu", "cập nhật"
  "street": null, // Tên đường nếu có (VD: "Hoàng Việt", "Nguyễn Thị Minh Khai")
  "free_text": null // Từ khóa phụ nếu không thuộc các trường trên
}

QUY TẮC PHÂN TÍCH:
- Hỗ trợ cả tiếng Việt có dấu, không dấu và viết tắt: "q1 hoac q3" -> ["Quận 1", "Quận 3"], "pn" -> ["Phú Nhuận"], "tb" -> ["Tân Bình"].
- Đơn vị giá luôn quy ra TỶ ĐỒNG.
- Không tự bịa thêm tiêu chí nếu người dùng không yêu cầu.
`;

    const requestPayload = {
      contents: [
        {
          role: "user",
          parts: [{ text: `Câu hỏi tìm kiếm của khách: "${rawQuery}"` }]
        }
      ],
      systemInstruction: {
        parts: [{ text: systemInstruction }]
      },
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 500,
        responseMimeType: "application/json"
      }
    };

    // Gọi Gemini API với Timeout 5 giây
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const geminiRes = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!geminiRes.ok) {
        const errText = await geminiRes.text();
        return new Response(JSON.stringify({
          success: false,
          fallback: true,
          error: `Google API Error (${geminiRes.status})`
        }), {
          status: 200, // Trả 200 kèm fallback: true để client tự quay về bộ lọc tĩnh
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const geminiData = await geminiRes.json();
      const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

      // Parse JSON an toàn
      let parsedFilter;
      try {
        parsedFilter = JSON.parse(rawText.trim());
      } catch (parseErr) {
        // Dự phòng làm sạch markdown nếu có
        const cleaned = rawText.replace(/```json/g, "").replace(/```/g, "").trim();
        parsedFilter = JSON.parse(cleaned);
      }

      return new Response(JSON.stringify({
        success: true,
        filter: parsedFilter
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });

    } catch (err) {
      const isTimeout = err.name === "AbortError";
      return new Response(JSON.stringify({
        success: false,
        fallback: true,
        error: isTimeout ? "Request to Google API timed out (5s)" : String(err.message || err)
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }
};


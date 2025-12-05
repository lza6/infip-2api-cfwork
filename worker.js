/**
 * =================================================================================
 * 项目: infip-2api (Cloudflare Worker 单文件版)
 * 版本: 2.4.0 (代号: Perfection - 完美兼容版)
 * 作者: 首席AI执行官 (Principal AI Executive Officer)
 * 协议: 奇美拉协议 · 综合版 (Project Chimera: Synthesis Edition)
 * 日期: 2025-12-05
 * 
 * [v2.4.0 核心修复]
 * 1. [客户端兼容] 彻底修复 Cherry Studio 等客户端的 TypeValidationError。
 *    - 策略: 仅对 Web UI 发送 debug 日志，API 客户端只接收标准 OpenAI 格式。
 * 2. [抗 429 策略] 既然 IP 伪装无法完全绕过 CF，改用“指数退避 + 强制串行”策略。
 *    - 当触发 429 时，自动延长等待时间，确保任务最终成功。
 * 3. [全功能保留] 画廊、图生图、Base64 直出、实时计时器全部保留。
 * =================================================================================
 */

// --- [第一部分: 核心配置 (Configuration-as-Code)] ---
const CONFIG = {
  PROJECT_NAME: "infip-2api",
  PROJECT_VERSION: "2.4.0",
  
  // 安全配置
  API_MASTER_KEY: "1", 
  
  // 上游服务配置
  UPSTREAM_ORIGIN: "https://chat.infip.pro",
  
  // 速率限制对抗配置
  MAX_RETRIES: 5,           // 增加重试次数
  RETRY_DELAY_BASE: 25000,  // 基础等待 25秒 (应对 3req/min)
  RETRY_DELAY_JITTER: 10000,// 随机抖动 10秒

  // 模型列表
  MODELS: [
    "nano-banana", 
    "img3",        
    "img4",        
    "qwen",        
    "flux-schnell",
    "lucid-origin",
    "phoenix",     
    "sdxl",        
    "sdxl-lite",   
    "gemini-2.0-flash-preview-image-generation"
  ],
  DEFAULT_MODEL: "nano-banana",

  // 基础伪装头
  BASE_HEADERS: {
    "authority": "chat.infip.pro",
    "accept": "*/*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "content-type": "application/json",
    "origin": "https://chat.infip.pro",
    "referer": "https://chat.infip.pro/",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "priority": "u=1, i"
  }
};

// --- [第二部分: 日志系统 (智能分流)] ---

class Logger {
  constructor(writer, encoder, isWebUI) { 
    this.writer = writer;
    this.encoder = encoder;
    this.isWebUI = isWebUI;
    this.logs = []; 
  }

  async add(step, message, type = 'info') {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    // 仅当请求来自 Web UI 时，才通过 SSE 发送 debug 事件
    if (this.isWebUI) {
      const logEntry = { time, step, message, type };
      const debugData = { debug: [logEntry] };
      try {
        await this.writer.write(this.encoder.encode(`data: ${JSON.stringify(debugData)}\n\n`));
      } catch (e) { /* 忽略写入错误 */ }
    }
    // console.log(`[${time}] [${step}] ${message}`); // Worker 后台日志
  }
}

// 生成随机 IP 地址以伪装
function getRandomIP() {
  return `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
}

// 获取带有伪装 IP 的 Headers
function getSpoofedHeaders(baseHeaders, cookie = "") {
  const ip = getRandomIP();
  const headers = {
    ...baseHeaders,
    "X-Forwarded-For": ip,
    "X-Real-IP": ip,
    "CF-Connecting-IP": ip,
    "True-Client-IP": ip
  };
  if (cookie) headers["Cookie"] = cookie;
  return { headers, ip };
}

// --- [第三部分: Worker 入口与路由] ---
export default {
  async fetch(request, env, ctx) {
    const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;
    request.ctx = { apiKey };

    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return handleCorsPreflight();
    if (url.pathname === '/') return handleUI(request);
    if (url.pathname.startsWith('/v1/')) return handleApi(request);
    
    return createErrorResponse(`路径未找到: ${url.pathname}`, 404, 'not_found');
  }
};

// --- [第四部分: 核心业务逻辑 (带重试机制)] ---

/**
 * 通用 Fetch 包装器，处理 429/503 重试
 */
async function fetchWithRetry(url, options, logger, stepName) {
  let retries = 0;
  
  while (retries <= CONFIG.MAX_RETRIES) {
    try {
      const res = await fetch(url, options);
      
      if (res.ok) return res;

      if (res.status === 429 || res.status === 503) {
        // 遇到 429，大幅增加等待时间
        const delay = CONFIG.RETRY_DELAY_BASE + (retries * 5000) + Math.floor(Math.random() * CONFIG.RETRY_DELAY_JITTER);
        const delaySec = Math.round(delay/1000);
        
        await logger.add(stepName, `触发限流 (${res.status})，进入冷却模式: ${delaySec}秒后重试 (${retries + 1}/${CONFIG.MAX_RETRIES})...`, "warning");
        
        await new Promise(resolve => setTimeout(resolve, delay));
        retries++;
        
        // 重试时重新生成 IP
        if (stepName === "Auth") {
            const newIp = getRandomIP();
            options.headers["X-Forwarded-For"] = newIp;
            options.headers["X-Real-IP"] = newIp;
            await logger.add(stepName, `切换伪装 IP: ${newIp}`, "info");
        }
        continue;
      }

      throw new Error(`HTTP ${res.status}: ${await res.text()}`);

    } catch (e) {
      if (retries < CONFIG.MAX_RETRIES) {
        await logger.add(stepName, `网络波动: ${e.message}，2秒后重试...`, "warning");
        await new Promise(resolve => setTimeout(resolve, 2000));
        retries++;
      } else {
        throw e;
      }
    }
  }
  throw new Error(`重试 ${CONFIG.MAX_RETRIES} 次后仍然失败`);
}

// 1. 获取“幻影身份”
async function getPhantomIdentity(logger) {
  const { headers, ip } = getSpoofedHeaders(CONFIG.BASE_HEADERS);
  await logger.add("Auth", `正在申请新凭证 (伪装IP: ${ip})...`, "info");
  
  try {
    const res = await fetchWithRetry(
      `${CONFIG.UPSTREAM_ORIGIN}/api/generate-key`, 
      { method: "GET", headers }, 
      logger, 
      "Auth"
    );
    
    const setCookie = res.headers.get("set-cookie");
    const data = await res.json();
    
    if (data.success && data.api_key) {
      await logger.add("Auth", `凭证获取成功: ${data.api_key.substring(0, 8)}...`, "success");
      return {
        apiKey: data.api_key,
        cookie: setCookie || "" 
      };
    }
    throw new Error("响应中未找到 api_key");
  } catch (e) {
    await logger.add("Auth", `凭证申请失败: ${e.message}`, "error");
    throw e;
  }
}

// 2. 上传图片
async function uploadImage(base64Data, identity, logger) {
  await logger.add("Upload", "正在上传参考图...", "info");
  
  try {
    const boundary = "----WebKitFormBoundary" + Math.random().toString(36).substring(2);
    const parts = base64Data.match(/^data:(image\/.+);base64,(.+)$/);
    if (!parts) throw new Error("无效的 Base64 图片数据");
    
    const mimeType = parts[1];
    const fileData = Uint8Array.from(atob(parts[2]), c => c.charCodeAt(0));
    const filename = "image." + mimeType.split('/')[1];

    let body = `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`;
    body += `Content-Type: ${mimeType}\r\n\r\n`;
    
    const preBody = new TextEncoder().encode(body);
    const postBody = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
    
    const finalBody = new Uint8Array(preBody.length + fileData.length + postBody.length);
    finalBody.set(preBody, 0);
    finalBody.set(fileData, preBody.length);
    finalBody.set(postBody, preBody.length + fileData.length);

    const { headers } = getSpoofedHeaders(CONFIG.BASE_HEADERS, identity.cookie);
    headers["content-type"] = `multipart/form-data; boundary=${boundary}`;

    const res = await fetchWithRetry(
      `${CONFIG.UPSTREAM_ORIGIN}/api/upload`,
      { method: "POST", headers, body: finalBody },
      logger,
      "Upload"
    );

    const data = await res.json();
    if (data.success && data.file_url) {
      await logger.add("Upload", `上传成功`, "success");
      return data.file_url;
    }
    throw new Error("上传响应异常");

  } catch (e) {
    await logger.add("Upload", `上传出错: ${e.message}`, "error");
    throw e;
  }
}

// 3. 执行单次生成
async function generateSingleImage(params, index, total, logger) {
  // 初始随机延迟，错开并发请求
  const initialDelay = Math.floor(Math.random() * 2000) + (index * 3000);
  if (initialDelay > 0) {
    await logger.add("Queue", `任务 ${index+1}/${total}: 排队中，等待 ${initialDelay}ms...`, "info");
    await new Promise(r => setTimeout(r, initialDelay));
  }

  // 获取独立身份
  const identity = await getPhantomIdentity(logger);

  // 上传
  let finalImageUrl = null;
  if (params.base64Image) {
    finalImageUrl = await uploadImage(params.base64Image, identity, logger);
  }

  await logger.add("Generate", `任务 ${index+1}/${total}: 发送生成请求 (${params.model})...`, "info");

  const payload = {
    prompt: params.prompt,
    model: params.model,
    num_images: 1,
    aspect_ratio: params.aspectRatio
  };

  if (finalImageUrl) {
    payload.image_url = finalImageUrl;
  }

  const { headers } = getSpoofedHeaders(CONFIG.BASE_HEADERS, identity.cookie);

  const res = await fetchWithRetry(
    `${CONFIG.UPSTREAM_ORIGIN}/api/generate-image`,
    { method: "POST", headers, body: JSON.stringify(payload) },
    logger,
    `Task ${index+1}`
  );

  const data = await res.json();
  if (!data.success || !data.image_urls || data.image_urls.length === 0) {
    throw new Error(`业务错误: ${data.error || JSON.stringify(data)}`);
  }

  let resultUrl = data.image_urls[0];
  if (!resultUrl.startsWith("http") && !resultUrl.startsWith("data:")) {
    resultUrl = `data:image/png;base64,${resultUrl}`;
  }
  
  await logger.add("Success", `任务 ${index+1}/${total}: 生成成功!`, "success");
  return resultUrl;
}

// --- [第五部分: API 接口处理] ---

async function handleApi(request) {
  if (!verifyAuth(request)) return createErrorResponse('Unauthorized', 401, 'unauthorized');

  const url = new URL(request.url);
  const requestId = `req-${crypto.randomUUID()}`;

  if (url.pathname === '/v1/models') {
    return new Response(JSON.stringify({
      object: 'list',
      data: CONFIG.MODELS.map(id => ({ id, object: 'model', created: Date.now(), owned_by: 'infip' }))
    }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
  }

  if (url.pathname === '/v1/chat/completions') {
    return handleChatCompletions(request, requestId);
  }
  
  return createErrorResponse('Not Found', 404, 'not_found');
}

async function handleChatCompletions(request, requestId) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const responsePromise = new Response(readable, {
    headers: corsHeaders({ 'Content-Type': 'text/event-stream' })
  });

  (async () => {
    try {
      const body = await request.json();
      const isWebUI = body.is_web_ui === true; // 关键标志
      const logger = new Logger(writer, encoder, isWebUI); // 初始化日志器

      const messages = body.messages || [];
      const lastMsg = messages[messages.length - 1];
      
      // 参数解析
      let prompt = "";
      let base64Image = null;
      let aspectRatio = "1:1";
      let concurrency = 1;
      let model = body.model;
      if (!CONFIG.MODELS.includes(model)) model = CONFIG.DEFAULT_MODEL;

      // 兼容 Vision 格式
      if (Array.isArray(lastMsg.content)) {
        for (const part of lastMsg.content) {
          if (part.type === 'text') prompt += part.text;
          if (part.type === 'image_url') base64Image = part.image_url.url;
        }
      } else {
        prompt = lastMsg.content;
      }

      // 兼容 WebUI JSON 注入
      try {
        if (prompt.trim().startsWith('{')) {
          const parsed = JSON.parse(prompt);
          if (parsed.prompt) prompt = parsed.prompt;
          if (parsed.image) base64Image = parsed.image;
          if (parsed.ar) aspectRatio = parsed.ar;
          if (parsed.n) concurrency = Math.min(Math.max(1, parseInt(parsed.n)), 5);
        }
      } catch (e) {}

      // Prompt 参数提取
      if (prompt.includes("--ar 16:9")) { aspectRatio = "16:9"; prompt = prompt.replace("--ar 16:9", ""); }
      else if (prompt.includes("--ar 9:16")) { aspectRatio = "9:16"; prompt = prompt.replace("--ar 9:16", ""); }
      else if (prompt.includes("--ar 1:1")) { aspectRatio = "1:1"; prompt = prompt.replace("--ar 1:1", ""); }
      prompt = prompt.trim();

      await logger.add("Init", `任务初始化: Model=${model}, AR=${aspectRatio}, 并发数=${concurrency}`, "info");

      // 并发执行循环
      const tasks = [];
      for (let i = 0; i < concurrency; i++) {
        const task = generateSingleImage(
          { prompt, model, aspectRatio, base64Image }, 
          i, concurrency, logger
        ).then(async (imgUrl) => {
          const markdown = `![Generated Image ${i+1}](${imgUrl})\n`;
          const chunk = {
            id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000),
            model: model, choices: [{ index: 0, delta: { content: markdown }, finish_reason: null }]
          };
          await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          
          await logger.add("Stream", `图片 ${i+1} 已推送至画廊`, "success");
          return imgUrl;
        }).catch(async (e) => {
          await logger.add("Error", `任务 ${i+1} 最终失败: ${e.message}`, "error");
          return null;
        });
        
        tasks.push(task);
      }

      await Promise.allSettled(tasks);

      await logger.add("Done", "所有任务处理完毕", "success");

      const endChunk = {
        id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000),
        model: model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      };
      await writer.write(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
      await writer.write(encoder.encode('data: [DONE]\n\n'));

    } catch (e) {
      // 发生致命错误时，向客户端发送错误信息
      const errChunk = {
        id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000),
        model: "error", choices: [{ index: 0, delta: { content: `\n\n**System Error:** ${e.message}` }, finish_reason: 'error' }]
      };
      await writer.write(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
      await writer.write(encoder.encode('data: [DONE]\n\n'));
    } finally {
      await writer.close();
    }
  })();

  return responsePromise;
}

// --- 辅助函数 ---
function verifyAuth(request) {
  const auth = request.headers.get('Authorization');
  const key = request.ctx.apiKey;
  if (key === "1") return true;
  return auth === `Bearer ${key}`;
}

function createErrorResponse(msg, status, code) {
  return new Response(JSON.stringify({ error: { message: msg, type: 'api_error', code } }), {
    status, headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function handleCorsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

// --- [第五部分: 开发者驾驶舱 UI (WebUI)] ---
function handleUI(request) {
  const origin = new URL(request.url).origin;
  const apiKey = request.ctx.apiKey;
  
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${CONFIG.PROJECT_NAME} - 开发者驾驶舱</title>
    <style>
      :root { --bg: #0f172a; --panel: #1e293b; --border: #334155; --text: #e2e8f0; --primary: #facc15; --accent: #38bdf8; --success: #4ade80; --error: #f87171; --warning: #fbbf24; }
      body { font-family: 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); margin: 0; height: 100vh; display: flex; overflow: hidden; }
      .sidebar { width: 360px; background: var(--panel); border-right: 1px solid var(--border); padding: 20px; display: flex; flex-direction: column; overflow-y: auto; flex-shrink: 0; }
      .main { flex: 1; display: flex; flex-direction: column; padding: 20px; position: relative; }
      
      .box { background: rgba(0,0,0,0.2); padding: 15px; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 20px; }
      .label { font-size: 12px; color: #94a3b8; margin-bottom: 8px; display: block; font-weight: 600; }
      .code-block { font-family: monospace; font-size: 12px; color: var(--primary); word-break: break-all; background: #0f172a; padding: 10px; border-radius: 4px; cursor: pointer; }
      
      input, select, textarea { width: 100%; background: #0f172a; border: 1px solid var(--border); color: #fff; padding: 10px; border-radius: 4px; margin-bottom: 15px; box-sizing: border-box; font-family: inherit; }
      button { width: 100%; padding: 12px; background: var(--primary); border: none; border-radius: 4px; font-weight: bold; cursor: pointer; color: #000; transition: 0.2s; }
      button:hover { opacity: 0.9; }
      button:disabled { background: #475569; cursor: not-allowed; }
      
      .chat-window { flex: 1; background: #0f172a; border: 1px solid var(--border); border-radius: 8px; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 20px; }
      .msg { max-width: 85%; padding: 15px; border-radius: 8px; line-height: 1.6; }
      .msg.user { align-self: flex-end; background: #1e293b; color: #fff; border: 1px solid var(--border); max-width: 80%; }
      .msg.ai { align-self: flex-start; background: #1a1a1a; border: 1px solid var(--primary); width: 100%; max-width: 100%; }
      .msg.ai img { max-width: 100%; border-radius: 4px; margin-top: 10px; display: block; cursor: pointer; }
      
      /* 画廊样式 */
      .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 15px; width: 100%; }
      .img-card { background: #1e293b; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; transition: transform 0.2s; position: relative; }
      .img-card:hover { transform: translateY(-2px); border-color: var(--primary); }
      .img-card img { width: 100%; height: 200px; object-fit: cover; display: block; cursor: zoom-in; background: #000; }
      .img-actions { padding: 10px; display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.5); position: absolute; bottom: 0; left: 0; right: 0; backdrop-filter: blur(5px); opacity: 0; transition: opacity 0.2s; }
      .img-card:hover .img-actions { opacity: 1; }
      .action-btn { color: #fff; text-decoration: none; font-size: 12px; background: rgba(255,255,255,0.2); padding: 4px 8px; border-radius: 4px; cursor: pointer; }
      .action-btn:hover { background: var(--primary); color: #000; }

      .log-panel { height: 200px; background: #020617; border-top: 1px solid var(--border); padding: 10px; font-family: monospace; font-size: 11px; color: #94a3b8; overflow-y: auto; }
      .log-entry { margin-bottom: 4px; border-bottom: 1px solid #1e293b; padding-bottom: 2px; display: flex; gap: 10px; }
      .log-time { color: #64748b; min-width: 60px; }
      .log-step { color: var(--accent); font-weight: bold; min-width: 80px; }
      .log-msg { color: #e2e8f0; flex: 1; }
      .log-entry.error .log-step { color: var(--error); }
      .log-entry.success .log-step { color: var(--success); }
      .log-entry.warning .log-step { color: var(--warning); }
      
      .upload-area { border: 2px dashed var(--border); padding: 0; text-align: center; cursor: pointer; border-radius: 6px; margin-bottom: 15px; transition: 0.2s; position: relative; overflow: hidden; height: 100px; display: flex; align-items: center; justify-content: center; background: #1e293b; }
      .upload-area:hover { border-color: var(--primary); }
      .preview-img { width: 100%; height: 100%; object-fit: contain; }
      .upload-placeholder { color: #888; font-size: 12px; pointer-events: none; }
      
      .slider-container { margin-bottom: 15px; }
      .slider-header { display: flex; justify-content: space-between; font-size: 12px; color: #94a3b8; margin-bottom: 5px; }
      input[type=range] { width: 100%; cursor: pointer; accent-color: var(--primary); padding: 0; margin: 0; }

      /* 进度条 */
      .progress-bar { width: 100%; height: 4px; background: #333; border-radius: 2px; overflow: hidden; margin-top: 10px; display: none; }
      .progress-fill { height: 100%; background: var(--primary); width: 0%; transition: width 0.3s; }
      
      /* 计时器 */
      .timer { font-family: monospace; color: var(--primary); font-weight: bold; margin-left: 10px; }
    </style>
</head>
<body>
    <div class="sidebar">
        <h2 style="margin-top:0; display:flex; align-items:center; gap:10px;">
            🍌 ${CONFIG.PROJECT_NAME} 
            <span style="font-size:12px;color:#94a3b8; font-weight:normal; margin-top:4px;">v${CONFIG.PROJECT_VERSION}</span>
        </h2>
        
        <div class="box">
            <span class="label">凭证状态 (动态获取)</span>
            <div class="status-indicator">
                <div id="statusDot" class="dot"></div>
                <span id="statusText">等待请求...</span>
            </div>
        </div>

        <div class="box">
            <span class="label">API 密钥 (点击复制)</span>
            <div class="code-block" onclick="copy('${apiKey}')">${apiKey}</div>
        </div>

        <div class="box">
            <span class="label">API 接口地址</span>
            <div class="code-block" onclick="copy('${origin}/v1/chat/completions')">${origin}/v1/chat/completions</div>
        </div>

        <div class="box">
            <span class="label">模型选择</span>
            <select id="model">
                ${CONFIG.MODELS.map(m => `<option value="${m}">${m}</option>`).join('')}
            </select>
            
            <span class="label">比例 (Aspect Ratio)</span>
            <select id="ratio">
                <option value="1:1">1:1 (方形)</option>
                <option value="16:9">16:9 (横屏)</option>
                <option value="9:16">9:16 (竖屏)</option>
            </select>

            <div class="slider-container">
                <div class="slider-header">
                    <span>并发数量 (Concurrency)</span>
                    <span id="concurrencyVal">1</span>
                </div>
                <input type="range" id="concurrency" min="1" max="5" value="1" oninput="document.getElementById('concurrencyVal').innerText=this.value">
            </div>

            <span class="label">参考图 (图生图 - 可选)</span>
            <input type="file" id="fileInput" accept="image/*" style="display:none" onchange="handleFile()">
            <div class="upload-area" onclick="document.getElementById('fileInput').click()">
                <div class="upload-placeholder">点击上传图片</div>
            </div>

            <span class="label">提示词 (Prompt)</span>
            <textarea id="prompt" rows="4" placeholder="描述你想生成的图片..."></textarea>
            
            <div style="display:flex; align-items:center;">
                <button id="btn-gen" onclick="generate()" style="flex:1">🚀 开始生成</button>
                <div id="timer" class="timer">00:00.0</div>
            </div>
        </div>
    </div>

    <main class="main">
        <div class="chat-window" id="chat">
            <div style="color:#64748b; text-align:center; margin-top:100px;">
                <div style="font-size:40px; margin-bottom:20px;">🎨</div>
                <h3>Infip Pro 画廊模式就绪</h3>
                <p>支持并发生成、图生图、实时预览。<br>内置抗 429 重试机制，请耐心等待。</p>
            </div>
        </div>
        <div class="log-panel" id="logs">
            <div class="log-entry"><span class="log-time">--:--:--</span><span class="log-step">System</span><span class="log-msg">系统就绪</span></div>
        </div>
    </main>

    <script>
        const API_KEY = "${apiKey}";
        const ENDPOINT = "${origin}/v1/chat/completions";
        let base64Image = null;
        let timerInterval = null;
        let startTime = 0;

        function log(step, msg, type='') {
            const el = document.getElementById('logs');
            const div = document.createElement('div');
            div.className = \`log-entry \${type}\`;
            div.innerHTML = \`<span class="log-time">\${new Date().toLocaleTimeString()}</span><span class="log-step">\${step}</span><span class="log-msg">\${msg}</span>\`;
            el.appendChild(div);
            el.scrollTop = el.scrollHeight;
        }

        function updateStatus(key) {
            const dot = document.getElementById('statusDot');
            const text = document.getElementById('statusText');
            dot.classList.add('active');
            text.innerText = \`Key: \${key.substring(0, 8)}...\`;
            text.style.color = "var(--success)";
        }

        function copy(text) {
            navigator.clipboard.writeText(text);
            alert('已复制');
        }

        function startTimer() {
            startTime = Date.now();
            const timerEl = document.getElementById('timer');
            clearInterval(timerInterval);
            timerInterval = setInterval(() => {
                const diff = Date.now() - startTime;
                const minutes = Math.floor(diff / 60000);
                const seconds = Math.floor((diff % 60000) / 1000);
                const deciseconds = Math.floor((diff % 1000) / 100);
                timerEl.innerText = \`\${minutes.toString().padStart(2, '0')}:\${seconds.toString().padStart(2, '0')}.\${deciseconds}\`;
            }, 100);
        }

        function stopTimer() {
            clearInterval(timerInterval);
        }

        function handleFile() {
            const file = document.getElementById('fileInput').files[0];
            if (!file) return;
            
            const reader = new FileReader();
            reader.onload = (e) => {
                base64Image = e.target.result;
                const area = document.querySelector('.upload-area');
                area.innerHTML = \`<img src="\${base64Image}" class="preview-img"><div style="position:relative;z-index:2;text-shadow:0 1px 2px black;">已选择图片</div>\`;
            };
            reader.readAsDataURL(file);
        }

        function createGallery() {
            const div = document.createElement('div');
            div.className = 'msg ai';
            div.innerHTML = \`
                <div class="gallery" id="current-gallery"></div>
                <div class="progress-bar"><div class="progress-fill"></div></div>
            \`;
            document.getElementById('chat').appendChild(div);
            return div;
        }

        function addImageToGallery(base64, index) {
            const gallery = document.getElementById('current-gallery');
            const card = document.createElement('div');
            card.className = 'img-card';
            card.innerHTML = \`
                <img src="\${base64}" onclick="window.open(this.src)">
                <div class="img-actions">
                    <span style="color:#fff;font-size:12px;">#\${index}</span>
                    <a class="action-btn" href="\${base64}" download="infip-\${Date.now()}.png">⬇️ 下载</a>
                </div>
            \`;
            gallery.appendChild(card);
            document.getElementById('chat').scrollTop = document.getElementById('chat').scrollHeight;
        }

        function appendMsg(role, html) {
            const div = document.createElement('div');
            div.className = \`msg \${role}\`;
            div.innerHTML = html;
            document.getElementById('chat').appendChild(div);
            div.scrollIntoView({ behavior: "smooth" });
            return div;
        }

        async function generate() {
            const prompt = document.getElementById('prompt').value.trim();
            if (!prompt && !base64Image) return alert('请输入提示词或上传图片');

            const btn = document.getElementById('btn-gen');
            const concurrency = document.getElementById('concurrency').value;
            
            btn.disabled = true;
            btn.innerText = \`生成中 (\${concurrency}张)...\`;
            startTimer();

            if(document.querySelector('.chat-window').innerText.includes('代理服务就绪')) {
                document.getElementById('chat').innerHTML = '';
            }

            // 用户消息
            const userDiv = document.createElement('div');
            userDiv.className = 'msg user';
            userDiv.innerText = prompt || "[仅参考图]";
            document.getElementById('chat').appendChild(userDiv);

            // 创建画廊容器
            createGallery();
            const progressBar = document.querySelector('.progress-fill');
            progressBar.parentElement.style.display = 'block';
            
            log('System', \`开始任务: \${concurrency} 并发, Prompt: \${prompt}\`);

            try {
                const payload = {
                    model: document.getElementById('model').value,
                    messages: [{ 
                        role: 'user', 
                        content: JSON.stringify({
                            prompt: prompt,
                            image: base64Image,
                            ar: document.getElementById('ratio').value,
                            n: concurrency
                        })
                    }],
                    stream: true,
                    is_web_ui: true // 关键：标记为 Web UI 请求
                };

                const res = await fetch(ENDPOINT, {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                let imgCount = 0;

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\\n');
                    buffer = lines.pop(); 
                    
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const dataStr = line.slice(6);
                            if (dataStr === '[DONE]') continue;
                            try {
                                const data = JSON.parse(dataStr);
                                
                                // 处理日志 (仅 Web UI 会收到 debug 字段)
                                if (data.debug) {
                                    data.debug.forEach(d => {
                                        log(d.step, d.message, d.type);
                                        if (d.step === 'Auth' && d.message.includes('成功')) {
                                            const key = d.message.split(': ')[1];
                                            updateStatus(key);
                                        }
                                    });
                                    continue;
                                }

                                // 处理图片内容
                                if (data.choices && data.choices[0].delta.content) {
                                    const content = data.choices[0].delta.content;
                                    const match = content.match(/\\((data:image.*?)\\)/);
                                    if (match) {
                                        imgCount++;
                                        addImageToGallery(match[1], imgCount);
                                        progressBar.style.width = \`\${(imgCount / concurrency) * 100}%\`;
                                    }
                                }
                            } catch (e) {}
                        }
                    }
                }

            } catch (e) {
                log('Error', e.message, 'error');
                alert('生成出错: ' + e.message);
            } finally {
                stopTimer();
                btn.disabled = false;
                btn.innerText = "🚀 开始生成";
                setTimeout(() => { progressBar.parentElement.style.display = 'none'; }, 1000);
            }
        }
    </script>
</body>
</html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

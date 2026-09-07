/* ============================================================================
 * /api/ai —— 统一 AI 网关（模型注册表 + 多通道降级 + 与 webdav 一致的鉴权）
 * ============================================================================
 *
 * 【这个文件解决什么问题】
 *   以前如果想换个模型，要在业务代码里搜模型名字符串逐个改。
 *   这里改成「注册表 + 统一网关」：模型是数据，不是代码。
 *   以后加一个模型 = 往 MODELS 数组加一项（需要 Key 的再加一个环境变量），
 *   业务代码（前端 /api/ai 调用方）一个字都不用动。
 *
 * 【调用方式】
 *   POST /api/ai
 *     { scene:'title', prompt:'帮我想 5 个标题', prefer:'cf-glm47', fallback:'zhipu-glm47' }
 *   返回
 *     { ok:true, text:'...', model:'cf-glm47', provider:'cloudflare', estNeurons:20, degraded:false }
 *
 *   GET  /api/ai?op=models   → 可用模型列表（前端下拉从这里自动生成，永远和后端同步）
 *   GET  /api/ai?diag=1      → 自检（谁配了、谁没配、谁能用；不回显任何密钥内容）
 *   GET  /api/ai?diag=1&probe=1 → 在上面基础上真跑一次最小请求，验证链路
 *
 * 【设计约定】
 *   1. 业务代码里禁止出现具体模型名 —— 只传 scene 和（可选的）模型 id
 *   2. 未配置 Key 的模型自动置为不可用，不报错、不连坐其他模型
 *   3. 任何情况下都不抛异常到边缘：全部失败也返回结构化 JSON + 友好文案
 *   4. 响应头 ASCII 净化 + 全局 try/catch —— 非 ASCII 响应头会让 CF 边缘直接回 520，
 *      而且代码一步都不抛、任何 try/catch 都抓不到（这个坑在 webdav 那轮踩过）
 *   5. 不设置 www-authenticate —— 会让浏览器弹原生登录框并挂住请求
 *
 * 【不动的东西】
 *   functions/api/webdav/[[path]].js（KV 同步）一行未动；sw.js 一行未动。
 *   两者是两条独立路由，且 sw.js 早已对 /api/ 全部 pass-through，无需改动。
 * ========================================================================== */

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/* 总预算 50 秒。主力与备用各走各的计时，不共用 30 秒 ——
   否则主力耗掉 25 秒后才失败，备用只剩 5 秒，必然也超时，等于没有兜底。 */
const TIMEOUT_PRIMARY_MS = 20000;
const TIMEOUT_FALLBACK_MS = 25000;

/* 单次请求允许的最大输入字符数（按字节算，中文一个字 3 字节） */
const MAX_INPUT_BYTES = 40000;

/* ---------------------------------------------------------------------------
 * 一、模型注册表
 * ---------------------------------------------------------------------------
 * 以后新增模型：只往这个数组加一项。字段说明：
 *   id       前端下拉用的稳定标识（改了要同步前端设置里已存的偏好，别乱改）
 *   name     下拉里显示的中文名
 *   provider 'cloudflare' | 'zhipu' | 任何其他已在 PROVIDERS 里注册的适配器名
 *   modelId   provider 认识的模型名
 *   endpoint 仅外部 HTTP  provider 需要
 *   needsKey  true 表示必须配 envVar 指定的环境变量，否则自动置为不可用
 *   envVar    needsKey 时读哪个环境变量
 *   ctx       上下文窗口（前端可用来提示"这条内容超长了"）
 *   tier      'fast' | 'long'，仅前端展示用
 *   priceIn / priceOut   每百万 token 消耗多少 Neurons（用于估算额度）
 *                         不走 Neurons 计费的 provider 填 null
 */
const MODELS = [
  {
    id: 'cf-glm47',
    name: 'Cloudflare GLM-4.7-Flash（快，推荐）',
    provider: 'cloudflare',
    modelId: '@cf/zai-org/glm-4.7-flash',
    chat: true,                 /* 走 messages 入参，不是 prompt */
    thinking: false,            /* ★ 必须显式关掉思考：见下方说明 */
    needsKey: false,
    ctx: 131072,
    tier: 'fast',
    quality: 'good',
    priceIn: 5500,
    priceOut: 36400,
    note: '免费层主力。已关闭思维链（thinking），轻量任务约 2-3 秒返回'
  },
  {
    id: 'zhipu-glm47',
    name: '智谱 GLM-4.7-Flash（200K 长上下文）',
    provider: 'zhipu',
    modelId: 'glm-4.7-flash',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    chat: true,
    needsKey: true,
    envVar: 'ZHIPU_KEY',
    ctx: 200000,
    tier: 'long',
    quality: 'good',
    priceIn: null,
    priceOut: null,
    note: '需配置环境变量 ZHIPU_KEY。限 1 并发、响应 15-25 秒，适合超长上下文兜底'
  },
  {
    /* 排在最后 = 最后一道防线。网关按数组顺序兜底，所以位置本身就是优先级。
       降级理由见 note：8B 小模型容易答非所问，只在前两个都挂了才轮到它。 */
    id: 'cf-llama31',
    name: 'Cloudflare Llama-3.1-8B（最后防线）',
    provider: 'cloudflare',
    modelId: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
    chat: true,
    thinking: false,
    needsKey: false,
    ctx: 131072,
    tier: 'last',
    quality: 'unstable',        /* ★ 网关会对此类模型做更严的输出校验 */
    priceIn: 4119,
    priceOut: 34868,
    note: '⚠ 输出质量不稳定：8B 小模型，实测会出现答非所问（例如要求生成标题却返回网络诊断文本）。已降级为最后一道防线，仅在前两个通道全部失败时使用'
  }
];

/* ===========================================================================
 * ⚠ 关于 thinking（思维链）—— 这是踩过的坑，改动前务必先读
 * ===========================================================================
 * @cf/zai-org/glm-4.7-flash 的 CF 文档标注为 Reasoning: Yes，
 * 且 chat_template_kwargs.enable_thinking 的默认值是 **true**。
 *
 * 后果：模型的思考过程同样占用 max_completion_tokens 预算。
 * title 场景上限只有 150 token，思考还没写完就被截断 ——
 * 正文一个 token 都没生成，返回 {"response": ""} 或者直接没有 response 字段，
 * 网关判定 "empty response"。耗时却接近 5 秒（因为确实推理了），
 * 极易被误判成"模型坏了"或"格式不对"。
 *
 * 对策（两道）：
 *   ① 对所有标注 chat:true 的模型显式传 enable_thinking:false
 *   ② 万一某天 CF 改了字段名导致 ① 失效，
 *      适配器检测到"响应为空但确实消耗了 output token"时会自动用更大额度重试一次。
 * =========================================================================== */

/* ---------------------------------------------------------------------------
 * 二、场景表：每个场景的输出上限 + 系统提示词
 * ---------------------------------------------------------------------------
 * max_tokens 必须封顶：GLM-4.7-Flash 输出单价 36400 Neurons/百万 token，
 * 是输入的 6.6 倍。不封顶的话一个"详细攻略"可能单次烧掉 300+ Neurons，
 * 一天 1 万额度跑不了几十次。
 */
const SCENES = {
  title: {
    label: '标题 / 标签',
    max_tokens: 150,
    system: '你是标题与标签助手。严格只输出结果本身：第一行给标题，第二行给标签（逗号分隔）。禁止输出任何说明、分析、客套话，禁止输出 Markdown 代码块围栏。',
    echoMax: 600
  },
  polish: {
    label: '润色笔记',
    max_tokens: 800,
    system: '你是中文写作润色助手。保留原意与作者语气，只改通顺度、结构与错别字。直接输出润色后的正文，不要加点评、不要重复原文、不要说明你改了什么。',
    echoMax: 600
  },
  script: {
    label: '短视频脚本',
    max_tokens: 2500,
    system: '你是短视频脚本策划。输出结构：钩子（前 3 秒）→ 正文分镜 → 结尾引导。给出可照读的台词。不要解释你的创作思路。',
    echoMax: 600
  },
  guide: {
    label: '详细攻略',
    max_tokens: 4000,
    system: '你是攻略作者。输出分步骤、可执行的详细内容，每步说明"做什么"和"为什么"。用 Markdown 小标题分节。不要输出免责声明。',
    echoMax: 600
  },
  plan: {
    label: '学习计划',
    max_tokens: 4000,
    system: '你是学习计划设计师。把目标拆成阶段性任务，给出每天可完成的具体动作与检查点。用 Markdown 分节。直接输出计划，不要先分析可行性。',
    echoMax: 600
  }
};

/* --- 拼装发给模型的 messages ---------------------------------------------
 * 不能把用户原文裸着扔给模型：裸文本歧义极大。
 * 实测案例：probe 用 "ping" 做 prompt，8B 模型直接理解成网络 ping 命令，
 * 输出了"IP地址/丢包率/路由跳数"这种答非所问的内容。
 * 所以统一用「任务声明 + 定界符包裹的原文」两层结构，
 * promptEcho 回显的也是拼装后的最终文本，方便判断是 prompt 没写对还是模型太弱。 */
function buildMessages(scene, prompt) {
  return [
    { role: 'system', content: scene.system },
    { role: 'user', content:
      '任务：' + scene.label + '\n\n' +
      '待处理内容：\n"""\n' + prompt + '\n"""\n\n' +
      '请只输出任务结果本身。不要复述上面的任务说明，不要写"好的"、"以下是"这类开场白，不要解释你的做法。' }
  ];
}

/* --- promptEcho：回显实际发出的文本（截断），用于排障 -------------------- */
function echoOf(text, cap) {
  const t = String(text || '');
  const limit = cap || 600;
  return t.length > limit ? t.slice(0, limit) + '…[共 ' + t.length + ' 字符]' : t;
}

/* ---------------------------------------------------------------------------
 * 三、小工具（与 webdav 那份同规格，独立实现以免改动 webdav）
 * --------------------------------------------------------------------------- */

/* 只保留可打印 ASCII：HTTP 头里出现非 ASCII，CF 边缘可能直接回 520，
   而 Worker 代码一步异常都不抛，任何 try/catch 都抓不到。 */
function asciiSafe(v) {
  return String(v).replace(/[^\x20-\x7e\t]/g, '?');
}

/* 安全写响应头
   ① 控制字符（\n \r \0）＝ 头注入风险 → 整个头丢弃，绝不改写成 '?' 放行
   ② 非法值被 Headers 拒绝 → 跳过并记 note，不连坐其他头 */
function safeSet(headers, name, value, notes) {
  if (value === null || value === undefined || value === '') return;
  const v = String(value);
  if (/[\r\n\0]/.test(v)) {
    if (notes) notes.push('dropped unsafe header "' + name + '": control characters');
    return;
  }
  try {
    headers.set(name, asciiSafe(v));
  } catch (e) {
    if (notes) notes.push('skipped invalid header "' + name + '": ' + (e && e.message || e));
  }
}

function byteLen(s) {
  try { return new TextEncoder().encode(s).length; } catch (e) { return String(s).length; }
}

function errInfo(e, extra) {
  const o = {
    name: (e && e.name) || 'Error',
    message: (e && e.message) || String(e),
    stack: String((e && e.stack) || '').slice(0, 1200)
  };
  if (extra) Object.assign(o, extra);
  return o;
}

function json(obj, status, notes, extraHeaders) {
  try {
    const h = new Headers();
    safeSet(h, 'content-type', JSON_CONTENT_TYPE, notes);
    safeSet(h, 'cache-control', 'no-store', notes);
    if (extraHeaders) {
      Object.keys(extraHeaders).forEach(function (k) { safeSet(h, k, extraHeaders[k], notes); });
    }
    if (notes && notes.length) {
      safeSet(h, 'x-proxy-notes', asciiSafe(notes.join(' | ').replace(/[\r\n\0]/g, ' ')).slice(0, 500), null);
    }
    return new Response(JSON.stringify(obj, null, 2), { status: status, headers: h });
  } catch (e) {
    return new Response(
      '{"error":"json build failed","message":' + JSON.stringify(String((e && e.message) || e)) + '}',
      { status: 500, headers: { 'content-type': JSON_CONTENT_TYPE, 'cache-control': 'no-store' } }
    );
  }
}

/* 恒定时间比较，避免通过响应耗时逐字符猜密钥 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/* 给一个 promise 套上超时。
   env.AI.run 不接受 signal，只能用 race —— 超时后底层请求仍在跑但结果被丢弃，
   这是可接受的：我们要的是"用户不用干等"，不是真的掐断上游。 */
function withTimeout(promise, ms, label) {
  let timer = null;
  const guard = new Promise(function (_, reject) {
    timer = setTimeout(function () {
      const e = new Error(label + ' timeout after ' + ms + 'ms');
      /* ★ 必须打码：超时绝不能和不兼容参数混淆 ——
         曾经因为区分不开，超时被当成"模型不认 enable_thinking"，
         又重试了一次同样长度的等待，主力预算从 20 秒膨胀成 40 秒。 */
      e.code = 'TIMEOUT';
      reject(e);
    }, ms);
  });
  return Promise.race([promise, guard]).then(function (v) {
    clearTimeout(timer); return v;
  }, function (e) {
    clearTimeout(timer); throw e;
  });
}

/* ---------------------------------------------------------------------------
 * 四、鉴权（与 webdav 完全一致，复用同一个 SYNC_TOKEN）
 * ---------------------------------------------------------------------------
 *   env.SYNC_TOKEN 已配置 → 严格校验 x-sync-token / Authorization: Bearer
 *   env.SYNC_TOKEN 未配置 → 不鉴权（和 webdav 保持同一套行为，用户只需记一个密码）
 */
function checkAuth(request, env, notes) {
  const expected = env && env.SYNC_TOKEN;
  if (!expected) return null;
  /* 只有 Bearer scheme 才算密钥：前端为兼容保留了 Authorization: Basic <账号:密码>，
     不区分 scheme 会把"填过账号密码但没填密钥"误判成 403，而正确答案是 401。 */
  const authz = String(request.headers.get('authorization') || '');
  const bearer = /^bearer\s+/i.test(authz) ? authz.replace(/^bearer\s+/i, '') : '';
  const got = request.headers.get('x-sync-token') || bearer;
  if (!got) {
    return json({
      error: 'missing sync token',
      detail: '这个站点设了同步密钥（SYNC_TOKEN），但本次请求没带。',
      fix: '工作台 → 设置 → 云端同步 → 把「同步密钥」填进去，与 Pages 环境变量 SYNC_TOKEN 保持一致。AI 功能复用同一个密钥。',
      accepts: ['x-sync-token: <token>', 'Authorization: Bearer <token>']
    }, 401, notes);
  }
  if (!safeEqual(got, expected)) {
    return json({
      error: 'invalid sync token',
      detail: '同步密钥不对（AI 与云端同步复用同一个密钥）。',
      fix: '核对工作台里的「同步密钥」与 Pages 环境变量 SYNC_TOKEN 是否一字不差（注意别多复制空格）。',
      receivedLength: got.length
    }, 403, notes);
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * 五、模型可用性：没配 Key 的模型自动置为不可用，不报错、不连坐
 * --------------------------------------------------------------------------- */
function modelStatus(m, env) {
  const st = {
    id: m.id, name: m.name, provider: m.provider, tier: m.tier,
    ctx: m.ctx, note: m.note || '',
    quality: m.quality || 'good'          /* unstable = 输出质量不稳定，前端下拉可标注 */
  };
  if (m.provider === 'cloudflare') {
    /* Workers AI 走 binding，不需要 Key；但 binding 本身可能没配 —— 那是运行时才知道的，
       这里只标"需要 binding"，具体等真正调用时再降级提示。 */
    st.needsKey = false;
    st.keyConfigured = true;
    st.available = true;
    st.reason = 'Workers AI binding（无需 Key）';
  } else if (m.needsKey) {
    const v = env && env[m.envVar];
    st.needsKey = true;
    st.envVar = m.envVar;
    st.keyConfigured = !!v;
    st.available = !!v;
    st.reason = v ? '已配置 ' + m.envVar : '未配置环境变量 ' + m.envVar + ' → 自动置为不可用';
  } else {
    st.needsKey = false;
    st.keyConfigured = true;
    st.available = true;
    st.reason = '无需 Key';
  }
  return st;
}

/* ---------------------------------------------------------------------------
 * 六、响应归一化
 * ---------------------------------------------------------------------------
 * 各家返回格式五花八门，这里统一成 { text, usage }：
 *   Workers AI 老 text-generation：{ response: '...' }
 *   Workers AI 包了一层：        { result: { response: '...' } }
 *   OpenAI 兼容（智谱 / CF 新模型）：{ choices: [{ message: { content } }] }
 *   某些模型的流式尾包：          { response: { response: '...' } }
 *   纯字符串
 */
function rawKeysOf(raw) {
  try {
    if (raw == null) return [];
    if (typeof raw === 'string') return ['(string)'];
    if (typeof raw !== 'object') return ['(' + typeof raw + ')'];
    return Object.keys(raw);
  } catch (e) { return ['<unreadable>']; }
}

function normalizeOutput(raw) {
  if (raw == null) return { text: '', usage: null, rawKeys: rawKeysOf(raw) };
  const rawKeys = rawKeysOf(raw);
  if (typeof raw === 'string') return { text: raw.trim(), usage: null, rawKeys: rawKeys };

  let text = '';
  if (typeof raw.response === 'string') text = raw.response;
  else if (raw.result && typeof raw.result.response === 'string') text = raw.result.response;
  else if (raw.result && typeof raw.result === 'string') text = raw.result;
  else if (Array.isArray(raw.choices) && raw.choices.length) {
    const c = raw.choices[0] || {};
    if (c.message && c.message.content != null) text = String(c.message.content);
    else if (c.text != null) text = String(c.text);
    else if (c.delta && c.delta.content != null) text = String(c.delta.content);
  } else if (raw.output_text != null) text = String(raw.output_text);
  else if (raw.text != null) text = String(raw.text);

  const usage = raw.usage || (raw.result && raw.result.usage) || null;

  /* 记住模型是否真的产出过内容 —— 即使正文为空。
     这是识别"思考链吃光预算"的关键证据：
     正文空 + output token 接近上限 = 被 thinking 截断，而不是模型坏了。 */
  let reasonTokens = 0;
  try {
    if (typeof raw.reasoning === 'string') reasonTokens = raw.reasoning.length;
    else if (raw.reasoning_content != null) reasonTokens = String(raw.reasoning_content).length;
    else if (raw.result && raw.result.reasoning != null) reasonTokens = String(raw.result.reasoning).length;
    else if (raw.choices && raw.choices[0] && raw.choices[0].message && raw.choices[0].message.reasoning_content != null) {
      reasonTokens = String(raw.choices[0].message.reasoning_content).length;
    }
  } catch (e) { reasonTokens = 0; }

  return {
    text: String(text || '').trim(),
    usage: usage && (usage.prompt_tokens != null || usage.completion_tokens != null)
      ? {
          input: usage.prompt_tokens || usage.input_tokens || 0,
          output: usage.completion_tokens || usage.output_tokens || 0
        }
      : null,
    rawKeys: rawKeys,
    reasonChars: reasonTokens
  };
}

/* 按模型费率估算 Neurons。不走 Neurons 计费的 provider 返回 null。 */
function estNeurons(m, usage) {
  if (!usage || m.priceIn == null || m.priceOut == null) return null;
  const n = (usage.input / 1e6) * m.priceIn + (usage.output / 1e6) * m.priceOut;
  return Math.round(n * 100) / 100;
}

/* ---------------------------------------------------------------------------
 * 六点五、输出质量校验
 * ---------------------------------------------------------------------------
 * 背景：网关原来只判"非空即成功"，结果 8B 备用模型返回了一段网络 ping
 * 诊断文本（"IP地址 / 丢包率 / 平均时间"），网关照样判成功，前端直接填给用户。
 *
 * 校验分三档，只有前两档会判失败：
 *   ① 硬失败：输出在复读指令 / 泄漏了我们的包装格式 / 有效内容过短
 *   ② 硬失败：内容跟用户原文零关联，且命中"典型跑偏特征词"
 *   ③ 软提示：零关联但没命中特征词 → 放行，标 quality:'weak' 让前端提示可重试
 *
 * 为什么 ③ 不判失败：标题类场景本来就会改写用词
 * （"如何三分钟做蛋炒饭" → "快手夜宵｜十分钟搞定一锅香"），
 * 严格判关联会把好结果误杀。宁可放过，不可误杀。
 */

/* p：跑偏特征词。选词原则＝宁缺毋滥，只收几乎不可能出现在正常结果里的词 */
const OFFTOPIC_TOKENS = [
  '丢包率', '丢包', 'traceroute', '路由跳数', 'icmp', 'ttl=', '默认网关',
  '子网掩码', 'ping 测试', '延迟:', '133.35', '平均时间', '网络质量',
  '作为一个 ai', '作为一个ai', '作为一个语言模型', '作为一个人工智能',
  '我无法访问', '我无法完成', '我无法获取实时', '我不能提供',
  'http 状态码', 'ping的结果'
];

/* g：把文本拆成词集（英文按词、中文按 2-gram） */
function grams(s) {
  const t = String(s || '').toLowerCase();
  const out = Object.create(null);
  let n = 0;
  (t.match(/[a-z0-9]{2,}/g) || []).forEach(function (w) { if (!out[w]) { out[w] = 1; n++; } });
  const zh = t.replace(/[^\u4e00-\u9fa5]/g, '');
  for (let i = 0; i + 1 < zh.length; i++) {
    const g2 = zh.slice(i, i + 2);
    if (!out[g2]) { out[g2] = 1; n++; }
  }
  return { set: out, n: n };
}

function hitCount(a, b) {
  let c = 0;
  Object.keys(b.set).forEach(function (k) { if (a.set[k]) c++; });
  return c;
}

/* 剥掉模型爱加的 Markdown 代码围栏 —— 这是"看起来像垃圾"的高频原因，
   其实内容是对的，别当成跑偏废掉 */
function cleanFence(t) {
  let s = String(t || '').trim();
  const m = s.match(/^```[a-zA-Z0-9]*\s*\n([\s\S]*?)\n```$/);
  if (m) s = m[1].trim();
  return s;
}

function checkQuality(scene, userPrompt, rawText, systemPrompt) {
  const text = cleanFence(rawText);
  if (!text) return { ok: false, reason: 'empty', level: 'hard', text: '' };

  const lower = text.toLowerCase();

  /* ①a 复读系统提示：把 system 里的话当答案输出了 */
  if (systemPrompt) {
    const sysGrams = grams(systemPrompt);
    const txtGrams = grams(text);
    if (sysGrams.n > 0 && txtGrams.n > 0) {
      const overlap = hitCount(sysGrams, txtGrams) / Math.min(sysGrams.n, txtGrams.n);
      if (overlap > 0.6) return { ok: false, reason: 'echoed system prompt', level: 'hard', text: text };
    }
  }

  /* ①b 泄漏包装格式：模型把我们拼装的框架原样吐了回来 */
  if (/待处理内容|三引号|^"""/m.test(text) || text.indexOf('"""') >= 0) {
    return { ok: false, reason: 'leaked prompt wrapper', level: 'hard', text: text };
  }

  /* ①c 有效内容太短（去掉标点空白后不足 2 字） */
  const solid = text.replace(/[\s\p{P}\p{S}]/gu, '');
  if (solid.length < 2) return { ok: false, reason: 'too short', level: 'hard', text: text };

  const pGrams = grams(userPrompt);
  const tGrams = grams(text);

  /* 零关联：输出跟原文一个共用词都没有（prompt 本身词太少时不可靠，跳过） */
  const related = pGrams.n >= 3 ? hitCount(pGrams, tGrams) : -1;

  if (related === 0) {
    const badHit = OFFTOPIC_TOKENS.filter(function (w) { return lower.indexOf(w) >= 0; });
    if (badHit.length) {
      return { ok: false, reason: 'off topic (' + badHit[0] + ')', level: 'hard', text: text };
    }
    return { ok: true, reason: 'unrelated but plausible', level: 'soft', quality: 'weak', text: text };
  }

  return { ok: true, reason: 'ok', level: 'soft', quality: 'good', text: text, related: related };
}

/* ---------------------------------------------------------------------------
 * 七、Provider 适配器
 * ---------------------------------------------------------------------------
 * 以后加一个新的服务商（比如腾讯混元）：在这里加一个同名适配器即可，
 * MODELS 里加一项指过去，业务代码零改动。
 */
const PROVIDERS = {
  /* Cloudflare Workers AI：走 binding，不需要 API Key */
  cloudflare: async function (m, messages, maxTokens, env, timeoutMs, notes) {
    if (!env || !env.AI || typeof env.AI.run !== 'function') {
      const e = new Error('workers_ai_binding_missing');
      e.code = 'BINDING_MISSING';
      throw e;
    }

    /* max_tokens 在 CF 文档中已标记 deprecated in favor of max_completion_tokens。
       两个都传且同值：认哪个都生效，避免某天 CF 摘掉旧字段导致预算失控。 */
    const base = {
      messages: messages,
      max_completion_tokens: maxTokens,
      max_tokens: maxTokens
    };
    const noThink = m.thinking === false;

    /* 整个适配器的时间预算是 timeoutMs —— 每一次重试都在吃同一份预算。
       不做剩余时间检查的话，一次超时 + 一次重试就会把主力撑成 40 秒。 */
    const tStart = Date.now();
    const remainMs = function () { return timeoutMs - (Date.now() - tStart); };
    const MIN_RETRY_MS = 3000;

    /* attempts：把每一次真实调用的证据都记下来，最终回显给 probe，
       这样"到底发给模型了什么、模型返回了什么结构"不用靠猜 */
    const attempts = [];
    async function attempt(input, label) {
      const budget = Math.max(1000, remainMs());
      const raw = await withTimeout(env.AI.run(m.modelId, input), budget, 'cloudflare ' + m.id);
      const out = normalizeOutput(raw);
      attempts.push({
        label: label,
        requestedMax: input.max_completion_tokens,
        keys: out.rawKeys,
        textLen: out.text.length,
        reasonChars: out.reasonChars,
        outputTokens: out.usage ? out.usage.output : null
      });
      return out;
    }

    let input = Object.assign({}, base);
    if (noThink) input.chat_template_kwargs = { enable_thinking: false };

    let out;
    try {
      out = await attempt(input, 'first');
    } catch (e) {
      /* 船新对策：万一某个模型的 chat template 不认 enable_thinking 直接报错，
         去掉这个参数再试一次 —— 宁可得到一个"可能带思考"的结果，也不要整个通道挂掉。

         但两类错误绝不重试：
           ① 超时（TIMEOUT）—— 再等一次只会让主力的 20 秒预算翻倍成 40 秒，
              而用户的契约写死了"主力 20 秒就切备用"
           ② 剩余时间不足 —— 重试注定失败 */
      if (e && e.code === 'TIMEOUT') throw e;
      if (!noThink) throw e;
      if (remainMs() < MIN_RETRY_MS) throw e;
      attempts.push({
        label: 'first call threw, retry without chat_template_kwargs',
        error: String((e && e.message) || e).slice(0, 200),
        remainMs: remainMs()
      });
      out = await attempt(Object.assign({}, base), 'retry-no-cth');
    }

    /* 空文本自动救一次。判据：模型确实产出了 output token（说明在干活），
       但正文是空的 → 极可能是思考链吃光了预算。此时放宽额度再问一次。 */
    if (!out.text && remainMs() >= MIN_RETRY_MS) {
      const spent = out.usage ? out.usage.output : 0;
      const looksTruncated = spent > 0 && spent >= maxTokens * 0.9;
      const newCap = looksTruncated
        ? Math.min(maxTokens * 6 + 500, 8000)   /* 给思考留足余量，但仍封顶 */
        : Math.max(maxTokens * 3, 1200);
      const input2 = Object.assign({}, base, {
        max_completion_tokens: newCap,
        max_tokens: newCap
      });
      if (noThink) input2.chat_template_kwargs = { enable_thinking: false };
      attempts.push({
        label: 'empty response → retry with larger cap',
        evidence: looksTruncated
          ? 'output 用了 ' + spent + '/' + maxTokens + ' token，疑似被思维链吃光预算'
          : '正文为空且无 usage 信息，换更大额度重试',
        newCap: newCap,
        remainMs: remainMs()
      });
      try { out = await attempt(input2, 'retry-cap-' + newCap); } catch (e) { /* 重试失败就保持原样，交给网关降级 */ }
    }

    out.debug = { modelId: m.modelId, requestedMax: maxTokens, attempts: attempts };
    return out;
  },

  /* 智谱 GLM：OpenAI 兼容的 HTTP 端点，需要 Bearer Key */
  zhipu: async function (m, messages, maxTokens, env, timeoutMs, notes) {
    const key = env && env[m.envVar];
    if (!key) {
      const e = new Error('missing env ' + m.envVar);
      e.code = 'KEY_MISSING';
      throw e;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, timeoutMs);
    try {
      const res = await fetch(m.endpoint.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer ' + key
        },
        body: JSON.stringify({
          model: m.modelId,                 /* 写死 glm-4.7-flash，绝不自动改成 flashx 等变体 */
          messages: messages,
          max_tokens: maxTokens,
          temperature: 0.7
        })
      });
      const body = await res.text();
      if (!res.ok) {
        const e = new Error('zhipu HTTP ' + res.status + ' ' + String(body).slice(0, 300));
        e.code = 'HTTP_' + res.status;
        e.status = res.status;
        throw e;
      }
      let parsed = null;
      try { parsed = JSON.parse(body); } catch (e) { parsed = body; }
      const out = normalizeOutput(parsed);
      out.debug = { modelId: m.modelId, requestedMax: maxTokens, attempts: [{ label: 'http', keys: out.rawKeys, textLen: out.text.length }] };
      return out;
    } finally {
      clearTimeout(timer);
    }
  }
};

/* ---------------------------------------------------------------------------
 * 八、统一网关：业务代码只调这一个，永远不出现具体模型名
 * ---------------------------------------------------------------------------
 * 顺序：首选 → 备用 → 全部失败给友好提示（不抛异常）
 */
async function gateway(opts, env, notes) {
  const scene = SCENES[opts.scene] || null;
  if (!scene) {
    return {
      ok: false, status: 400,
      body: {
        error: 'unknown scene',
        detail: '场景「' + String(opts.scene) + '」不存在。',
        supported: Object.keys(SCENES)
      }
    };
  }

  const byId = {};
  MODELS.forEach(function (m) { byId[m.id] = m; });

  /* 候选顺序：前端指定的首选 → 前端指定的备用 → 注册表里第一个可用的（兜底再兜底）
     opts.only=true 时不追加任何兜底 —— 用于 probe 单独测量某一个模型，
     否则主力挂了会被后面的模型救回来，测量结果失去意义。 */
  let wanted;
  if (opts.only) {
    wanted = [opts.prefer].filter(Boolean);
  } else {
    wanted = [opts.prefer, opts.fallback].filter(Boolean);
    MODELS.forEach(function (m) { if (wanted.indexOf(m.id) < 0 && modelStatus(m, env).available) wanted.push(m.id); });
  }

  const messages = buildMessages(scene, opts.prompt);

  /* promptEcho：把真正发出去的那段 user 文本回显（截断）。
     排查"输出是垃圾"时第一件事就是看这个 ——
     是 prompt 写得有歧义，还是模型太弱，看一眼就分得清。 */
  const echo = {
    scene: opts.scene,
    sceneLabel: scene.label,
    systemPrompt: echoOf(scene.system, 200),
    userMessage: echoOf(messages[1].content, scene.echoMax || 600),
    maxTokens: scene.max_tokens,
    userMessageLength: messages[1].content.length
  };

  const attempts = [];
  const tStart = Date.now();                 /* ★ 总墙钟：从第一个候选开始算 */
  const debugTrace = [];

  for (let i = 0; i < wanted.length; i++) {
    const m = byId[wanted[i]];
    if (!m) { attempts.push({ id: wanted[i], ok: false, error: 'unknown model id' }); continue; }

    const st = modelStatus(m, env);
    if (!st.available) {
      attempts.push({ id: m.id, provider: m.provider, ok: false, skipped: st.reason });
      continue;                              /* 没配 Key 就跳过，不报错、不连坐 */
    }

    const adapter = PROVIDERS[m.provider];
    if (!adapter) {
      attempts.push({ id: m.id, ok: false, error: 'no adapter for provider ' + m.provider });
      continue;
    }

    /* ★ 每个通道独立计时，不共用总预算。
       主力 20 秒、备用 25 秒 —— 备用慢是已知的（智谱 15-25 秒），
       共用 30 秒的话主力一慢备用就必然来不及。 */
    const budget = (i === 0) ? TIMEOUT_PRIMARY_MS : TIMEOUT_FALLBACK_MS;
    const t0 = Date.now();
    try {
      const out = await adapter(m, messages, scene.max_tokens, env, budget, notes);
      if (out.debug) debugTrace.push({ id: m.id, provider: m.provider, rawKeys: out.debug.attempts && out.debug.attempts.length ? out.debug.attempts[out.debug.attempts.length - 1].keys : null, attempts: out.debug.attempts });

      if (!out.text) {
        attempts.push({ id: m.id, provider: m.provider, ok: false, ms: Date.now() - t0, error: 'empty response', rawKeys: out.rawKeys, reasonChars: out.reasonChars });
        continue;                            /* 空结果也算失败，换下一个 */
      }

      /* ★ 非空不等于可用。以前这里只判 !out.text，
         结果 8B 模型返回 ping 诊断文本也照样算成功 */
      const q = checkQuality(scene, opts.prompt, out.text, scene.system);
      if (!q.ok) {
        attempts.push({
          id: m.id, provider: m.provider, ok: false, ms: Date.now() - t0,
          error: 'bad output: ' + q.reason, qualityCheck: q.reason,
          preview: echoOf(q.text, 120)
        });
        if (notes) notes.push('ai bad output ' + m.id + ': ' + q.reason);
        continue;                            /* 垃圾输出 = 失败，换下一个 */
      }
      if (q.related === 0 && notes) {
        notes.push('ai weak output ' + m.id + ': 输出与原文零关联，已放行但标 weak');
      }

      const usage = out.usage;
      return {
        ok: true,
        status: 200,
        body: {
          ok: true,
          text: q.text,
          model: m.id,
          modelName: m.name,
          provider: m.provider,
          scene: opts.scene,
          sceneLabel: scene.label,
          maxTokens: scene.max_tokens,
          degraded: i > 0,                   /* true = 用的不是首选，前端可显示小字提示 */
          attempts: attempts,
          usage: usage,
          estNeurons: estNeurons(m, usage),
          ms: Date.now() - t0,               /* 命中那个模型的耗时 */
          totalMs: Date.now() - tStart,      /* ★ 含失败候选在内的总耗时 */
          quality: q.quality || 'good',      /* weak = 输出可能不太准，前端可提示"可重试" */
          qualityNote: q.reason !== 'ok' ? q.reason : null,
          debug: Object.assign({}, echo, { rawKeys: out.rawKeys, trace: opts.trace ? debugTrace : undefined })
        }
      };
    } catch (e) {
      attempts.push({
        id: m.id, provider: m.provider, ok: false, ms: Date.now() - t0,
        error: e && e.code ? e.code : ((e && e.message) || String(e)),
        /* 带上完整信息，否则 TIMEOUT 这种错误码看不出具体超了多少 */
        detail: String((e && e.message) || e).slice(0, 200)
      });
      if (notes) notes.push('ai fail ' + m.id + ': ' + String((e && e.message) || e).slice(0, 120));
    }
  }

  /* 全部失败 —— 结构化返回，不抛异常、不白屏 */
  const hasKeyIssue = attempts.some(function (a) { return a.skipped; });
  const hasBadOutput = attempts.some(function (a) { return a.qualityCheck; });
  return {
    ok: false,
    status: 503,
    body: {
      error: 'ai_unavailable',
      detail: 'AI 暂时不可用，刚才试了 ' + attempts.length + ' 个通道都没成功。工作台其他功能不受影响。',
      fix: hasKeyIssue
        ? '有通道因为没配 Key 被跳过（见 attempts）。去 Pages 项目 → Settings → Environment variables 补上即可。'
        : (hasBadOutput
            ? '有通道返回了跑题或异常内容，已被拦截（见 attempts 的 qualityCheck）。可以换个模型或缩短输入再试。'
            : '可能是当天 1 万 Neurons 额度用完了（每天 00:00 UTC 重置），或上游临时故障。稍后再试。'),
      attempts: attempts,
      totalMs: Date.now() - tStart,
      debug: Object.assign({}, echo, { trace: opts.trace ? debugTrace : undefined })
    }
  };
}

/* ---------------------------------------------------------------------------
 * 九、路由入口
 * --------------------------------------------------------------------------- */
export async function onRequest(context) {
  const notes = [];
  try {
    const request = context.request;
    const env = context.env || {};
    const url = new URL(request.url);

    /* CORS 预检：同源页面用不到，但本地调试与自定义域名场景会打过来 */
    if (request.method === 'OPTIONS') {
      const h = new Headers();
      safeSet(h, 'access-control-allow-methods', 'GET, POST, OPTIONS', notes);
      safeSet(h, 'access-control-allow-headers', 'content-type, x-sync-token, authorization', notes);
      safeSet(h, 'cache-control', 'no-store', notes);
      return new Response(null, { status: 204, headers: h });
    }

    /* 1) 模型列表：前端下拉从这里生成，以后加了新模型自动出现 */
    if (request.method === 'GET' && (url.searchParams.get('op') === 'models' || url.searchParams.get('op') === 'list')) {
      const list = MODELS.map(function (m) { return modelStatus(m, env); });
      return json({
        ok: true,
        models: list,
        scenes: Object.keys(SCENES).map(function (k) {
          return { id: k, label: SCENES[k].label, maxTokens: SCENES[k].max_tokens };
        }),
        defaults: { prefer: MODELS[0].id, fallback: MODELS[1] ? MODELS[1].id : MODELS[0].id },
        timeouts: { primaryMs: TIMEOUT_PRIMARY_MS, fallbackMs: TIMEOUT_FALLBACK_MS }
      }, 200, notes);
    }

    /* 2) 自检：谁配了、谁没配、谁能用。不回显任何密钥内容，只给长度 */
    if (url.searchParams.get('diag') === '1') {
      const out = {
        ok: true,
        diag: 'ai',
        aiBinding: {
          bound: !!(env && env.AI && typeof env.AI.run === 'function'),
          bindingName: 'AI',
          status: (env && env.AI && typeof env.AI.run === 'function') ? '✓ 已绑定' : '✗ 未绑定'
        },
        auth: {
          syncTokenConfigured: !!(env && env.SYNC_TOKEN),
          mode: (env && env.SYNC_TOKEN)
            ? '需要密钥：请求须带 x-sync-token 或 Authorization: Bearer'
            : '未设 SYNC_TOKEN → 不鉴权（与 webdav 一致）'
        },
        models: MODELS.map(function (m) {
          const st = modelStatus(m, env);
          st.keyLength = m.needsKey && env[m.envVar] ? String(env[m.envVar]).length : 0;
          return st;
        }),
        scenes: Object.keys(SCENES),
        timeouts: { primaryMs: TIMEOUT_PRIMARY_MS, fallbackMs: TIMEOUT_FALLBACK_MS },
        note: '密钥内容不会出现在任何响应里，这里只给长度'
      };

      /* &probe=1 → 逐个实测每一个模型，不是跑一次兜底链
         ------------------------------------------------------------------
         为什么要逐个跑：以前 probe 只跑 gateway 一次，
         主力失败后会被备用模型悄悄救回来，返回 200 + ok:true，
         看起来"一切正常"，实际主力从头到尾就是坏的。
         现在每个模型单独测，谁行谁不行一眼看清。

         &prompt=xxx 可以自定义探测词，默认用一个不带歧义的句子
         （历史上用 'ping' 当探测词，结果 8B 模型理解成网络 ping 命令，
           输出了丢包率/路由跳数，制造了一次假成功） */
      if (url.searchParams.get('probe') === '1') {
        const sceneId = url.searchParams.get('scene') || 'title';
        const probePrompt = url.searchParams.get('prompt') || '如何在 10 分钟内做出一份好吃的番茄炒蛋';
        const perModel = [];
        for (let i = 0; i < MODELS.length; i++) {
          const m = MODELS[i];
          const st = modelStatus(m, env);
          if (!st.available) {
            perModel.push({ id: m.id, name: m.name, provider: m.provider, ok: false, skipped: st.reason });
            continue;
          }
          const t0 = Date.now();
          const r = await gateway({
            scene: sceneId, prompt: probePrompt,
            prefer: m.id, fallback: null, trace: true,
            /* 只测这一个：关掉自动追加其他模型进行兜底 */
            only: true
          }, env, notes);
          const b = r.body || {};
          const tr = (b.debug && b.debug.trace) ? b.debug.trace[0] : null;
          perModel.push({
            id: m.id,
            name: m.name,
            provider: m.provider,
            tier: m.tier,
            quality: m.quality || 'good',
            ok: !!b.ok,
            ms: Date.now() - t0,
            text: b.ok ? echoOf(b.text, 200) : null,
            error: b.ok ? null : (b.detail || b.error || 'failed'),
            rawKeys: b.debug ? b.debug.rawKeys : null,
            estNeurons: b.estNeurons,
            attempts: tr ? tr.attempts : null
          });
        }
        out.probe = {
          scene: sceneId,
          promptEcho: echoOf(probePrompt, 300),
          models: perModel,
          totalMs: perModel.reduce(function (a, x) { return a + (x.ms || 0); }, 0),
          passCount: perModel.filter(function (x) { return x.ok; }).length,
          failCount: perModel.filter(function (x) { return !x.ok; }).length,
          note: '逐个实测结果。 ms 是每个模型自己的耗时； totalMs 是所有模型加起来的墙钟时间（串行测量，不代表线上一次调用的耗时）'
        };
      }
      return json(out, 200, notes);
    }

    /* 3) 鉴权（未设 SYNC_TOKEN 时直接放行，与 webdav 同规格） */
    const denied = checkAuth(request, env, notes);
    if (denied) return denied;

    /* 4) 只接受 POST */
    if (request.method !== 'POST') {
      return json({
        error: 'method not allowed',
        detail: 'AI 接口只接受 POST。',
        usage: 'POST /api/ai  body: { scene, prompt, prefer?, fallback? }',
        tip: '想看可用模型用 GET /api/ai?op=models，想自检用 GET /api/ai?diag=1'
      }, 405, notes);
    }

    /* 5) 解析请求体 */
    let payload = null;
    try {
      payload = await request.json();
    } catch (e) {
      return json({ error: 'invalid json', detail: '请求体不是合法 JSON。' }, 400, notes);
    }
    payload = payload || {};

    const prompt = String(payload.prompt || '').trim();
    if (!prompt) {
      return json({ error: 'missing prompt', detail: 'prompt 不能为空。' }, 400, notes);
    }
    const pb = byteLen(prompt);
    if (pb > MAX_INPUT_BYTES) {
      return json({
        error: 'prompt too long',
        detail: '输入太长了（' + pb + ' 字节），上限 ' + MAX_INPUT_BYTES + ' 字节。',
        fix: '删掉一部分再试。注意中文一个字算 3 字节。'
      }, 413, notes);
    }

    /* 6) 走网关 */
    const result = await gateway({
      scene: payload.scene || 'polish',
      prompt: prompt,
      prefer: payload.prefer,
      fallback: payload.fallback
    }, env, notes);

    const b = result.body || {};
    return json(b, result.status, notes, {
      'x-ai-provider': b.provider || 'none',
      'x-ai-model': b.model || '',
      'x-ai-degraded': b.degraded ? '1' : '0',
      'x-ai-scene': b.scene || ''
    });
  } catch (e) {
    /* 最后一道防线：任何漏网的异常都不允许变成裸 520 */
    return json({
      error: 'unhandled exception',
      detail: String((e && e.message) || e),
      info: errInfo(e)
    }, 500, notes);
  }
}

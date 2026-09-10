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
  },

  /* ---- 批次二新增：思维洞察 / 周期回顾 ------------------------------------
   ★ 全部是【新增项 + 新增可选字段】，上面 5 个老 scene 一行未改。
     新增字段语义（老 scene 没有这些字段时走默认分支，行为与原来完全一致）：
       maxInputChars  本 scene 的 per-scene 输入上限（字符数），超限「截断」而非报错
       maxTokensBy    按粒度覆盖 max_tokens（review 的日/周/月差别只在输出长度）
       allowUnrelated 输入是用户自己的零散记录，零共用词属正常，不该判 weak
       buildUser      scene 自己决定怎么拼 user message（对比数据用方括号分段）
     ------------------------------------------------------------------------ */
  insight: {
    label: '思维洞察',
    max_tokens: 2000,
    maxInputChars: 6000,          /* 约 2000 token，单次 ≈84 Neurons */
    allowUnrelated: true,         /* 见 checkQuality 的注释 */
    echoMax: 600,
    system: [
      '你是我的思维教练。我只给你我自己的真实记录，你要基于这些记录做分析。',
      '三条硬约束：',
      '① 只能引用记录里真实出现过的内容，禁止编造我没写过的事件、数字、人名。',
      '② 记录不足以支撑某个结论时，直接说"记录里看不出来"，不要硬凑。',
      '③ 这是"解读"不是"事实"，可以用"看起来""似乎""从这些记录推测"这类留有余地的措辞。',
      /* 心情统计段的处理写在最后一条，防止模型把统计数字演绎成情绪叙事 */
      '④ 如果输入里有【心情统计】段，那是按天汇总的数字，只把它当作背景事实使用；' +
      '不要逐个分析单个表情符号代表什么意思，不要编造某一天发生了什么。',
      '输出用 Markdown 分节，不要代码块围栏，不要开场白和客套话。'
    ].join('\n'),
    emptyReply: '选中的范围里还没有任何记录。先记点东西，我再帮你做洞察。'
  },

  review: {
    label: '周期回顾',
    max_tokens: 1200,             /* 默认（= 周） */
    maxTokensBy: { day: 800, week: 1200, month: 2000 },   /* 由 gran 参数挑选，见 gateway */
    maxInputChars: 8000,          /* 对比模式下要装两期数据，放得比方 insight 宽 */
    allowUnrelated: true,
    echoMax: 600,
    /* gran 的默认值与合法值。gateway 只做查表，非法值静默回落 week ——
       不报错是因为这只是输出长度档位，不值得为它打断用户的一次回顾。 */
    buildUser: function (opts) {
      var s = '';
      if (opts.compare) {
        s += '【本期 ' + opts.compare.curRange + '】\n' + opts.compare.cur + '\n\n';
        s += '【上期 ' + opts.compare.prevRange + '】\n' + opts.compare.prev + '\n\n';
        s += '任务：对比两期。先说变化（变好 / 变差 / 持平分别是什么），再说本期本身。';
      } else {
        s += '【本期】\n' + opts.prompt + '\n';
      }
      return s;
    },
    system: [
      '你是我的一对一回顾教练。我给你我自己的真实记录，你帮我复盘这段时间。',

      /* ── 证据规则。放在最前面：这一版的复盘事故全出在"输入为空却输出严厉人格批判"。
           与其事后靠 checkQuality 兜，不如把规则写成模型躲不开的第一段。 */
      '★★ 证据规则（最重要，违反即整段作废）：',
      '- 你写下的每一句判断，都必须能在输入里找到对应的原始记录。找不到依据的，就不许写。',
      '- 严禁使用这几类没有数据支撑的标签：拖延、执行力差、崩盘、失败率、自我感动、逃避、内耗、缺乏自律。',
      '  除非输入里出现了可数的具体事实（例：某任务顺延了 3 次），才可以写成"X 任务顺延了 3 次"这种可追溯的话。',
      '- 严禁发明心理机制。不许出现"反向心理反馈""错误的成就确认""潜意识里欺骗自己""自我许可"',
      '  "一旦天亮了就没动力"这类从输入里推不出来的解释。你看到什么就说什么，不要解释为什么。',
      '- 好的观察长这样："8月31日朗读自评 7 分，之后 9 月再没有新的练习记录"——有日期、有数据、可追溯。只写这种。',

      /* ── 心情只统计不解读 ── */
      '★★ 心情只统计，不解读：',
      '- 输入里的【心情统计】是按天汇总的数字，只当背景事实使用。',
      '- 严禁解读单个 emoji 的含义，严禁写"你感到轻松 / 焦虑 / 愉悦 / 懒散 / 疲惫"。',
      '- 要写就写数字："这段时间记录了 N 天，其中低落 X 天"。',

      /* ── 行动与想法分开（想法定性为"没做"，不许混进成果） ── */
      '★★ 做过的事 ≠ 想过的事：',
      '- 【做过的事】这一段只统计真实发生的行为：已完成的打卡、写下的笔记 / 摘抄 / 书评、',
      '  录入的体重、完成的练习。',
      '- 【想过的事】里的想法、感悟、闪念、灵感**不算做过的事**，一条都不许写进"做了什么"，',
      '  也不许据此说"针对 X 进行了深度复盘"——那只是想过。',

      /* ── 今天还没结束 ── */
      '★★ 今天还没结束：',
      '- 如果输入里注明"今天还没结束"，涉及今天的部分只能说"截至目前完成了 X 项"，',
      '  禁止计算完成率 / 执行率 / 失败率，禁止下"今天效率低 / 今天崩了"这类结论。',

      '输出结构（每段一个小标题）：',
      '① 做了什么 —— 只列【做过的事】里的真实行为，按主题归类，不要按日期流水账。输入里没有就写"这段时间没有可确认的行动记录"。',
      '② 想过什么（不是做过什么）—— 只有在【想过的事】非空时才写这一段，开头必须写明"以下是想法和感悟，不是已完成的行动"。',
      '③ 状态如何 —— 只基于打卡数据和心情的统计数字，说整体向上 / 持平 / 下滑。判断不了就直说"记录里看不出来"。',
      '④ 一个观察 —— 挑一件我可能没意识到的事，必须能追溯到具体日期的记录。只给一个，宁缺毋滥；',
      '   找不到就写"这次记录里没有看出明显的模式"，不要硬凑。',
      '⑤ 下一段的一条建议 —— 只要一条，具体到"什么时候做什么"，不要给清单。',

      '硬约束：',
      '- 记录数为 0 时，只回复"这段时间没有记录"，不要写其它任何内容。',
      '- 记录少于 3 条时，先说"这段时间记录不多，回顾会比较粗略"，再基于仅有的内容写，不硬凑篇幅。',
      '- 不要安慰，不要说"你已经很棒了"这类空话。做得不好可以直说，但必须指得出是哪条记录。',
      '- 输入里如果有【上期】段，说明我在做对比：必须明确指出变化（变好 / 变差 / 持平各是什么），不要只描述本期。'
    ].join('\n'),
    emptyReply: '这段时间没有记录。等记下几条之后再来生成回顾，会比空着分析靠谱得多。'
  }
};

/* ---------------------------------------------------------------------------
 * 二之二、思维框架注册表（批次二新增）
 * 思路与 MODELS / SCENES 一致：注册表 + 加一项不改任何逻辑。
 * 前端只传 id —— 防止前端传任意文本刷 Neurons；pass prompt 一律在后端拼。
 *
 * guard 只是语义标记，供前端决定要不要先弹免责声明；
 * ★ 真正的危机拦截已经脱离 guard，对所有 scene 无条件生效（见 detectCrisis 注释）。
 * ------------------------------------------------------------------------- */
const FRAMEWORKS = [
  {
    id: 'default',
    name: '默认洞察',
    desc: '找出反复出现的主题',
    guard: null,
    system: '通读这些记录，找出 2-3 个反复出现的主题。每个主题：' +
      '先用一句话说清是什么，再引用 2-3 条具体记录作为证据（注明日期），' +
      '最后给一句"这意味着什么"。如果记录里看不出重复主题，直接说明并挑出最值得聊的 1 条单独分析。'
  },
  {
    id: 'value',
    name: '价值澄清',
    desc: '反推你真正在乎什么',
    guard: null,
    system: '从这些记录反推：这个人真正在乎什么。' +
      '步骤：① 找出他主动花时间做的事（不是"应该做"而是"实际做了"的）；' +
      '② 找出他反复吐槽或纠结的点，反推背后被触犯的价值观；' +
      '③ 指出 1 处"声称在乎 vs 实际行动"不一致的地方，语气要温和，不要审判。' +
      '结尾给一个可以马上做的、5 分钟内的验证动作。'
  },
  {
    id: 'inverse',
    name: '逆向思考',
    desc: '什么会导致失败',
    guard: null,
    system: '用逆向思考（inversion）分析这些记录。' +
      '不要回答"怎么才能做好"，只回答"哪些做法一定会让事情搞砸"。' +
      '从记录里找出 3-5 个已经出现的失败信号（拖延、重复踩同一个坑、回避某件事等），' +
      '每条说明：信号是什么 → 它会导致什么 → 现在砍掉它还来得及吗。' +
      '语气要冷静克制，不要吓人。'
  },
  {
    id: 'second',
    name: '二阶思考',
    desc: '后果的后果',
    guard: null,
    system: '对记录里的 1-2 个重要决定或倾向做二阶思考。' +
      '一阶：这个做法直接带来什么（大部分人只想到这里）。' +
      '二阶：这个结果又会引发什么连锁反应？3 个月、1 年后分别会怎样？' +
      '三阶：到那时，哪些东西已经不可逆、无法轻易退回了？' +
      '最后明确说一句："现在还来得及调整的是哪一步"。'
  },
  {
    id: 'cbt',
    name: 'CBT 认知重构',
    desc: '识别自动思维，找替代解释',
    guard: 'mental',
    /* ★ 免责声明走后端确定性追加，不写在 prompt 里 —— 见 gateway 的 append 逻辑。
       理由：这是"少了会出事"的内容，不能指望模型每次都记得附。 */
    disclaimer: '---\n\n' +
      '⚠️ 本内容由 AI 基于你的记录生成，是思维练习，**不能替代专业心理咨询或医疗建议**。\n' +
      '如果你正经历持续的情绪困扰，建议寻求专业帮助：全国心理援助热线 **12356**（24 小时）。',
    /* prompt 层管上限（正文里不要出现诊断性结论），append 层管下限（结尾一定有声明）。两层并存。 */
    /* ★ 上一版的问题：见句子就当认知扭曲，把"原来卡住我的从来不是难度，是一直没开始"
       这种健康的自我觉察也判成扭曲。CBT 的前提是"先筛选再重构"，不是"先定罪再找理由"。 */
    system: '用认知行为疗法（CBT）的框架帮我梳理这些记录里的想法。' +

      '★★ 先筛选，再重构 —— 不要见句子就当扭曲：' +
      '只有【痛苦的】【自我贬低的】【灾难化的】【非黑即白的】想法才需要重构。' +
      '遇到下面这几类，明确写一句"这句是健康的自我觉察 / 有效的应对，无明显认知扭曲"，然后到此为止，' +
      '不要硬给它安一个扭曲类型：' +
      '· 客观指出自己的卡点并且已经想明白怎么办（例："卡住我的从来不是难度，是一直没开始"）；' +
      '· 正常的生活感受（累、忙、开心、不想动）；' +
      '· 已经在起作用的应对策略（把任务拆小、先做 5 分钟、降低门槛）。' +
      '找不出 2-3 个真正需要重构的思维，就只写找到的那 1 个 —— 宁可只写一条，' +
      '也不许为了凑够条目把健康的话病理化。' +

      '结构：' +
      '① 需要重构的想法（1-3 条，每条四小步）：原样引用记录里的话 → 它带来什么痛苦 → ' +
      '属于哪类扭曲（只在这一步才命名，如灾难化 / 非黑即白 / 读心术 / 以偏概全）→ 更符合证据的替代想法；' +
      '② 健康的自我觉察（如果记录里有）—— 原样引用并明确标注"无需重构"，说明它为什么是有效的；' +
      '③ 一个可以做的小行动。' +

      '⚠️ 严禁：不得给出任何诊断性结论（不得说"你有 XX 症/障碍/倾向"）；' +
      '不得建议停药、减药或改变任何治疗方案；' +
      '不得使用"你应该""你必须"这类命令式措辞；' +
      '不得把中性的自我描述解读成防御机制、潜意识动机或人格缺陷。'
  },
  {
    id: 'mbti',
    name: 'MBTI 性格速写',
    desc: '娱乐性质的倾向速写',
    guard: 'fun',
    disclaimer: '---\n\n' +
      '⚠️ 这只是**娱乐性质的速写**，不是心理测评。MBTI 在心理学界的信效度本身存在争议，' +
      '而这里的依据只是你随手记的有限几条记录，样本既不完整也不具代表性。' +
      '别把它当标签贴在自己或别人身上。',
    /* 上一版的问题：四个维度全是正向好话，读起来像星座运势，没有信息量。
       真正的速写要有张力 —— 每个倾向都有代价，并且能指出行为之间互相打架的地方。 */
    system: '基于这些记录，画一张"性格速写"。' +
      '四个维度各给一段：E/I（能量来源）、S/N（信息偏好）、T/F（决策依据）、J/P（组织方式）。' +
      '⚠️ 措辞硬约束：' +
      '① 标题和正文里必须出现"速写"二字，不得说"测出你的类型是 XXXX"；' +
      '② 每个维度只描述倾向（"看起来更偏向…"），不得下确定判断，不得给百分比；' +
      '③ ★ 每个维度不许只写正向描述，必须带一句这个倾向的代价或反面（"这样…但代价是…"）。' +
      '   四个维度全是好话的速写没有信息量，那是夸奖不是分析；' +
      '④ ★ 必须额外指出至少一处内在矛盾：记录里互相打架的地方' +
      '（例："既追求极简，又制定了很复杂的时间块规则"；"既说不在乎评价，又反复记录别人的反馈"）。' +
      '   找不到就明确写"这批记录里没看出明显的内在矛盾"，不许硬编一个。'
  }
];

/* id → 对象，运行时查一次（避免每次请求都跑一遍 find） */
const FW_BY_ID = FRAMEWORKS.reduce(function (a, f) { a[f.id] = f; return a; }, {});

/* ---------------------------------------------------------------------------
 * 二之三、危机干预（批次二新增）
 * ---------------------------------------------------------------------------
 * 三道防线里的第三道 —— 也是唯一无法被绕过的一道。
 * 第一、二道都在前端（界面免责声明 / 关键词短路），前端可以被 curl 绕过；
 * 这道在后端，无论谁用什么方式调接口，只要内容命中就拦。
 *
 * ★ 三条设计原则：
 *   ① 用确定性正则，绝不交给 AI 判断 —— 模型有概率把危机表述当普通情绪去分析；
 *   ② 宁可误报，不可漏报 —— 误报的代价是"这次没分析成"，漏报的代价不可接受；
 *   ③ 无条件生效 —— 不看 scene、不看 framework，哪怕是摘抄名言写下的句子也拦。
 *      （用户明确要求：危机检测绝不能"在某些开关下自动消失"。）
 */
const CRISIS_PATTERNS = [
  /不想活|不想活了|活不下去了|活着没意[思义]|活著沒意[思義]/,
  /轻生|輕生|自杀|自殺|想死|去死/,
  /结束一切|結束一切|了结自己|了結自己|结束生命|結束生命/,
  /伤害自己|傷害自己|自残|自殘|割腕|吞药|吞藥/,
  /消失算了|人间蒸发|离开这个世界|離開這個世界|永别|永別/,
  /* ★ 跨行匹配：正则的 . 默认不匹配换行，写成 /没有我.*会更好/ 的话，
     "没有我\n大家会更好" 这种跨行表述会漏掉 —— 必须显式用 [\s\S]* 包含换行符。 */
  /没有我[\s\S]*会更好|沒有我[\s\S]*會更好|少我一个|少我一個/,
  /* 下面两条是实测补的（批次二验证脚本抓到的漏检）：
     "把这一切都结束掉" 匹配不到"结束一切"，"想划自己" 也匹配不到"自残/割腕"。
     ★ 收窄而不是放开：单独匹配「了断/了结」会把"和过去做个了断""把这件事了结"
       这种完全正常的表达也拦下来 —— 误报一次，用户就不会再信这个入口。
       所以要求"把 … 自己/一切/生命/人生 … 结束"的自指结构，精确度和召回都要。 */
  /把[\s\S]{0,8}(?:自己|一切|生命|人生)[\s\S]{0,4}(?:结束|結束|了断|了斷|了结|了結)/,
  /划自己|劃自己|划手|劃手|割手|割自己|割脉|劃脈|割脈/
];

const CRISIS_REPLY = [
  '我看到你现在很不好受。这些话我不会去分析 —— 有些时刻，需要的不是分析，是有人在。',
  '',
  '**如果你现在需要有人说话，请打给这些电话，24 小时都有人接：**',
  '',
  '- 全国心理援助热线：**12356**',
  '- 北京心理危机研究与干预中心：**010-82951332**',
  '- 希望 24 热线：**400-161-9995**',
  '',
  '如果你身边有信任的人，现在就联系他们，不用说理由。',
  '如果你觉得马上会伤害自己，请立刻拨打 120 或去最近的急诊。',
  '',
  '这些记录我会一直留着，等你好了再回来看。'
].join('\n');

/* 确定性判定：命中任一条即 true。没有任何"让模型再看看"的分支。 */
function detectCrisis(text) {
  const t = String(text || '');
  if (!t) return false;
  for (let i = 0; i < CRISIS_PATTERNS.length; i++) {
    if (CRISIS_PATTERNS[i].test(t)) return true;
  }
  return false;
}

/* --- 拼装发给模型的 messages ---------------------------------------------
 * 不能把用户原文裸着扔给模型：裸文本歧义极大。
 * 实测案例：probe 用 "ping" 做 prompt，8B 模型直接理解成网络 ping 命令，
 * 输出了"IP地址/丢包率/路由跳数"这种答非所问的内容。
 * 所以统一用「任务声明 + 定界符包裹的原文」两层结构，
 * promptEcho 回显的也是拼装后的最终文本，方便判断是 prompt 没写对还是模型太弱。 */
function buildMessages(scene, prompt, opts) {
  /* 批次二：scene 可以用 buildUser 自己拼 user message（对比数据要分段、不能用 """ 包裹，
     因为输出里出现三引号会触发 checkQuality 的 leaked prompt wrapper 拦截）。
     老 scene 没有 buildUser，走原来这条路径 —— 行为一字不变。 */
  const userText = scene.buildUser
    ? scene.buildUser(opts || { prompt: prompt })
    : '任务：' + scene.label + '\n\n' +
      '待处理内容：\n"""\n' + prompt + '\n"""\n\n' +
      '请只输出任务结果本身。不要复述上面的任务说明，不要写"好的"、"以下是"这类开场白，不要解释你的做法。';
  return [
    { role: 'system', content: scene.system },
    { role: 'user', content: userText }
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
    /* 批次二：insight / review 的输入是用户自己的零散记录，输出必然会换一套说法，
       零共用词属于正常现象。这类 scene 标记 allowUnrelated 后直接判 good，
       不然每次洞察都会被标 weak，反倒让这个标记失去意义。 */
    if (scene && scene.allowUnrelated) {
      return { ok: true, reason: 'ok (allowUnrelated)', level: 'soft', quality: 'good', text: text, related: 0 };
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

  /* ==== 批次二：危机干预（无条件，必须排在所有业务逻辑之前） ==============
     ★ 不看 scene、不看 framework、不问前端有没有做过短路 —— 只看内容。
       放在模型调用之前还有个好处：命中时一个 token 都不消耗，零延迟返回。
     ★ 返回 200 + ok:true + crisis:true 而不是 400：前端现有逻辑对 4xx/!ok
       会弹「AI 暂时不可用」，那对一个刚写下这类话的人是最糟糕的结果。 */
  if (detectCrisis(opts.prompt)) {
    if (notes) notes.push('crisis: 命中危机词表，未调用模型');
    return {
      ok: true, status: 200,
      body: {
        ok: true,
        text: CRISIS_REPLY,
        crisis: true,                 /* 前端据此渲染援助卡片，不显示"AI 生成"、不给重试按钮 */
        model: null, modelName: null, provider: null,
        scene: opts.scene,
        sceneLabel: scene.label,
        maxTokens: 0,
        degraded: false,
        attempts: [],
        usage: null,
        estNeurons: 0,                /* 没调模型，零消耗 */
        ms: 0, totalMs: 0,
        quality: 'good',
        /* 没发过任何请求，就没有 promptEcho 可回显 —— 这里给一个最小自解释对象，
           免得前端 / probe 读到 undefined 再到处判空。 */
        debug: { scene: opts.scene, sceneLabel: scene.label, crisis: true, sentToModel: false }
      }
    };
  }

  /* ==== 空输入确定性短路 ==================================================
     ★ 这一版事故：输入为空，模型照样输出"极高的执行失败率""严重的拖延倾向"。
       "有没有数据"是确定性事实，不该交给模型判断 —— 它只会把"没有记录"读成
       "记录里全是失败"。这里直接返回固定文案，一次模型都不调。
     触发条件二选一：前端明确传了 count=0，或者 prompt 本身就是空的。
     老 scene（title/polish/...）不传 count，前端那边也已经挡过空输入，不受影响。 */
  const countNum = (opts.count === undefined || opts.count === null || opts.count === '')
    ? null : Number(opts.count);
  if (!String(opts.prompt || '').trim() || countNum === 0) {
    if (notes) notes.push('empty input: 未调用模型，直接返回占位文案');
    const emptyText = scene.emptyReply ||
      '这段时间没有记录，先记下几条再来生成，会比空着分析靠谱得多。';
    return {
      ok: true, status: 200,
      body: {
        ok: true,
        text: emptyText,
        empty: true,                  /* 前端据此不显示"存为备忘 / 复制"这类操作 */
        crisis: false,
        model: null, modelName: null, provider: null,
        scene: opts.scene,
        sceneLabel: scene.label,
        maxTokens: 0,
        degraded: false,
        attempts: [],
        usage: null,
        estNeurons: 0,
        ms: 0, totalMs: 0,
        quality: 'good',
        debug: { scene: opts.scene, sceneLabel: scene.label, empty: true, sentToModel: false }
      }
    };
  }

  /* ==== 批次二：per-scene 输入上限 ========================================
     与全局 MAX_INPUT_BYTES 是两回事、也不可互相替代：
       全局  40000 字节 —— 兜底防滥用，超限返回 413（在最外层，这里够不着）
       scene maxInputChars —— 控成本，超限「截断」而不是报错
     为什么局部要截断而非报错：用户点了"生成洞察"，结果因为记太多被拒，
     体验远不如"用前 6000 字生成"。截断还会在 notes 里留痕，便于事后发现。 */
  let truncated = false;
  if (scene.maxInputChars && opts.prompt && opts.prompt.length > scene.maxInputChars) {
    if (notes) notes.push('ai input truncated: ' + opts.prompt.length + ' → ' + scene.maxInputChars + ' 字符');
    opts.prompt = opts.prompt.slice(0, scene.maxInputChars);
    truncated = true;
  }

  /* ==== 批次二：思维框架（只有 insight 用得上） =========================== */
  let fw = null;
  if (opts.scene === 'insight') {
    if (!opts.framework) {
      fw = FW_BY_ID['default'];       /* 不传就用默认洞察，不报错 —— 少一次往返 */
    } else {
      fw = FW_BY_ID[String(opts.framework)] || null;
      if (!fw) {
        return {
          ok: false, status: 400,
          body: {
            error: 'unknown framework',
            detail: '思维框架「' + String(opts.framework) + '」不存在。',
            supported: FRAMEWORKS.map(function (f) { return f.id; })
          }
        };
      }
    }
  }

  /* ==== 批次二：按粒度覆盖输出上限（review 专用） ==========================
     gran 只影响输出长度档位，非法值静默回落 week —— 不值得为它打断一次回顾。 */
  let scenemaxTokens = scene.max_tokens;
  if (scene.maxTokensBy) {
    const gran = String(opts.gran || 'week');
    scenemaxTokens = scene.maxTokensBy[gran] || scene.max_tokens;
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

  /* 批次二：insight 要把选中的框架规则拼进 system —— 这是唯一一处 system 会被改写的地方。
     拼接方式固定为「框架规则 + 空行 + scene 通用规则」，老 scene 不进这个分支。 */
  const systemText = fw
    ? fw.system + '\n\n下面是通用输出要求：\n' + scene.system
    : scene.system;
  const messages = buildMessages(scene, opts.prompt, opts);
  if (fw) messages[0] = { role: 'system', content: systemText };

  /* promptEcho：把真正发出去的那段 user 文本回显（截断）。
     排查"输出是垃圾"时第一件事就是看这个 ——
     是 prompt 写得有歧义，还是模型太弱，看一眼就分得清。 */
  const echo = {
    scene: opts.scene,
    sceneLabel: scene.label,
    framework: fw ? fw.id : null,
    systemPrompt: echoOf(systemText, 200),
    userMessage: echoOf(messages[1].content, scene.echoMax || 600),
    maxTokens: scenemaxTokens,
    userMessageLength: messages[1].content.length,
    /* 批次二：这两个字段只有被触发时才出现，老 scene 的 echo 结构保持不变 */
    gran: scene.maxTokensBy ? String(opts.gran || 'week') : undefined,
    truncated: truncated || undefined
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
      const out = await adapter(m, messages, scenemaxTokens, env, budget, notes);
      if (out.debug) debugTrace.push({ id: m.id, provider: m.provider, rawKeys: out.debug.attempts && out.debug.attempts.length ? out.debug.attempts[out.debug.attempts.length - 1].keys : null, attempts: out.debug.attempts });

      if (!out.text) {
        attempts.push({ id: m.id, provider: m.provider, ok: false, ms: Date.now() - t0, error: 'empty response', rawKeys: out.rawKeys, reasonChars: out.reasonChars });
        continue;                            /* 空结果也算失败，换下一个 */
      }

      /* ★ 非空不等于可用。以前这里只判 !out.text，
         结果 8B 模型返回 ping 诊断文本也照样算成功。
         批次二：第 4 个参数传实际发出去的 systemText（含框架规则），
         否则"复读 system"检测拿视图错的参照系。 */
      const q = checkQuality(scene, opts.prompt, out.text, systemText);
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

      /* ==== 批次二：免责声明「确定性追加」 ================================
         ★ 位置很关键：必须在 checkQuality 之后。
           放在之前的话，声明里的措辞（"不能替代专业心理咨询"）与 system 里的严禁条款
           高度重合，会抬高 2-gram 重叠率 → 触发 echoed system prompt 误判 →
           每次 CBT / MBTI 都白白换模型重试一遍。
         ★ 为什么要追加而不是让模型自己写：
           prompt 层管上限（正文别出诊断结论），追加层管下限（结尾一定有声明）。
           模型偶尔忘写时，追加层补上；多写一句也无害。
           反过来说 —— 这是"少了会出事"的内容，不能交给概率。 */
      let outText = q.text;
      if (fw && fw.disclaimer) {
        outText = String(outText).replace(/\s+$/, '') + '\n\n' + fw.disclaimer;
        if (notes) notes.push('ai disclaimer appended: ' + fw.id);
      }

      const usage = out.usage;
      return {
        ok: true,
        status: 200,
        body: {
          ok: true,
          text: outText,
          model: m.id,
          modelName: m.name,
          provider: m.provider,
          scene: opts.scene,
          sceneLabel: scene.label,
          /* 批次二新增字段。老 scene 这里是 null / false，前端已有逻辑不读就不显示 */
          framework: fw ? fw.id : null,
          disclaimer: !!(fw && fw.disclaimer),   /* true = 本次输出尾部已附免责声明 */
          gran: scene.maxTokensBy ? String(opts.gran || 'week') : null,
          truncated: truncated,                  /* true = 输入被 per-scene 上限截过 */
          maxTokens: scenemaxTokens,
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
        /* 批次二：思维框架随 scenes 一起下发，前端的选择按钮遍历这份列表自动生成。
           ★ 只返回 id/name/desc/guard —— 不返回 system（prompt 资产，没必要暴露），
             也不返回 disclaimer（前端进 CBT 界面时本来就要自己先显示一遍）。 */
        frameworks: FRAMEWORKS.map(function (f) {
          return { id: f.id, name: f.name, desc: f.desc, guard: f.guard || null };
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
    /* 批次二修正：前端明确传 count=0（真的没数据）时不算"参数缺失"，
       放行给网关去返回固定的空数据文案 —— 空的输入交给模型，它只会编出人格批判。
       老 scene 不传 count，仍然按原契约返回 400 missing prompt。 */
    const zeroCount = (payload.count === 0 || payload.count === '0');
    if (!prompt && !zeroCount) {
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
      fallback: payload.fallback,
      /* 批次二：新增的四个可选字段。老请求不带它们（= undefined），
         网关里对应的新分支会全部跳过 —— 现有 5 个 scene 的行为不受影响。 */
      framework: payload.framework,
      gran: payload.gran,
      compare: payload.compare,
      count: payload.count
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

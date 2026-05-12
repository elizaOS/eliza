---
title: 插件设置指南
description: Eliza 连接器、AI 提供者和直播推流插件的完整设置说明。
---

<div id="plugin-setup-guide--eliza-ai">

# 插件设置指南 — Eliza AI
</div>

所有连接器、AI 提供者和直播推流插件的完整设置说明。
当用户询问如何设置插件时，请使用本指南：提供确切的环境变量名称、
获取凭据的位置、最少必填字段以及可选字段的提示。

---

<div id="ai-providers">

## AI 提供者
</div>

<div id="openai">

### OpenAI
</div>

**获取凭据：** https://platform.openai.com/api-keys
**最少必填：** `OPENAI_API_KEY`（以 `sk-` 开头）
**变量：**
- `OPENAI_API_KEY` — 来自 platform.openai.com 的密钥
- `OPENAI_BASE_URL` — 使用 OpenAI 默认值时留空；使用自定义端点时设置为代理 URL
- `OPENAI_SMALL_MODEL` — 例如 `gpt-5-mini`（用于快速/低成本任务）
- `OPENAI_LARGE_MODEL` — 例如 `gpt-4o`（用于复杂推理）
- `OPENAI_EMBEDDING_MODEL` — 例如 `text-embedding-3-small`（用于语义搜索）
- `OPENAI_TTS_MODEL` / `OPENAI_TTS_VOICE` — 例如 `tts-1` / `alloy`（用于语音合成）
- `OPENAI_IMAGE_DESCRIPTION_MODEL` — 例如 `gpt-4o`（用于图像理解）
**提示：** OpenAI 是大多数功能的默认回退方案。如果您有额度，请优先设置此项。使用 `gpt-5-mini` 作为小模型可节省成本。

<div id="anthropic">

### Anthropic
</div>

**获取凭据：** https://console.anthropic.com/settings/keys
**最少必填：** `ANTHROPIC_API_KEY`（以 `sk-ant-` 开头）或 `CLAUDE_API_KEY`
**变量：**
- `ANTHROPIC_API_KEY` / `CLAUDE_API_KEY` — 来自 console.anthropic.com 的密钥（两者均可自动启用）
- `ANTHROPIC_SMALL_MODEL` — 例如 `claude-haiku-4-5-20251001`
- `ANTHROPIC_LARGE_MODEL` — 例如 `claude-sonnet-4-6`
- `ANTHROPIC_BROWSER_BASE_URL` — （高级）浏览器端请求的代理 URL
**提示：** 最适合复杂推理和长上下文任务。Claude Haiku 作为小模型速度非常快。

<div id="google-gemini">

### Google Gemini
</div>

**获取凭据：** https://aistudio.google.com/app/apikey
**最少必填：** `GOOGLE_GENERATIVE_AI_API_KEY` 或 `GOOGLE_API_KEY`
**变量：**
- `GOOGLE_GENERATIVE_AI_API_KEY` / `GOOGLE_API_KEY` — 来自 AI Studio 或 Google Cloud（两者均可自动启用）
- `GOOGLE_SMALL_MODEL` — 例如 `gemini-2.0-flash`
- `GOOGLE_LARGE_MODEL` — 例如 `gemini-2.0-pro`
- `GOOGLE_EMBEDDING_MODEL` — 例如 `text-embedding-004`
- `GOOGLE_IMAGE_MODEL` — 例如 `imagen-3.0-generate-002`
**提示：** Gemini Flash 速度快且价格低；非常适合作为小模型使用。免费额度非常慷慨。

<div id="groq">

### Groq
</div>

**获取凭据：** https://console.groq.com/keys
**最少必填：** `GROQ_API_KEY`
**变量：**
- `GROQ_API_KEY` — 来自 console.groq.com
- `GROQ_SMALL_MODEL` — 例如 `openai/gpt-oss-120b`
- `GROQ_LARGE_MODEL` — 例如 `openai/gpt-oss-120b`
- `GROQ_TTS_MODEL` / `GROQ_TTS_VOICE` — 例如 `playai-tts` / `Fritz-PlayAI`
**提示：** Groq 推理速度极快——非常适合对延迟敏感的场景。有免费额度。通过 PlayAI 语音支持 TTS。

<div id="openrouter">

### OpenRouter
</div>

**获取凭据：** https://openrouter.ai/keys
**最少必填：** `OPENROUTER_API_KEY`
**变量：**
- `OPENROUTER_API_KEY` — 来自 openrouter.ai/keys
- `OPENROUTER_SMALL_MODEL` — 例如 `openai/gpt-5-mini` 或 `openai/gpt-oss-120b`
- `OPENROUTER_LARGE_MODEL` — 例如 `anthropic/claude-sonnet-4-6`
- `OPENROUTER_IMAGE_MODEL` — 例如 `openai/gpt-4o`（用于视觉任务）
- `OPENROUTER_IMAGE_GENERATION_MODEL` — 例如 `openai/dall-e-3`
- `OPENROUTER_EMBEDDING_MODEL` — 例如 `openai/text-embedding-3-small`
- `OPENROUTER_TOOL_EXECUTION_MAX_STEPS` — 每轮最大工具调用步数（默认：5）
**提示：** OpenRouter 让您通过一个 API 密钥访问 200 多个模型。如果您想在不管理多个账户的情况下切换模型，非常方便。使用 `provider/model-name` 格式的模型 ID。

<div id="xai-grok">

### xAI (Grok)
</div>

**获取凭据：** https://console.x.ai/
**最少必填：** `XAI_API_KEY` 或 `GROK_API_KEY`
**变量：**
- `XAI_API_KEY` / `GROK_API_KEY` — 来自 console.x.ai（两者均可自动启用）
- `XAI_MODEL` — 例如 `grok-2-1212`（覆盖 small/large）
- `XAI_SMALL_MODEL` / `XAI_LARGE_MODEL` — 特定模型槽位
- `XAI_EMBEDDING_MODEL` — 例如 `v1`
- `X_AUTH_MODE` — `api_key`（默认）或 `oauth`
- `X_API_KEY`、`X_API_SECRET`、`X_ACCESS_TOKEN`、`X_ACCESS_TOKEN_SECRET` — Twitter OAuth 密钥（用于 xAI 的 X 连接器部分）
- `X_ENABLE_POST`、`X_ENABLE_REPLIES`、`X_ENABLE_ACTIONS` — 切换 X/Twitter 行为
**提示：** xAI = Grok 模型。`X_*` 变量用于与 xAI 捆绑的 Twitter 集成。除非需要 OAuth，否则保持认证模式为 `api_key`。

<div id="ollama-local-models">

### Ollama（本地模型）
</div>

**获取凭据：** 无需 API 密钥——在本地安装 Ollama
**设置：** https://ollama.com — 运行 `ollama create eliza-1-9b -f packages/training/cloud/ollama/Modelfile.eliza-1-9b-q4_k_m` 下载模型
**最少必填：** `OLLAMA_BASE_URL` = `http://localhost:11434`（自动启用触发器）或 `OLLAMA_API_ENDPOINT` = `http://localhost:11434/api`
**变量：**
- `OLLAMA_BASE_URL` — 自动启用触发器。默认：`http://localhost:11434`
- `OLLAMA_API_ENDPOINT` — 插件端点。默认：`http://localhost:11434/api`
- `OLLAMA_SMALL_MODEL` — 例如 `eliza-1-2b`
- `OLLAMA_MEDIUM_MODEL` — 例如 `eliza-1-9b`
- `OLLAMA_LARGE_MODEL` — 例如 `eliza-1-9b`
- `OLLAMA_EMBEDDING_MODEL` — 例如 `nomic-embed-text`
**提示：** 完全免费且私密。需要在您的机器或服务器上运行 Ollama。使用 `ollama pull <model>` 拉取模型。嵌入模型建议使用 `nomic-embed-text`。

<div id="local-ai">

### Local AI
</div>

**获取凭据：** 无需 API 密钥——使用本地模型文件
**变量：**
- `MODELS_DIR` — 本地模型文件路径（例如 `/Users/you/models`）
- `CACHE_DIR` — 缓存路径（例如 `/tmp/ai-cache`）
- `LOCAL_SMALL_MODEL` / `LOCAL_LARGE_MODEL` — MODELS_DIR 中的模型文件名
- `LOCAL_EMBEDDING_MODEL` / `LOCAL_EMBEDDING_DIMENSIONS` — 嵌入模型及其维度数
- `CUDA_VISIBLE_DEVICES` — GPU 选择，例如 `0` 表示第一个 GPU
**提示：** 当您拥有 .gguf 或类似模型文件并希望完全离线运行时使用。

<div id="vercel-ai-gateway">

### Vercel AI Gateway
</div>

**获取凭据：** https://vercel.com/docs/ai/ai-gateway
**最少必填：** `AI_GATEWAY_API_KEY` 和 `AI_GATEWAY_BASE_URL`
**变量：**
- `AI_GATEWAY_API_KEY` / `AIGATEWAY_API_KEY` — 您的网关密钥（两者均可）
- `VERCEL_OIDC_TOKEN` — 仅用于 Vercel 托管部署
- `AI_GATEWAY_BASE_URL` — 您的网关端点 URL
- `AI_GATEWAY_SMALL_MODEL` / `AI_GATEWAY_LARGE_MODEL` / `AI_GATEWAY_EMBEDDING_MODEL` — 模型 ID
- `AI_GATEWAY_IMAGE_MODEL` — 用于图像生成
- `AI_GATEWAY_TIMEOUT_MS` — 请求超时时间，默认 30000ms
**提示：** 通过 Vercel 的 AI 网关路由模型调用，实现缓存、速率限制和可观测性。如果您已在使用 Vercel，非常有用。

<div id="eliza-cloud">

### Eliza Cloud
</div>

**获取凭据：** 来自 elizaOS Cloud 服务
**最少必填：** `ELIZAOS_CLOUD_API_KEY` 或 `ELIZAOS_CLOUD_ENABLED=true`
**变量：**
- `ELIZAOS_CLOUD_API_KEY` — 您的 Eliza Cloud API 密钥
- `ELIZAOS_CLOUD_ENABLED` — 设置为 `true` 以启用云功能
**提示：** Eliza Cloud 提供用于运行 Eliza 代理的托管基础设施，具备托管扩展和监控功能。

---

<div id="connectors">

## 连接器
</div>

<div id="discord">

### Discord
</div>

**获取凭据：** https://discord.com/developers/applications → 新建应用 → Bot → 重置令牌
**最少必填：** `DISCORD_API_TOKEN` + `DISCORD_APPLICATION_ID`
**变量：**
- `DISCORD_API_TOKEN` — Bot 令牌（在 Bot 部分，点击"重置令牌"）
- `DISCORD_APPLICATION_ID` — 应用 ID（在"常规信息"中）
- `CHANNEL_IDS` — 逗号分隔的频道 ID
- `DISCORD_VOICE_CHANNEL_ID` — 用于语音频道支持
- `DISCORD_SHOULD_IGNORE_BOT_MESSAGES` — `true` 以防止机器人之间的循环对话
- `DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES` — `true` 以禁用私信回复
- `DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS` — `true` 以仅在被 @提及时回复
- `DISCORD_LISTEN_CHANNEL_IDS` — 仅监听但不主动发言的频道 ID
**设置步骤：**
1. 在 discord.com/developers/applications 创建应用
2. 转到 Bot 标签 → 重置令牌（立即复制）
3. 从"常规信息"标签获取应用 ID
4. 在 OAuth2 → URL Generator → Bot → 选择权限：发送消息、读取消息、使用斜杠命令
5. 使用生成的 URL 邀请机器人
6. 在 Bot → 特权网关意图 下启用"消息内容意图"
**提示：** 您需要 Bot 令牌和应用 ID——没有应用 ID 斜杠命令将无法注册。右键点击频道并选择"复制 ID"来获取频道 ID（需先在 Discord 设置中启用开发者模式）。

<div id="telegram">

### Telegram
</div>

**获取凭据：** 在 Telegram 上给 @BotFather 发消息
**最少必填：** `TELEGRAM_BOT_TOKEN`
**变量：**
- `TELEGRAM_BOT_TOKEN` — 执行 `/newbot` 后从 @BotFather 获取
- `TELEGRAM_ALLOWED_CHATS` — 允许的聊天 ID 的 JSON 数组，例如 `["123456789", "-100987654321"]`
- `TELEGRAM_API_ROOT` — 使用默认值时留空；使用 Telegram 代理时设置
- `TELEGRAM_TEST_CHAT_ID` — 用于测试（高级）
**设置步骤：**
1. 给 @BotFather 发消息：`/newbot`
2. 为其指定名称和用户名
3. 复制它给您的令牌
4. 获取您的聊天 ID：给 @userinfobot 发消息
**提示：** 群组使用负数 ID（以 -100 开头）。使用 `TELEGRAM_ALLOWED_CHATS` 限制谁可以与机器人对话，以确保安全。

<div id="twitter--x">

### Twitter / X
</div>

**获取凭据：** https://developer.twitter.com/en/portal/dashboard
**最少必填：** 全部 4 个 OAuth 密钥：`TWITTER_API_KEY`、`TWITTER_API_SECRET_KEY`、`TWITTER_ACCESS_TOKEN`、`TWITTER_ACCESS_TOKEN_SECRET`
**变量：**
- `TWITTER_API_KEY` — Consumer API Key
- `TWITTER_API_SECRET_KEY` — Consumer API Secret
- `TWITTER_ACCESS_TOKEN` — Access Token（在"密钥和令牌"标签中）
- `TWITTER_ACCESS_TOKEN_SECRET` — Access Token Secret
- `TWITTER_DRY_RUN` — `true` 表示测试但不实际发布
- `TWITTER_POST_ENABLE` — `true` 表示启用自主发帖
- `TWITTER_POST_INTERVAL_MIN` / `TWITTER_POST_INTERVAL_MAX` — 发帖间隔分钟数（例如 90/180）
- `TWITTER_POST_IMMEDIATELY` — `true` 表示启动时立即发帖
- `TWITTER_AUTO_RESPOND_MENTIONS` — `true` 表示回复 @提及
- `TWITTER_POLL_INTERVAL` — 检查提及的间隔秒数（例如 120）
- `TWITTER_SEARCH_ENABLE` / `TWITTER_ENABLE_TIMELINE` / `TWITTER_ENABLE_DISCOVERY` — 高级互动模式
**设置步骤：**
1. 在 developer.twitter.com 申请开发者账户（基础版可即时获批）
2. 创建一个项目和应用
3. 从"密钥和令牌"标签生成全部 4 个密钥
4. 将应用权限设置为读写
5. 设置权限后重新生成令牌
**提示：** 先使用 `TWITTER_DRY_RUN=true` 进行验证而不实际发帖。免费 API 层级每月有 500 条发帖限额。您需要全部 4 个 OAuth 密钥——缺少任何一个都会导致认证失败。

<div id="slack">

### Slack
</div>

**获取凭据：** https://api.slack.com/apps → 创建新应用
**最少必填：** `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`
**变量：**
- `SLACK_BOT_TOKEN` — 以 `xoxb-` 开头（在 OAuth & Permissions → Bot Token 中获取）
- `SLACK_APP_TOKEN` — 以 `xapp-` 开头（在 Basic Information → App-Level Tokens 中获取；scope：`connections:write`）
- `SLACK_SIGNING_SECRET` — 在 Basic Information 中（用于 webhook 验证）
- `SLACK_USER_TOKEN` — 以 `xoxp-` 开头（可选，用于用户级操作）
- `SLACK_CHANNEL_IDS` — 逗号分隔的频道 ID，例如 `C01ABCDEF,C02GHIJKL`
- `SLACK_SHOULD_IGNORE_BOT_MESSAGES` — 防止机器人循环
- `SLACK_SHOULD_RESPOND_ONLY_TO_MENTIONS` — 仅在 @提及时回复
**设置步骤：**
1. 在 api.slack.com/apps 创建应用（从头开始 → 选择工作区）
2. Socket Mode：启用 Socket Mode → 生成具有 `connections:write` scope 的 App-Level Token
3. Bot Token Scopes（OAuth & Permissions）：`chat:write`、`channels:read`、`channels:history`、`groups:history`、`im:history`、`app_mentions:read`
4. 将应用安装到工作区 → 复制 Bot Token
5. 启用 Event Subscriptions → 订阅 bot 事件：`message.channels`、`message.im`、`app_mention`
**提示：** Socket Mode 意味着您不需要公共 webhook URL。Bot Token（xoxb-）和 App Token（xapp-）在 Socket Mode 下都是必需的。获取频道 ID：在 Slack 中右键点击频道 → 复制链接，ID 在 URL 中。

<div id="whatsapp">

### WhatsApp
</div>

**两种模式——选择其一：**

**模式 1：Cloud API（商业版，推荐）**
**获取凭据：** https://developers.facebook.com/apps → WhatsApp → API Setup
- `WHATSAPP_ACCESS_TOKEN` — 来自 Meta Business 的永久系统用户令牌
- `WHATSAPP_PHONE_NUMBER_ID` — 来自 WhatsApp → API Setup
- `WHATSAPP_BUSINESS_ACCOUNT_ID` — 来自 WhatsApp Business 设置
- `WHATSAPP_WEBHOOK_VERIFY_TOKEN` — 您自定义的任意字符串（用于验证 webhook）
- `WHATSAPP_API_VERSION` — 例如 `v18.0`（使用最新版本）
**设置：** 需要 Meta Business 账户、已验证的电话号码、已批准的 WhatsApp Business 应用

**模式 2：Baileys（个人版，二维码）**
- `WHATSAPP_AUTH_DIR` — 存储会话文件的目录，例如 `/data/whatsapp-auth`
- 无需其他凭据——首次运行时扫描二维码
**提示：** Baileys 模式可使用您的个人 WhatsApp 号码，但违反服务条款。生产环境请使用 Cloud API。Cloud API 需要真实的企业和 Meta 应用审核。

<div id="instagram">

### Instagram
</div>

**获取凭据：** 使用您的 Instagram 账户凭据
**最少必填：** `INSTAGRAM_USERNAME` + `INSTAGRAM_PASSWORD`
**变量：**
- `INSTAGRAM_USERNAME` — 您的 Instagram 用户名
- `INSTAGRAM_PASSWORD` — 您的 Instagram 密码
- `INSTAGRAM_VERIFICATION_CODE` — 如果启用了双重认证，填写您的 2FA 代码
- `INSTAGRAM_PROXY` — 如果被限流或封禁，填写代理 URL
**提示：** ⚠️ 使用非官方 API。Instagram 经常封禁自动化访问。请使用专用账号，不要使用您的个人账号。使用代理可减少封禁。启用了 2FA 的用户必须在启动时提供验证码。

<div id="bluesky">

### Bluesky
</div>

**获取凭据：** https://bsky.app → 设置 → 应用密码
**最少必填：** `BLUESKY_HANDLE` + `BLUESKY_PASSWORD`（应用密码，而非您的真实密码）
**变量：**
- `BLUESKY_HANDLE` — 您的 handle，例如 `yourname.bsky.social`
- `BLUESKY_PASSWORD` — 应用密码（不是您的登录密码——请在设置中创建一个）
- `BLUESKY_ENABLED` — `true` 以启用
- `BLUESKY_SERVICE` — 默认：`https://bsky.social`（仅在自托管 PDS 时更改）
- `BLUESKY_ENABLE_POSTING` — `true` 以启用自主发帖
- `BLUESKY_POST_INTERVAL_MIN` / `BLUESKY_POST_INTERVAL_MAX` — 发帖间隔秒数
- `BLUESKY_MAX_POST_LENGTH` — 每条帖子最大字符数（默认：300）
- `BLUESKY_POLL_INTERVAL` — 检查提及/私信的间隔秒数
- `BLUESKY_ENABLE_DMS` — `true` 以回复私信
**提示：** 在 bsky.app → 设置 → 应用密码 中创建应用密码。切勿使用您的主登录密码。

<div id="farcaster">

### Farcaster
</div>

**获取凭据：** https://warpcast.com → 设置，然后在 https://neynar.com 获取 API
**最少必填：** `FARCASTER_FID` + `FARCASTER_SIGNER_UUID` + `FARCASTER_NEYNAR_API_KEY`
**变量：**
- `FARCASTER_FID` — 您的 Farcaster ID（在个人资料 URL 中显示的数字）
- `FARCASTER_SIGNER_UUID` — 来自 Neynar 控制台的 Signer UUID
- `FARCASTER_NEYNAR_API_KEY` — 来自 neynar.com（读写操作所需）
- `ENABLE_CAST` — `true` 以启用自主发帖
- `CAST_INTERVAL_MIN` / `CAST_INTERVAL_MAX` — 发帖间隔分钟数
- `MAX_CAST_LENGTH` — 默认 320 个字符
- `FARCASTER_POLL_INTERVAL` — 检查通知的间隔秒数
- `FARCASTER_HUB_URL` — 自定义 Farcaster hub（高级，留空使用默认值）
**设置步骤：**
1. 创建 Warpcast 账户，从您的个人资料 URL 获取 FID
2. 在 neynar.com 注册，为您的 FID 创建一个 signer
3. 从 Neynar 控制台获取 API 密钥
**提示：** Neynar 是必需的——它是使 Farcaster 数据可通过 API 访问的索引器。

<div id="wechat">

### 微信
</div>

**获取凭据：** 来自您的微信代理服务提供商
**最少必填：** `WECHAT_API_KEY` + 配置中的代理 URL
**变量：**
- `WECHAT_API_KEY` — 代理服务 API 密钥
**仅配置字段**（在 `connectors.wechat` 中设置，非环境变量）：
- `proxyUrl` — **必填** — 您的微信代理服务 URL
- `webhookPort` — Webhook 监听端口（默认：18790）
- `deviceType` — 设备模拟：`ipad`（默认）或 `mac`
- `features.images` — 启用图片收发（默认：false）
- `features.groups` — 启用群聊支持（默认：false）
**设置步骤：**
1. 从微信代理服务获取 API 密钥
2. 在 eliza.json 中配置 `connectors.wechat`，设置 `apiKey` 和 `proxyUrl`
3. 启动 Eliza——用微信扫描终端中显示的二维码
**提示：** 微信使用第三方代理服务，而非官方 API。只使用您信任的代理——它能看到所有消息流量。通过 `accounts` 映射支持多账户。插件包：`@elizaos/plugin-wechat`。

<div id="github">

### GitHub
</div>

**获取凭据：** https://github.com/settings/tokens → 细粒度或经典令牌
**最少必填：** `GITHUB_API_TOKEN`
**变量：**
- `GITHUB_API_TOKEN` — 个人访问令牌或 GitHub App 令牌
- `GITHUB_OWNER` — 仓库所有者（用户名或组织名）
- `GITHUB_REPO` — 仓库名称
- `GITHUB_BRANCH` — 默认分支（例如 `main`）
- `GITHUB_WEBHOOK_SECRET` — 用于 GitHub App webhook 验证
- `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_INSTALLATION_ID` — 用于 GitHub Apps
**提示：** 细粒度令牌更安全——仅授予所需仓库的权限。对于组织仓库，您可能需要向组织请求访问权限。

<div id="twitch">

### Twitch
</div>

**获取凭据：** https://dev.twitch.tv/console/apps → 注册您的应用
**最少必填：** `TWITCH_USERNAME` + `TWITCH_CLIENT_ID` + `TWITCH_ACCESS_TOKEN` + `TWITCH_CLIENT_SECRET`
**变量：**
- `TWITCH_USERNAME` — 您的 Twitch 机器人用户名
- `TWITCH_CLIENT_ID` — 来自 Twitch 开发者控制台
- `TWITCH_CLIENT_SECRET` — 来自 Twitch 开发者控制台
- `TWITCH_ACCESS_TOKEN` — OAuth 令牌（通过 https://twitchapps.com/tmi/ 或 Twitch OAuth 流程获取）
- `TWITCH_REFRESH_TOKEN` — 用于长期会话
- `TWITCH_CHANNEL` — 要加入的主频道（例如 `mychannel`）
- `TWITCH_CHANNELS` — 其他频道（逗号分隔）
- `TWITCH_REQUIRE_MENTION` — `true` 表示仅在提及机器人用户名时回复
- `TWITCH_ALLOWED_ROLES` — `broadcaster`、`moderator`、`vip`、`subscriber`、`viewer`
**提示：** 为机器人创建一个单独的 Twitch 账户。使用 https://twitchapps.com/tmi/ 可快速获取聊天机器人的访问令牌。

<div id="twilio-sms--voice">

### Twilio（短信 + 语音）
</div>

**获取凭据：** https://console.twilio.com
**最少必填：** `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` + `TWILIO_PHONE_NUMBER`
**变量：**
- `TWILIO_ACCOUNT_SID` — 来自 Twilio 控制台仪表板（以 `AC` 开头）
- `TWILIO_AUTH_TOKEN` — 来自 Twilio 控制台仪表板
- `TWILIO_PHONE_NUMBER` — 您的 Twilio 号码，E.164 格式（例如 `+15551234567`）
- `TWILIO_WEBHOOK_URL` — 用于接收消息的公开可访问 URL
- `TWILIO_WEBHOOK_PORT` — 监听端口（自托管时，默认 3000）
- `VOICE_CALL_PROVIDER` — 例如 `twilio`
- `VOICE_CALL_FROM_NUMBER` — 外呼来电显示号码
- `VOICE_CALL_TO_NUMBER` — 默认呼叫号码
- `VOICE_CALL_PUBLIC_URL` — 语音 webhook 的公开可访问 URL
- `VOICE_CALL_MAX_DURATION_SECONDS` — 最大通话时长（默认 3600）
- `VOICE_CALL_INBOUND_POLICY` — `allow-all`、`allow-from` 或 `deny-all`
- `VOICE_CALL_INBOUND_GREETING` — 接听电话时播放的文字
**提示：** 要使 webhook 正常工作，Twilio 需要一个公共 URL。开发时使用 ngrok。在控制台 → 电话号码 → 购买号码 中获取电话号码。免费试用提供约 $15 额度。

<div id="matrix">

### Matrix
</div>

**获取凭据：** 您的 Matrix 家庭服务器账户
**最少必填：** `MATRIX_HOMESERVER` + `MATRIX_USER_ID` + `MATRIX_ACCESS_TOKEN`
**变量：**
- `MATRIX_HOMESERVER` — 例如 `https://matrix.org` 或您自己的家庭服务器
- `MATRIX_USER_ID` — 例如 `@yourbot:matrix.org`
- `MATRIX_ACCESS_TOKEN` — 从 Element 获取：设置 → 帮助与关于 → 高级 → Access Token
- `MATRIX_DEVICE_ID` — 留空以自动分配
- `MATRIX_ROOMS` — 逗号分隔的房间 ID（例如 `!abc123:matrix.org`）
- `MATRIX_AUTO_JOIN` — `true` 以自动加入邀请的房间
- `MATRIX_ENCRYPTION` — `true` 以启用端到端加密（需要更多设置）
- `MATRIX_REQUIRE_MENTION` — `true` 以仅在 @提及时回复
**提示：** 在 Element → 设置 → 帮助与关于 → 高级 中获取您的 access token。Matrix ID 使用 `@user:server` 格式。

<div id="microsoft-teams">

### Microsoft Teams
</div>

**获取凭据：** https://portal.azure.com → Azure Active Directory → 应用注册
**最少必填：** `MSTEAMS_APP_ID` + `MSTEAMS_APP_PASSWORD` + `MSTEAMS_TENANT_ID`
**变量：**
- `MSTEAMS_APP_ID` — 来自 Azure 门户的应用（客户端）ID
- `MSTEAMS_APP_PASSWORD` — 来自 Azure 门户的客户端密钥值
- `MSTEAMS_TENANT_ID` — 您的 Azure AD 租户 ID
- `MSTEAMS_WEBHOOK_PORT` / `MSTEAMS_WEBHOOK_PATH` — Bot Framework 发送消息的位置
- `MSTEAMS_ALLOWED_TENANTS` — 限制为特定租户（逗号分隔）
- `MSTEAMS_SHAREPOINT_SITE_ID` — 用于 SharePoint 集成（高级）
- `MSTEAMS_MEDIA_MAX_MB` — 最大文件上传大小（默认 25MB）
**设置步骤：**
1. 在 Azure 门户 → 应用注册 → 新建注册 中注册应用
2. 在"证书和密钥"下添加客户端密钥
3. 通过 https://dev.botframework.com → 创建机器人 注册 bot
4. 在 Bot Framework 门户中将 bot 连接到 Microsoft Teams 频道
**提示：** 需要 Microsoft 365 管理员访问权限或允许应用注册的组织。

<div id="google-chat">

### Google Chat
</div>

**获取凭据：** https://console.cloud.google.com → APIs → Google Chat API
**最少必填：** 服务账户 JSON 或 `GOOGLE_APPLICATION_CREDENTIALS` 路径
**变量：**
- `GOOGLE_CHAT_SERVICE_ACCOUNT_KEY` — 完整的服务账户 JSON（粘贴整个 JSON）
- `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE` — 备选方案：服务账户 JSON 文件路径
- `GOOGLE_APPLICATION_CREDENTIALS` — 备选方案：凭据文件路径
- `GOOGLE_CHAT_SPACES` — 逗号分隔的空间名称（例如 `spaces/AAAA_space_id`）
- `GOOGLE_CHAT_AUDIENCE_TYPE` — `PUBLISHED` 或 `DOMAIN_INSTALL`
- `GOOGLE_CHAT_AUDIENCE` — 您应用的 audience URL
- `GOOGLE_CHAT_WEBHOOK_PATH` — 接收消息的 webhook 路径
- `GOOGLE_CHAT_REQUIRE_MENTION` — `true` 以要求 @提及
- `GOOGLE_CHAT_BOT_USER` — Bot 用户 ID
**提示：** 在 Cloud Console 中启用 Google Chat API。创建具有 Chat 权限的服务账户。Workspace 管理员必须批准该 Chat 应用。

<div id="signal">

### Signal
</div>

**获取凭据：** 您自己的电话号码 + signal-cli 或 signal-api-rest-api
**最少必填：** `SIGNAL_ACCOUNT_NUMBER` + `SIGNAL_HTTP_URL`
**变量：**
- `SIGNAL_ACCOUNT_NUMBER` — 您的电话号码，E.164 格式（例如 `+15551234567`）
- `SIGNAL_HTTP_URL` — REST API URL，例如 `http://localhost:8080`
- `SIGNAL_CLI_PATH` — signal-cli 二进制文件路径（可选，用于直接 CLI 模式）
- `SIGNAL_SHOULD_IGNORE_GROUP_MESSAGES` — `true` 以忽略群聊
**设置：** 运行 signal-api-rest-api 服务器：https://github.com/bbernhard/signal-cli-rest-api
**提示：** Signal 没有官方 API。使用 bbernhard/signal-cli-rest-api Docker 镜像——它处理 signal-cli 连接并暴露 REST API。

<div id="imessage-macos-only">

### iMessage（仅 macOS）
</div>

**获取凭据：** 仅 macOS——无需凭据，使用本地 Messages.app
**变量：**
- `IMESSAGE_CLI_PATH` — imessage-reader CLI 路径（从 GitHub 安装）
- `IMESSAGE_DB_PATH` — Messages chat.db 路径（默认：`~/Library/Messages/chat.db`）
- `IMESSAGE_POLL_INTERVAL_MS` — 检查新消息的频率（默认：5000ms）
- `IMESSAGE_DM_POLICY` — `allow-all` 或 `allow-from`
- `IMESSAGE_GROUP_POLICY` — `allow-all`、`allow-from` 或 `deny-all`
- `IMESSAGE_ALLOW_FROM` — 逗号分隔的允许发送者
- `IMESSAGE_ENABLED` — `true` 以启用
**提示：** 仅限 macOS。应用需要"完全磁盘访问"权限才能读取 Messages 数据库。仅在配置了 iMessage 的机器上有效。

<div id="blooio-sms-via-api">

### Blooio（通过 API 发送短信）
</div>

**获取凭据：** https://bloo.io
**最少必填：** `BLOOIO_API_KEY`
**变量：**
- `BLOOIO_API_KEY` — 来自 bloo.io 控制台
- `BLOOIO_WEBHOOK_URL` — 用于接收短信 webhook 的公共 URL
- `BLOOIO_WEBHOOK_SECRET` — 用于 webhook 签名验证的密钥
- `BLOOIO_BASE_URL` — bloo.io API 基础 URL（保持默认值）
- `BLOOIO_PHONE_NUMBER` — 发送短信的电话号码
- `BLOOIO_WEBHOOK_PORT` — webhook 监听端口
**提示：** Blooio 桥接 iMessage/短信。需要运行 Blooio 应用的 Mac。

<div id="nostr">

### Nostr
</div>

**获取凭据：** 使用任何 Nostr 客户端生成您自己的密钥对
**最少必填：** `NOSTR_PRIVATE_KEY`
**变量：**
- `NOSTR_PRIVATE_KEY` — 您的 nsec 私钥（十六进制格式）
- `NOSTR_RELAYS` — 逗号分隔的中继 URL，例如 `wss://relay.damus.io,wss://relay.nostr.band`
- `NOSTR_DM_POLICY` — `allow-all` 或 `allow-from`
- `NOSTR_ALLOW_FROM` — 允许的公钥（npub 格式）
- `NOSTR_ENABLED` — `true` 以启用
**提示：** 使用任何 Nostr 应用（Damus、Primal、Amethyst）生成密钥。保护好私钥——它代表您的身份。使用多个中继以提高可靠性。

<div id="line">

### LINE
</div>

**获取凭据：** https://developers.line.biz/console
**最少必填：** `LINE_CHANNEL_ACCESS_TOKEN` + `LINE_CHANNEL_SECRET`
**变量：**
- `LINE_CHANNEL_ACCESS_TOKEN` — 来自 LINE Developers 控制台 → Messaging API → Channel Access Token
- `LINE_CHANNEL_SECRET` — 来自 Basic Settings 标签
- `LINE_WEBHOOK_PATH` — Webhook URL 路径（也需在 LINE 控制台中配置）
- `LINE_DM_POLICY` / `LINE_GROUP_POLICY` — `allow-all` 或 `allow-from`
- `LINE_ALLOW_FROM` — 允许的用户 ID
- `LINE_ENABLED` — `true` 以启用
**设置步骤：**
1. 在 developers.line.biz 创建一个频道
2. 签发频道访问令牌（长期有效，在 Messaging API 标签中）
3. 在控制台中设置您的 webhook URL
**提示：** LINE 要求您的 webhook 使用具有有效证书的 HTTPS。开发时使用 ngrok 或部署到服务器。

<div id="feishu-lark">

### 飞书 (Lark)
</div>

**获取凭据：** https://open.feishu.cn（Lark 版本为 open.larksuite.com）
**最少必填：** `FEISHU_APP_ID` + `FEISHU_APP_SECRET`
**变量：**
- `FEISHU_APP_ID` — 来自飞书/Lark 开发者控制台 → 应用凭证
- `FEISHU_APP_SECRET` — 来自应用凭证部分
- `FEISHU_DOMAIN` — `feishu.cn`（默认）或 `larksuite.com`
- `FEISHU_ALLOWED_CHATS` — 允许的聊天 ID（逗号分隔）
- `FEISHU_TEST_CHAT_ID` — 用于测试

<div id="mattermost">

### Mattermost
</div>

**获取凭据：** 您的 Mattermost 实例 → 系统控制台 → 集成 → Bot 账户
**最少必填：** `MATTERMOST_SERVER_URL` + `MATTERMOST_BOT_TOKEN`
**变量：**
- `MATTERMOST_SERVER_URL` — 例如 `https://mattermost.yourcompany.com`
- `MATTERMOST_BOT_TOKEN` — 来自系统控制台 → Bot 账户 → 添加 Bot 账户
- `MATTERMOST_TEAM_ID` — 您的团队 ID（来自团队 URL 或 API）
- `MATTERMOST_DM_POLICY` / `MATTERMOST_GROUP_POLICY` — `allow-all` 或 `allow-from`
- `MATTERMOST_ALLOWED_USERS` / `MATTERMOST_ALLOWED_CHANNELS` — 限制访问
- `MATTERMOST_REQUIRE_MENTION` — `true` 以要求 @提及
**提示：** 在系统控制台 → 认证 → Bot 账户 中启用 Bot 账户。自托管 Mattermost 是免费的。

<div id="nextcloud-talk">

### Nextcloud Talk
</div>

**获取凭据：** 您的 Nextcloud 实例 → 设置 → 安全 → 应用密码
**最少必填：** `NEXTCLOUD_URL` + `NEXTCLOUD_BOT_SECRET`
**变量：**
- `NEXTCLOUD_URL` — 您的 Nextcloud URL（例如 `https://cloud.yourserver.com`）
- `NEXTCLOUD_BOT_SECRET` — 通过 Nextcloud Talk API 注册 bot 时设置
- `NEXTCLOUD_WEBHOOK_PUBLIC_URL` — Talk webhook 的公开可访问 URL
- `NEXTCLOUD_WEBHOOK_PORT` / `NEXTCLOUD_WEBHOOK_PATH` — Webhook 服务器设置
- `NEXTCLOUD_ALLOWED_ROOMS` — 允许的房间令牌

<div id="tlon-urbit">

### Tlon (Urbit)
</div>

**获取凭据：** 您的 Urbit ship 访问权限
**最少必填：** `TLON_SHIP` + `TLON_URL` + `TLON_CODE`
**变量：**
- `TLON_SHIP` — 您的 ship 名称（例如 `~sampel-palnet`）
- `TLON_URL` — 您 ship 的 URL（例如 `http://localhost:8080`）
- `TLON_CODE` — 您 ship 的访问代码（在 Dojo 中通过 `+code` 获取）
- `TLON_GROUP_CHANNELS` — 要监听的频道（群组路径格式）
- `TLON_DM_ALLOWLIST` — 允许的私信发送者
- `TLON_AUTO_DISCOVER_CHANNELS` — 自动加入频道

<div id="zalo-vietnam-messaging">

### Zalo（越南即时通讯）
</div>

**获取凭据：** https://developers.zalo.me
**最少必填：** `ZALO_APP_ID` + `ZALO_SECRET_KEY` + `ZALO_ACCESS_TOKEN`
**变量：**
- `ZALO_APP_ID` / `ZALO_SECRET_KEY` — 来自 Zalo 开发者门户
- `ZALO_ACCESS_TOKEN` / `ZALO_REFRESH_TOKEN` — 来自 Zalo 的 OAuth 令牌
- `ZALO_WEBHOOK_URL` / `ZALO_WEBHOOK_PATH` / `ZALO_WEBHOOK_PORT` — Webhook 配置

<div id="zalo-user-personal">

### Zalo User（个人版）
</div>

个人 Zalo 账户连接器（非官方，无需 API 密钥）。
**变量：**
- `ZALOUSER_COOKIE_PATH` — 导出的 Zalo 会话 cookie 路径
- `ZALOUSER_IMEI` — 用于会话的设备 IMEI（来自官方 Zalo 应用）
- `ZALOUSER_USER_AGENT` — 浏览器 user agent 字符串
- `ZALOUSER_PROFILES` — 多账户配置文件（JSON）
- `ZALOUSER_ALLOWED_THREADS` — 允许的会话线程
- `ZALOUSER_DM_POLICY` / `ZALOUSER_GROUP_POLICY` — 消息策略

<div id="acp-agent-communication-protocol">

### ACP（代理通信协议）
</div>

用于连接多个 AI 代理的内部代理间通信协议。
**变量：**
- `ACP_GATEWAY_URL` — ACP hub 的网关 URL
- `ACP_GATEWAY_TOKEN` / `ACP_GATEWAY_PASSWORD` — 认证凭据
- `ACP_DEFAULT_SESSION_KEY` / `ACP_DEFAULT_SESSION_LABEL` — 会话标识
- `ACP_CLIENT_NAME` / `ACP_CLIENT_DISPLAY_NAME` — 此代理的身份
- `ACP_AGENT_ID` — 唯一代理 ID
- `ACP_PERSIST_SESSIONS` — `true` 以在重启后保存会话
- `ACP_SESSION_STORE_PATH` — 会话保存位置

<div id="mcp-model-context-protocol">

### MCP（模型上下文协议）
</div>

连接到任何 MCP 服务器以获取扩展工具能力。
**变量：**
- `mcp` — MCP 服务器的 JSON 配置对象
**提示：** MCP 服务器可以直接向 AI 提供工具（网络搜索、代码执行、文件访问、数据库等）。可用服务器请参见 https://modelcontextprotocol.io。

<div id="iq-solana-on-chain">

### IQ（Solana 链上）
</div>

通过 Solana 区块链的链上聊天。
**最少必填：** `SOLANA_PRIVATE_KEY` + `IQ_GATEWAY_URL`
**变量：**
- `SOLANA_PRIVATE_KEY` — Solana 钱包私钥（base58 编码）
- `SOLANA_KEYPAIR_PATH` — 备选方案：密钥对 JSON 文件路径
- `SOLANA_RPC_URL` — 例如 `https://api.mainnet-beta.solana.com`
- `IQ_GATEWAY_URL` — IQ 协议网关 URL
- `IQ_AGENT_NAME` — 您代理的显示名称
- `IQ_DEFAULT_CHATROOM` — 默认加入的聊天室
- `IQ_CHATROOMS` — 其他聊天室（逗号分隔）

<div id="gmail-watch">

### Gmail Watch
</div>

通过 Google Pub/Sub 推送通知监控 Gmail。
**设置：** 需要具有 Gmail API 访问权限的 Google Cloud 服务账户。
**提示：** 内部使用 `gog gmail watch serve`。需要启用了 Gmail API 和配置了 Pub/Sub 的 Google Cloud 项目。

---

<div id="streaming"></div>

## 直播推流

### Stream 标签页（`streaming`）

在 UI 中添加「推流」标签页，并提供 RTMP 目标管理。只需启用 **`@elizaos/plugin-streaming` 一次**，即可覆盖 Twitch、YouTube、X、pump.fun、自定义 RTMP，以及可选的多路命名 ingest（`streaming.rtmpSources`）。

### Twitch 推流

**获取凭据：** https://dashboard.twitch.tv → 设置 → 直播
**变量：** `TWITCH_STREAM_KEY` — 您的推流密钥（请保密！）
**提示：** 切勿分享您的推流密钥——任何人都可以用它向您的频道推流。如果泄露请立即重新生成。

### YouTube 推流

**获取凭据：** https://studio.youtube.com → 开始直播 → 直播设置
**变量：**
- `YOUTUBE_STREAM_KEY` — 来自 YouTube Studio → 推流密钥
- `YOUTUBE_RTMP_URL` — 默认：`rtmp://a.rtmp.youtube.com/live2`（很少需要更改）
**提示：** 您需要一个启用了直播功能的 YouTube 频道（可能需要手机验证）。

### X 推流

使用为活跃广播生成的 RTMP 凭据向 X 推流。
**获取凭据：** 创建直播时从 X Live Producer / Media Studio 获取
**变量：**
- `X_STREAM_KEY` — 广播的推流密钥
- `X_RTMP_URL` — 广播会话的 RTMP 推流 URL
**提示：** X 的 RTMP 凭据通常是按广播生成的。先创建直播，然后将两个值直接复制到插件中。

### pump.fun 推流

使用平台的 RTMP 推流凭据向 pump.fun 推流。
**获取凭据：** 创建直播时从 pump.fun 直播推流流程中获取
**变量：**
- `PUMPFUN_STREAM_KEY` — pump.fun 推流的推流密钥
- `PUMPFUN_RTMP_URL` — 当前直播的 RTMP 推流 URL
**提示：** 将两个值视为会话凭据。如果推流拒绝启动，请重新创建广播并粘贴新的值。

### 自定义 RTMP

向任何平台推流（Facebook、TikTok、Kick、自托管 RTMP 等）
**变量：**
- `CUSTOM_RTMP_URL` — RTMP 端点 URL，例如 `rtmp://live.kick.com/app`
- `CUSTOM_RTMP_KEY` — 来自平台的推流密钥
**常见 RTMP URL：**
- Facebook Live：`rtmps://live-api-s.facebook.com:443/rtmp/`
- TikTok：`rtmp://push.tiktokcdn.com/third/`（需要 TikTok 直播权限）
- Kick：`rtmp://ingest.global-contribute.live-video.net/app`

---

<div id="general-tips">

## 通用提示
</div>

**必填 vs 可选：** 每个插件都有最少必填字段。先只设置这些——您可以稍后添加可选设置。

**上线前测试：** 大多数连接器都有"试运行"模式（例如 `TWITTER_DRY_RUN=true`、`FARCASTER_DRY_RUN=true`、`BLUESKY_DRY_RUN=true`）——使用此模式在不实际发帖的情况下验证设置。

**策略字段：** 大多数连接器都有 `DM_POLICY` 和 `GROUP_POLICY` 字段：
- `allow-all` — 回复所有人
- `allow-from` — 仅回复 `ALLOW_FROM` 列表中的账户
- `deny-all` — 从不回复（实际上禁用该频道类型）

**Webhook vs 轮询：** LINE、Twilio、WhatsApp Cloud API 和 Google Chat 等连接器使用 webhook（它们将消息推送到您的服务器）。您需要一个公开可访问的 URL。本地开发时使用 ngrok：`ngrok http 3000`。

**速率限制：** 大多数平台都有速率限制。特别是 Twitter，请使用保守的发帖间隔（最少 90-180 分钟）。

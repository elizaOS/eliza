---
title: 插件概述
sidebarTitle: 概述
description: Eliza 的插件系统提供模块化能力 — 模型提供者、平台连接器、DeFi 集成和自定义功能。
---

插件是 elizaOS 的主要扩展机制。核心运行时之外的每项能力 — 从 LLM 提供者到区块链交互 — 都以插件的形式提供。

<div id="what-is-a-plugin">

## 什么是插件？

</div>

插件是一个独立的模块，可以注册以下一项或多项：

- **Actions** — 代理可以执行的操作（例如，发送推文、交换代币）
- **Providers** — 注入到代理提示中的上下文（例如，钱包余额、时间）
- **Evaluators** — 每次响应后运行的后处理逻辑
- **Services** — 长时间运行的后台进程（例如，定时任务、事件监听器）

<div id="plugin-categories">

## 插件分类

</div>

<CardGroup cols={2}>

<Card title="核心插件" icon="cube" href="/zh/plugin-registry/documents">
  每个 Eliza 安装都附带的基础插件 — knowledge、database、form、cron、shell、agent-skills、trajectories 和 agent-orchestrator。
</Card>

<Card title="模型提供者" icon="brain" href="/zh/plugin-registry/llm/openai">
  LLM 集成，支持 OpenAI、Anthropic、Google Gemini、Google Antigravity、Groq、Ollama、OpenRouter、DeepSeek、xAI、Mistral、Cohere、Together、Qwen、Minimax、Perplexity、Zai、Vercel AI Gateway 和 Eliza Cloud。
</Card>

<Card title="平台连接器" icon="plug" href="/zh/plugin-registry/platform/discord">
  28 个平台连接器。18 个通过配置自动启用（Discord、Telegram、Twitter、Slack、WhatsApp、Signal、iMessage、Blooio、MS Teams、Google Chat、Mattermost、Farcaster、Twitch、WeChat、Feishu、Matrix、Nostr、Lens）。另外 10 个可从注册表安装（BlueBubbles、Bluesky、Instagram、LINE、Zalo、Twilio、GitHub、Gmail Watch、Nextcloud Talk、Tlon）。
</Card>

<Card title="DeFi 与区块链" icon="wallet" href="/zh/plugin-registry/defi/evm">
  EVM 链和 Solana 的链上交互 — 代币转账、交换和 DeFi 协议。
</Card>

<Card title="功能插件" icon="wand-magic-sparkles" href="/zh/plugin-registry/browser">
  扩展能力 — 浏览器控制、图像生成、文本转语音、语音转文本、计算机操控、定时调度、视觉、shell、webhooks、FAL 媒体生成、Suno 音乐、OpenTelemetry 诊断、x402 支付、Obsidian 保管库同步、Gmail Watch、个性调整、经验追踪、代理技能、Claude Code 工作台、RepoPrompt 等。
</Card>

</CardGroup>

<div id="how-plugins-load">

## 插件如何加载

</div>

插件在运行时初始化期间按以下顺序加载：

1. **Eliza 插件** — 桥接插件（`createElizaPlugin()`），提供工作区上下文、会话密钥、表情、自定义操作和生命周期操作。始终是插件数组中的第一个。
2. **预注册插件** — `@elizaos/plugin-sql` 和 `@elizaos/plugin-local-embedding` 在 `runtime.initialize()` 之前预注册，以防止竞态条件。
3. **核心插件** — 始终加载：`sql`、`local-embedding`、`form`、`knowledge`、`trajectories`、`agent-orchestrator`、`cron`、`shell`、`agent-skills`（见 `packages/agent/src/runtime/core-plugins.ts`）。`pdf`、`cua`、`browser`、`computeruse`、`obsidian`、`code`、`repoprompt`、`vision`、`cli`、`edge-tts`、`elevenlabs`、`discord`、`telegram` 和 `twitch` 等附加插件是可选的，当其功能标志或环境变量配置后才会加载。
4. **自动启用的插件** — 连接器、提供者、功能、流式、订阅、hooks（webhooks + Gmail Watch）和媒体生成插件根据配置和环境变量自动启用（参见[架构](/zh/plugins/architecture)了解完整映射）。
5. **弹出的插件** — 从 `~/.eliza/plugins/ejected/` 发现的本地覆盖。当存在弹出副本时，它优先于 npm 发布的版本。
6. **用户安装的插件** — 在 `eliza.json` 的 `plugins.installs` 中跟踪。在 drop-in 插件之前收集；此处已存在的任何插件名称具有优先权。
7. **自定义/drop-in 插件** — 从 `~/.eliza/plugins/custom/` 和 `plugins.load.paths` 中的任何额外路径扫描。名称已存在于 `plugins.installs` 中的插件将被跳过（`mergeDropInPlugins` 优先规则）。

```json
// eliza.json plugin configuration
{
  "plugins": {
    "allow": ["@elizaos/plugin-openai", "discord"],
    "entries": {
      "openai": { "enabled": true }
    }
  },
  "connectors": {
    "discord": { "token": "..." }
  }
}
```

<div id="plugin-lifecycle">

## 插件生命周期

</div>

```
Install → Register → Initialize → Active → Shutdown
```

1. **Install** — 解析插件包（npm 或本地）
2. **Register** — 将操作、提供者、评估器和服务注册到运行时
3. **Initialize** — 使用运行时上下文调用 `init()`
4. **Active** — 插件处理事件并提供能力
5. **Shutdown** — 在运行时停止时调用 `cleanup()`

<div id="managing-plugins">

## 管理插件

</div>

<div id="install-from-registry">

### 从注册表安装

</div>

```bash
eliza plugins install @elizaos/plugin-openai
```

<div id="list-installed-plugins">

### 列出已安装的插件

</div>

```bash
eliza plugins list
```

<div id="enable-disable">

### 启用/禁用

</div>

通过在 `eliza.json` 中设置 `enabled` 标志来启用或禁用插件：

```json
{
  "plugins": {
    "entries": {
      "plugin-name": { "enabled": false }
    }
  }
}
```

或直接编辑配置文件（`eliza config path` 显示文件位置）：

```bash
$EDITOR "$(eliza config path)"
```

<div id="eject-copy-to-local">

### 弹出（复制到本地）

</div>

通过代理聊天弹出插件以克隆其源代码进行本地编辑：

```
eject the telegram plugin so I can edit its source
```

参见[插件弹出](/zh/plugins/plugin-eject)了解完整的弹出/同步/重新注入工作流。

<div id="related">

## 相关内容

</div>

- [插件架构](/zh/plugins/architecture) — 深入了解插件系统
- [创建插件](/zh/plugins/create-a-plugin) — 分步教程
- [插件开发](/zh/plugins/development) — 开发指南和 API
- [插件注册表](/zh/plugins/registry) — 浏览可用插件

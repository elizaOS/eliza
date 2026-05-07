---
title: "插件架构"
sidebarTitle: "架构"
description: "深入了解 Eliza 的插件系统——注册生命周期、钩子点、自动启用机制和依赖解析。"
---

Eliza 插件系统基于 elizaOS 核心构建。除基础运行时之外的所有能力——模型提供者、平台连接器、DeFi 集成、调度和自定义功能——都以插件形式交付。

<div id="system-design">

## 系统设计

</div>

插件是独立的模块，通过 `AgentRuntime` 注册各种能力。运行时负责编排插件的加载、依赖解析、初始化和关闭。

```
AgentRuntime
├── Core Plugins     (始终加载)
├── Auto-enabled     (由环境变量/配置触发)
├── Character        (在角色文件中指定)
└── Local            (来自 plugins/ 目录)
```

确定哪些插件始终加载的权威来源位于 `eliza/packages/agent/src/runtime/core-plugins.ts`（在上游 elizaOS 子模块中，由 `eliza/packages/app-core/src/runtime/core-plugins.ts` 重新导出）：

```typescript
export const CORE_PLUGINS: readonly string[] = [
  "@elizaos/plugin-sql",               // database adapter — required
  "@elizaos/plugin-local-embedding",   // local embeddings — required for memory
  "knowledge",         // RAG knowledge management — required for knowledge tab
  "trajectories", // trajectory logging for debugging and RL training
  "@elizaos/plugin-agent-orchestrator",// multi-agent orchestration (PTY, SwarmCoordinator, workspace provisioning)
  "@elizaos/plugin-shell",             // shell command execution
  "@elizaos/plugin-coding-tools",      // native Read/Write/Edit/Bash/Grep/Glob（桌面；CODING_TOOLS_DISABLE）
  "@elizaos/plugin-agent-skills",      // skill execution and marketplace runtime
  "@elizaos/plugin-commands",          // slash command handling (skills auto-register as /commands)
  "roles",                            // internal role-based access control (OWNER/ADMIN/NONE)
];
```

> **注意：** 许多曾以独立插件形式提供的功能现已内置于运行时：experience、form、clipboard、personality（通过 `advancedCapabilities: true` 的高级能力）、trust（通过 `enableTrust: true`）、secrets（通过 `enableSecretsManager: true`）、plugin-manager（通过 `enablePluginManager: true`）、knowledge、relationships 以及 trajectories（原生功能）。agent-orchestrator 可通过 `ELIZA_AGENT_ORCHESTRATOR` 选配（Eliza 应用默认启用）。

<div id="optional-core-plugins">

### 可选核心插件

</div>

另有一组可选核心插件可从管理面板启用。由于打包或规范约束，这些插件默认不加载。列表位于 `eliza/packages/agent/src/runtime/core-plugins.ts`：

```typescript
export const OPTIONAL_CORE_PLUGINS: readonly string[] = [
  "@elizaos/plugin-pdf",                   // PDF processing
  "@elizaos/plugin-cua",                   // CUA computer-use agent (cloud sandbox automation)
  "@elizaos/plugin-obsidian",              // Obsidian vault CLI integration
  "@elizaos/plugin-repoprompt",            // RepoPrompt CLI integration
  "@elizaos/plugin-claude-code-workbench", // Claude Code companion workflows
  "@elizaos/plugin-computeruse",           // computer use automation (platform-specific)
  "@elizaos/plugin-browser",              // browser automation (requires stagehand-server)
  "@elizaos/plugin-vision",               // vision/image understanding (feature-gated)
  "@elizaos/plugin-cli",                  // CLI interface
  "@elizaos/plugin-discord",              // Discord bot integration
  "@elizaos/plugin-telegram",             // Telegram bot integration
  "@elizaos/plugin-twitch",               // Twitch integration
  "@elizaos/plugin-edge-tts",             // text-to-speech (Microsoft Edge TTS)
  "@elizaos/plugin-elevenlabs",           // ElevenLabs text-to-speech
];
```

`@elizaos/plugin-directives`、`@elizaos/plugin-commands`、`@elizaos/plugin-mcp` 和 `@elizaos/plugin-scheduling` 等插件在源码中被注释掉，可能会在未来版本中激活。

<div id="plugin-hook-points">

## 插件钩子点

</div>

插件可以注册以下钩子点的任意组合：

| 钩子 | 类型 | 用途 |
|------|------|------|
| `actions` | `Action[]` | 代理可以执行的操作；LLM 从此列表中选择动作 |
| `providers` | `Provider[]` | 在每次 LLM 调用前注入到提示词中的上下文 |
| `evaluators` | `Evaluator[]` | 响应后评估；可触发后续动作 |
| `services` | `ServiceClass[]` | 长时间运行的后台进程 |
| `routes` | `Route[]` | 由代理 API 服务器暴露的 HTTP 端点 |
| `events` | `Record<EventName, Handler[]>` | 运行时事件的回调 |
| `models` | `Record<ModelType, Handler>` | 自定义模型推理处理器 |

<div id="registration-lifecycle">

## 注册生命周期

</div>

```
1. Resolve      — 定位插件包（npm、本地、工作区）
2. Import       — 动态导入模块并验证其结构
3. Sort         — 按依赖关系和优先级字段排序插件
4. Init         — 调用 plugin.init(config, runtime)
5. Register     — 注册 actions、providers、services、routes、events
6. Active       — 插件响应消息和事件
7. Shutdown     — 退出时调用 plugin.cleanup() / service.stop()
```

<div id="plugin-interface">

### 插件接口

</div>

```typescript
interface Plugin {
  name: string;
  description: string;

  // Lifecycle
  init?: (config: Record<string, unknown>, runtime: IAgentRuntime) => Promise<void>;

  // Hook points
  actions?: Action[];
  providers?: Provider[];
  evaluators?: Evaluator[];
  services?: ServiceClass[];
  routes?: Route[];
  events?: Record<string, Handler[]>;
  models?: Record<string, ModelHandler>;
  componentTypes?: ComponentType[];

  // Load order
  priority?: number;          // Higher = loaded later
  dependencies?: string[];    // Other plugin names this depends on
  tests?: TestSuite[];
}
```

<div id="auto-enable-mechanism">

## 自动启用机制

</div>

当检测到所需配置时，插件会自动启用。此逻辑位于 `eliza/packages/agent/src/config/plugin-auto-enable.ts`（由 Eliza 自身的 `plugin-auto-enable.ts` 扩展，用于微信等连接器），并在运行时初始化之前执行。

<div id="trigger-sources">

### 触发来源

</div>

**环境变量 API 密钥** — `AUTH_PROVIDER_PLUGINS` 映射将环境变量关联到插件包名称：

```typescript
const AUTH_PROVIDER_PLUGINS = {
  ANTHROPIC_API_KEY:              "@elizaos/plugin-anthropic",
  CLAUDE_API_KEY:                 "@elizaos/plugin-anthropic",
  OPENAI_API_KEY:                 "@elizaos/plugin-openai",
  AI_GATEWAY_API_KEY:             "@elizaos/plugin-vercel-ai-gateway",
  AIGATEWAY_API_KEY:              "@elizaos/plugin-vercel-ai-gateway",
  GOOGLE_API_KEY:                 "@elizaos/plugin-google-genai",
  GOOGLE_GENERATIVE_AI_API_KEY:   "@elizaos/plugin-google-genai",
  GOOGLE_CLOUD_API_KEY:           "@elizaos/plugin-google-antigravity",
  GROQ_API_KEY:                   "@elizaos/plugin-groq",
  XAI_API_KEY:                    "@elizaos/plugin-xai",
  GROK_API_KEY:                   "@elizaos/plugin-xai",
  OPENROUTER_API_KEY:             "@elizaos/plugin-openrouter",
  OLLAMA_BASE_URL:                "@elizaos/plugin-ollama",
  ZAI_API_KEY:                    "@homunculuslabs/plugin-zai",
  DEEPSEEK_API_KEY:               "@elizaos/plugin-deepseek",
  TOGETHER_API_KEY:               "@elizaos/plugin-together",
  MISTRAL_API_KEY:                "@elizaos/plugin-mistral",
  COHERE_API_KEY:                 "@elizaos/plugin-cohere",
  PERPLEXITY_API_KEY:             "@elizaos/plugin-perplexity",
  ELIZAOS_CLOUD_API_KEY:          "@elizaos/plugin-elizacloud",
  ELIZAOS_CLOUD_ENABLED:          "@elizaos/plugin-elizacloud",
  CUA_API_KEY:                    "@elizaos/plugin-cua",
  CUA_HOST:                       "@elizaos/plugin-cua",
  OBSIDIAN_VAULT_PATH:            "@elizaos/plugin-obsidian",
  REPOPROMPT_CLI_PATH:            "@elizaos/plugin-repoprompt",
  CLAUDE_CODE_WORKBENCH_ENABLED:  "@elizaos/plugin-claude-code-workbench",
};
```

**连接器配置** — 包含 `botToken`、`token` 或 `apiKey` 字段的连接器配置块会自动启用对应的连接器插件：

```typescript
const CONNECTOR_PLUGINS = {
  telegram:    "@elizaos/plugin-telegram",
  discord:     "@elizaos/plugin-discord",
  slack:       "@elizaos/plugin-slack",
  twitter:     "@elizaos/plugin-x",
  whatsapp:    "@elizaos/plugin-whatsapp",
  signal:      "@elizaos/plugin-signal",
  imessage:    "@elizaos/plugin-imessage",
  farcaster:   "@elizaos/plugin-farcaster",
  lens:        "@elizaos/plugin-lens",
  msteams:     "@elizaos/plugin-msteams",
  mattermost:  "@elizaos/plugin-mattermost",
  googlechat:  "@elizaos/plugin-google-chat",
  feishu:      "@elizaos/plugin-feishu",
  matrix:      "@elizaos/plugin-matrix",
  nostr:       "@elizaos/plugin-nostr",
  blooio:      "@elizaos/plugin-blooio",
  twitch:      "@elizaos/plugin-twitch",
  wechat:      "@elizaos/plugin-wechat",  // Eliza-specific (added in app-core)
};
```

> **注意：** 上游 `packages/agent` 定义了所有 `@elizaos/*` 连接器。Eliza 的 `packages/app-core` 扩展了此映射，添加了指向 `@elizaos/plugin-wechat` 的 `wechat` 条目。

**功能标志** — `eliza.json` 的 `features` 部分可自动启用功能插件。功能可以通过 `features.<name>: true` 或 `features.<name>.enabled: true` 启用：

```json
{
  "features": {
    "browser": true,
    "imageGen": true,
    "tts": { "enabled": true }
  }
}
```

完整的 `FEATURE_PLUGINS` 映射：

```typescript
const FEATURE_PLUGINS = {
  browser:              "@elizaos/plugin-browser",
  cua:                  "@elizaos/plugin-cua",
  obsidian:             "@elizaos/plugin-obsidian",
  shell:                "@elizaos/plugin-shell",
  imageGen:             "@elizaos/plugin-image-generation",
  tts:                  "@elizaos/plugin-tts",
  stt:                  "@elizaos/plugin-stt",
  agentSkills:          "@elizaos/plugin-agent-skills",
  commands:             "@elizaos/plugin-commands",
  diagnosticsOtel:      "@elizaos/plugin-diagnostics-otel",
  webhooks:             "@elizaos/plugin-webhooks",
  gmailWatch:           "@elizaos/plugin-gmail-watch",
  x402:                 "@elizaos/plugin-x402",
  fal:                  "@elizaos/plugin-fal",
  suno:                 "@elizaos/plugin-suno",
  vision:               "@elizaos/plugin-vision",
  computeruse:          "@elizaos/plugin-computeruse",
  repoprompt:           "@elizaos/plugin-repoprompt",
  claudeCodeWorkbench:  "@elizaos/plugin-claude-code-workbench",
};
```

> **注意：** `personality`、`experience` 与 `form` 不再作为特性标志映射中的独立插件包——它们由内置于 `@elizaos/core` 的高级能力提供，通过在角色设置中启用 `advancedCapabilities: true` 开启。

**流媒体目标** — 配置中的 `streaming` 部分可自动启用直播平台的流媒体插件：

```typescript
const STREAMING_PLUGINS = {
  twitch:       "@elizaos/plugin-streaming",
  youtube:      "@elizaos/plugin-streaming",
  customRtmp:   "@elizaos/plugin-streaming",
  pumpfun:      "@elizaos/plugin-streaming",
  x:            "@elizaos/plugin-streaming",
  rtmpSources:  "@elizaos/plugin-streaming",
};
```

**认证配置文件** — 指定提供者名称的认证配置文件会触发加载匹配的提供者插件。

<div id="opting-out">

### 退出自动启用

</div>

即使环境变量存在，也可以单独禁用插件：

```json
{
  "plugins": {
    "entries": {
      "anthropic": { "enabled": false }
    }
  }
}
```

在配置中设置 `plugins.enabled: false` 可禁用所有可选插件的自动启用。

<div id="dependency-resolution">

## 依赖解析

</div>

插件在初始化之前会进行拓扑排序。如果插件 B 在其 `dependencies` 数组中列出了插件 A，则 A 将始终在 B 之前初始化。

`priority` 字段提供独立于依赖边的粗粒度排序。较低的优先级值更早初始化（默认值：`0`）。

<div id="plugin-isolation">

## 插件隔离

</div>

每个插件接收：

- 对共享 `AgentRuntime` 的引用（对其他插件已注册能力的只读访问）
- 自己的配置命名空间
- 在初始化时由密钥管理器注入的密钥

插件之间不直接共享可变状态——它们通过运行时的服务注册表和事件系统进行通信。

<div id="module-shape">

## 模块结构

</div>

当动态导入插件包时，`findRuntimePluginExport()` 按以下优先顺序定位 Plugin 导出：

1. `module.default` — ES 模块默认导出
2. `module.plugin` — 名为 `plugin` 的导出
3. `module` 本身 — CJS 默认模式
4. 以 `Plugin` 结尾或以 `plugin` 开头的命名导出
5. 其他匹配 Plugin 接口结构的命名导出
6. 针对匹配 `plugin` 的命名键的最小 `{ name, description }` 导出

当模块导出同时具有 `name` 和 `description` 字段，并且至少包含 `services`、`providers`、`actions`、`routes`、`events`（作为数组）或 `init`（作为函数）之一时，该导出会被接受为 Plugin。

<div id="related">

## 相关内容

</div>

- [创建插件](/zh/plugins/create-a-plugin) — 从零开始构建插件
- [插件模式](/zh/plugins/patterns) — 常见实现模式
- [插件模式定义](/zh/plugins/schemas) — 完整模式参考
- [插件注册表](/zh/plugins/registry) — 浏览可用插件

---
title: "核心运行时"
sidebarTitle: "Core"
description: "AgentRuntime 类、构造函数参数、插件注册以及 Eliza 配置级联。"
---

`@elizaos/core` 中的 `AgentRuntime` 类是管理插件注册、消息处理、提供者上下文组装和服务生命周期的核心对象。Eliza 在 `src/runtime/eliza.ts` 中用额外的引导逻辑对其进行了封装。

<div id="agentruntime-constructor">
## AgentRuntime 构造函数
</div>

```typescript
const runtime = new AgentRuntime({
  character,
  actionPlanning: true,
  plugins: [elizaPlugin, ...resolvedPlugins],
  logLevel: "error",
  // sandboxMode and sandboxAuditHandler are only included when sandbox is active
  ...(isSandboxActive && {
    sandboxMode: true,
    sandboxAuditHandler: handleSandboxAudit,
  }),
  settings: {
    VALIDATION_LEVEL: "fast",
    MODEL_PROVIDER: "anthropic/claude-sonnet-4.6",
    BUNDLED_SKILLS_DIRS: "/path/to/skills",
    WORKSPACE_SKILLS_DIR: "~/.eliza/workspace/skills",
    SKILLS_ALLOWLIST: "skill-a,skill-b",
    SKILLS_DENYLIST: "skill-x",
  },
});
```

<div id="constructor-parameters">
### 构造函数参数
</div>

| 参数 | 类型 | 描述 |
|---|---|---|
| `character` | `Character` | 代理的身份、个性和密钥。由 `buildCharacterFromConfig()` 构建。 |
| `actionPlanning` | `boolean` | 启用操作规划子系统。Eliza 将其设为 `true`。 |
| `plugins` | `Plugin[]` | 有序的插件数组。Eliza 插件排在第一位，然后是已解析的插件。 |
| `logLevel` | `string` | 日志详细程度：`"trace"`、`"debug"`、`"info"`、`"warn"`、`"error"`、`"fatal"`。从 `config.logging.level` 解析。 |
| `sandboxMode` | `boolean` | 启用沙箱令牌替换以进行审计日志记录。仅在 `isSandboxActive` 为真时（即 `agents.defaults.sandbox.mode != "off"`）在构造函数中包含。当沙箱关闭时，不传递此参数。 |
| `sandboxAuditHandler` | `function` | 沙箱 fetch 审计事件的回调。接收 `{ direction, url, tokenIds }`。 |
| `settings` | `Record<string, string>` | 通过 `runtime.getSetting()` 传递给插件的运行时设置。 |

<div id="key-settings">
## 关键设置
</div>

| 设置键 | 来源 | 描述 |
|---|---|---|
| `VALIDATION_LEVEL` | 硬编码 | 设为 `"fast"` — 控制 elizaOS 验证深度 |
| `MODEL_PROVIDER` | `agents.defaults.model.primary` | 主模型选择（例如 `"anthropic/claude-sonnet-4.6"`） |
| `BUNDLED_SKILLS_DIRS` | `@elizaos/skills` 包 | 内置技能目录的绝对路径 |
| `WORKSPACE_SKILLS_DIR` | 工作区路径 + `/skills` | 每个代理的技能覆盖目录 |
| `EXTRA_SKILLS_DIRS` | `skills.load.extraDirs` | 来自配置的额外技能目录 |
| `SKILLS_ALLOWLIST` | `skills.allowBundled` | 逗号分隔的允许内置技能列表 |
| `SKILLS_DENYLIST` | `skills.denyBundled` | 逗号分隔的拒绝内置技能列表 |
| `DISABLE_IMAGE_DESCRIPTION` | `features.vision == false` | 即使云插件已加载也阻止图像描述 |

<div id="plugin-registration">
## 插件注册
</div>

Eliza 分两个阶段注册插件：

<div id="phase-1-pre-registration-sequential">
### 阶段 1：预注册（顺序）
</div>

```typescript
// 1. SQL plugin — must be first so DB adapter is ready
// Wrapped in registerSqlPluginWithRecovery() which catches PGLite corruption,
// resets the data directory, and retries registration once.
await registerSqlPluginWithRecovery(runtime, sqlPlugin.plugin, config);
await initializeDatabaseAdapter(runtime, config);

// 2. Local embedding — must be second so TEXT_EMBEDDING handler is ready
configureLocalEmbeddingPlugin(localEmbeddingPlugin.plugin, config);
await runtime.registerPlugin(localEmbeddingPlugin.plugin);
```

<Note>
**SQL 插件恢复**：`registerSqlPluginWithRecovery()` 将 SQL 插件注册包装在 try/catch 中。如果由于 PGLite 状态损坏导致初始注册失败，包装器会删除 PGLite 数据目录、记录警告并从头重试注册。这防止代理在崩溃损坏本地数据库后永久卡住。
</Note>

<div id="phase-2-full-initialization-parallel">
### 阶段 2：完整初始化（并行）
</div>

```typescript
// All remaining plugins initialize in parallel
await runtime.initialize();
```

`runtime.initialize()` 对每个已注册的插件调用 `init()` 并启动所有已注册的服务。

<div id="plugin-export-detection">
## 插件导出检测
</div>

`src/runtime/eliza.ts` 中的 `findRuntimePluginExport()` 使用优先级顺序从动态导入的模块中定位 Plugin 导出：

```
1. module.default   (ES 模块默认导出)
2. module.plugin    (命名导出 "plugin")
3. module itself    (CJS 默认模式)
4. Named exports ending in "Plugin" or starting with "plugin"
5. Other named exports that match Plugin shape
6. Minimal { name, description } exports for named keys matching "plugin"
```

<div id="plugin-shape-validation">
## 插件形状验证
</div>

当模块导出具有 `name` 和 `description` 字段且至少具有以下之一时，将被接受为 Plugin：

```typescript
Array.isArray(obj.services) ||
Array.isArray(obj.providers) ||
Array.isArray(obj.actions) ||
Array.isArray(obj.routes) ||
Array.isArray(obj.events) ||
typeof obj.init === "function"
```

<div id="collectpluginnames">
## collectPluginNames
</div>

`collectPluginNames(config)` 生成要加载的完整插件包名称集合：

```typescript
// Core plugins — always loaded
const pluginsToLoad = new Set<string>(CORE_PLUGINS);

// allow list — additive, not exclusive
for (const item of config.plugins?.allow ?? []) {
  pluginsToLoad.add(CHANNEL_PLUGIN_MAP[item] ?? OPTIONAL_PLUGIN_MAP[item] ?? item);
}

// Connector plugins — from config.connectors entries
for (const [channelName] of Object.entries(connectors)) {
  pluginsToLoad.add(CHANNEL_PLUGIN_MAP[channelName]);
}

// Provider plugins — from environment variables
for (const [envKey, pluginName] of Object.entries(PROVIDER_PLUGIN_MAP)) {
  if (process.env[envKey]) pluginsToLoad.add(pluginName);
}

// Feature flags
for (const [featureName, enabled] of Object.entries(config.features ?? {})) {
  if (enabled) pluginsToLoad.add(OPTIONAL_PLUGIN_MAP[featureName]);
}
```

<Note>
**Eliza Cloud 插件排除**：当 Eliza Cloud 被有效启用时（云 API 密钥已设置且云插件已加载），直接 AI 提供者插件（例如 `@elizaos/plugin-anthropic`、`@elizaos/plugin-openai`）会从加载集合中移除。云插件通过 Eliza Cloud 代理模型请求，因此加载单独的提供者插件是多余的，可能导致路由冲突。
</Note>

<div id="channel-to-plugin-mapping">
## 通道到插件的映射
</div>

```typescript
const CHANNEL_PLUGIN_MAP = {
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
};
```

<div id="provider-to-plugin-mapping">
## 提供者到插件的映射
</div>

```typescript
const PROVIDER_PLUGIN_MAP = {
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
  ZAI_API_KEY:                    "@elizaos/plugin-zai",
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

};
```

<div id="error-boundaries">
## 错误边界
</div>

每个插件的 `init()` 和 `providers` 通过 `wrapPluginWithErrorBoundary()` 包装了错误边界。`init()` 中的崩溃会记录错误并将插件置于降级模式。提供者的 `get()` 中的崩溃会返回错误标记文本而不是抛出异常：

```typescript
return {
  text: `[Provider ${provider.name} error: ${msg}]`,
  data: { _providerError: true },
};
```

<div id="method-bindings">
## 方法绑定
</div>

`installRuntimeMethodBindings()` 将某些运行时方法绑定到运行时实例，以防止在插件存储和调用方法时丢失 `this` 上下文：

```typescript
runtime.getConversationLength = runtime.getConversationLength.bind(runtime);
```

<div id="configuration-cascade">
## 配置级联
</div>

配置值按以下优先级顺序从多个来源级联：

```
process.env（最高优先级）
  ↓
eliza.json（配置文件）
  ↓
AgentRuntime settings 对象
  ↓
插件默认值（最低优先级）
```

<div id="related-pages">
## 相关页面
</div>

- [运行时和生命周期](/zh/agents/runtime-and-lifecycle) — 完整的启动序列
- [服务](/zh/runtime/services) — 服务注册和生命周期
- [提供者](/zh/runtime/providers) — 提供者接口和上下文注入
- [模型](/zh/runtime/models) — 模型提供者选择和配置

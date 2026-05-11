---
title: "Core Runtime"
sidebarTitle: "Core"
description: "AgentRuntime class, constructor parameters, plugin registration, and the Eliza configuration cascade."
---

The `AgentRuntime` class from `@elizaos/core` is the central object that manages plugin registration, message processing, provider context assembly, and service lifecycle. Eliza wraps it with additional bootstrap logic in `eliza/packages/agent/src/runtime/eliza.ts`.

## AgentRuntime Constructor

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

### Constructor Parameters

| Parameter | Type | Description |
|---|---|---|
| `character` | `Character` | The agent's identity, personality, and secrets. Built by `buildCharacterFromConfig()`. |
| `actionPlanning` | `boolean` | Enable the action planning subsystem. Eliza sets this to `true`. |
| `plugins` | `Plugin[]` | Ordered array of plugins. Eliza plugin comes first, then resolved plugins. |
| `logLevel` | `string` | Log verbosity: `"trace"`, `"debug"`, `"info"`, `"warn"`, `"error"`, `"fatal"`. Resolved from `config.logging.level`. |
| `sandboxMode` | `boolean` | Enable sandbox token replacement for audit logging. Only spread-included in the constructor when `isSandboxActive` is true (i.e., `agents.defaults.sandbox.mode != "off"`). When sandbox is off, this parameter is not passed at all. |
| `sandboxAuditHandler` | `function` | Callback for sandbox fetch audit events. Receives `{ direction, url, tokenIds }`. |
| `settings` | `Record<string, string>` | Runtime settings passed to plugins via `runtime.getSetting()`. |

## Key Settings

| Setting Key | Source | Description |
|---|---|---|
| `VALIDATION_LEVEL` | Hardcoded | Set to `"fast"` — controls elizaOS validation depth |
| `MODEL_PROVIDER` | `agents.defaults.model.primary` | Primary model selection (e.g., `"anthropic/claude-sonnet-4.6"`) |
| `BUNDLED_SKILLS_DIRS` | `@elizaos/skills` package | Absolute path to bundled skills directory |
| `WORKSPACE_SKILLS_DIR` | workspace path + `/skills` | Per-agent skills override directory |
| `EXTRA_SKILLS_DIRS` | `skills.load.extraDirs` | Additional skill directories from config |
| `SKILLS_ALLOWLIST` | `skills.allowBundled` | Comma-separated list of allowed bundled skills |
| `SKILLS_DENYLIST` | `skills.denyBundled` | Comma-separated list of denied bundled skills |
| `DISABLE_IMAGE_DESCRIPTION` | `features.vision == false` | Prevents image description even when the cloud plugin is loaded |

## Plugin Registration

Eliza registers plugins in two phases:

### Phase 1: Pre-registration (sequential)

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
**SQL plugin recovery**: `registerSqlPluginWithRecovery()` wraps the SQL plugin registration in a try/catch. If the initial registration fails due to corrupted PGLite state, the wrapper deletes the PGLite data directory, logs a warning, and retries registration from scratch. This prevents the agent from being permanently stuck after a crash corrupts the local database.
</Note>

### Phase 2: Full initialization (parallel)

```typescript
// All remaining plugins initialize in parallel
await runtime.initialize();
```

`runtime.initialize()` calls `init()` on each registered plugin and starts all registered services.

## Plugin Export Detection

`findRuntimePluginExport()` in `eliza/packages/agent/src/runtime/eliza.ts` locates the Plugin export from a dynamically-imported module using a priority order:

```
1. module.default   (ES module default export)
2. module.plugin    (named "plugin" export)
3. module itself    (CJS default pattern)
4. Named exports ending in "Plugin" or starting with "plugin"
5. Other named exports that match Plugin shape
6. Minimal { name, description } exports for named keys matching "plugin"
```

## Plugin Shape Validation

A module export is accepted as a Plugin when it has both `name` and `description` fields plus at least one of:

```typescript
Array.isArray(obj.services) ||
Array.isArray(obj.providers) ||
Array.isArray(obj.actions) ||
Array.isArray(obj.routes) ||
Array.isArray(obj.events) ||
typeof obj.init === "function"
```

## collectPluginNames

`collectPluginNames(config)` produces the complete set of plugin package names to load:

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
**Eliza Cloud plugin exclusion**: When Eliza Cloud is effectively enabled (cloud API key is set and the cloud plugin is loaded), direct AI provider plugins (e.g., `@elizaos/plugin-anthropic`, `@elizaos/plugin-openai`) are removed from the load set. The cloud plugin proxies model requests through Eliza Cloud, so loading individual provider plugins would be redundant and could cause routing conflicts.
</Note>

## Channel to Plugin Mapping

> **Note:** Not all plugins in this map are bundled with Eliza. `twitter` (`@elizaos/plugin-x`) and `lens` (`@elizaos/plugin-lens`) are upstream elizaOS plugins that must be installed manually. `wechat` (added by Eliza's `app-core`) is experimental. See the [connectors availability table](/guides/connectors#supported-platforms).

```typescript
const CHANNEL_PLUGIN_MAP = {
  telegram:    "@elizaos/plugin-telegram",
  discord:     "@elizaos/plugin-discord",
  slack:       "@elizaos/plugin-slack",
  twitter:     "@elizaos/plugin-x",     // upstream, not bundled
  whatsapp:    "@elizaos/plugin-whatsapp",
  signal:      "@elizaos/plugin-signal",
  imessage:    "@elizaos/plugin-imessage",
  farcaster:   "@elizaos/plugin-farcaster",
  lens:        "@elizaos/plugin-lens",         // upstream, not bundled
  msteams:     "@elizaos/plugin-msteams",
  mattermost:  "@elizaos/plugin-mattermost",
  googlechat:  "@elizaos/plugin-google-chat",
  feishu:      "@elizaos/plugin-feishu",
  matrix:      "@elizaos/plugin-matrix",
  nostr:       "@elizaos/plugin-nostr",
  blooio:      "@elizaos/plugin-blooio",
  twitch:      "@elizaos/plugin-twitch",
  wechat:      "@elizaos/plugin-wechat",       // experimental
};
```

## Provider to Plugin Mapping

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

## Error Boundaries

Each plugin's `init()` and `providers` are wrapped with error boundaries via `wrapPluginWithErrorBoundary()`. A crash in `init()` logs the error and puts the plugin in degraded mode. A crash in a provider's `get()` returns an error marker text rather than throwing:

```typescript
return {
  text: `[Provider ${provider.name} error: ${msg}]`,
  data: { _providerError: true },
};
```

## Method Bindings

`installRuntimeMethodBindings()` binds certain runtime methods to the runtime instance to prevent `this` context loss when the method is stored and invoked by plugins:

```typescript
runtime.getConversationLength = runtime.getConversationLength.bind(runtime);
```

## Configuration Cascade

Config values cascade from multiple sources in this priority order:

```
process.env (highest priority)
  ↓
eliza.json (config file)
  ↓
AgentRuntime settings object
  ↓
Plugin defaults (lowest priority)
```

## Related Pages

- [Runtime and Lifecycle](/agents/runtime-and-lifecycle) — the full boot sequence
- [Services](/runtime/services) — service registration and lifecycle
- [Providers](/runtime/providers) — provider interface and context injection
- [Models](/runtime/models) — model provider selection and configuration

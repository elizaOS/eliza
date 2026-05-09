---
title: "Plugin Architecture"
sidebarTitle: "Architecture"
description: "Deep dive into Eliza's plugin system — registration lifecycle, hook points, auto-enable mechanism, and dependency resolution."
---

The Eliza plugin system is built on elizaOS core. Every capability beyond the base runtime — model providers, platform connectors, DeFi integrations, scheduling, and custom features — is delivered as a plugin.

> **Path convention:** Paths like `packages/agent/` and `packages/app-core/` below refer to directories inside the `eliza/` git submodule.

## System Design

Plugins are isolated modules that register capabilities with the `AgentRuntime`. The runtime orchestrates plugin loading, dependency resolution, initialization, and shutdown.

```
AgentRuntime
├── Core Plugins     (always loaded)
├── Auto-enabled     (triggered by env vars / config)
├── Character        (specified in character file)
└── Local            (from plugins/ directory)
```

The source of truth for which plugins are always loaded lives in the elizaOS submodule at `eliza/packages/agent/src/runtime/core-plugins.ts` (re-exported by `eliza/packages/app-core/src/runtime/core-plugins.ts`). Initialize the submodule with `bun run setup:upstreams` to inspect these files locally.

```typescript
export const CORE_PLUGINS: readonly string[] = [
  "@elizaos/plugin-sql",               // database adapter — required
  "@elizaos/plugin-local-embedding",   // local embeddings — required for memory
  "@elizaos/app-companion",            // VRM companion emotes
  "@elizaos/plugin-shell",             // shell command execution
  "@elizaos/plugin-coding-tools",      // native Read/Write/Edit/Bash/Grep/Glob (desktop; CODING_TOOLS_DISABLE)
  "@elizaos/plugin-agent-skills",      // skill execution and marketplace runtime
  "@elizaos/plugin-commands",          // slash command handling
  "@elizaos/app-lifeops",             // LifeOps: tasks, goals, calendar, inbox
  "@elizaos/plugin-browser",    // Chrome/Safari companion pairing
];
```

> **Note:** Several capabilities that were previously standalone plugins are now built-in runtime features: experience, form, clipboard, personality (advanced capabilities via `advancedCapabilities: true`), trust (via `enableTrust: true`), secrets (via `enableSecretsManager: true`), plugin-manager (via `enablePluginManager: true`), knowledge, relationships, and trajectories (native features). The agent-orchestrator is opt-in via `ELIZA_AGENT_ORCHESTRATOR` (Eliza app enables by default).

### Optional Core Plugins

A separate list of optional core plugins can be enabled from the admin panel. These are not loaded by default due to packaging or specification constraints. The list lives in `eliza/packages/agent/src/runtime/core-plugins.ts`:

```typescript
export const OPTIONAL_CORE_PLUGINS: readonly string[] = [
  "@elizaos/plugin-pdf",                   // PDF processing
  "@elizaos/plugin-cua",                   // CUA computer-use agent (cloud sandbox automation)
  "@elizaos/plugin-obsidian",              // Obsidian vault CLI integration
  "@elizaos/plugin-repoprompt",            // RepoPrompt CLI integration and workflow orchestration
  "@elizaos/plugin-computeruse",           // computer use automation (requires platform-specific binaries)
  "@elizaos/plugin-browser",              // browser automation (requires stagehand-server)
  "@elizaos/plugin-vision",               // vision/image understanding (feature-gated)
  "@elizaos/plugin-cli",                  // CLI interface
  "@elizaos/plugin-discord",              // Discord bot integration
  "@elizaos/plugin-discord-local",        // Local Discord desktop integration for macOS
  "@elizaos/plugin-bluebubbles",          // BlueBubbles-backed iMessage integration for macOS
  "@elizaos/plugin-telegram",             // Telegram bot integration
  "@elizaos/plugin-signal",               // Signal user-account integration
  "@elizaos/plugin-twitch",               // Twitch integration
  "@elizaos/plugin-edge-tts",             // text-to-speech (Microsoft Edge TTS)
  "@elizaos/plugin-elevenlabs",           // ElevenLabs text-to-speech
  "@elizaos/plugin-music-library",        // music metadata, library, playlists
  "@elizaos/plugin-music-player",         // music playback engine + streaming routes
];
```

Plugins such as `@elizaos/plugin-directives`, `@elizaos/plugin-mcp`, and `@elizaos/plugin-scheduling` are commented out in the source and may be activated in future releases.

## Plugin Hook Points

A plugin can register any combination of the following hook points:

| Hook | Type | Purpose |
|------|------|---------|
| `actions` | `Action[]` | Things the agent can do; the LLM selects actions from this list |
| `providers` | `Provider[]` | Context injected into the prompt before each LLM call |
| `evaluators` | `Evaluator[]` | Post-response assessment; can trigger follow-up actions |
| `services` | `ServiceClass[]` | Long-running background processes |
| `routes` | `Route[]` | HTTP endpoints exposed by the agent API server |
| `events` | `Record<EventName, Handler[]>` | Callbacks for runtime events |
| `models` | `Record<ModelType, Handler>` | Custom model inference handlers |

## Registration Lifecycle

```
1. Resolve      — Plugin package is located (npm, local, workspace)
2. Import       — Module is dynamically imported and shape is validated
3. Sort         — Plugins are ordered by dependencies and priority field
4. Init         — plugin.init(config, runtime) is called
5. Register     — actions, providers, services, routes, events are registered
6. Active       — Plugin responds to messages and events
7. Shutdown     — plugin.cleanup() / service.stop() called on exit
```

### Plugin Interface

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

## Auto-Enable Mechanism

Plugins are automatically enabled when their required configuration is detected. This logic lives in `packages/agent/src/config/plugin-auto-enable.ts` (extended by `packages/app-core/src/config/plugin-auto-enable.ts` for Eliza-specific connectors like WeChat) and runs before runtime initialization.

### Trigger Sources

**Environment variable API keys** — The `AUTH_PROVIDER_PLUGINS` map connects env vars to plugin package names. Plugins marked with `// bundled` ship in `plugins.json`; others require the upstream elizaOS registry or explicit installation:

```typescript
const AUTH_PROVIDER_PLUGINS = {
  ANTHROPIC_API_KEY:              "@elizaos/plugin-anthropic",           // bundled
  CLAUDE_API_KEY:                 "@elizaos/plugin-anthropic",           // bundled
  OPENAI_API_KEY:                 "@elizaos/plugin-openai",              // bundled
  AI_GATEWAY_API_KEY:             "@elizaos/plugin-vercel-ai-gateway",   // bundled
  AIGATEWAY_API_KEY:              "@elizaos/plugin-vercel-ai-gateway",   // bundled
  GOOGLE_API_KEY:                 "@elizaos/plugin-google-genai",        // bundled
  GOOGLE_GENERATIVE_AI_API_KEY:   "@elizaos/plugin-google-genai",        // bundled
  GOOGLE_CLOUD_API_KEY:           "@elizaos/plugin-google-antigravity",  // upstream
  GROQ_API_KEY:                   "@elizaos/plugin-groq",                // bundled
  XAI_API_KEY:                    "@elizaos/plugin-xai",                 // bundled
  GROK_API_KEY:                   "@elizaos/plugin-xai",                 // bundled
  OPENROUTER_API_KEY:             "@elizaos/plugin-openrouter",          // bundled
  OLLAMA_BASE_URL:                "@elizaos/plugin-ollama",              // bundled
  ZAI_API_KEY:                    "@homunculuslabs/plugin-zai",          // upstream
  DEEPSEEK_API_KEY:               "@elizaos/plugin-deepseek",            // upstream
  TOGETHER_API_KEY:               "@elizaos/plugin-together",            // upstream
  MISTRAL_API_KEY:                "@elizaos/plugin-mistral",             // upstream
  COHERE_API_KEY:                 "@elizaos/plugin-cohere",              // upstream
  PERPLEXITY_API_KEY:             "@elizaos/plugin-perplexity",          // upstream
  ELIZAOS_CLOUD_API_KEY:          "@elizaos/plugin-elizacloud",          // bundled
  ELIZAOS_CLOUD_ENABLED:          "@elizaos/plugin-elizacloud",          // bundled
  CUA_API_KEY:                    "@elizaos/plugin-cua",                 // bundled
  CUA_HOST:                       "@elizaos/plugin-cua",                 // bundled
  OBSIDIAN_VAULT_PATH:            "@elizaos/plugin-obsidian",            // bundled
  REPOPROMPT_CLI_PATH:            "@elizaos/plugin-repoprompt",          // bundled
};
```

> **Note:** Upstream plugins (DeepSeek, Together, Mistral, Cohere, Perplexity, Google Antigravity, Zai) are not included in the bundled `plugins.json`. Setting their env var will attempt to resolve them from the upstream elizaOS registry at runtime. Install them explicitly with `eliza plugins install <package>` if auto-resolution fails.

**Connector configuration** — Connector blocks with a `botToken`, `token`, or `apiKey` field auto-enable the corresponding connector plugin:

```typescript
const CONNECTOR_PLUGINS = {
  telegram:    "@elizaos/plugin-telegram",      // bundled
  discord:     "@elizaos/plugin-discord",        // bundled
  slack:       "@elizaos/plugin-slack",           // bundled
  twitter:     "@elizaos/plugin-x",         // upstream (not in plugins.json)
  whatsapp:    "@elizaos/plugin-whatsapp",        // bundled
  signal:      "@elizaos/plugin-signal",          // bundled
  imessage:    "@elizaos/plugin-imessage",        // bundled
  farcaster:   "@elizaos/plugin-farcaster",       // bundled
  lens:        "@elizaos/plugin-lens",            // upstream (not in plugins.json)
  msteams:     "@elizaos/plugin-msteams",         // bundled
  mattermost:  "@elizaos/plugin-mattermost",      // bundled
  googlechat:  "@elizaos/plugin-google-chat",     // bundled
  feishu:      "@elizaos/plugin-feishu",          // bundled
  matrix:      "@elizaos/plugin-matrix",          // bundled
  nostr:       "@elizaos/plugin-nostr",           // bundled
  blooio:      "@elizaos/plugin-blooio",          // bundled (feature category)
  twitch:      "@elizaos/plugin-twitch",          // bundled
  wechat:      "@elizaos/plugin-wechat",          // upstream (Eliza-specific, not in plugins.json)
};
```

> **Note:** The upstream `packages/agent` defines all `@elizaos/*` connectors. Eliza's `packages/app-core` extends this map with the `wechat` entry. Connectors marked "upstream" are not in the bundled `plugins.json` — they resolve from the upstream elizaOS registry at runtime. Install them explicitly if auto-resolution fails.

**Feature flags** — The `features` section of `eliza.json` auto-enables feature plugins. A feature can be enabled with `features.<name>: true` or `features.<name>.enabled: true`:

```json
{
  "features": {
    "browser": true,
    "imageGen": true,
    "tts": { "enabled": true }
  }
}
```

The complete `FEATURE_PLUGINS` map. Plugins marked with `*` are upstream-only (not in the bundled `plugins.json`):

```typescript
const FEATURE_PLUGINS = {
  browser:              "@elizaos/plugin-browser",
  cua:                  "@elizaos/plugin-cua",                   // * upstream-only
  obsidian:             "@elizaos/plugin-obsidian",              // * upstream-only
  shell:                "@elizaos/plugin-shell",
  executeCode:          "@elizaos/plugin-executecode",
  imageGen:             "@elizaos/plugin-image-generation",
  tts:                  "@elizaos/plugin-edge-tts",
  stt:                  "@elizaos/plugin-stt",
  agentSkills:          "@elizaos/plugin-agent-skills",
  commands:             "@elizaos/plugin-commands",
  diagnosticsOtel:      "@elizaos/plugin-diagnostics-otel",      // * upstream-only
  webhooks:             "@elizaos/plugin-webhooks",
  gmailWatch:           "@elizaos/plugin-gmail-watch",
  x402:                 "@elizaos/plugin-x402",
  fal:                  "@elizaos/plugin-fal",
  suno:                 "@elizaos/plugin-suno",
  musicLibrary:         "@elizaos/plugin-music-library",
  musicPlayer:          "@elizaos/plugin-music-player",
  vision:               "@elizaos/plugin-vision",
  computeruse:          "@elizaos/plugin-computeruse",
  repoprompt:           "@elizaos/plugin-repoprompt",            // * upstream-only
};
```

> **Note:** `personality`, `experience`, and `form` are no longer separate feature plugins -- they are now built-in advanced capabilities enabled via `advancedCapabilities: true` in the character settings.

**Streaming destinations** — The `streaming` section of config auto-enables streaming plugins for live video platforms:

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

**Auth profiles** — Auth profiles specifying a provider name trigger loading of the matching provider plugin.

### Opting Out

Individual plugins can be disabled even when their env vars are present:

```json
{
  "plugins": {
    "entries": {
      "anthropic": { "enabled": false }
    }
  }
}
```

Setting `plugins.enabled: false` in config disables auto-enable for all optional plugins.

## Dependency Resolution

Plugins are sorted topologically before initialization. If plugin B lists plugin A in its `dependencies` array, A will always initialize before B.

The `priority` field provides coarse ordering independent of dependency edges. Lower priority values initialize earlier (default: `0`).

## Plugin Isolation

Each plugin receives:

- A reference to the shared `AgentRuntime` (read-only access to other plugins' registered capabilities)
- Its own configuration namespace
- Secrets injected by the secrets manager at init time

Plugins do not share mutable state directly — they communicate through the runtime's service registry and event system.

## Module Shape

When a plugin package is dynamically imported, `findRuntimePluginExport()` locates the Plugin export using this priority order:

1. `module.default` — ES module default export
2. `module.plugin` — named `plugin` export
3. `module` itself — CJS default pattern
4. Named exports ending in `Plugin` or starting with `plugin`
5. Other named exports matching the Plugin interface shape
6. Minimal `{ name, description }` exports for named keys matching `plugin`

A module export is accepted as a Plugin when it has both `name` and `description` fields plus at least one of `services`, `providers`, `actions`, `routes`, `events` (as arrays), or `init` (as a function).

## Related

- [Create a Plugin](/plugins/create-a-plugin) — Build a plugin from scratch
- [Plugin Patterns](/plugins/patterns) — Common implementation patterns
- [Plugin Schemas](/plugins/schemas) — Full schema reference
- [Plugin Registry](/plugins/registry) — Browse available plugins

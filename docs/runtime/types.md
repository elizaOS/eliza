---
title: "Types"
sidebarTitle: "Types"
description: "Key TypeScript type definitions: ElizaConfig, AgentConfig, AgentRuntime interfaces, Character, Plugin, Provider, Hook, Trigger, and more."
---

This page is a quick reference for the key TypeScript types used across the Eliza codebase. Types from `@elizaos/core` are noted as such; types defined in the `eliza/packages/` source tree are Eliza-specific.

## ElizaConfig

The root configuration type for the config file (defaults to `eliza.json` in this product). All fields are optional.

```typescript
// eliza/packages/shared/src/config/types.eliza.ts
export type ElizaConfig = {
  meta?:         { onboardingComplete?: boolean; lastTouchedVersion?: string; lastTouchedAt?: string };
  auth?:         AuthConfig;
  env?:          {
    shellEnv?: { enabled?: boolean; timeoutMs?: number };
    vars?: Record<string, string>;
    [key: string]: string | Record<string, string>
                 | { enabled?: boolean; timeoutMs?: number }
                 | undefined;
  };
  wizard?:       { lastRunAt?: string; lastRunVersion?: string; lastRunCommit?: string;
                   lastRunCommand?: string; lastRunMode?: "local" | "remote" };
  diagnostics?:  DiagnosticsConfig;
  logging?:      LoggingConfig;
  update?:       UpdateConfig;
  browser?:      BrowserConfig;
  ui?:           {
    seamColor?: string;
    theme?: "eliza" | "qt314" | "web2000" | "programmer" | "haxor" | "psycho";
    assistant?: { name?: string; avatar?: string };
    avatarIndex?: number;
    language?: string;
    presetId?: string;
    ownerName?: string;
  };
  knowledge?:    KnowledgeConfig;
  roles?:        RolesConfig;
  skills?:       SkillsConfig;
  plugins?:      PluginsConfig;
  models?:       ModelsConfig;
  nodeHost?:     NodeHostConfig;
  agents?:       AgentsConfig;
  tools?:        ToolsConfig;
  bindings?:     AgentBinding[];
  broadcast?:    BroadcastConfig;
  audio?:        AudioConfig;
  messages?:     MessagesConfig;
  commands?:     CommandsConfig;
  approvals?:    ApprovalsConfig;
  session?:      SessionConfig;
  web?:          WebConfig;
  connectors?:   Record<string, ConnectorConfig>;
  channels?:     Record<string, ConnectorConfig>; // deprecated alias for connectors
  cron?:         CronConfig;
  hooks?:        HooksConfig;
  discovery?:    DiscoveryConfig;
  talk?:         TalkConfig;
  gateway?:      GatewayConfig;
  memory?:       MemoryConfig;
  embedding?:    EmbeddingConfig;
  database?:     DatabaseConfig;
  cloud?:        CloudConfig;
  x402?:         X402Config;
  media?:        MediaConfig;
  mcp?:          { servers?: Record<string, MCPServerConfig> };
  registry?:     { mainnetRpc?: string; registryAddress?: string; collectionAddress?: string };
  features?:     Record<string, boolean | { enabled?: boolean; [k: string]: unknown }>;
  customActions?: CustomActionDef[];
};
```

## AgentConfig

Per-agent configuration stored in `agents.list[]`:

```typescript
// eliza/packages/shared/src/config/types.agents.ts
export type AgentConfig = {
  id: string;
  default?: boolean;
  name?: string;
  workspace?: string;
  agentDir?: string;
  model?: AgentModelConfig;       // string or { primary?, fallbacks? }
  skills?: string[];
  memorySearch?: MemorySearchConfig;
  humanDelay?: HumanDelayConfig;
  heartbeat?: AgentDefaultsConfig["heartbeat"];
  identity?: IdentityConfig;
  groupChat?: GroupChatConfig;
  // Personality (set during onboarding)
  bio?: string[];
  system?: string;
  style?: { all?: string[]; chat?: string[]; post?: string[] };
  adjectives?: string[];
  topics?: string[];
  postExamples?: string[];
  messageExamples?: Array<Array<{ user: string; content: { text: string } }>>;
  subagents?: {
    allowAgents?: string[];
    model?: string | { primary?: string; fallbacks?: string[] };
  };
  // Sandbox
  sandbox?: {
    mode?: "off" | "non-main" | "all";
    workspaceAccess?: "none" | "ro" | "rw";
    sessionToolsVisibility?: "spawned" | "all";
    scope?: "session" | "agent" | "shared";
    perSession?: boolean;
    workspaceRoot?: string;
    docker?: SandboxDockerSettings;
    browser?: SandboxBrowserSettings;
    prune?: SandboxPruneSettings;
  };
  tools?: AgentToolsConfig;
  cloud?: { cloudAgentId?: string; lastStatus?: string; lastProvisionedAt?: string };
};
```

## AgentsConfig

```typescript
export type AgentsConfig = {
  defaults?: AgentDefaultsConfig;
  list?: AgentConfig[];
};
```

## Character (elizaOS Core)

The Character object passed to `AgentRuntime`. Built by `buildCharacterFromConfig()`:

```typescript
// @elizaos/core
interface Character {
  name: string;
  bio: string[];
  system?: string;
  style?: {
    all?: string[];
    chat?: string[];
    post?: string[];
  };
  adjectives?: string[];
  topics?: string[];
  postExamples?: string[];
  messageExamples?: Array<Array<{ name: string; content: { text: string } }>>;
  secrets?: Record<string, string>;
  settings?: Record<string, string | boolean | number>;
}
```

## Plugin (elizaOS Core)

```typescript
// @elizaos/core
interface Plugin {
  name: string;
  description: string;
  init?: (config: Record<string, unknown>, runtime: IAgentRuntime) => Promise<void>;
  providers?: Provider[];
  actions?: Action[];
  services?: Service[];
  routes?: Route[];
  events?: EventHandler[];
}
```

## Provider (elizaOS Core)

```typescript
// @elizaos/core
interface Provider {
  name: string;
  description?: string;
  get(runtime: IAgentRuntime, message: Memory, state: State): Promise<ProviderResult>;
}

interface ProviderResult {
  text?: string;
  data?: Record<string, unknown>;
}
```

## Service (elizaOS Core)

```typescript
// @elizaos/core
interface Service {
  serviceType: string;
  initialize(runtime: IAgentRuntime): Promise<void>;
  stop?(): Promise<void>;
}
```

## ElizaPluginConfig

```typescript
// eliza/packages/agent/src/runtime/eliza-plugin.ts
export type ElizaPluginConfig = {
  workspaceDir?: string;
  initMaxChars?: number;
  sessionStorePath?: string;
  agentId?: string;
};
```

## HookEvent

```typescript
// eliza/packages/agent/src/hooks/types.ts
export interface HookEvent {
  type: "command" | "session" | "agent" | "gateway";
  action: string;
  sessionKey: string;
  timestamp: Date;
  messages: string[];
  context: Record<string, unknown>;
}

export type HookHandler = (event: HookEvent) => Promise<void> | void;
```

## Hook

```typescript
// eliza/packages/agent/src/hooks/types.ts
export interface Hook {
  name: string;
  description: string;
  source: "eliza-bundled" | "eliza-managed" | "eliza-workspace" | "eliza-plugin";
  pluginId?: string;
  filePath: string;
  baseDir: string;
  handlerPath: string;
}
```

## TriggerConfig

```typescript
// @elizaos/core (re-exported via eliza/packages/agent/src/triggers/types.ts)
export interface TriggerConfig {
  version: 1;
  triggerId: UUID;
  displayName: string;
  instructions: string;
  triggerType: "interval" | "once" | "cron";
  enabled: boolean;
  wakeMode: "inject_now" | "next_autonomy_cycle";
  createdBy: string;
  timezone?: string;
  intervalMs?: number;
  scheduledAtIso?: string;
  cronExpression?: string;
  maxRuns?: number;
  runCount: number;
  dedupeKey?: string;
  nextRunAtMs?: number;
  lastRunAtIso?: string;
  lastStatus?: "success" | "error" | "skipped";
  lastError?: string;
  kind?: "text" | "workflow";
  workflowId?: string;
  workflowName?: string;
}
```

## PluginsConfig

```typescript
// eliza/packages/shared/src/config/types.eliza.ts
export type PluginsConfig = {
  enabled?: boolean;
  allow?: string[];
  deny?: string[];
  load?: { paths?: string[] };
  slots?: { memory?: string };
  entries?: Record<string, { enabled?: boolean; config?: Record<string, unknown> }>;
  installs?: Record<string, PluginInstallRecord>;
};

export type PluginInstallRecord = {
  source: "npm" | "archive" | "path";
  spec?: string;
  requestedVersion?: string;
  releaseStream?: "latest" | "alpha";
  sourcePath?: string;
  installPath?: string;
  version?: string;
  installedAt?: string;
};
```

## DatabaseConfig

```typescript
// eliza/packages/shared/src/config/types.eliza.ts
export type DatabaseConfig = {
  provider?: "pglite" | "postgres";
  pglite?: { dataDir?: string };
  postgres?: {
    connectionString?: string;
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
    ssl?: boolean;
  };
};
```

## EmbeddingConfig

```typescript
// eliza/packages/shared/src/config/types.eliza.ts
export type EmbeddingConfig = {
  model?: string;
  modelRepo?: string;
  dimensions?: number;
  contextSize?: number;
  gpuLayers?: number | "auto" | "max";
  idleTimeoutMinutes?: number;
};
```

## HooksConfig

```typescript
// eliza/packages/shared/src/config/types.hooks.ts
export type HooksConfig = {
  enabled?: boolean;
  path?: string;
  token?: string;
  maxBodyBytes?: number;
  presets?: string[];
  transformsDir?: string;
  mappings?: HookMappingConfig[];
  gmail?: HooksGmailConfig;
  internal?: InternalHooksConfig;
};
```

## HookMappingConfig

```typescript
// eliza/packages/shared/src/config/types.hooks.ts
export type HookMappingConfig = {
  id?: string;
  match?: { path?: string; source?: string };
  action?: "wake" | "agent";
  wakeMode?: "now" | "next-heartbeat";
  name?: string;
  sessionKey?: string;
  messageTemplate?: string;
  channel?: "last" | "whatsapp" | "telegram" | "discord" | "googlechat" | "slack" | "signal" | "imessage" | "msteams";
  to?: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
  transform?: { module: string; export?: string };
  allowUnsafeExternalContent?: boolean;
};
```

## MemoryConfig

```typescript
// eliza/packages/shared/src/config/types.eliza.ts
export type MemoryConfig = {
  backend?: "builtin" | "qmd";
  citations?: "auto" | "on" | "off";
  qmd?: MemoryQmdConfig;
};
```

## StartElizaOptions

```typescript
// eliza/packages/agent/src/runtime/eliza.ts
export interface StartElizaOptions {
  headless?: boolean;
  serverOnly?: boolean;
  pgliteRecoveryAttempted?: boolean;
}

export interface BootElizaRuntimeOptions {
  requireConfig?: boolean;
}
```

## ResolvedPlugin (Internal)

```typescript
// eliza/packages/agent/src/runtime/eliza.ts (internal)
interface ResolvedPlugin {
  name: string;   // npm package name
  plugin: Plugin; // Plugin instance
}
```

## Related Pages

- [Character Interface](/agents/character-interface) — Character fields in detail
- [Core Runtime](/runtime/core) — AgentRuntime usage
- [Providers](/runtime/providers) — Provider interface
- [Services](/runtime/services) — Service interface
- [Events](/runtime/events) — HookEvent and HookHandler

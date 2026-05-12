import type {
  RolesConfig,
  SessionConfig,
  SessionSendPolicyConfig,
} from "@elizaos/core";
import type {
  CustomActionDef,
  DatabaseProviderType,
  MediaConfig,
  ReleaseChannel,
} from "../contracts/config.js";
import type {
  DeploymentTargetConfig,
  LinkedAccountFlagsConfig,
  ServiceRoutingConfig,
} from "../contracts/service-routing.js";
import type { AgentBinding, AgentsConfig } from "./types.agents.js";
import type {
  DiscoveryConfig,
  GatewayConfig,
  TalkConfig,
} from "./types.gateway.js";
import type { HooksConfig } from "./types.hooks.js";
import type {
  AudioConfig,
  BroadcastConfig,
  CommandsConfig,
  MessagesConfig,
} from "./types.messages.js";
import type { ToolsConfig } from "./types.tools.js";

export type {
  AudioElevenlabsConfig,
  AudioElevenlabsSfxConfig,
  AudioElevenlabsVoiceSettings,
  AudioFalConfig,
  AudioGenConfig,
  AudioGenProvider,
  AudioKind,
  AudioProviderRoutingConfig,
  AudioSunoConfig,
  CustomActionDef,
  CustomActionHandler,
  DatabaseProviderType,
  ImageConfig,
  ImageFalConfig,
  ImageGoogleConfig,
  ImageOpenaiConfig,
  ImageProvider,
  ImageXaiConfig,
  MediaConfig,
  MediaMode,
  ReleaseChannel,
  VideoConfig,
  VideoFalConfig,
  VideoGoogleConfig,
  VideoOpenaiConfig,
  VideoProvider,
  VisionAnthropicConfig,
  VisionConfig,
  VisionGoogleConfig,
  VisionOllamaConfig,
  VisionOpenaiConfig,
  VisionProvider,
  VisionXaiConfig,
} from "../contracts/config.js";

// --- Auth types (merged from types.auth.ts) ---

export type AuthProfileConfig = {
  provider: string;
  /**
   * Credential type expected in auth-profiles.json for this profile id.
   * - api_key: static provider API key
   * - oauth: refreshable OAuth credentials (access+refresh+expires)
   * - token: static bearer-style token (optionally expiring; no refresh)
   */
  mode: "api_key" | "oauth" | "token";
  email?: string;
};

export type AuthConfig = {
  profiles?: Record<string, AuthProfileConfig>;
  order?: Record<string, string[]>;
  cooldowns?: {
    /** Default billing backoff (hours). Default: 5. */
    billingBackoffHours?: number;
    /** Optional per-provider billing backoff (hours). */
    billingBackoffHoursByProvider?: Record<string, number>;
    /** Billing backoff cap (hours). Default: 24. */
    billingMaxHours?: number;
    /**
     * Failure window for backoff counters (hours). If no failures occur within
     * this window, counters reset. Default: 24.
     */
    failureWindowHours?: number;
  };
};

// --- Browser types (merged from types.browser.ts) ---

export type BrowserProfileConfig = {
  /** CDP port for this profile. Allocated once at creation, persisted permanently. */
  cdpPort?: number;
  /** CDP URL for this profile (use for remote Chrome). */
  cdpUrl?: string;
  /** Profile driver (default: eliza). */
  driver?: "eliza" | "extension";
  /** Profile color (hex). Auto-assigned at creation. */
  color: string;
};
export type BrowserSnapshotDefaults = {
  /** Default snapshot mode (applies when mode is not provided). */
  mode?: "efficient";
};
export type BrowserConfig = {
  enabled?: boolean;
  /** If false, disable browser act:evaluate (arbitrary JS). Default: true */
  evaluateEnabled?: boolean;
  /** Base URL of the CDP endpoint (for remote browsers). Default: loopback CDP on the derived port. */
  cdpUrl?: string;
  /** Remote CDP HTTP timeout (ms). Default: 1500. */
  remoteCdpTimeoutMs?: number;
  /** Remote CDP WebSocket handshake timeout (ms). Default: max(remoteCdpTimeoutMs * 2, 2000). */
  remoteCdpHandshakeTimeoutMs?: number;
  /** Accent color for the eliza browser profile (hex). Default: #FF4500 */
  color?: string;
  /** Override the browser executable path (all platforms). */
  executablePath?: string;
  /** Start Chrome headless (best-effort). Default: false */
  headless?: boolean;
  /** Pass --no-sandbox to Chrome (Linux containers). Default: false */
  noSandbox?: boolean;
  /** If true: never launch; only attach to an existing browser. Default: false */
  attachOnly?: boolean;
  /** Default profile to use when profile param is omitted. Default: "chrome" */
  defaultProfile?: string;
  /** Named browser profiles with explicit CDP ports or URLs. */
  profiles?: Record<string, BrowserProfileConfig>;
  /** Default snapshot options (applied by the browser tool/CLI when unset). */
  snapshotDefaults?: BrowserSnapshotDefaults;
};

// --- Skills types (merged from types.skills.ts) ---

export type SkillConfig = {
  enabled?: boolean;
  apiKey?: string;
  env?: Record<string, string>;
  config?: Record<string, unknown>;
};

export type SkillsLoadConfig = {
  /**
   * Additional skill folders to scan (lowest precedence).
   * Each directory should contain skill subfolders with `SKILL.md`.
   */
  extraDirs?: string[];
  /** Watch skill folders for changes and refresh the skills snapshot. */
  watch?: boolean;
  /** Debounce for the skills watcher (ms). */
  watchDebounceMs?: number;
};

export type SkillsInstallConfig = {
  preferBrew?: boolean;
  nodeManager?: "npm" | "yarn" | "bun";
};

export type SkillsConfig = {
  /** Optional bundled-skill allowlist (only these bundled skills load). */
  allowBundled?: string[];
  /** Skills to explicitly deny/block from loading (takes priority over allow). */
  denyBundled?: string[];
  load?: SkillsLoadConfig;
  install?: SkillsInstallConfig;
  /** Per-skill configuration. Set `enabled: false` to disable a skill. */
  entries?: Record<string, SkillConfig>;
};

export type DocumentsConfig = {
  /** Enable contextual enrichment for document ingestion. */
  contextualEnrichment?: boolean;
  /** Docs directory path used for enrichment context. */
  docsPath?: string;
};

export type { RolesConfig } from "@elizaos/core";

// --- Models types (merged from types.models.ts) ---

export type ModelApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "bedrock-converse-stream";

export type ModelCompatConfig = {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
};

export type ModelProviderAuthMode = "api-key" | "aws-sdk" | "oauth" | "token";

export type ModelDefinitionConfig = {
  id: string;
  name: string;
  api?: ModelApi;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: ModelCompatConfig;
};

export type ModelProviderConfig = {
  baseUrl: string;
  apiKey?: string;
  auth?: ModelProviderAuthMode;
  api?: ModelApi;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models: ModelDefinitionConfig[];
};

export type BedrockDiscoveryConfig = {
  enabled?: boolean;
  region?: string;
  providerFilter?: string[];
  refreshInterval?: number;
  defaultContextWindow?: number;
  defaultMaxTokens?: number;
};

export type ModelsConfig = {
  mode?: "merge" | "replace";
  providers?: Record<string, ModelProviderConfig>;
  bedrockDiscovery?: BedrockDiscoveryConfig;
  /** Selected small model ID for fast tasks (e.g. "claude-haiku"). Set during onboarding. */
  small?: string;
  /** Selected large model ID for complex reasoning (e.g. "claude-sonnet-4-6"). Set during onboarding. */
  large?: string;
};

// --- Cron types (merged from types.cron.ts) ---

export type CronConfig = {
  enabled?: boolean;
  store?: string;
  maxConcurrentRuns?: number;
};

// --- Node host types (merged from types.node-host.ts) ---

export type NodeHostBrowserProxyConfig = {
  /** Enable the browser proxy on the node host (default: true). */
  enabled?: boolean;
  /** Optional allowlist of profile names exposed via the proxy. */
  allowProfiles?: string[];
};

export type NodeHostConfig = {
  /** Browser proxy settings for node hosts. */
  browserProxy?: NodeHostBrowserProxyConfig;
};

// --- Approvals types (merged from types.approvals.ts) ---

export type ExecApprovalForwardingMode = "session" | "targets" | "both";

export type ExecApprovalForwardTarget = {
  /** Channel id (e.g. "discord", "slack", or plugin channel id). */
  channel: string;
  /** Destination id (channel id, user id, etc. depending on channel). */
  to: string;
  /** Optional account id for multi-account channels. */
  accountId?: string;
  /** Optional thread id to reply inside a thread. */
  threadId?: string | number;
};

export type ExecApprovalForwardingConfig = {
  /** Enable forwarding exec approvals to chat channels. Default: false. */
  enabled?: boolean;
  /** Delivery mode (session=origin chat, targets=config targets, both=both). Default: session. */
  mode?: ExecApprovalForwardingMode;
  /** Only forward approvals for these agent IDs. Omit = all agents. */
  agentFilter?: string[];
  /** Only forward approvals matching these session key patterns (substring or regex). */
  sessionFilter?: string[];
  /** Explicit delivery targets (used when mode includes targets). */
  targets?: ExecApprovalForwardTarget[];
};

export type ApprovalsConfig = {
  exec?: ExecApprovalForwardingConfig;
};

// --- Base types (merged from types.base.ts) ---

export type LoggingConfig = {
  level?: "silent" | "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  file?: string;
  consoleLevel?:
    | "silent"
    | "fatal"
    | "error"
    | "warn"
    | "info"
    | "debug"
    | "trace";
  consoleStyle?: "pretty" | "compact" | "json";
  /** Redact sensitive tokens in tool summaries. Default: "tools". */
  redactSensitive?: "off" | "tools";
  /** Regex patterns used to redact sensitive tokens (defaults apply when unset). */
  redactPatterns?: string[];
};

export type DiagnosticsOtelConfig = {
  enabled?: boolean;
  endpoint?: string;
  protocol?: "http/protobuf" | "grpc";
  headers?: Record<string, string>;
  serviceName?: string;
  traces?: boolean;
  metrics?: boolean;
  logs?: boolean;
  /** Trace sample rate (0.0 - 1.0). */
  sampleRate?: number;
  /** Metric export interval (ms). */
  flushIntervalMs?: number;
};

export type DiagnosticsCacheTraceConfig = {
  enabled?: boolean;
  filePath?: string;
  includeMessages?: boolean;
  includePrompt?: boolean;
  includeSystem?: boolean;
};

export type DiagnosticsConfig = {
  enabled?: boolean;
  /** Optional ad-hoc diagnostics flags (e.g. "telegram.http"). */
  flags?: string[];
  otel?: DiagnosticsOtelConfig;
  cacheTrace?: DiagnosticsCacheTraceConfig;
};

export type WebReconnectConfig = {
  initialMs?: number;
  maxMs?: number;
  factor?: number;
  jitter?: number;
  maxAttempts?: number; // 0 = unlimited
};

export type WebConfig = {
  /** If false, do not start the WhatsApp web provider. Default: true. */
  enabled?: boolean;
  heartbeatSeconds?: number;
  reconnect?: WebReconnectConfig;
};

// --- Memory types (merged from types.memory.ts) ---

export type MemoryBackend = "builtin" | "qmd";
export type MemoryCitationsMode = "auto" | "on" | "off";

export type MemoryConfig = {
  backend?: MemoryBackend;
  citations?: MemoryCitationsMode;
  qmd?: MemoryQmdConfig;
};

export type MemoryQmdConfig = {
  command?: string;
  includeDefaultMemory?: boolean;
  paths?: MemoryQmdIndexPath[];
  sessions?: MemoryQmdSessionConfig;
  update?: MemoryQmdUpdateConfig;
  limits?: MemoryQmdLimitsConfig;
  scope?: SessionSendPolicyConfig;
};

export type MemoryQmdIndexPath = {
  path: string;
  name?: string;
  pattern?: string;
};

export type MemoryQmdSessionConfig = {
  enabled?: boolean;
  exportDir?: string;
  retentionDays?: number;
};

export type MemoryQmdUpdateConfig = {
  interval?: string;
  debounceMs?: number;
  onBoot?: boolean;
  embedInterval?: string;
};

export type MemoryQmdLimitsConfig = {
  maxResults?: number;
  maxSnippetChars?: number;
  maxInjectedChars?: number;
  timeoutMs?: number;
};

// --- Database types ---

export type PgliteConfig = {
  /** Custom PGLite data directory. Default: ~/.eliza/workspace/.eliza/.elizadb */
  dataDir?: string;
};

export type PostgresCredentials = {
  /** Full PostgreSQL connection string. Takes precedence over individual fields. */
  connectionString?: string;
  /** PostgreSQL host. Default: localhost */
  host?: string;
  /** PostgreSQL port. Default: 5432 */
  port?: number;
  /** Database name. */
  database?: string;
  /** Database user. */
  user?: string;
  /** Database password. */
  password?: string;
  /** Enable SSL connection. Default: false */
  ssl?: boolean;
};

export type DatabaseConfig = {
  /** Active database provider. Default: "pglite". */
  provider?: DatabaseProviderType;
  /** PGLite (local embedded Postgres) configuration. */
  pglite?: PgliteConfig;
  /** Remote PostgreSQL configuration. */
  postgres?: PostgresCredentials;
};

// --- Plugins types (merged from types.plugins.ts) ---

export type PluginEntryConfig = {
  enabled?: boolean;
  config?: Record<string, unknown>;
};

export type PluginSlotsConfig = {
  /** Select which plugin owns the memory slot ("none" disables memory plugins). */
  memory?: string;
};

export type PluginsLoadConfig = {
  /** Additional plugin/extension paths to load. */
  paths?: string[];
};

export type PluginInstallRecord = {
  source: "npm" | "archive" | "path";
  spec?: string;
  requestedVersion?: string;
  releaseStream?: "latest" | "beta";
  sourcePath?: string;
  installPath?: string;
  version?: string;
  installedAt?: string;
};

export type RegistryEndpoint = {
  /** Human-friendly label shown in UI. */
  label: string;
  /** Endpoint URL returning registry JSON payload. */
  url: string;
  /** Whether this endpoint is enabled for fetch/merge. */
  enabled?: boolean;
};

export type PluginsConfig = {
  /** Enable or disable plugin loading. */
  enabled?: boolean;
  /** Optional plugin allowlist (plugin ids). */
  allow?: string[];
  /** Optional plugin denylist (plugin ids). */
  deny?: string[];
  load?: PluginsLoadConfig;
  slots?: PluginSlotsConfig;
  entries?: Record<string, PluginEntryConfig>;
  installs?: Record<string, PluginInstallRecord>;
  /** Additional plugin registry endpoints. */
  registryEndpoints?: RegistryEndpoint[];
};

// --- Cloud types (Eliza Cloud integration) ---

export type CloudInferenceMode = "cloud" | "byok" | "local";

export type CloudBridgeConfig = {
  /** Reconnection interval base (ms). Default: 3000. */
  reconnectIntervalMs?: number;
  /** Max reconnection attempts. Default: 20. */
  maxReconnectAttempts?: number;
  /** Heartbeat interval (ms). Default: 30000. */
  heartbeatIntervalMs?: number;
};

export type CloudBackupConfig = {
  /** Auto-backup interval (ms). Default: 3600000 (1 hour). */
  autoBackupIntervalMs?: number;
  /** Maximum auto-snapshots to retain. Default: 10. */
  maxSnapshots?: number;
};

export type CloudContainerDefaults = {
  /** Default ECR image URI for agent containers. */
  defaultImage?: string;
  /** Default CPU architecture. Default: arm64. */
  defaultArchitecture?: "arm64" | "x86_64";
  /** Default CPU units. Default: 1792. */
  defaultCpu?: number;
  /** Default memory (MB). Default: 1792. */
  defaultMemory?: number;
  /** Default container port. Default: 2138. */
  defaultPort?: number;
};

export type CloudServiceToggles = {
  /** Use Eliza Cloud for model inference. Default: true. */
  inference?: boolean;
  /** Use Eliza Cloud for blockchain RPC. Default: true. */
  rpc?: boolean;
  /** Use Eliza Cloud for media generation (image/video/audio/vision). Default: true. */
  media?: boolean;
  /** Use Eliza Cloud for TTS (text-to-speech). Default: true. */
  tts?: boolean;
  /** Use Eliza Cloud for embeddings. Default: true. */
  embeddings?: boolean;
};

export type CloudConfig = {
  /** Enable Eliza Cloud integration. Default: false. */
  enabled?: boolean;
  /** Selected cloud provider ID (e.g. "elizacloud"). Set during onboarding. */
  provider?: string;
  /** Remote API base URL used when the app is attached to a remote backend. */
  remoteApiBase?: string;
  /** Remote access token used when the app is attached to a remote backend. */
  remoteAccessToken?: string;
  /** Eliza Cloud API base URL. Default: https://elizacloud.ai/api/v1 */
  baseUrl?: string;
  /** Cached API key (stored encrypted via gateway auth). */
  apiKey?: string;
  /** ID of the cloud agent created during onboarding. */
  agentId?: string;
  /** Inference mode: cloud (proxied), byok (user keys), local (no cloud). */
  inferenceMode?: CloudInferenceMode;
  /** Granular service toggles — pick which cloud services to use. */
  services?: CloudServiceToggles;
  /** Runtime mode chosen during onboarding: "cloud" or "local". */
  runtime?: "cloud" | "local";
  /** Auto-deploy agents to cloud on creation. Default: false. */
  autoProvision?: boolean;
  /** Bridge settings for WebSocket communication with cloud agents. */
  bridge?: CloudBridgeConfig;
  /** Backup settings for agent state snapshots. */
  backup?: CloudBackupConfig;
  /** Default container settings for new cloud deployments. */
  container?: CloudContainerDefaults;
};

/** Workflow integration configuration. */
export type WorkflowConfig = {
  /** Master gate. Default: true. When false, plugin auto-enable is skipped. */
  enabled?: boolean;
};

/** CUA (Computer Use Agent) configuration. Supports local (Lume VM) and cloud modes. */
export type CuaConfig = {
  /** Enable the CUA plugin. Default: false. */
  enabled?: boolean;
  /** Local mode: host:port of the CUA computer server (e.g. "localhost:8002"). Skips cloud API. */
  host?: string;
  /** Cloud mode: CUA API key for cloud sandbox access. */
  apiKey?: string;
  /** Cloud mode: Name of the CUA cloud sandbox. */
  sandboxName?: string;
  /** OS type for the sandbox: linux, windows, macos, android. Default: linux. */
  osType?: "linux" | "windows" | "macos" | "android";
  /** Custom CUA API base URL. */
  apiBase?: string;
  /** OpenAI model for computer-use (default: computer-use-preview). */
  computerUseModel?: string;
  /** Maximum steps per run (default: 30). */
  maxSteps?: number;
  /** Auto-acknowledge safety checks (default: false). */
  autoAckSafetyChecks?: boolean;
  /** Connect to sandbox on plugin start (default: false). */
  connectOnStart?: boolean;
  /** Disconnect from sandbox after each run (default: true). */
  disconnectAfterRun?: boolean;
};

/** x402 HTTP payment protocol configuration. */
export type X402Config = {
  enabled?: boolean;
  privateKey?: string;
  network?: string;
  payTo?: string;
  facilitatorUrl?: string;
  maxPaymentUsd?: number;
  maxTotalUsd?: number;
  dbPath?: string;
};

// ============================================================================
// Media Generation Types
// ============================================================================

// --- Local embedding runtime config ---

export type EmbeddingConfig = {
  /** GGUF model filename (e.g. "text/eliza-1-lite-0_6b-32k.gguf"). */
  model?: string;
  /** Optional Hugging Face repo/source for model resolution. */
  modelRepo?: string;
  /** Embedding vector dimension (default: 1024). */
  dimensions?: number;
  /** Embedding context window size (must match the model; default: model hint). */
  contextSize?: number;
  /** GPU layers for model loading: "auto", "max", or a number. */
  gpuLayers?: number | "auto" | "max";
  /** Minutes of inactivity before unloading model from memory (default: 30, 0 = never). */
  idleTimeoutMinutes?: number;
};

// --- Update/release channel types ---

export type UpdateConfig = {
  channel?: ReleaseChannel;
  /** Default: true. */
  checkOnStart?: boolean;
  lastCheckAt?: string;
  lastCheckVersion?: string;
  /** Seconds between automatic checks. Default: 14400 (4 hours). */
  checkIntervalSeconds?: number;
};

// --- Custom Actions types ---

// --- Connector types ---

/** JSON-serializable value for connector configuration fields. */
export type ConnectorFieldValue =
  | string
  | number
  | boolean
  | string[]
  | { [key: string]: ConnectorFieldValue | undefined }
  | undefined;

/**
 * Configuration for a single messaging connector (e.g. Telegram, Discord).
 *
 * Common fields:
 * - `enabled` — disable without removing config
 * - `botToken` / `token` / `apiKey` — authentication credential
 * - `dmPolicy` — DM access control ("open" | "pairing" | "closed")
 * - `configWrites` — allow the connector to write config on events
 */
export type ConnectorConfig = { [key: string]: ConnectorFieldValue };

export type ElizaConfig = {
  meta?: {
    /** Explicit onboarding completion marker. Reset clears the entire state dir. */
    onboardingComplete?: boolean;
    /** Last Eliza version that wrote this config. */
    lastTouchedVersion?: string;
    /** ISO timestamp when this config was last written. */
    lastTouchedAt?: string;
  };
  auth?: AuthConfig;
  env?: {
    /** Opt-in: import missing secrets from a login shell environment (exec `$SHELL -l -c 'env -0'`). */
    shellEnv?: {
      enabled?: boolean;
      /** Timeout for the login shell exec (ms). Default: 15000. */
      timeoutMs?: number;
    };
    /** Inline env vars to apply when not already present in the process env. */
    vars?: Record<string, string>;
    /** Sugar: allow env vars directly under env (string values only). */
    [key: string]:
      | string
      | Record<string, string>
      | { enabled?: boolean; timeoutMs?: number }
      | undefined;
  };
  wizard?: {
    lastRunAt?: string;
    lastRunVersion?: string;
    lastRunCommit?: string;
    lastRunCommand?: string;
    lastRunMode?: "local" | "remote";
  };
  diagnostics?: DiagnosticsConfig;
  logging?: LoggingConfig;
  update?: UpdateConfig;
  browser?: BrowserConfig;
  ui?: {
    /** Accent color for Eliza UI chrome (hex). */
    seamColor?: string;
    /** User's preferred UI theme. Set during onboarding. */
    theme?:
      | "eliza"
      | "eliza"
      | "qt314"
      | "web2000"
      | "programmer"
      | "haxor"
      | "psycho";
    assistant?: {
      /** Assistant display name for UI surfaces. */
      name?: string;
      /** Assistant avatar (emoji, short text, or image URL/data URI). */
      avatar?: string;
    };
    /** Selected built-in avatar index (0 means custom upload). */
    avatarIndex?: number;
    /** Selected UI / character language. */
    language?: string;
    /** Selected built-in character preset id. */
    presetId?: string;
    /** Owner display name set during onboarding or via LifeOps. */
    ownerName?: string;
    /**
     * Pinned/favorite apps shown in the dashboard header. Owned by the
     * server so the agent can mutate them via /api/apps/favorites.
     */
    favoriteApps?: string[];
  };
  documents?: DocumentsConfig;
  roles?: RolesConfig;
  skills?: SkillsConfig;
  plugins?: PluginsConfig;
  models?: ModelsConfig;
  nodeHost?: NodeHostConfig;
  agents?: AgentsConfig;
  tools?: ToolsConfig;
  bindings?: AgentBinding[];
  broadcast?: BroadcastConfig;
  audio?: AudioConfig;
  messages?: MessagesConfig;
  commands?: CommandsConfig;
  approvals?: ApprovalsConfig;
  session?: SessionConfig;
  web?: WebConfig;

  cron?: CronConfig;
  hooks?: HooksConfig;
  discovery?: DiscoveryConfig;
  talk?: TalkConfig;
  gateway?: GatewayConfig;
  memory?: MemoryConfig;
  /** Local embedding model configuration (Metal GPU, idle unloading, model selection). */
  embedding?: EmbeddingConfig;
  /** Database provider and connection configuration (local-only feature). */
  database?: DatabaseConfig;
  /** Eliza Cloud integration for remote agent provisioning and inference. */
  cloud?: CloudConfig;
  /** In-process workflow integration. */
  workflow?: WorkflowConfig;
  /** Wallet source selection and cached cloud wallet descriptors. */
  wallet?: {
    primary?: Partial<Record<"evm" | "solana", "local" | "cloud">>;
    cloud?: Partial<
      Record<
        "evm" | "solana",
        {
          agentWalletId?: string | null;
          walletAddress?: string | null;
          address?: string | null;
          walletProvider?: string | null;
          balance?: string | number | null;
        }
      >
    >;
    rpcProviders?: Record<string, string>;
    [key: string]: unknown;
  };
  /** Deployment target for the current agent runtime. */
  deploymentTarget?: DeploymentTargetConfig;
  /**
   * Legacy linked-account flags persisted in `eliza.json` (e.g.
   * `linkedAccounts.elizacloud.status === "linked"`). Per-account
   * credential records live under `~/.eliza/auth/{providerId}/...`
   * and are surfaced via the WS3 accounts API, not this config.
   */
  linkedAccounts?: LinkedAccountFlagsConfig;
  /** Canonical per-capability routing for AI and cloud-backed services. */
  serviceRouting?: ServiceRoutingConfig;
  /** CUA (Computer Use Agent) cloud sandbox configuration. */
  cua?: CuaConfig;
  x402?: X402Config;
  /** Media generation configuration (image, video, audio, vision providers). */
  media?: MediaConfig;
  /** Messaging connector configuration (Telegram, Discord, Slack, etc.). */
  connectors?: Record<string, ConnectorConfig>;
  /** Streaming destination configuration (RTMP, Twitch, YouTube, etc.). */
  streaming?: Record<string, ConnectorConfig>;
  /** MCP server configuration. */
  mcp?: {
    servers?: Record<
      string,
      {
        type: string;
        command?: string;
        args?: string[];
        url?: string;
        env?: Record<string, string>;
        headers?: Record<string, string>;
        cwd?: string;
        timeoutInMillis?: number;
      }
    >;
  };
  /** ERC-8004 agent registry and ElizaMaker NFT collection configuration. */
  registry?: {
    /** Ethereum mainnet (or local Anvil) RPC URL. */
    mainnetRpc?: string;
    /** ElizaAgentRegistry contract address. */
    registryAddress?: string;
    /** ElizaMaker collection contract address. */
    collectionAddress?: string;
  };
  /** Feature flags for plugin auto-enable. */
  features?: Record<
    string,
    boolean | { enabled?: boolean; [k: string]: unknown }
  >;
  /** User-defined custom actions for the agent. */
  customActions?: CustomActionDef[];
};

/** Alias so call-sites using the old name keep compiling. */

export type ConfigValidationIssue = {
  path: string;
  message: string;
};

export type ConfigFileSnapshot = {
  path: string;
  exists: boolean;
  raw: string | null;
  parsed: unknown;
  valid: boolean;
  config: ElizaConfig;
  hash?: string;
  issues: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
};

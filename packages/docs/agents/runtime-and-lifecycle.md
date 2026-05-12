---
title: "Runtime and Lifecycle"
sidebarTitle: "Runtime & Lifecycle"
description: "Boot sequence, initialization steps, plugin loading order, service startup, and restart behavior for the Eliza agent runtime."
---

This page documents how Eliza initializes and manages the elizaOS `AgentRuntime`, from process startup through graceful shutdown.

## Entry Points

Eliza has two primary runtime entry points:

| Function | File | Use |
|---|---|---|
| `startEliza(opts)` | `eliza/packages/agent/src/runtime/eliza.ts` | Full startup including onboarding and optional interactive loop |
| `bootElizaRuntime(opts)` | `eliza/packages/agent/src/runtime/eliza.ts` | Headless startup for API server use (wraps `startEliza`) |

```typescript
// CLI mode — interactive chat after boot
await startEliza();

// Server mode — returns runtime, starts API
const runtime = await bootElizaRuntime({ requireConfig: true });

// Headless mode — returns runtime without entering readline loop
const runtime = await startEliza({ headless: true });
```

## Boot Sequence

`startEliza()` executes the following steps in order:

### Step 1: Log Capture

Early log buffering begins so startup messages appear in the UI log viewer even before the runtime is ready:

```typescript
captureEarlyLogs();
addLogListener(logToChatListener);
```

### Step 2: Load Config

`eliza.json` is loaded from the state directory (`~/.eliza/eliza.json`). If the file does not exist, an empty config is used with defaults:

```typescript
config = loadElizaConfig();
// Falls back to {} if ENOENT
```

### Step 3: First-Run Onboarding (CLI only)

If no agent name is configured and stdin is a TTY, the interactive onboarding wizard runs. It prompts for:

1. Agent name (4 random suggestions + custom input)
2. Writing style preset (from `STYLE_PRESETS`)
3. AI provider selection + API key
4. Wallet setup (EVM and Solana keypairs)
5. Skills registry URL

The wizard writes the agent name and chosen style template back to `eliza.json` before continuing. In headless mode, onboarding is skipped — the GUI handles it.

### Step 3a: Post-Config Propagation

Immediately after config is loaded and before onboarding, several environment variables and internal flags are propagated:

| Step | Detail |
|---|---|
| LOG_LEVEL propagation | `process.env.LOG_LEVEL = config.logging?.level ?? "error"` |
| Destructive migrations | `ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true` |
| Subscription credentials | `applySubscriptionCredentials()` applies any stored subscription keys |
| OG tracking | OG tracking initialization for analytics/telemetry |

### Step 4: Environment Variable Population

Several helper functions push config values into `process.env` so that elizaOS plugins can read them:

| Function | Purpose |
|---|---|
| `applyConnectorSecretsToEnv()` | Channel credentials (Discord token, Telegram bot token, etc.) |
| `autoResolveDiscordAppId()` | Fetches Discord Application ID from the API if not set |
| `applyCloudConfigToEnv()` | ElizaCloud API key, base URL, model selections |
| `applyX402ConfigToEnv()` | x402 HTTP payment protocol settings |
| `applyDatabaseConfigToEnv()` | `POSTGRES_URL` or `PGLITE_DATA_DIR` for `@elizaos/plugin-sql` |

### Step 5: Build Character

`buildCharacterFromConfig()` assembles the elizaOS `Character` from `eliza.json`, resolving the agent name, personality fields, and secrets from environment variables.

### Step 6: Ensure Workspace

The agent workspace directory is created if needed:

```typescript
await ensureAgentWorkspace({ dir: workspaceDir });
```

### Step 7: Create Eliza Plugin

`createElizaPlugin()` is called to produce the core bridge plugin that provides workspace context, session keys, custom actions, and lifecycle actions (restart, send-message):

```typescript
const elizaPlugin = createElizaPlugin({
  workspaceDir,
  agentId,
});
```

### Step 8: Resolve Plugins

`resolvePlugins()` collects and dynamically imports all plugins in parallel. This resolves three categories:

1. **Core plugins** — always loaded (see [Services](/runtime/services))
2. **Connector plugins** — loaded when channel config is present (Discord, Telegram, etc.)
3. **Provider plugins** — loaded when the corresponding API key env var is set
4. **Custom/drop-in plugins** — scanned from `~/.eliza/plugins/custom/`
5. **Ejected plugins** — local overrides from `~/.eliza/plugins/ejected/`

Each plugin is wrapped with an error boundary so a crash in one plugin cannot halt startup.

### Step 9: Create AgentRuntime

```typescript
let runtime = new AgentRuntime({
  character,
  actionPlanning: true,
  plugins: [elizaPlugin, ...otherPlugins.map((p) => p.plugin)],
  logLevel: runtimeLogLevel,
  settings: {
    VALIDATION_LEVEL: "fast",
    MODEL_PROVIDER: primaryModel,
    BUNDLED_SKILLS_DIRS: bundledSkillsDir,
    WORKSPACE_SKILLS_DIR: workspaceSkillsDir,
    // ...
  },
});
```

### Step 10: Pre-register Critical Plugins

Two plugins are pre-registered before `runtime.initialize()` to prevent race conditions:

1. **`@elizaos/plugin-sql`** — Database adapter must be ready before any plugin `init()` runs. On PGLite corruption, the data directory is reset and startup is retried once.

2. **`@elizaos/plugin-local-embedding`** — Must register its `TEXT_EMBEDDING` handler (priority 10) before services start. Without pre-registration, the cloud plugin's handler (priority 0) wins and incurs API costs for local embeddings.

### Step 11: Runtime Initialization

`runtime.initialize()` runs all remaining plugin `init()` functions in parallel, starts services, and prepares the agent for message processing.

### Step 12: Post-Init Setup

After initialization:

- Trajectory logger is located and enabled
- Action aliases are installed (e.g., `CODE_TASK` → `START_CODING_TASK`)
- Skills service is warmed up asynchronously
- Sandbox manager is started if configured
- Hooks are loaded
- API server starts (in server/headless mode)

## Plugin Loading Order

```
1. elizaPlugin                     (passed first in the plugins array to AgentRuntime constructor)
2. @elizaos/plugin-sql             (pre-registered via registerSqlPluginWithRecovery() before runtime.initialize())
3. @elizaos/plugin-local-embedding (pre-registered so TEXT_EMBEDDING handler at priority 10 is available)
4. All other plugins               (registered during runtime.initialize() in parallel)
```

## Restart Behavior

Eliza supports pluggable restart handlers via `eliza/packages/agent/src/runtime/restart.ts`:

```typescript
export const RESTART_EXIT_CODE = 75;

// Default: exit so the CLI runner can relaunch
let _handler: RestartHandler = () => {
  process.exit(RESTART_EXIT_CODE);
};

export function setRestartHandler(handler: RestartHandler): void {
  _handler = handler;
}

export function requestRestart(reason?: string): void | Promise<void> {
  return _handler(reason);
}
```

| Environment | Restart strategy |
|---|---|
| CLI | Exits with code 75; `eliza/packages/app-core/scripts/run-node.mjs` catches this, rebuilds if needed, relaunches |
| Dev server | Host calls `setRestartHandler()` to hot-swap the runtime in-process |
| API endpoint | `POST /api/agent/restart` calls `requestRestart()` |

The `restartAction` available to the LLM calls `requestRestart()` with an optional reason string.

## Lifecycle States

| State | Description |
|---|---|
| Starting | Config loaded, plugins resolving, database initializing |
| Running | `runtime.initialize()` complete, API server accepting requests |
| Restarting | `requestRestart()` called, handler in progress |
| Stopped | Process exited or runtime disposed |

## Sandbox Modes

The sandbox system has two layers of configuration:

**TypeScript config type** (`AgentDefaultsConfig` in `eliza/packages/shared/src/config/types.agent-defaults.ts` and `AgentConfig` in `eliza/packages/shared/src/config/types.agents.ts`):

| Mode | Description |
|---|---|
| `"off"` | No sandboxing (default) |
| `"non-main"` | Sandbox non-main sessions only |
| `"all"` | Sandbox all sessions |

**Runtime sandbox manager** (`SandboxManager` in `eliza/packages/app-core/src/services/sandbox-manager.ts`):

| Mode | Description |
|---|---|
| `"off"` | No sandboxing (default) |
| `"light"` | Audit log only; no container isolation |
| `"standard"` | Docker container isolation for tool execution |
| `"max"` | Maximum isolation including network restrictions |
<Note>
The runtime in `eliza.ts` reads `agents.defaults.sandbox.mode` as a raw string and maps it to the `SandboxMode` type. It only recognizes `"light"`, `"standard"`, and `"max"` -- all other values (including the TypeScript-typed `"non-main"` and `"all"`) fall back to `"off"`. To enable sandboxing, use `"light"`, `"standard"`, or `"max"` in `eliza.json`. The per-agent `sandbox.mode` field in `types.agents.ts` (`"off" | "non-main" | "all"`) controls which sessions are sandboxed, while the defaults-level mode controls the sandbox intensity.
</Note>

## Related Pages

- [Core Runtime](/runtime/core) — AgentRuntime class reference
- [Services](/runtime/services) — service lifecycle and built-in service list
- [Plugins](/plugins/development) — plugin development guide

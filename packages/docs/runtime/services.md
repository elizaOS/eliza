---
title: "Services"
sidebarTitle: "Services"
description: "Service interface, service registry, built-in services list, service lifecycle, and dependency patterns."
---

Services are long-running background components registered with `AgentRuntime`. Unlike providers (which run on each turn) or actions (which run on demand), services start when their plugin initializes and run for the lifetime of the agent.

## Service Interface

From `@elizaos/core`:

```typescript
export interface Service {
  serviceType: string;
  initialize(runtime: IAgentRuntime): Promise<void>;
  stop?(): Promise<void>;
}
```

| Field | Type | Description |
|---|---|---|
| `serviceType` | string | Unique identifier for this service type (e.g., `"AGENT_SKILLS_SERVICE"`) |
| `initialize()` | function | Called once when the plugin that owns this service is initialized |
| `stop()` | function (optional) | Called during graceful shutdown |

## Service Registry

Services are accessible via the runtime:

```typescript
// Get a service by type string
const service = runtime.getService("AGENT_SKILLS_SERVICE");

// Get all services of a type (returns array for multi-instance services)
const services = runtime.getServicesByType("trajectories");

// Wait for a service to finish loading
const svcPromise = runtime.getServiceLoadPromise("AGENT_SKILLS_SERVICE");

// Check registration status
const status = runtime.getServiceRegistrationStatus("trajectories");
// Returns: "pending" | "registering" | "registered" | "failed" | "unknown"
```

## Core Plugins and Their Services

Core plugins are always loaded and each provides one or more services:

| Plugin | Service Type | Description |
|---|---|---|
| `@elizaos/plugin-sql` | Database adapter | PGLite or PostgreSQL persistence; provides `runtime.adapter` |
| `@elizaos/plugin-local-embedding` | `TEXT_EMBEDDING` handler | Local GGUF embedding model via node-llama-cpp |
| `@elizaos/plugin-form` | `FORM` | Structured conversational forms — FormService, form provider/evaluator, and restore action |
| `knowledge` | Knowledge service | RAG knowledge indexing and retrieval |
| `trajectories` | `trajectories` | Debug and RL training trajectory capture |
| `@elizaos/plugin-agent-orchestrator` | Orchestrator service | Multi-agent task coordination and spawning |
| `@elizaos/plugin-shell` | Shell service | Shell command execution with security controls |
| `@elizaos/plugin-coding-tools` | File/shell sandbox services | Native coding tools (READ, WRITE, EDIT, BASH, GREP, GLOB, …); workspace-root sealing |
| `@elizaos/plugin-agent-skills` | `AGENT_SKILLS_SERVICE` | Skill catalog loading and execution |
| `@elizaos/plugin-commands` | Commands service | Slash command handling (skills auto-register as /commands) |
| Built-in (`plugin_manager` / `@elizaos/core`) | Plugin manager service | Dynamic plugin install/uninstall at runtime |
| `roles` | Roles service | Role-based access control (OWNER/ADMIN/NONE) |

## Optional Core Services

These services are available but not loaded by default — enable via admin panel or config:

| Plugin | Description |
|---|---|
| `@elizaos/plugin-pdf` | PDF document processing |
| `@elizaos/plugin-cua` | CUA computer-use agent (cloud sandbox automation) |
| `@elizaos/plugin-obsidian` | Obsidian vault CLI integration |
| `@elizaos/plugin-repoprompt` | RepoPrompt CLI integration |
| `@elizaos/plugin-computeruse` | Computer use automation (platform-specific, requires platform binaries) |
| `@elizaos/plugin-browser` | Browser automation (requires stagehand-server) |
| `@elizaos/plugin-vision` | Visual understanding (feature-gated) |
| `@elizaos/plugin-edge-tts` | Text-to-speech (Microsoft Edge TTS) |
| `@elizaos/plugin-elevenlabs` | ElevenLabs text-to-speech |
| `@elizaos/plugin-cli` | CLI interface |
| Built-in (`enableSecretsManager` / `ENABLE_SECRETS_MANAGER`) | [`SECRETS` service](#secrets-secrets-service) — encrypted credential storage and onboarding (`@elizaos/core`) |
| `relationships` | Contact graph, relationship memory (statically imported, may be re-enabled as core) |
| `@elizaos/plugin-x402` | x402 HTTP micropayment protocol |

## Secrets (`SECRETS` service)

Secrets are handled by **`@elizaos/core`** (not a standalone npm plugin). Enable with `enableSecretsManager: true` or `ENABLE_SECRETS_MANAGER` on the character/settings; the runtime registers the `SECRETS` service and related actions/providers early so secrets exist before connectors and other plugins initialize.

Secrets are encrypted at rest (AES-256-GCM), audited (key names only), and scoped per agent. Use **Agent → Settings → Secrets**, `eliza config path`, the `secrets` section of config, environment variables at startup, or `runtime.getSetting()` from plugins (`runtime.getSetting` merges DB-stored secrets, character `settings.secrets`, `process.env`, and global secrets under `~/.eliza/secrets`, in that priority order for resolution).

Audit lines use the `[SECRETS]` / service logging channel — values are never logged.

## Trajectory Logger Service

The trajectory logger is treated specially during startup. Eliza waits for it to become available with a 3-second timeout before enabling it:

```typescript
await waitForTrajectoriesService(runtime, "post-init", 3000);
ensureTrajectoryLoggerEnabled(runtime, "post-init");
```

The service supports `isEnabled()` and `setEnabled(enabled: boolean)` methods. Eliza enables it by default after initialization.

## Skills Service

`@elizaos/plugin-agent-skills` loads and manages the skill catalog. Eliza asynchronously warms up this service after startup:

```typescript
const svc = runtime.getService("AGENT_SKILLS_SERVICE") as {
  getCatalogStats?: () => { loaded: number; total: number; storageType: string };
};
const stats = svc?.getCatalogStats?.();
logger.info(`[eliza] Skills: ${stats.loaded}/${stats.total} loaded`);
```

Skills are discovered from multiple directories in precedence order:

```
1. Workspace skills:  <workspaceDir>/skills/
2. Bundled skills:    from @elizaos/skills package
3. Extra dirs:        skills.load.extraDirs
```

Skills are filtered by `skills.allowBundled` and `skills.denyBundled` lists. Forwarded as runtime settings:

```
BUNDLED_SKILLS_DIRS = <path from @elizaos/skills>
WORKSPACE_SKILLS_DIR = <workspaceDir>/skills
EXTRA_SKILLS_DIRS = <comma-separated extra dirs>
SKILLS_ALLOWLIST = <comma-separated allowed skill names>
SKILLS_DENYLIST = <comma-separated denied skill names>
```

## Sandbox Manager

`SandboxManager` from `eliza/packages/app-core/src/services/sandbox-manager.ts` provides Docker-based code execution isolation when `agents.defaults.sandbox.mode` is `"standard"` or `"max"`:

```typescript
const sandboxManager = new SandboxManager({
  mode: "standard",
  image: dockerSettings?.image ?? undefined,  // no default image — must be configured
  browser: dockerSettings?.browser ?? undefined,
  containerPrefix: "eliza-sandbox",
  network: "bridge",
  memory: "512m",
  cpus: 0.5,
  workspaceRoot: workspaceDir,
});

await sandboxManager.start();
```

In `"light"` mode, only an audit log is created — no container isolation.

## Service Lifecycle

```
Plugin registered
    ↓
service.initialize(runtime) called during plugin.init()
    ↓
Service running (available via runtime.getService())
    ↓
Graceful shutdown: service.stop() called
```

## Writing a Service

To create a service in a plugin:

```typescript
import type { IAgentRuntime, Service } from "@elizaos/core";

class MyService implements Service {
  serviceType = "MY_SERVICE";
  private runtime!: IAgentRuntime;

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    // Start background work
    this.startPolling();
  }

  async stop(): Promise<void> {
    // Clean up resources
    this.stopPolling();
  }
}

// In the plugin:
export default {
  name: "my-plugin",
  description: "...",
  services: [new MyService()],
};
```

## Accessing a Service from Another Plugin

Services are accessed by type string. Always check for null if the service might not be loaded:

```typescript
const myService = runtime.getService("MY_SERVICE") as MyService | null;
if (myService) {
  await myService.doSomething();
}
```

## Related Pages

- [Core Runtime](/runtime/core) — plugin loading and registration
- [Runtime and Lifecycle](/agents/runtime-and-lifecycle) — service startup timing
- [Types](/runtime/types) — Service interface type definitions

---
title: "Sandbox & Security"
sidebarTitle: "Sandbox & Security"
description: "Container-based sandbox isolation with configurable security modes, network policies, audit logging, and remote signing."
---

Milady provides a container-based sandbox system that isolates agent code execution from the host environment. The sandbox supports multiple security levels, network policies, audit logging, and a remote signing service that keeps private keys on the host while allowing sandboxed agents to submit transactions.

## Table of Contents

1. [Sandbox Modes](#sandbox-modes)
2. [Container Engines](#container-engines)
3. [Sandbox Lifecycle](#sandbox-lifecycle)
4. [Sandbox Configuration](#sandbox-configuration)
5. [Network Policy](#network-policy)
6. [Audit Logging](#audit-logging)
7. [Remote Signing Service](#remote-signing-service)
8. [API Endpoints](#api-endpoints)

---

## Sandbox Modes

The sandbox supports four security levels, configured via the `mode` field:

| Mode | Description |
|------|-------------|
| `off` | No sandboxing. Agent code runs directly on the host. |
| `light` | Minimal isolation. Basic process separation without full container overhead. |
| `standard` | Full container isolation with resource limits, capability dropping, and network restrictions. |
| `max` | Maximum security. Read-only root filesystem, strictest capability drops, tightest resource limits. |

---

## Container Engines

The sandbox engine layer (`src/services/sandbox-engine.ts`) supports multiple container runtimes:

| Engine | Description |
|--------|-------------|
| `docker` | Standard Docker runtime. Works on all platforms. |
| `apple-container` | Apple Container runtime for macOS. Native performance on Apple Silicon. |
| `auto` | Auto-detect the best available engine (default). |

Engine selection is configured via `engineType` in the sandbox config. The `auto` mode probes available runtimes and selects the optimal one for the current platform.

The engine interface provides:

- **Container run** with configurable mounts, environment variables, network mode, user, capability drops, memory/CPU/PIDs limits, port mappings, DNS servers, and read-only root
- **Container exec** with command, working directory, environment overrides, timeout, and stdin support
- **Container listing** by name prefix
- **Container removal** and cleanup

---

## Sandbox Lifecycle

The sandbox manager tracks container state through the following transitions:

```
uninitialized → initializing → ready → degraded → stopping → stopped
                                  ↑                     |
                                  └── recovering ←──────┘
```

| State | Description |
|-------|-------------|
| `uninitialized` | Sandbox has not been created yet. |
| `initializing` | Container is being pulled/started. |
| `ready` | Container is running and accepting commands. |
| `degraded` | Container is running but health checks are failing. |
| `recovering` | Attempting to restore a degraded container. |
| `stopping` | Container shutdown in progress. |
| `stopped` | Container has been terminated and cleaned up. |

---

## Sandbox Configuration

The `SandboxManagerConfig` interface defines all sandbox settings:

```typescript
interface SandboxManagerConfig {
  mode: "off" | "light" | "standard" | "max";
  image?: string;              // Docker image for containers
  containerPrefix?: string;     // Container name prefix
  workdir?: string;            // Container workdir mount path
  readOnlyRoot?: boolean;       // Read-only root filesystem
  network?: string;            // Container network mode
  user?: string;               // Container user (uid:gid)
  capDrop?: string[];          // Linux capabilities to drop
  env?: Record<string, string>; // Environment variables
  memory?: string;             // Memory limit (e.g., "512m")
  cpus?: number;               // CPU limit
  pidsLimit?: number;          // Process ID limit
  workspaceRoot?: string;       // Root for sandbox workspaces
  binds?: string[];            // Additional bind mounts
  dns?: string[];              // DNS servers
  engineType?: "docker" | "apple-container" | "auto";
  browser?: {                  // Browser sandbox settings
    enabled?: boolean;
    image?: string;
    cdpPort?: number;
    vncPort?: number;
    headless?: boolean;
    autoStart?: boolean;
    autoStartTimeoutMs?: number;
  };
}
```

---

## Network Policy

The network policy module (`src/security/network-policy.ts`) prevents sandboxed code from reaching sensitive network targets.

### Always Blocked IPs

These IP patterns are blocked regardless of configuration:

- `0.*` -- "this" network
- `169.254.*` -- link-local / cloud metadata endpoints
- `fe[89ab]*:` -- IPv6 link-local (fe80::/10)
- `::` -- unspecified
- `::1` -- IPv6 loopback

### Private IP Ranges

The following RFC 1918 and IPv6 ULA ranges are also blocked:

- `10.*` -- RFC 1918
- `127.*` -- loopback
- `172.16-31.*` -- RFC 1918
- `192.168.*` -- RFC 1918
- `fc00::/7` -- IPv6 unique local addresses

### IPv6 Handling

IPv6-mapped IPv4 addresses (e.g., `::ffff:192.168.1.1`) are normalized to their IPv4 equivalents before policy evaluation. This prevents bypass via IPv6-mapped addresses.

### Helper Functions

- `isBlockedPrivateOrLinkLocalIp(ip)` -- checks if an IP should be blocked
- `isLoopbackHost(host)` -- checks if a host resolves to a loopback address
- `normalizeIpForPolicy(ip)` -- canonicalizes an IP for consistent policy matching

---

## Audit Logging

The audit log (`src/security/audit-log.ts`) provides an append-only record of security-relevant events. It never logs actual secret values -- only token IDs and metadata.

### Audit Event Types

| Event Type | Description |
|------------|-------------|
| `sandbox_mode_transition` | Sandbox mode changed (e.g., standard to max) |
| `secret_token_replacement_outbound` | Secret tokens replaced before sending to sandbox |
| `secret_sanitization_inbound` | Secrets sanitized from sandbox responses |
| `privileged_capability_invocation` | A privileged capability was used |
| `policy_decision` | A policy allow/deny decision was made |
| `signing_request_submitted` | A transaction signing request was received |
| `signing_request_rejected` | A signing request was denied by policy |
| `signing_request_approved` | A signing request was approved |
| `plugin_fallback_attempt` | Plugin fallback resolution attempted |
| `security_kill_switch` | Security kill switch activated |
| `sandbox_lifecycle` | Sandbox state transition occurred |
| `fetch_proxy_error` | Fetch proxy encountered an error |

### Severity Levels

Each audit entry has a severity: `info`, `warn`, `error`, or `critical`.

### Audit Entry Structure

```typescript
interface AuditEntry {
  timestamp: string;        // ISO 8601
  type: AuditEventType;
  summary: string;
  metadata?: Record<string, string | number | boolean | null>;
  severity: AuditSeverity;
  traceId?: string;
}
```

### Querying and Subscribing

- `queryAuditFeed({ type?, severity?, sinceMs?, limit? })` -- filter and retrieve entries from the process-wide feed
- `subscribeAuditFeed(subscriber)` -- receive real-time entries via callback; returns an unsubscribe function
- `getAuditFeedSize()` -- returns the current number of entries

The in-memory audit buffer defaults to 5000 entries. When exceeded, it trims to half capacity.

### SandboxAuditLog Class

Each sandbox instance has its own `SandboxAuditLog` with convenience methods:

- `record(entry)` -- record an event
- `recordTokenReplacement(direction, url, tokenIds)` -- log secret token operations
- `recordCapabilityInvocation(capability, detail, metadata)` -- log privileged operations
- `recordPolicyDecision(decision, reason, metadata)` -- log allow/deny decisions
- `getRecent(count)` -- get last N entries
- `getByType(type, count)` -- get entries filtered by event type

---

## Remote Signing Service

The remote signing service (`src/services/remote-signing-service.ts`) keeps private keys on the host machine while allowing sandboxed agents to request transaction signatures.

### Architecture

```
Sandboxed Agent ──(unsigned tx)──> Remote Signing Service ──(policy check)──> Signer Backend
                                                                                   │
                <──(signed tx or rejection)──────────────────────────────────────────┘
```

### Signer Backend Interface

```typescript
interface SignerBackend {
  getAddress(): Promise<string>;
  signMessage(message: string): Promise<string>;
  signTransaction(tx: UnsignedTransaction): Promise<string>;
}
```

### Unsigned Transaction Format

```typescript
interface UnsignedTransaction {
  to: string;
  value: string;
  data: string;
  chainId: number;
  nonce?: number;
  gasLimit?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}
```

### Signing Result

Each signing attempt returns:

```typescript
interface SigningResult {
  success: boolean;
  signature?: string;
  error?: string;
  policyDecision: PolicyDecision;
  humanConfirmed: boolean;
}
```

### Pending Approvals

When a transaction exceeds the human confirmation threshold, it enters a pending approval queue:

```typescript
interface PendingApproval {
  requestId: string;
  request: SigningRequest;
  decision: PolicyDecision;
  createdAt: number;
  expiresAt: number;
}
```

### Configuration

The service accepts a signer backend, an optional signing policy (defaults to the standard policy with 0.1 ETH max value, 10/hour and 50/day rate limits), and an optional audit log for recording all signing events.

---

## API Endpoints

### Sandbox Management

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sandbox/status` | Get current sandbox state, mode, and health |
| `GET` | `/api/sandbox/events` | Get the last 100 sandbox event log entries |
| `GET` | `/api/sandbox/platform` | Get platform info (Docker/Apple Container availability) |
| `GET` | `/api/sandbox/capabilities` | Detect available host capabilities (screenshot, audio, computer use, browser, shell) |
| `GET` | `/api/sandbox/browser` | Get browser container CDP and WebSocket endpoints |
| `POST` | `/api/sandbox/start` | Start the sandbox container |
| `POST` | `/api/sandbox/stop` | Stop the sandbox container |
| `POST` | `/api/sandbox/recover` | Attempt recovery from degraded state |
| `POST` | `/api/sandbox/exec` | Execute a command inside the sandbox |
| `POST` | `/api/sandbox/docker/start` | Attempt to start Docker Desktop on the host |

### Screen and Computer Use

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sandbox/screen/screenshot` | Capture a screenshot (returns PNG binary) |
| `POST` | `/api/sandbox/screen/screenshot` | Capture a screenshot with optional region (returns base64) |
| `GET` | `/api/sandbox/screen/windows` | List visible windows on the host |
| `POST` | `/api/sandbox/computer/click` | Perform a mouse click at (x, y) coordinates |
| `POST` | `/api/sandbox/computer/type` | Type text via keyboard input |
| `POST` | `/api/sandbox/computer/keypress` | Send a keypress (e.g., return, tab, escape) |

### Audio

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/sandbox/audio/record` | Record audio from the default microphone |
| `POST` | `/api/sandbox/audio/play` | Play base64-encoded audio |

### Remote Signing

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/sandbox/sign` | Submit a transaction signing request |
| `POST` | `/api/sandbox/sign/approve` | Approve a pending signing request |
| `POST` | `/api/sandbox/sign/reject` | Reject a pending signing request |
| `GET` | `/api/sandbox/sign/pending` | List pending signing approvals |
| `GET` | `/api/sandbox/sign/address` | Get the signer address |

### Audit Feed

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/audit/feed` | Query audit entries with optional filters (type, severity, sinceMs, limit) |

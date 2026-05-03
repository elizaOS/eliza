# Agent ↔ Eliza Cloud: Onboarding Integration Plan

> **Status**: Planning — ready for implementation  
> **Date**: 2026-03-16  
> **Author**: Sol (automated analysis)  
> **Repos**: `agent-ai/agent` (develop), `elizaOS/cloud` (cloud)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current Onboarding Flow (As-Is)](#2-current-onboarding-flow-as-is)
3. [Eliza Cloud Compat API Map](#3-eliza-cloud-compat-api-map)
4. [Proposed Onboarding Flow (To-Be)](#4-proposed-onboarding-flow-to-be)
5. [Auth Flow Design](#5-auth-flow-design)
6. [Provisioning Flow Design](#6-provisioning-flow-design)
7. [Thin Client Mode](#7-thin-client-mode)
8. [Desktop App Integration](#8-desktop-app-integration)
9. [Fallback to Local Mode](#9-fallback-to-local-mode)
10. [Code Changes Required](#10-code-changes-required)
11. [New Compat API Endpoints Needed](#11-new-compat-api-endpoints-needed)
12. [Sequence Diagrams](#12-sequence-diagrams)
13. [Open Questions](#13-open-questions)

---

## 1. Executive Summary

**Goal**: Make "Host on Eliza Cloud" the default/recommended runtime option during agent's first-run onboarding, while keeping local mode as a fully-supported fallback.

**Current state**: The agent CLI (`agent start`) runs `runFirstTimeSetup()` in `src/runtime/eliza.ts` which walks the user through: name → personality → AI provider → wallets → GitHub. Cloud integration exists (`src/cloud/`) but is a separate, opt-in path — never surfaced during onboarding.

**Target state**: After the name + personality steps, the user sees a new "How should I run?" prompt where "☁️ Eliza Cloud (recommended)" is the default. Choosing it triggers browser-based auth → agent provisioning → thin client connection — all within the same `agent start` flow.

---

## 2. Current Onboarding Flow (As-Is)

### Entry Points

| Surface | Entry | Code |
|---------|-------|------|
| CLI | `agent start` (first run, no agent name in config) | `src/runtime/eliza.ts` → `runFirstTimeSetup()` (line ~3055) |
| CLI | `agent setup` (explicit) | `src/cli/program/register.setup.ts` → `registerSetupCommand()` |
| Desktop | Electron/Electrobun app → headless boot | `bootElizaRuntime({ requireConfig: true })` — skips CLI onboarding, GUI handles it |
| API | Web UI onboarding | `src/api/server.ts` — uses same `STYLE_PRESETS` from `src/onboarding-presets.ts` |

### `runFirstTimeSetup()` Steps (CLI path)

```
Step 1: Welcome banner
  └─ clack.intro("WELCOME TO AGENT!")

Step 2: Name selection
  └─ 4 random names from onboarding-names.ts + "Custom..."
  └─ Stored in config.agents.list[0].name

Step 3: Personality/style selection
  └─ 7 presets from STYLE_PRESETS: uwu~, hell yeah, lol k, Noted., hehe~, ..., locked in
  └─ Each has bio[], system prompt, style rules, adjectives, examples
  └─ composeCharacter() mixes preset with random BIO_POOL + SYSTEM_POOL samples
  └─ Stored in config.agents.list[0].{bio, system, style, adjectives, ...}

Step 4: Model provider selection  ◀── THIS IS WHERE CLOUD SHOULD GO
  └─ Detects existing env keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
  └─ If none found: menu of 11 providers + "Skip for now"
  └─ Chosen key saved to config.env[PROVIDER_KEY]

Step 5: Wallet setup
  └─ Generate new / Import existing / Skip
  └─ EVM + Solana keypairs saved to config.env

Step 6: Skills registry (silent)
  └─ Sets SKILLS_REGISTRY=https://clawhub.ai

Step 7: GitHub access
  └─ PAT / OAuth / Skip

Step 8: Persist config
  └─ saveAgentConfig(updated)
  └─ Saves to ~/.agent/agent.json
```

### `agent setup` Command

Separate from `runFirstTimeSetup()`. Runs `runProviderWizard()` which only handles the model provider key — a simpler version of Step 4. Also bootstraps the agent workspace directory.

### Config Structure (`~/.agent/agent.json`)

```jsonc
{
  "agents": {
    "list": [{
      "id": "main",
      "default": true,
      "name": "Mochi",
      "bio": ["..."],
      "system": "...",
      "style": { "all": [], "chat": [], "post": [] },
      "adjectives": ["..."],
      "postExamples": ["..."],
      "messageExamples": [...]
    }]
  },
  "env": {
    "ANTHROPIC_API_KEY": "sk-ant-...",
    "EVM_PRIVATE_KEY": "0x...",
    "SOLANA_PRIVATE_KEY": "..."
  },
  "cloud": {
    "enabled": false,       // ← currently off by default
    "apiKey": null,
    "baseUrl": "https://www.elizacloud.ai"
  }
}
```

### Cloud Config Type (`src/config/types.agent.ts`)

```typescript
type CloudConfig = {
  enabled?: boolean;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  inferenceMode?: "cloud" | "byok" | "local";
  services?: CloudServiceToggles;
  autoProvision?: boolean;
  bridge?: CloudBridgeConfig;
  backup?: CloudBackupConfig;
  container?: CloudContainerDefaults;
};
```

### Existing Cloud Modules (`src/cloud/`)

| File | Purpose | Status |
|------|---------|--------|
| `auth.ts` | `cloudLogin()` — creates CLI session, opens browser, polls for API key | ✅ Complete |
| `bridge-client.ts` | `ElizaCloudClient` — full CRUD + messaging + streaming + snapshots | ✅ Complete |
| `cloud-manager.ts` | `CloudManager` — orchestrates client + proxy + backup + reconnect | ✅ Complete |
| `cloud-proxy.ts` | `CloudRuntimeProxy` — drop-in replacement for local AgentRuntime | ✅ Complete |
| `base-url.ts` | URL normalization, defaults to `https://www.elizacloud.ai` | ✅ Complete |
| `index.ts` | Re-exports | ✅ Complete |

**Key insight**: The cloud infrastructure in the agent repo is already built. The gap is purely in the **onboarding flow** — cloud is never presented as an option during setup.

---

## 3. Eliza Cloud Compat API Map

### Authentication Flow

```
POST /api/auth/cli-session
  Body: { sessionId: "<uuid>" }
  Returns: { sessionId, status: "pending", expiresAt }

Browser: /auth/cli-login?session=<sessionId>
  User authenticates via Privy (wallet, email, social)

POST /api/auth/cli-session/[sessionId]/complete  (called by web UI after Privy auth)
  Requires: Privy session auth
  Action: Generates API key, stores encrypted, marks session "authenticated"
  Returns: { success, apiKey, keyPrefix, expiresAt }

GET /api/auth/cli-session/[sessionId]  (polled by CLI)
  Public: no auth required
  If pending: { status: "pending" }
  If authenticated: { status: "authenticated", apiKey, keyPrefix, expiresAt }
    NOTE: apiKey is one-time retrieval (cleared after first GET)
  If expired/not found: 404
```

### Agent Management (Compat Layer)

All require auth via: `X-Service-Key` OR service JWT OR Privy/API-key (`X-Api-Key` header).

```
GET  /api/compat/agents
  Returns: { success, data: CompatAgentShape[] }

POST /api/compat/agents
  Body: { agentName, agentConfig?, environmentVars? }
  Returns: { success, data: { agentId, agentName, jobId, status, nodeId, message } }
  Note: if WAIFU_AUTO_PROVISION=true, auto-provisions on create

GET  /api/compat/agents/[id]
  Returns: { success, data: CompatAgentShape }

DELETE /api/compat/agents/[id]
  Returns: { success, data: { jobId, status, message } }

GET  /api/compat/agents/[id]/status
  Returns: { success, data: { status, lastHeartbeat, bridgeUrl, webUiUrl, ... } }

POST /api/compat/agents/[id]/launch
  Provisions if needed, returns launch URL + connection details
  Returns: { success, data: { agentId, agentName, appUrl, launchSessionId, connection } }
  Note: launchManagedAgentAgent not yet implemented (placeholder)
```

### Availability

```
GET  /api/compat/availability  (public for aggregate, auth for node topology)
  Returns: { success, data: { totalSlots, usedSlots, availableSlots, acceptingNewAgents } }
```

### Status Mapping

| Eliza Cloud Internal | Compat/Thin Client |
|---------------------|--------------------|
| pending | queued |
| provisioning | provisioning |
| running | running |
| stopped | stopped |
| disconnected | stopped |
| error | failed |

### Bridge Client API (agent → cloud agent)

The `ElizaCloudClient` in agent's `src/cloud/bridge-client.ts` calls these internal V1 endpoints:

```
GET    /api/v1/eliza/agents           — list agents
POST   /api/v1/eliza/agents           — create agent
GET    /api/v1/eliza/agents/:id       — get agent
DELETE /api/v1/eliza/agents/:id       — delete agent
POST   /api/v1/eliza/agents/:id/provision  — provision sandbox
POST   /api/v1/eliza/agents/:id/bridge     — JSON-RPC message relay
POST   /api/v1/eliza/agents/:id/stream     — SSE streaming message relay
POST   /api/v1/eliza/agents/:id/snapshot   — create backup
GET    /api/v1/eliza/agents/:id/backups    — list backups
POST   /api/v1/eliza/agents/:id/restore    — restore from backup
```

**Note**: The bridge-client uses `/api/v1/eliza/agents/` paths, but the compat API is at `/api/compat/agents/`. Either the bridge-client needs to switch to compat routes, or the V1 routes need to be verified as equivalent. **Recommendation**: Use the compat routes for the thin client since they're the official external API.

---

## 4. Proposed Onboarding Flow (To-Be)

### Modified `runFirstTimeSetup()` Steps

```
Step 1: Welcome banner (unchanged)
  └─ clack.intro("WELCOME TO AGENT!")

Step 2: Name selection (unchanged)
  └─ Same 4 random + Custom

Step 3: Personality/style selection (unchanged)
  └─ Same 7 STYLE_PRESETS

Step 3.5: ★ NEW — Runtime selection  ◀── THE KEY CHANGE
  └─ "Where should I live?"
  │
  ├─ ☁️ Eliza Cloud (recommended)     ← DEFAULT, pre-selected
  │   └─ "Zero setup — runs in the cloud, always online"
  │
  ├─ 💻 Run locally
  │   └─ "Full control — runs on this machine"
  │
  └─ ⏭️ Decide later
      └─ "Start local, switch to cloud anytime"

  IF "Eliza Cloud":
    └─ Step 3.5a: Check availability (GET /api/compat/availability)
    │   └─ If !acceptingNewAgents → warn, offer local fallback
    │
    └─ Step 3.5b: Cloud authentication
    │   └─ cloudLogin() → opens browser → polls for API key
    │   └─ Stores apiKey in config.cloud.apiKey
    │   └─ Sets config.cloud.enabled = true
    │
    └─ Step 3.5c: Create cloud agent
    │   └─ POST /api/compat/agents { agentName, agentConfig: { preset, style... } }
    │   └─ Wait for status == "running" (poll GET /api/compat/agents/:id/status)
    │   └─ Store agentId in config.cloud.agentId (new field)
    │
    └─ Step 3.5d: Skip Steps 4-7 (provider, wallets, GitHub)
        └─ Cloud handles inference, no local API key needed
        └─ Wallets can be configured later via cloud dashboard

  IF "Run locally":
    └─ Continue to Step 4 (model provider) as today

  IF "Decide later":
    └─ Continue to Step 4 as today (local default)

Step 4: Model provider selection (only if local)
Step 5: Wallet setup (only if local or always?)
Step 6: Skills registry (unchanged)
Step 7: GitHub access (unchanged)
Step 8: Persist config (unchanged + cloud fields)
```

### Post-Onboarding Start Behavior

After `runFirstTimeSetup()` returns, `startEliza()` needs to check if cloud mode was chosen:

```
if config.cloud.enabled && config.cloud.apiKey && config.cloud.agentId:
  → Initialize CloudManager
  → Connect to cloud agent via bridge
  → Start thin client mode (TUI talks to cloud proxy)
  → Skip local runtime initialization
else:
  → Start local elizaOS runtime (current behavior)
```

---

## 5. Auth Flow Design

### CLI Auth Sequence

```
User                   agent CLI              Eliza Cloud            Browser
 │                        │                        │                     │
 │  picks "Eliza Cloud"   │                        │                     │
 │───────────────────────>│                        │                     │
 │                        │  POST /api/auth/       │                     │
 │                        │  cli-session           │                     │
 │                        │  {sessionId: uuid}     │                     │
 │                        │───────────────────────>│                     │
 │                        │  201 {sessionId,       │                     │
 │                        │   status: "pending"}   │                     │
 │                        │<───────────────────────│                     │
 │                        │                        │                     │
 │                        │  open(browserUrl)      │                     │
 │                        │────────────────────────│────────────────────>│
 │                        │                        │                     │
 │                        │                        │  /auth/cli-login?   │
 │                        │                        │  session=<id>       │
 │                        │                        │<────────────────────│
 │                        │                        │                     │
 │                        │                        │  User logs in       │
 │                        │                        │  (Privy: wallet/    │
 │                        │                        │   email/social)     │
 │                        │                        │                     │
 │                        │                        │  POST /api/auth/    │
 │                        │                        │  cli-session/:id/   │
 │                        │                        │  complete           │
 │                        │                        │<────────────────────│
 │                        │                        │                     │
 │                        │  poll GET /api/auth/   │                     │
 │                        │  cli-session/:id       │                     │
 │                        │───────────────────────>│                     │
 │                        │  {status: "auth'd",    │                     │
 │                        │   apiKey: "...",       │                     │
 │                        │   keyPrefix, expiresAt}│                     │
 │                        │<───────────────────────│                     │
 │                        │                        │                     │
 │  "✓ Logged in!"        │                        │                     │
 │<───────────────────────│                        │                     │
```

### Implementation Notes

- `cloudLogin()` in `src/cloud/auth.ts` already implements this exact flow
- It accepts `onBrowserUrl` callback — the onboarding wizard can use this to show the URL in the terminal
- Default timeout: 5 minutes (300s) — configurable
- Poll interval: 2s
- API key is one-time retrieval (security: cleared after first GET)
- `normalizeCloudSiteUrl()` defaults to `https://www.elizacloud.ai`

### What to Store After Auth

```jsonc
// ~/.agent/agent.json
{
  "cloud": {
    "enabled": true,
    "provider": "elizacloud",
    "apiKey": "ec_...",           // from cloudLogin()
    "baseUrl": "https://www.elizacloud.ai",
    "inferenceMode": "cloud",    // cloud handles model calls
    "autoProvision": true,
    "services": {
      "inference": true,
      "tts": true,
      "media": true
    }
  }
}
```

---

## 6. Provisioning Flow Design

### After Auth, During Onboarding

```typescript
// Pseudocode for onboarding provisioning
async function provisionCloudAgent(
  config: AgentConfig,
  agentName: string,
  preset: StylePreset,
): Promise<{ agentId: string; bridgeUrl: string }> {
  const client = new ElizaCloudClient(
    normalizeCloudSiteUrl(config.cloud.baseUrl),
    config.cloud.apiKey,
  );

  // 1. Create agent with character config
  const { bio, system } = composeCharacter(preset);
  const agent = await client.createAgent({
    agentName,
    agentConfig: {
      preset: preset.catchphrase,
      bio,
      system,
      style: preset.style,
      adjectives: preset.adjectives,
      postExamples: preset.postExamples,
      messageExamples: preset.messageExamples,
    },
  });

  // 2. Wait for provisioning to complete
  const spinner = clack.spinner();
  spinner.start("Setting up your cloud agent...");

  let status = agent.status;
  while (status !== "running" && status !== "completed") {
    await sleep(3000);
    const statusRes = await client.getAgent(agent.agentId);
    status = statusRes.status;

    if (status === "failed" || status === "error") {
      spinner.stop("Provisioning failed");
      throw new Error(`Cloud agent provisioning failed: ${statusRes.errorMessage}`);
    }

    spinner.message(`Status: ${status}...`);
  }

  spinner.stop("Cloud agent is running! ☁️");

  return {
    agentId: agent.agentId,
    bridgeUrl: agent.bridgeUrl,
  };
}
```

### Status Polling Strategy

1. Create agent → immediately get `jobId` (same as `agentId`)
2. Poll `GET /api/compat/agents/:id/status` every 3s
3. Status transitions: `queued` → `provisioning` → `running`
4. Timeout after 120s (containers take ~30-60s to provision)
5. On failure: offer retry or fallback to local

### What to Store After Provisioning

```jsonc
// Added to ~/.agent/agent.json → cloud section
{
  "cloud": {
    // ...existing auth fields...
    "agentId": "uuid-of-cloud-agent",    // NEW FIELD
    "bridgeUrl": "https://...",           // NEW FIELD (cached for fast reconnect)
  }
}
```

---

## 7. Thin Client Mode

### How It Works (Already Built)

Once connected, the agent CLI/TUI acts as a thin client:

1. **CloudManager** (`src/cloud/cloud-manager.ts`) initializes `ElizaCloudClient` with the stored API key
2. **CloudManager.connect(agentId)** provisions if needed, creates a `CloudRuntimeProxy`
3. **CloudRuntimeProxy** (`src/cloud/cloud-proxy.ts`) is a drop-in for `AgentRuntime`:
   - `handleChatMessage(text)` → calls `ElizaCloudClient.sendMessage()` (JSON-RPC bridge)
   - `handleChatMessageStream(text)` → calls `ElizaCloudClient.sendMessageStream()` (SSE)
   - `getStatus()` → calls `ElizaCloudClient.getAgent()`
   - `isAlive()` → calls `ElizaCloudClient.heartbeat()`
4. **BackupScheduler** auto-snapshots every 60s
5. **ConnectionMonitor** heartbeats every 30s, auto-reconnects on disconnect

### Changes Needed in `startEliza()`

After `runFirstTimeSetup()` completes, `startEliza()` needs a cloud-mode branch:

```typescript
// In startEliza(), after config = await runFirstTimeSetup(config)

if (config.cloud?.enabled && config.cloud?.apiKey && config.cloud?.agentId) {
  // Cloud mode — start thin client
  const cloudManager = new CloudManager(config.cloud);
  await cloudManager.init();
  const proxy = await cloudManager.connect(config.cloud.agentId);

  if (opts?.headless) {
    // For API server mode, return proxy as runtime-like object
    return proxy as unknown as AgentRuntime; // needs interface alignment
  }

  // Interactive mode — start readline loop with cloud proxy
  await startCloudChatLoop(proxy, cloudManager);
  return undefined;
}

// Otherwise: continue with local runtime (existing code)
```

### Chat Loop Integration

The existing interactive chat loop in `startEliza()` uses `AgentRuntime` directly. For cloud mode, we need either:

**Option A**: Make `CloudRuntimeProxy` implement the same interface as `AgentRuntime` (duck typing)
**Option B**: Create a new `startCloudChatLoop()` that uses the proxy directly

**Recommendation**: Option B — cleaner separation, can show cloud-specific status (connection state, latency, agent status).

---

## 8. Desktop App Integration

### Current Desktop Onboarding

The desktop app (Electron/Electrobun) boots with `bootElizaRuntime({ requireConfig: true })` which calls `startEliza({ headless: true })`. Interactive onboarding is skipped — the GUI web UI handles it via the API server.

### Changes for Cloud Integration

1. **Web UI onboarding** (in the desktop app's renderer) should present the same runtime choice:
   - Cloud (recommended) vs Local
   - Uses the same API endpoints

2. **Web UI auth flow**: Instead of opening an external browser:
   - Open the Eliza Cloud login page in an embedded webview or in-app browser window
   - Or use the same open-external-browser pattern (simpler, works today)

3. **API server endpoints** (`src/api/server.ts`) need a new route:
   ```
   POST /api/onboarding/cloud-auth    → initiates cloudLogin()
   GET  /api/onboarding/cloud-status  → returns auth + provisioning status
   POST /api/onboarding/cloud-provision → creates cloud agent
   ```

4. **Config persistence**: Same `saveAgentConfig()` path — GUI writes to `~/.agent/agent.json`

5. **Runtime switch**: After provisioning, GUI triggers a runtime restart (`bootElizaRuntime()` re-reads config, sees cloud.enabled → initializes CloudManager)

---

## 9. Fallback to Local Mode

### When Cloud Is Unavailable

```
Scenario 1: No internet / cloud unreachable
  → Pre-flight check: try GET /api/compat/availability
  → If fails: "Cloud is currently unavailable. Run locally instead?"
  → Falls through to Step 4 (provider selection)

Scenario 2: No capacity
  → availability.acceptingNewAgents === false
  → "Cloud is at capacity. Run locally for now?"
  → Can switch to cloud later via `eliza cloud connect`

Scenario 3: Auth timeout
  → cloudLogin() times out after 5 minutes
  → "Login wasn't completed. Try again or run locally?"

Scenario 4: Provisioning failure
  → Agent creation/provisioning fails
  → "Cloud setup failed. Run locally instead?"
  → Error details logged for debugging

Scenario 5: User explicitly wants local
  → Picks "Run locally" in Step 3.5
  → Normal flow continues
```

### Switching Between Modes Later

```bash
# Switch from local to cloud
eliza cloud login    # auth with Eliza Cloud
eliza cloud connect  # provision + connect agent

# Switch from cloud to local
agent config set cloud.enabled false
agent start  # starts in local mode

# Check current mode
eliza cloud status
```

---

## 10. Code Changes Required

### In `agent-ai/agent` (the agent repo)

#### 10.1 Modified: `src/runtime/eliza.ts` — `runFirstTimeSetup()`

**What**: Insert Step 3.5 (runtime selection) between personality choice and provider selection.

**Changes**:
- After `styleChoice` (line ~3110), add runtime selection prompt
- If cloud chosen: call new `runCloudOnboarding()` helper
- If cloud chosen: skip Steps 4-7 (wrap them in `if (!isCloudMode)` guard)
- After setup: if cloud mode, store cloud config fields

**New function** `runCloudOnboarding()`:
```typescript
async function runCloudOnboarding(
  clack: ClackModule,
  name: string,
  chosenTemplate: StylePreset | undefined,
): Promise<{
  apiKey: string;
  agentId: string;
  bridgeUrl?: string;
} | null> {
  // 1. Check availability
  // 2. Run cloudLogin()
  // 3. Create agent with POST /api/compat/agents
  // 4. Poll for running status
  // 5. Return { apiKey, agentId }
  // Returns null if user cancels or error occurs
}
```

**Lines affected**: ~3055–3470 (the entire `runFirstTimeSetup` function)

#### 10.2 Modified: `src/runtime/eliza.ts` — `startEliza()`

**What**: After `runFirstTimeSetup()`, check for cloud mode and branch.

**Changes** (around line ~3610):
```typescript
// After: config = await runFirstTimeSetup(config);
// Before: existing local runtime setup

if (config.cloud?.enabled && config.cloud?.apiKey) {
  const cloudAgentId = (config.cloud as any).agentId;
  if (cloudAgentId) {
    return startInCloudMode(config, cloudAgentId, opts);
  }
}
```

**New function** `startInCloudMode()`:
```typescript
async function startInCloudMode(
  config: AgentConfig,
  agentId: string,
  opts?: StartElizaOptions,
): Promise<AgentRuntime | undefined> {
  const cloudManager = new CloudManager(config.cloud!);
  await cloudManager.init();
  const proxy = await cloudManager.connect(agentId);

  if (opts?.headless || opts?.serverOnly) {
    // API server mode: register cloud proxy as the runtime
    // Start the HTTP server that the GUI connects to
    return startCloudApiServer(proxy, cloudManager, config);
  }

  // Interactive CLI mode
  return startCloudChatLoop(proxy, cloudManager, config);
}
```

#### 10.3 New: `src/runtime/cloud-onboarding.ts`

**What**: Extracted cloud onboarding logic (keeps `eliza.ts` from growing further).

**Contains**:
- `checkCloudAvailability(baseUrl)` — pre-flight availability check
- `runCloudAuth(clack, baseUrl)` — wraps `cloudLogin()` with clack spinners/messages
- `provisionCloudAgent(client, agentName, preset)` — creates + waits for running
- `runCloudOnboarding(clack, name, preset)` — orchestrates the above

**Dependencies**: `src/cloud/auth.ts`, `src/cloud/bridge-client.ts`, `@clack/prompts`

#### 10.4 New: `src/runtime/cloud-chat-loop.ts`

**What**: Interactive readline loop for cloud mode (replaces local chat loop).

**Contains**:
- `startCloudChatLoop(proxy, cloudManager, config)` — readline loop using `CloudRuntimeProxy`
- Shows connection status, latency, cloud agent info in prompt
- Handles reconnection gracefully

#### 10.5 Modified: `src/config/types.agent.ts` — `CloudConfig`

**What**: Add `agentId` field.

```typescript
type CloudConfig = {
  // ...existing fields...
  /** ID of the cloud agent created during onboarding. */
  agentId?: string;
};
```

#### 10.6 Modified: `src/cli/program/register.setup.ts`

**What**: Add cloud option to the `agent setup` non-interactive path.

**Changes**:
- Add `--cloud` flag to setup command
- If `--cloud`: run cloud auth + provisioning flow
- Update `runProviderWizard()` to show cloud as first option

#### 10.7 New: `src/cli/program/register.cloud.ts`

**What**: New `eliza cloud` subcommand group.

**Commands**:
```
eliza cloud login   — authenticate with Eliza Cloud (runs cloudLogin())
eliza cloud status  — show connection status, agent info, capacity
eliza cloud connect — provision a new cloud agent or reconnect to existing
eliza cloud logout  — clear stored API key, disable cloud mode
```

#### 10.8 Modified: `src/cloud/bridge-client.ts`

**What**: Update API paths to use compat routes (or verify V1 routes work).

The `ElizaCloudClient` currently uses `/api/v1/eliza/agents/` paths. For the thin client use case via compat API, either:
- Switch to `/api/compat/agents/` paths, OR
- Verify both route sets map to the same backend service

**Recommendation**: Keep V1 paths for now (they work with the provisioning infrastructure), but add a `useCompatApi` option for the onboarding flow.

#### 10.9 Modified: `src/api/server.ts` (Desktop App API)

**What**: Add onboarding API routes for the GUI to call.

**New routes**:
```
POST /api/onboarding/cloud/check-availability
POST /api/onboarding/cloud/start-auth
GET  /api/onboarding/cloud/auth-status
POST /api/onboarding/cloud/provision
GET  /api/onboarding/cloud/provision-status
```

### Summary Table

| # | File | Change Type | Priority |
|---|------|------------|----------|
| 10.1 | `src/runtime/eliza.ts` (runFirstTimeSetup) | Modify | P0 — core |
| 10.2 | `src/runtime/eliza.ts` (startEliza) | Modify | P0 — core |
| 10.3 | `src/runtime/cloud-onboarding.ts` | New file | P0 — core |
| 10.4 | `src/runtime/cloud-chat-loop.ts` | New file | P1 — UX |
| 10.5 | `src/config/types.agent.ts` | Modify (minor) | P0 — core |
| 10.6 | `src/cli/program/register.setup.ts` | Modify | P1 |
| 10.7 | `src/cli/program/register.cloud.ts` | New file | P1 |
| 10.8 | `src/cloud/bridge-client.ts` | Modify (optional) | P2 |
| 10.9 | `src/api/server.ts` | Modify | P1 — desktop |

---

## 11. New Compat API Endpoints Needed

### In Eliza Cloud (`elizaOS/cloud`)

#### 11.1 `POST /api/compat/agents/[id]/launch` — Implementation

**Status**: Route exists but `launchManagedAgentAgent` is not implemented.

**What it should do**:
1. Verify agent belongs to authenticated user
2. If agent status is "pending" → provision it
3. If agent status is "stopped" → restart it
4. Return `{ agentId, agentName, appUrl, connection: { bridgeUrl, apiKey } }`

**Priority**: P0 — needed for onboarding flow

#### 11.2 Compat API Route Aliases

The agent `ElizaCloudClient` uses `/api/v1/eliza/agents/` paths. Ensure these are either:
- Aliased to compat routes, OR
- Independently served

**Current state**: V1 routes exist separately from compat routes. Both work but may have slight differences in auth and response shapes.

**Recommendation**: Add V1 → compat passthrough or update `ElizaCloudClient` to use compat paths.

#### 11.3 Character Config Pass-Through

When agent creates a cloud agent via `POST /api/compat/agents`, the `agentConfig` should include the full character definition (bio, system, style, etc.) so the cloud agent runs with the chosen personality.

**Current state**: `agentConfig` is stored as JSON in `agent_sandboxes.agent_config`. The cloud provisioning worker passes it to the container.

**Verify**: That the character config in `agentConfig` is correctly applied when the container starts. The cloud agent's `agent.json` should include the personality data.

---

## 12. Sequence Diagrams

### Full Cloud Onboarding (Happy Path)

```
User              agent CLI          Eliza Cloud         Browser         Docker Node
 │                   │                    │                  │                │
 │  agent start     │                    │                  │                │
 │──────────────────>│                    │                  │                │
 │                   │                    │                  │                │
 │  "Name?"          │                    │                  │                │
 │<──────────────────│                    │                  │                │
 │  "Mochi"          │                    │                  │                │
 │──────────────────>│                    │                  │                │
 │                   │                    │                  │                │
 │  "Personality?"   │                    │                  │                │
 │<──────────────────│                    │                  │                │
 │  "uwu~"           │                    │                  │                │
 │──────────────────>│                    │                  │                │
 │                   │                    │                  │                │
 │  "Where to run?"  │                    │                  │                │
 │<──────────────────│                    │                  │                │
 │  "☁️ Eliza Cloud"  │                    │                  │                │
 │──────────────────>│                    │                  │                │
 │                   │                    │                  │                │
 │                   │  GET /compat/      │                  │                │
 │                   │  availability      │                  │                │
 │                   │───────────────────>│                  │                │
 │                   │  {accepting: true} │                  │                │
 │                   │<───────────────────│                  │                │
 │                   │                    │                  │                │
 │                   │  POST /auth/       │                  │                │
 │                   │  cli-session       │                  │                │
 │                   │───────────────────>│                  │                │
 │                   │  {sessionId}       │                  │                │
 │                   │<───────────────────│                  │                │
 │                   │                    │                  │                │
 │  "Open browser    │                    │                  │                │
 │   to log in"      │                    │                  │                │
 │<──────────────────│  open browser ────────────────────>│                │
 │                   │                    │                  │                │
 │                   │  poll...           │  User logs in    │                │
 │                   │  poll...           │  (Privy auth)    │                │
 │                   │───────────────────>│<─────────────────│                │
 │                   │  {apiKey: "ec_."} │                  │                │
 │                   │<───────────────────│                  │                │
 │                   │                    │                  │                │
 │  "✓ Logged in!"   │                    │                  │                │
 │<──────────────────│                    │                  │                │
 │                   │                    │                  │                │
 │                   │  POST /compat/     │                  │                │
 │                   │  agents            │                  │                │
 │                   │  {name, config}    │                  │                │
 │                   │───────────────────>│                  │                │
 │                   │  {agentId, status} │  provision job──────────────────>│
 │                   │<───────────────────│                  │    Docker pull │
 │                   │                    │                  │    Container   │
 │  "Setting up..."  │  poll status...   │                  │    start...    │
 │<──────────────────│───────────────────>│                  │                │
 │                   │  {status: running} │                  │                │
 │                   │<───────────────────│<─────────────────────────────────│
 │                   │                    │                  │                │
 │  "☁️ Ready!       │                    │                  │                │
 │   Talk to Mochi"  │                    │                  │                │
 │<──────────────────│                    │                  │                │
 │                   │                    │                  │                │
 │  "hi mochi~"      │  bridge/message   │                  │                │
 │──────────────────>│───────────────────>│  relay──────────────────────────>│
 │                   │<───────────────────│<─────────────────────────────────│
 │  "hi~ :3"         │                    │                  │                │
 │<──────────────────│                    │                  │                │
```

### Fallback to Local

```
User              agent CLI          Eliza Cloud
 │                   │                    │
 │  picks Cloud      │                    │
 │──────────────────>│                    │
 │                   │  GET /availability │
 │                   │───────────────────>│
 │                   │  {accepting: false}│
 │                   │<───────────────────│
 │                   │                    │
 │  "Cloud is full.  │                    │
 │   Run locally?"   │                    │
 │<──────────────────│                    │
 │  "Yes"            │                    │
 │──────────────────>│                    │
 │                   │                    │
 │  "AI provider?"   │  (Step 4 - local) │
 │<──────────────────│                    │
```

---

## 13. Open Questions

### Must Resolve Before Implementation

1. **V1 vs Compat routes**: Should `ElizaCloudClient` switch to `/api/compat/agents/` or keep `/api/v1/eliza/agents/`? Need to verify both are equivalent or if compat has features V1 lacks.

2. **Character config propagation**: When `agentConfig` is passed to `POST /api/compat/agents`, does the provisioning worker correctly inject it into the container's `agent.json`? Need to trace through `agentSandboxService.createAgent()` → provisioning worker → container startup.

3. **`launchManagedAgentAgent`**: This is referenced in the launch route but not implemented. Is it needed for onboarding, or can we use create + poll + connect?

4. **Wallet setup for cloud agents**: Should the onboarding skip wallets entirely in cloud mode, or should the user still be able to set up wallets that get passed to the cloud agent via `environmentVars`?

5. **Desktop app onboarding**: The GUI web UI handles onboarding separately. Who implements the cloud option in the GUI — the agent team or the Eliza Cloud team? Need coordination.

### Nice to Have (Can Defer)

6. **Agent migration**: Can a local agent be "uploaded" to cloud later? (snapshot → restore)

7. **Multi-agent**: What if the user wants multiple cloud agents? The current onboarding assumes one.

8. **Billing**: Should onboarding show pricing/tier info before the user commits to cloud?

9. **Offline detection**: If the user starts `agent start` without internet and cloud is configured, should it fail gracefully or fall back to local?

---

## Appendix: File Reference

### Agent Repo (`agent-ai/agent`)

| Path | Purpose |
|------|---------|
| `src/runtime/eliza.ts` | Main runtime entry, `runFirstTimeSetup()`, `startEliza()` |
| `src/cli/program/register.setup.ts` | `agent setup` command |
| `src/cli/program/register.start.ts` | `agent start` command (calls `startEliza()`) |
| `src/cli/program/register.config.ts` | `agent config` command |
| `src/onboarding-presets.ts` | `STYLE_PRESETS`, `BIO_POOL`, `SYSTEM_POOL`, `composeCharacter()` |
| `src/runtime/onboarding-names.ts` | `pickRandomNames()` |
| `src/cloud/auth.ts` | `cloudLogin()` — CLI auth session flow |
| `src/cloud/bridge-client.ts` | `ElizaCloudClient` — API client for cloud agents |
| `src/cloud/cloud-manager.ts` | `CloudManager` — orchestrator |
| `src/cloud/cloud-proxy.ts` | `CloudRuntimeProxy` — drop-in runtime replacement |
| `src/cloud/base-url.ts` | URL normalization |
| `src/config/types.agent.ts` | `CloudConfig` type |
| `src/config/config.ts` | `loadAgentConfig()`, `saveAgentConfig()` |

### Eliza Cloud (`elizaOS/cloud` / cloud)

| Path | Purpose |
|------|---------|
| `app/api/auth/cli-session/route.ts` | `POST` — create CLI auth session |
| `app/api/auth/cli-session/[sessionId]/route.ts` | `GET` — poll for auth completion |
| `app/api/auth/cli-session/[sessionId]/complete/route.ts` | `POST` — complete auth (web UI) |
| `app/api/compat/agents/route.ts` | `GET`/`POST` — list/create agents |
| `app/api/compat/agents/[id]/route.ts` | `GET`/`DELETE` — get/delete agent |
| `app/api/compat/agents/[id]/status/route.ts` | `GET` — agent status |
| `app/api/compat/agents/[id]/launch/route.ts` | `POST` — launch/provision agent |
| `app/api/compat/availability/route.ts` | `GET` — capacity check |
| `packages/lib/api/compat-envelope.ts` | Response shape utilities |
| `app/api/compat/_lib/auth.ts` | Auth helper (service key / JWT / Privy) |

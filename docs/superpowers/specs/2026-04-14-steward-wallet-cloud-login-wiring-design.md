# Steward Wallet Auto-Provisioning on Cloud Login

## Problem

When a desktop user logs into Eliza Cloud, the wallet page stays empty. All
Steward infrastructure (signing bridge, policy UI, approval queue, credential
persistence, auto-enable) already exists but sits dormant because cloud login
never provisions Steward credentials for the local agent.

## Solution

Wire three existing systems together so cloud login automatically provisions a
Steward-managed wallet with default spending policies. No new packages, no new
UI components — just plumbing between cloud-routes, steward-bridge, and
plugin-auto-enable.

### Data flow

```
User clicks "Login to Eliza Cloud"
  │
  ▼
useCloudState → POST /api/cloud/login → opens browser auth
  │
  ▼
Poll GET /api/cloud/login/status → status: "authenticated", apiKey
  │
  ▼
cloud-routes.ts (line 322–390, existing):
  ├── save cloud.apiKey to config
  ├── set process.env.ELIZAOS_CLOUD_API_KEY
  │
  ▼
NEW: provisionStewardFromCloud(state, cloudBaseUrl, apiKey)
  │
  ├── 1. Derive stewardApiUrl = cloudBaseUrl + "/steward"
  │      (cloud proxy, no direct Steward port exposure)
  │
  ├── 2. POST {cloudBase}/api/v1/steward/tenants
  │      body: { organizationId }
  │      returns: { tenantId, isNew }
  │      (idempotent — returns existing if already provisioned)
  │
  ├── 3. Fetch org API key from cloud
  │      GET {cloudBase}/api/v1/steward/tenants/credentials
  │      returns: { tenantId, apiKey }
  │      (new cloud endpoint, thin DB lookup)
  │
  ├── 4. Set process.env:
  │      STEWARD_API_URL = stewardApiUrl
  │      STEWARD_TENANT_ID = tenantId
  │      STEWARD_API_KEY = apiKey
  │
  ├── 5. ensureStewardAgent({ agentId, agentName })
  │      (existing function in steward-bridge.ts)
  │      → creates agent if missing
  │      → fetches wallet addresses
  │      → persists to ~/.eliza/steward-credentials.json
  │      → calls applyStewardWalletAddressesToRuntimeCache()
  │
  ├── 6. Apply default policies via client.setPolicies(agentId, DEFAULT_POLICIES)
  │
  └── 7. Persist STEWARD_* env vars to config.env in eliza.json
         (so they survive restart)
  │
  ▼
Existing: restart runtime → @stwd/eliza-plugin auto-enables →
  steward-evm-bridge injects signing → wallet UI shows addresses + policies
```

### What becomes visible after login

All of this is already built and will activate once credentials exist:

- **InventoryView**: StewardWalletInfoPopup shows EVM/Solana addresses, vault
  health badge, "View Wallet Policies" button
- **PolicyControlsView**: Spending limits, rate limits, time windows, approved
  addresses, auto-approve toggles
- **ApprovalQueue**: Pending transactions with approve/deny buttons
- **TransactionHistory**: Past signed transactions with status
- **Wallet balances**: Steward-managed balances via steward-balances/tokens endpoints
- **Signing**: All plugin-evm transactions route through Steward vault

## Files to Modify

### 1. `eliza/packages/agent/src/api/cloud-routes.ts`

**Where**: After line 390 (after `sendJson(res, { status: "authenticated" })`)
but before the response is sent.

**What**: Insert call to new `provisionStewardFromCloud()` function. Wrap in
try/catch so Steward provisioning failure does not block cloud login success.

```typescript
// After API key save succeeds, before sending response:
try {
  await provisionStewardFromCloud(state, cloudBaseUrl, data.apiKey);
  logger.info("[cloud-login] Steward wallet provisioned");
} catch (stewardErr) {
  logger.warn(`[cloud-login] Steward provisioning failed (non-fatal): ${String(stewardErr)}`);
}
```

The login response changes from `{ status: "authenticated", keyPrefix }` to
also include `stewardProvisioned: boolean` so the UI knows whether to show
a wallet loading state.

### 2. New function: `provisionStewardFromCloud()` in cloud-routes.ts

~80 lines. Orchestrates the 7-step flow above. Lives in cloud-routes.ts
(not a new file) because it's tightly coupled to the login handler's `state`
object.

Key implementation details:

- **Steward URL derivation**: `cloudBaseUrl + "/steward"` — assumes the cloud
  deployment proxies Steward behind this path. If not available, falls back to
  `process.env.STEWARD_API_URL` (for self-hosted setups).
  > **SSRF concern**: `cloudBaseUrl` originates from user-controlled cloud config.
  > Before using it to make server-side requests, validate it against an allowlist
  > of known Eliza Cloud hostnames (e.g. `*.elizaos.ai`) or at minimum reject
  > private/loopback IPs to prevent the runtime from being pointed at internal
  > services via a malicious config.

- **Tenant provisioning**: Uses the existing `POST /api/v1/steward/tenants`
  endpoint which is idempotent. Needs `organizationId` — fetch from
  `GET /api/cloud/status` (which already returns `organizationId`) or extract
  from the auth session.

- **Credentials persistence**: Writes to both `process.env` (for current
  session) and `config.env` in `eliza.json` (for restart survival). Uses the
  existing `state.saveConfig()` pattern.

- **ensureStewardAgent**: Already handles agent creation, wallet address
  extraction, credential file persistence, and runtime cache population. The
  single-flight mutex prevents races.

### 3. New cloud endpoint: `GET /api/v1/steward/tenants/credentials`

**Where**: `eliza/cloud/app/api/v1/steward/tenants/credentials/route.ts`

~40 lines. Authenticated endpoint that returns the Steward tenant credentials
for the caller's organization. Reads `steward_tenant_id` and
`steward_tenant_api_key` from the organizations table. Returns 404 if not
provisioned.

```typescript
// Response shape:
{ tenantId: string, apiKey: string, stewardApiUrl: string }
```

The `stewardApiUrl` is derived server-side from `process.env.STEWARD_API_URL`
so the desktop client never needs to guess.

### 4. `eliza/packages/agent/src/api/cloud-routes.ts` — cloud status extension

**Where**: The handler for `GET /api/cloud/status` (already exists)

**What**: Add `organizationId` to the response if not already present. The
provisioning function needs it to call `POST /api/v1/steward/tenants`.

### 5. Default policies constant

**Where**: New constant in `steward-bridge.ts` or alongside
`provisionStewardFromCloud()`.

```typescript
const DEFAULT_STEWARD_POLICIES: PolicyRule[] = [
  {
    type: "spend_limit",
    enabled: true,
    config: {
      maxPerTransaction: "100000000000000000", // 0.1 ETH
      maxPerDay: "500000000000000000",         // 0.5 ETH
      currency: "wei",
    },
  },
  {
    type: "rate_limit",
    enabled: true,
    config: {
      maxTransactionsPerHour: 10,
      maxTransactionsPerDay: 50,
    },
  },
];
```

Conservative defaults. User can adjust via PolicyControlsView immediately.

### 6. Config persistence for STEWARD_* vars

**Where**: Inside `provisionStewardFromCloud()`, after env vars are set.

**What**: Write to `config.env` object in eliza.json:

```typescript
config.env.STEWARD_API_URL = stewardApiUrl;
config.env.STEWARD_TENANT_ID = tenantId;
config.env.STEWARD_API_KEY = apiKey;
// STEWARD_AGENT_TOKEN comes from ensureStewardAgent → persisted in
// steward-credentials.json (existing path)
state.saveConfig(config);
```

## Files NOT Modified

- **useCloudState.ts**: Already calls `loadWalletConfig()` and
  `getStewardStatus()` on login success (lines 414-419). Once credentials
  exist, this works as-is.
- **InventoryView.tsx**: Already renders StewardWalletInfoPopup when Steward
  is configured. No changes needed.
- **PolicyControlsView.tsx**: Already fully functional. No changes.
- **steward-compat-routes.ts**: All 13 endpoints already work. No changes.
- **steward-bridge.ts**: `ensureStewardAgent()` already handles everything. No
  changes needed (only consumed).
- **plugin-auto-enable.ts**: Already auto-enables `@stwd/eliza-plugin` when
  `STEWARD_API_URL` is set, and `@elizaos/plugin-evm` when
  `STEWARD_AGENT_TOKEN` is set. No changes.
- **useWalletState.ts**: Already fetches from `/api/wallet/config`. No changes.
- **No new packages**. No new UI components. No new npm dependencies.

## Edge Cases

### Cloud login succeeds but Steward provisioning fails
Non-fatal. Cloud login still returns `authenticated`. Steward provisioning is
best-effort. User can retry by disconnecting and reconnecting, or we can add a
"Retry wallet setup" button in a future iteration.

### User already has Steward credentials (re-login)
`POST /api/v1/steward/tenants` is idempotent (returns existing tenant).
`ensureStewardAgent()` checks if agent exists before creating. Both are safe to
call repeatedly.

### Multiple agents on same cloud account
Current scope: one Steward agent per local Eliza instance, keyed on agentId
from the runtime. Multiple desktop instances each get their own agent within the
same tenant.

### Cloud disconnect
Existing `handleCloudDisconnect()` clears `cloud.apiKey`. Steward credentials
in `steward-credentials.json` persist — the wallet continues to work in
local-only mode with the Steward vault still active. This is correct behavior:
the wallet is a distinct resource from the cloud connection.

### Self-hosted Steward (future)
Out of scope. Would add a "Connect to Steward" settings field for
`STEWARD_API_URL`. The provisioning code already falls back to
`process.env.STEWARD_API_URL` if set, so manual configuration would work
with zero code changes to the provisioning flow.

## Verification

### Manual test
1. `rm -rf ~/.eliza/steward-credentials.json` (clean slate)
2. `bun run dev`
3. Open UI → Cloud → Login
4. After login: wallet page shows Steward addresses within 5s
5. Navigate to wallet policies → spending limits visible
6. Kill and restart → wallet still shows (credentials persisted)

### Unit test targets
- `provisionStewardFromCloud()` with mocked fetch: happy path, tenant already
  exists, Steward unreachable, partial failure recovery
- Config persistence: verify `config.env.STEWARD_*` written after provisioning

### Integration
- Cloud login → wallet addresses visible in InventoryView
- Policy controls render and save
- Signing a transaction routes through Steward vault

## Build Order

1. **Cloud credential endpoint** — `GET /api/v1/steward/tenants/credentials`
   (cloud-side, ~40 lines)
2. **provisionStewardFromCloud()** — the orchestration function (~80 lines)
3. **Wire into cloud-routes.ts login handler** — insert after API key save
   (~10 lines)
4. **Config persistence** — write STEWARD_* to eliza.json config.env
5. **Default policies** — constant + apply in provisioning
6. **Test** — manual login flow, verify wallet + policies appear

Total estimated new code: ~150 lines across 3 files.

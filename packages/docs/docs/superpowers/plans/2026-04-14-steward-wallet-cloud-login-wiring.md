# Steward Wallet Cloud Login Wiring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user logs into Eliza Cloud from the desktop app, automatically provision a Steward-managed wallet so the wallet page, policies, and signing all work out of the box.

**Architecture:** Insert a `provisionStewardFromCloud()` call into the app-core cloud login handler (`packages/app-core/src/api/cloud-routes.ts:345-356`). This function calls the cloud's existing Steward tenant endpoint, sets env vars, runs the existing `ensureStewardAgent()` from `steward-bridge.ts`, applies default policies, and persists credentials. A thin new cloud-side endpoint returns tenant credentials. Total ~170 new lines across 2 files modified + 1 file created.

**Tech Stack:** TypeScript, Bun, Next.js (cloud-side), `@stwd/sdk`, existing `steward-bridge.ts`

**Spec:** `docs/superpowers/specs/2026-04-14-steward-wallet-cloud-login-wiring-design.md`

**Key context:**
- There are TWO `cloud-routes.ts` files: `packages/agent/src/api/cloud-routes.ts` (585 lines, base handler) and `packages/app-core/src/api/cloud-routes.ts` (379 lines, desktop wrapper). We modify the **app-core** one — it's what runs in the desktop app, and it can import from `steward-bridge.ts` (same package).
- `ensureStewardAgent()` lives in `packages/app-core/src/api/steward-bridge.ts:893`. It is already exported, idempotent, single-flighted, and handles agent creation + wallet address extraction + credential persistence + runtime cache population.
- The login success path is at app-core `cloud-routes.ts:345-356`: after `persistCloudLoginStatus()` saves the API key, before `sendJson()` responds.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `eliza/cloud/app/api/v1/steward/tenants/credentials/route.ts` | **Create** | Cloud endpoint: return Steward tenant credentials for authenticated user's org |
| `eliza/packages/app-core/src/api/cloud-routes.ts` | **Modify** | Insert `provisionStewardFromCloud()` into login success handler |
| `eliza/packages/app-core/src/api/steward-bridge.ts` | Read-only | Consumed — `ensureStewardAgent()` already exists at line 893 |
| `eliza/packages/app-core/src/state/useCloudState.ts` | Read-only | Already calls `getStewardStatus()` + `loadWalletConfig()` on login success (lines 414-419) |
| `CLAUDE.md` | **Modify** | Remove phantom env vars, add real Steward ones |

---

### Task 1: Cloud Endpoint — Steward Tenant Credentials

**Files:**
- Create: `eliza/cloud/app/api/v1/steward/tenants/credentials/route.ts`

This endpoint lets the desktop agent fetch Steward credentials after cloud login, using the cloud API key for auth.

- [ ] **Step 1: Check the DB schema has the column**

```bash
grep -n "steward_tenant_api_key" eliza/cloud/packages/db/schemas/organizations.ts
```

Expected: a column definition. If missing, add it after `steward_tenant_id`:

```typescript
steward_tenant_api_key: text("steward_tenant_api_key"),
```

The migration `0060` already created this column in the DB — this just makes Drizzle's TypeScript schema aware of it.

- [ ] **Step 2: Create the credentials endpoint**

Create `eliza/cloud/app/api/v1/steward/tenants/credentials/route.ts`:

```typescript
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getErrorStatusCode } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { logger } from "@/lib/utils/logger";
import { dbWrite } from "@/packages/db/helpers";
import { organizations } from "@/packages/db/schemas/organizations";

/**
 * GET /api/v1/steward/tenants/credentials
 *
 * Returns Steward tenant credentials for the authenticated user's org.
 * Called by the desktop agent after cloud login to configure Steward locally.
 * Auth: X-Api-Key header (cloud API key from login).
 */
export async function GET(req: NextRequest) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(req);

    const [org] = await dbWrite
      .select({
        id: organizations.id,
        stewardTenantId: organizations.steward_tenant_id,
        stewardTenantApiKey: organizations.steward_tenant_api_key,
      })
      .from(organizations)
      .where(eq(organizations.id, user.organization_id))
      .limit(1);

    if (!org) {
      return NextResponse.json(
        { error: "Organization not found" },
        { status: 404 },
      );
    }

    if (!org.stewardTenantId) {
      return NextResponse.json(
        { error: "Steward not provisioned for this organization" },
        { status: 404 },
      );
    }

    const stewardApiUrl =
      process.env.STEWARD_API_URL ?? "http://localhost:3200";

    return NextResponse.json({
      tenantId: org.stewardTenantId,
      apiKey: org.stewardTenantApiKey ?? "",
      stewardApiUrl,
    });
  } catch (error) {
    const status = getErrorStatusCode(error);
    if (status >= 500) {
      logger.error("[steward-credentials] Unexpected error", { error });
    }
    if (status === 401) {
      return NextResponse.json({ error: "Unauthorized" }, { status });
    }
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Internal server error",
      },
      { status },
    );
  }
}
```

- [ ] **Step 3: Commit**

```bash
cd "$(git rev-parse --show-toplevel)/eliza"
git add cloud/app/api/v1/steward/tenants/credentials/route.ts
git commit -m "feat: add GET /api/v1/steward/tenants/credentials endpoint

Returns Steward tenant ID, API key, and API URL for the authenticated
user's organization. Used by the desktop agent after cloud login to
configure Steward locally."
```

---

### Task 2: Steward Provisioning Function

**Files:**
- Modify: `eliza/packages/app-core/src/api/cloud-routes.ts`

Add `provisionStewardFromCloud()` and wire it into the login handler.

- [ ] **Step 1: Add import for ensureStewardAgent**

At the top of `eliza/packages/app-core/src/api/cloud-routes.ts`, after the existing imports (after line 22 — `from "./cloud-connection"`), add:

```typescript
import {
  ensureStewardAgent,
  type EnsureStewardAgentResult,
} from "./steward-bridge";
```

- [ ] **Step 2: Add default policies constant and provisioning function**

Insert after the `isTimeoutError` import block and before the `CLOUD_LOGIN_POLL_TIMEOUT_MS` constant. Find the line:

```typescript
import { isTimeoutError } from "../utils/errors";
```

After all imports and before any runtime code, add:

```typescript
// ── Steward auto-provisioning on cloud login ──────────────────────────────

/**
 * Conservative default policies applied to newly provisioned Steward wallets.
 * Users can adjust via PolicyControlsView in the wallet settings.
 */
const DEFAULT_STEWARD_POLICIES = [
  {
    type: "spend_limit" as const,
    enabled: true,
    config: {
      maxPerTransaction: "100000000000000000", // 0.1 ETH
      maxPerDay: "500000000000000000", // 0.5 ETH
      currency: "wei",
    },
  },
  {
    type: "rate_limit" as const,
    enabled: true,
    config: {
      maxTransactionsPerHour: 10,
      maxTransactionsPerDay: 50,
    },
  },
];

interface StewardProvisionResult {
  tenantId: string;
  agentResult: EnsureStewardAgentResult | null;
}

/**
 * Provision a Steward wallet after successful Eliza Cloud login.
 *
 * 1. Provision tenant on cloud (idempotent)
 * 2. Fetch credentials from cloud
 * 3. Set STEWARD_* env vars
 * 4. Ensure steward agent + wallet exist
 * 5. Apply default spending policies (new agents only)
 * 6. Persist to config.env for restart survival
 *
 * Best-effort: logs warnings on failure, never throws.
 */
async function provisionStewardFromCloud(
  state: CloudRouteState,
  cloudBaseUrl: string,
  cloudApiKey: string,
): Promise<StewardProvisionResult | null> {
  if (process.env.STEWARD_API_URL && process.env.STEWARD_TENANT_ID) {
    logger.debug(
      "[cloud-login] Steward already configured, skipping cloud provisioning",
    );
    return null;
  }

  const cloudHeaders = {
    "Content-Type": "application/json",
    "X-Api-Key": cloudApiKey,
  };

  // ── Step 1: Ensure tenant exists on cloud ──
  // We need the organizationId to provision. Fetch from cloud status.
  let organizationId: string | undefined;
  try {
    const statusRes = await fetch(`${cloudBaseUrl}/api/cloud/status`, {
      headers: { "X-Api-Key": cloudApiKey },
      signal: AbortSignal.timeout(5_000),
    });
    if (statusRes.ok) {
      const body = (await statusRes.json()) as {
        organizationId?: string;
      };
      organizationId = body.organizationId;
    }
  } catch {
    // Non-fatal — tenant may already be provisioned
  }

  if (organizationId) {
    try {
      await fetch(`${cloudBaseUrl}/api/v1/steward/tenants`, {
        method: "POST",
        headers: cloudHeaders,
        body: JSON.stringify({ organizationId }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      logger.warn(
        `[cloud-login] Steward tenant provisioning request failed: ${String(err)}`,
      );
    }
  }

  // ── Step 2: Fetch credentials from cloud ──
  let tenantId: string;
  let tenantApiKey: string;
  let stewardApiUrl: string;
  try {
    const credRes = await fetch(
      `${cloudBaseUrl}/api/v1/steward/tenants/credentials`,
      {
        headers: { "X-Api-Key": cloudApiKey },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!credRes.ok) {
      logger.warn(
        `[cloud-login] Steward credentials not available (HTTP ${credRes.status})`,
      );
      return null;
    }
    const creds = (await credRes.json()) as {
      tenantId: string;
      apiKey: string;
      stewardApiUrl: string;
    };
    tenantId = creds.tenantId;
    tenantApiKey = creds.apiKey;
    stewardApiUrl = creds.stewardApiUrl;
  } catch (err) {
    logger.warn(
      `[cloud-login] Failed to fetch Steward credentials: ${String(err)}`,
    );
    return null;
  }

  // ── Step 3: Set env vars for current session ──
  process.env.STEWARD_API_URL = stewardApiUrl;
  process.env.STEWARD_TENANT_ID = tenantId;
  process.env.STEWARD_API_KEY = tenantApiKey;

  // ── Step 4: Ensure steward agent + wallet exist ──
  const runtime = state.runtime as
    | { agentId?: string; character?: { name?: string } }
    | null
    | undefined;
  const agentId = runtime?.agentId ?? "eliza-desktop";
  const agentName = runtime?.character?.name ?? "Eliza";

  let agentResult: EnsureStewardAgentResult | null = null;
  try {
    agentResult = await ensureStewardAgent({ agentId, agentName });
  } catch (err) {
    logger.warn(
      `[cloud-login] Steward agent provisioning failed: ${String(err)}`,
    );
  }

  // ── Step 5: Apply default policies to newly created agents ──
  if (agentResult?.created) {
    try {
      const { StewardClient } = await import("@stwd/sdk");
      const policyClient = new StewardClient({
        baseUrl: stewardApiUrl,
        apiKey: tenantApiKey,
        tenantId,
      });
      await policyClient.setPolicies(agentId, DEFAULT_STEWARD_POLICIES);
      logger.info("[cloud-login] Default Steward spending policies applied");
    } catch (err) {
      logger.warn(
        `[cloud-login] Failed to apply default policies (non-fatal): ${String(err)}`,
      );
    }
  }

  // ── Step 6: Persist to config.env for restart survival ──
  try {
    const config = state.config as Record<string, unknown>;
    if (!config.env) config.env = {};
    const env = config.env as Record<string, string>;
    env.STEWARD_API_URL = stewardApiUrl;
    env.STEWARD_TENANT_ID = tenantId;
    env.STEWARD_API_KEY = tenantApiKey;
    saveElizaConfig(state.config);
    logger.info("[cloud-login] Steward credentials persisted to config.env");
  } catch (err) {
    logger.warn(
      `[cloud-login] Failed to persist Steward config: ${String(err)}`,
    );
  }

  return { tenantId, agentResult };
}
```

- [ ] **Step 3: Verify import resolution**

```bash
grep -n "^export function ensureStewardAgent" eliza/packages/app-core/src/api/steward-bridge.ts
```

Expected: `export function ensureStewardAgent(` at ~line 893.

```bash
grep -n "^export interface EnsureStewardAgentResult" eliza/packages/app-core/src/api/steward-bridge.ts
```

Expected: `export interface EnsureStewardAgentResult` at ~line 878.

- [ ] **Step 4: Commit**

```bash
cd "$(git rev-parse --show-toplevel)/eliza"
git add packages/app-core/src/api/cloud-routes.ts
git commit -m "feat: add provisionStewardFromCloud orchestration function

Provisions a Steward tenant and agent wallet after Eliza Cloud login.
Derives credentials from the cloud API, creates the steward agent
idempotently, applies conservative default spending policies, and
persists STEWARD_* env vars to config.env for restart survival."
```

---

### Task 3: Wire Into Login Handler

**Files:**
- Modify: `eliza/packages/app-core/src/api/cloud-routes.ts` (line 345-356)

Insert the provisioning call between `persistCloudLoginStatus()` and `sendJson()`.

- [ ] **Step 1: Modify the login success block**

Find this block at lines 345-356:

```typescript
    if (data.status === "authenticated" && typeof data.apiKey === "string") {
      await persistCloudLoginStatus({
        apiKey: data.apiKey,
        state,
        epochAtPollStart: epochBeforePoll,
      });
      sendJson(res, 200, {
        status: "authenticated",
        keyPrefix:
          typeof data.keyPrefix === "string" ? data.keyPrefix : undefined,
      });
      return true;
    }
```

Replace with:

```typescript
    if (data.status === "authenticated" && typeof data.apiKey === "string") {
      await persistCloudLoginStatus({
        apiKey: data.apiKey,
        state,
        epochAtPollStart: epochBeforePoll,
      });

      // Provision Steward wallet (best-effort — login succeeds regardless)
      let stewardProvisioned = false;
      try {
        const baseUrl = normalizeCloudSiteUrl(state.config.cloud?.baseUrl);
        const result = await provisionStewardFromCloud(
          state,
          baseUrl,
          data.apiKey,
        );
        stewardProvisioned = result?.agentResult != null;
        if (stewardProvisioned) {
          logger.info(
            `[cloud-login] Steward wallet ready: EVM=${result!.agentResult!.walletAddresses.evm ?? "none"}`,
          );
        }
      } catch (err) {
        logger.warn(
          `[cloud-login] Steward provisioning failed (non-fatal): ${String(err)}`,
        );
      }

      sendJson(res, 200, {
        status: "authenticated",
        keyPrefix:
          typeof data.keyPrefix === "string" ? data.keyPrefix : undefined,
        stewardProvisioned,
      });
      return true;
    }
```

- [ ] **Step 2: Verify build**

```bash
cd "$(git rev-parse --show-toplevel)"
bun run verify 2>&1 | grep -E "(cloud-routes|error TS)" | head -20
```

Expected: no new TypeScript errors in `cloud-routes.ts`. Pre-existing errors in other files are acceptable.

- [ ] **Step 3: Commit**

```bash
cd "$(git rev-parse --show-toplevel)/eliza"
git add packages/app-core/src/api/cloud-routes.ts
git commit -m "feat: wire steward provisioning into cloud login success path

After cloud API key is saved, attempts to provision a Steward tenant
and agent wallet. Non-fatal: login succeeds even if Steward setup fails.
Response now includes stewardProvisioned boolean for the UI."
```

---

### Task 4: Clean Up CLAUDE.md Env Vars

**Files:**
- Modify: `$(git rev-parse --show-toplevel)/CLAUDE.md`

Remove phantom env vars from the abandoned cloud-wallet plan and add the real Steward ones.

- [ ] **Step 1: Remove phantom env vars**

In CLAUDE.md's "Setup Environment Variables" table, find and remove these rows (they reference code that was never implemented):

- `ENABLE_CLOUD_WALLET` — the entire row
- `ELIZA_CLOUD_CLIENT_ADDRESS_KEY` — the entire row
- `WALLET_SOURCE_EVM` / `WALLET_SOURCE_SOLANA` — the entire row
- `ENABLE_EVM_PLUGIN` — the entire row

- [ ] **Step 2: Add real Steward env vars**

Add these rows to the env var table:

```markdown
| `STEWARD_API_URL` | Steward vault API base URL. Auto-provisioned on Eliza Cloud login; set manually for self-hosted Steward. | — |
| `STEWARD_TENANT_ID` | Steward tenant identifier. Auto-provisioned on cloud login. | — |
| `STEWARD_API_KEY` | Steward tenant API key. Auto-provisioned on cloud login. Persisted to `config.env`. | — |
| `STEWARD_AGENT_TOKEN` | Steward agent bearer token. Generated during agent provisioning, persisted to `~/.eliza/steward-credentials.json`. | — |
| `STEWARD_AGENT_ID` | Steward agent identifier. Defaults to the runtime `agentId`. | — |
```

- [ ] **Step 3: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
git add CLAUDE.md
git commit -m "docs: replace phantom cloud-wallet env vars with real Steward ones

Remove ENABLE_CLOUD_WALLET, ELIZA_CLOUD_CLIENT_ADDRESS_KEY,
WALLET_SOURCE_*, ENABLE_EVM_PLUGIN (never implemented). Add STEWARD_*
env vars that are actually used by the cloud login provisioning flow."
```

---

### Task 5: Remove Stale Working Notes

**Files:**
- Delete: `COMPLETE_FIXES.md`, `FIXES_APPLIED.md`, `FIX_SUMMARY.md`, `ONBOARDING_COMPLETE_MAP.md`

- [ ] **Step 1: Delete stale files**

```bash
cd "$(git rev-parse --show-toplevel)"
rm -f COMPLETE_FIXES.md FIXES_APPLIED.md FIX_SUMMARY.md ONBOARDING_COMPLETE_MAP.md
```

These are untracked working notes from prior sessions. The information is preserved in git history and the spec/plan docs.

- [ ] **Step 2: Commit**

```bash
git add COMPLETE_FIXES.md FIXES_APPLIED.md FIX_SUMMARY.md ONBOARDING_COMPLETE_MAP.md
git commit -m "chore: remove stale working notes from repo root"
```

---

### Task 6: Integration Verification

Manual testing to confirm the full flow works end-to-end.

- [ ] **Step 1: Clean steward state**

```bash
rm -f ~/.eliza/steward-credentials.json
```

Verify no STEWARD_* vars in config:

```bash
grep -i steward ~/.eliza/eliza.json || echo "Clean — no steward config"
```

- [ ] **Step 2: Start dev environment**

```bash
cd "$(git rev-parse --show-toplevel)"
bun run dev
```

Wait for `[api] API ready on http://127.0.0.1:31337`.

- [ ] **Step 3: Login to Eliza Cloud**

Open `http://localhost:2138` → Cloud → Login. Complete browser auth flow.

- [ ] **Step 4: Check server logs for provisioning**

Look for these log lines (in order):

```
[cloud-login] Saved cloud API key to config file
[cloud-login] Steward credentials persisted to config.env
[cloud-login] Default Steward spending policies applied
[cloud-login] Steward wallet ready: EVM=0x...
```

If you see `Steward credentials not available (HTTP 404)`, the cloud doesn't have a tenant for this org yet — check that `POST /api/v1/steward/tenants` succeeded first.

If you see `Steward already configured, skipping cloud provisioning`, credentials already exist from a prior run — this is correct idempotent behavior.

- [ ] **Step 5: Verify credentials persisted**

```bash
cat ~/.eliza/steward-credentials.json | python3 -m json.tool
```

Expected fields: `apiUrl`, `tenantId`, `agentId`, `apiKey`, `agentToken`, `walletAddresses.evm`.

```bash
grep -i steward ~/.eliza/eliza.json
```

Expected: `STEWARD_API_URL`, `STEWARD_TENANT_ID`, `STEWARD_API_KEY` in the `env` object.

- [ ] **Step 6: Verify wallet UI**

After the runtime restarts (triggered by `useCloudState.ts` line 404-413):

1. Navigate to wallet page (InventoryView)
2. Steward wallet info popup should show EVM address + vault health "ok"
3. Click "View Wallet Policies" — should show spend limit (0.1 ETH/tx, 0.5 ETH/day) and rate limit (10/hr, 50/day)
4. Wallet balances should load (will be 0 for a new wallet)

- [ ] **Step 7: Verify idempotency (re-login)**

Disconnect from cloud, then reconnect. Check logs for:
```
[cloud-login] Steward already configured, skipping cloud provisioning
```

Steward credentials should remain unchanged. No duplicate agents created.

# LifeOps OWNER vs AGENT live-validation matrix

> Tracks issue [#8833](https://github.com/elizaOS/eliza/issues/8833) §2/§5.
> This document is the single source of truth for the live, account-backed
> validation of the split LifeOps surface (`@elizaos/plugin-personal-assistant`
> plus the per-domain plugins) across OWNER and AGENT identities. It records the
> account/device/scope/env prerequisites and the repeatable run instructions so
> the matrix can be re-exercised on demand.

The static/code-level split is already validated (see the issue body and
`docs/lifeops-cleanup-review.md`). The remaining work is **live** validation
with real accounts, devices, and OAuth/provider state. This doc + the
credential-gated harness (`test/owner-agent-permission-matrix.integration.test.ts`)
cover the parts that can be exercised repeatably; the native-device items
(iOS/macOS/Android) are tracked separately because they cannot run in CI.

---

## 1. The nine permission states

For every owner-gated action/connector surface, the validation exercises these
nine states (issue §2):

| # | State | Expected behavior |
|---|---|---|
| 1 | Unauthenticated connector / no world context | Owner-only operation denied; no sender role resolves above GUEST. |
| 2 | OWNER authenticated and authorized | Allowed through the planned-tool gate **and** the direct handler. |
| 3 | AGENT authenticated but **not** owner-authorized | Denied with a clear permission error on both paths. |
| 4 | Expired / revoked grant | Owner-side grant no longer resolves; the operation surfaces a reconnect-required state. |
| 5 | Missing required scope | The granted capability set does not advertise the write/send capability; the action returns the matching unavailable message rather than acting. |
| 6 | Multiple grants — owner-side selection must win | An owner-only operation resolves the `side="owner"` grant; the `side="agent"` grant never leaks in. |
| 7 | Planned-tool execution path | `satisfiesRoleGate(userRoles, action.roleGate)` denies non-owner callers. |
| 8 | Direct handler-invocation path | `hasLifeOpsAccess` → `hasOwnerAccess` → `hasRoleAccess(..., "OWNER")` denies non-owner callers. |
| 9 | UI-triggered path from the relevant view | The view dispatches the same gated action; the gate above applies unchanged. |

### Where each state is enforced (source of truth)

- **Planned-tool gate (state 7):** `packages/core/src/runtime/execute-planned-tool-call.ts`
  → `getGateFailure()` → `satisfiesRoleGate()` (`packages/core/src/runtime/context-gates.ts`).
- **Handler guard (state 8):** each owner action calls
  `hasLifeOpsAccess()` (`src/lifeops/access.ts`) → `hasOwnerAccess()`
  (`@elizaos/agent` security) → `hasRoleAccess(..., "OWNER")`
  (`packages/core/src/roles.ts`), returning `PERMISSION_DENIED` on failure.
- **Owner-side grant resolution (states 4/5/6):**
  `LifeOpsRepository.getConnectorGrant()` (`src/lifeops/repository.ts`) filters
  by `side` (default `"owner"`), so an owner-only operation never resolves the
  agent-side grant.
- **Typed dispatch (no swallowed failures):** connector `send` returns
  `DispatchResult` (`@elizaos/plugin-scheduling`), surfaced through the
  `CONNECTOR` action; never a bare boolean.

---

## 2. Owner-gated action surfaces

The harness covers the four cross-cutting owner-gated umbrella actions; the same
gate applies to every action carrying `roleGate: { minRole: "OWNER" }`:

| Action | File | Notes |
|---|---|---|
| `CONNECTOR` | `src/actions/connector.ts` | Connect/disconnect/verify/status/list across Google, X, Telegram, Signal, Discord, iMessage, WhatsApp, health, browser. |
| `CREDENTIALS` | `src/actions/credentials.ts` | Credential lookup + autofill. |
| `PERSONAL_ASSISTANT` | `src/actions/owner-surfaces.ts` | Cross-domain assistant orchestration. |
| `VOICE_CALL` | `src/actions/voice-call.ts` | Outbound Twilio voice. |

Other owner surfaces (`CALENDAR`, `INBOX`, `OWNER_*`, `ENTITY`, `BLOCK`,
`SCHEDULED_TASKS`, …) share the identical `roleGate` + `hasLifeOpsAccess`
mechanism; see `test/lifeops-action-gating.integration.test.ts` for the full
registered-surface inventory.

---

## 3. Account / device / scope / env prerequisites

The credential-gated harness runs against a local PGLite-backed runtime with no
external accounts. The **live connector smoke** (send/read/sync against real
providers) and the **native-device** items require the identities below. Provide
them, set `LIFEOPS_PERMISSION_MATRIX=1`, and (for the live-LLM journeys)
`ELIZA_LIVE_TEST=1` plus a provider key.

| Surface | OWNER identity | AGENT identity | Required scopes / env | Run gate |
|---|---|---|---|---|
| Google Calendar | OWNER Google acct, Calendar enabled | Separate AGENT Google acct or non-owner grant | `google.calendar.read` / `.write` (OAuth) | `LIFEOPS_PERMISSION_MATRIX=1` + live OAuth |
| Gmail / inbox | OWNER Gmail | AGENT Gmail | `google.gmail.triage` / `.send` / `.manage` | as above |
| Telegram | OWNER Telegram | AGENT Telegram | `@elizaos/plugin-telegram` configured | as above |
| Discord | OWNER Discord | AGENT Discord | `DISCORD_BOT_TOKEN` (`@elizaos/plugin-discord`) | as above |
| Signal | OWNER paired number | AGENT paired number | `@elizaos/plugin-signal` paired | as above |
| WhatsApp | OWNER WhatsApp | AGENT WhatsApp | `ELIZA_WHATSAPP_ACCESS_TOKEN`, `ELIZA_WHATSAPP_PHONE_NUMBER_ID` | as above |
| X | OWNER X | AGENT X | `@elizaos/plugin-x` configured | as above |
| iMessage | OWNER macOS bridge | n/a | macOS host; `ELIZA_IMESSAGE_BACKEND` | native (not CI) |
| Phone / SMS / voice | Twilio number | recipient allowlist | `@elizaos/plugin-phone/twilio` env | `LIFEOPS_PERMISSION_MATRIX=1` |
| Health | Apple Health / Google Fit / Fitbit / Oura / Strava / Withings | n/a | per-provider OAuth / `ELIZA_HEALTHKIT_CLI_PATH`, `ELIZA_GOOGLE_FIT_ACCESS_TOKEN` | native / live OAuth |
| Blocker / focus | macOS SelfControl / admin | n/a | `SELFCONTROL_HOSTS_FILE_PATH` | native (not CI) |
| Finances | Gmail billing corpus / CSV / Plaid sandbox | n/a | CSV fixture or sandbox creds | `LIFEOPS_PERMISSION_MATRIX=1` |

> Native iOS/macOS/Android permission flows (HealthKit, Family Controls, Usage
> Access, SelfControl admin) are **out of scope for CI** and must be exercised
> on a real device; capture redacted screenshots/logs per the issue §5.

---

## 4. Repeatable run instructions

### Credential-free (default CI) — proves clean skip

The permission-matrix harness is gated behind `LIFEOPS_PERMISSION_MATRIX`. With
the flag unset it skips cleanly (one skipped suite, zero failures), so the
default suite stays green without any accounts:

```bash
# Runs in the integration lane; skips when LIFEOPS_PERMISSION_MATRIX is unset.
bun run --cwd plugins/plugin-personal-assistant test:integration
```

### Credential-backed — exercises the matrix

```bash
LIFEOPS_PERMISSION_MATRIX=1 \
  bun run --cwd plugins/plugin-personal-assistant test:integration
```

With the flag set, the harness boots a real `AgentRuntime` + PGLite + the
LifeOps schema, establishes genuine OWNER and non-owner identities via
`setEntityRole`, and asserts all nine states across the planned-tool gate, the
handler guard, and the owner-side grant resolution — no role mocks.

### Live connector smoke (real providers)

Add the provider accounts/env from §3, then run the existing live connector
suites (each `describeIf`-gates on its own credentials and skips otherwise):

```bash
ELIZA_LIVE_TEST=1 LIFEOPS_PERMISSION_MATRIX=1 \
  bun run --cwd plugins/plugin-personal-assistant test:background-real
```

---

## 5. Evidence checklist (issue §5 acceptance criteria)

For each connector family, record OWNER and AGENT evidence: a redacted log /
screenshot of the planned-tool path, the direct handler path, and the
UI-triggered path, for each of the nine states it can reach. The harness covers
the role-gate and grant-resolution states deterministically; live send/read and
native-permission states are captured manually against the §3 identities.

Stage session artifacts under the local scratch dir
`reports/lifeops-live-validation/<session>/` (gitignored — evidence is never
committed to the repo) and attach the redacted screenshots / logs **inline in
the PR/issue** per [`CONTRIBUTING.md`](../../../CONTRIBUTING.md).

| Connector family | Owner evidence | Agent evidence | Status |
|---|---|---|---|
| Google Calendar | _attach_ | _attach_ | pending live accounts |
| Gmail / inbox | _attach_ | _attach_ | pending live accounts |
| Telegram / Discord / Signal / WhatsApp / X | _attach_ | _attach_ | pending live accounts |
| Phone / voice / SMS | _attach_ | n/a | pending Twilio env |
| Health | _attach_ | n/a | pending native device |
| Blocker / focus | _attach_ | n/a | pending native device |
| Finances | _attach_ | n/a | pending sandbox data |

> The harness in this PR satisfies the role-gate / grant-selection rows
> deterministically (run it with `LIFEOPS_PERMISSION_MATRIX=1`). The remaining
> rows require the live accounts/devices from §3 and are filled in as those are
> provisioned. Any bug discovered while exercising the matrix gets a linked
> issue/PR before #8833 is closed.

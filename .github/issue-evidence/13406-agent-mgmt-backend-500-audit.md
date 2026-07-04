# Agent-management backend 500-class audit (#13406)

Lane: [cloud-security] · Branch: `fix/agent-mgmt-backend-500s` · Date: 2026-07-04

Scope: the backend endpoints the console `/dashboard/agents` + agent-detail
pages (packages/ui/src/cloud/instances) fire on load and on action, under
`packages/cloud/api/v1/eliza/agents/`. Hunted the NON-stub 500 class
(unguarded throw mapped to 500 on a normal/empty/not-provisioned input);
stub-drift is already closed + mirror-guarded (#13557) and was not re-audited.
Money/credit assertions (gates, billing) were left to the money lane.

## Endpoints audited (handler + the cloud-shared repos/services it calls)

| Endpoint | Fired by | Verdict |
| --- | --- | --- |
| GET `/api/v1/eliza/agents` (list) | agents table, status poll | CLEAN — `listByOrganization` returns `[]`; char join `findByIdsInOrganization([])` short-circuits; `toIsoStringOrNull` guards nullable `last_backup_at`/`last_heartbeat_at`; `resolvePublicWebUiUrl` returns null for shared/unset domains |
| GET `/api/v1/eliza/agents/:agentId` (detail) | detail page, status poll | CLEAN — 404 on missing row; steward wallet lookup wrapped (J-annotated warn); `db.query.agentServerWallets` registered via `schemas/index.ts` barrel; admin slice null for non-admins; all nullable timestamps guarded |
| GET `/api/v1/eliza/agents/:agentId/backups` | backups panel | CLEAN — missing agent/no backups → `[]` (metadata select, no R2 hydration on the list path) |
| POST `/api/v1/eliza/agents/:agentId/pairing-token` | Open Web UI | CLEAN — starting/stopped/never-provisioned → typed 202 + Retry-After; error-state agent → explicit 500 by design; enqueue failure → typed 503 |
| POST `/api/v1/eliza/agents/:agentId/provision` | create dialog, table action | CLEAN — 404/402/409 typed; warm-pool claim wrapped; enqueue throw mapped |
| POST `/api/v1/eliza/agents/:agentId/resume` | actions | CLEAN — same shape as provision |
| POST `/api/v1/eliza/agents/:agentId/sleep` | actions | CLEAN — no body parse, all status branches typed |
| POST `/api/v1/eliza/agents/:agentId/wake` | actions | CLEAN — same shape as sleep + gates |
| POST `/api/v1/eliza/agents/:agentId/snapshot` | backups panel | CLEAN — no body parse; not-running → 409 |
| PATCH/DELETE `/api/v1/eliza/agents/:agentId` | actions | CLEAN — `c.req.json().catch(() => null)` guard; provisioning → 409 |
| POST `/api/v1/eliza/agents` (create) | create dialog | CLEAN — `json().catch(() => { throw ValidationError })` guard already present |
| POST `/api/v1/eliza/agents/:agentId/restore` | backups panel | **BUG (fixed)** |
| POST `/api/v1/eliza/agents/:agentId/bridge` | agent chat surfaces | **BUG (fixed)** |
| POST `/api/v1/eliza/agents/:agentId/stream` | agent chat surfaces | **BUG (fixed)** |

Cost badge / pricing banner compute from the list DTO (no extra GET); wallet
`/:agentId/api/wallet/*` is the money lane and was not touched.

## Bugs (the non-stub 500 class)

1. **restore: unguarded `await request.json()`** — every field of
   `restoreSchema` is optional, so a bodyless POST is the canonical
   "restore the latest backup" call (SDK/curl); it threw a SyntaxError that
   `errorToResponse` maps to **500**. Fix: empty body ⇒ `{}` (restore-latest
   semantics), malformed non-empty JSON ⇒ typed 400 `ValidationError`
   (`error-policy:J3`).
2. **restore: cross-agent backupId → 500 + existence oracle** — the service's
   "Backup does not belong to this agent" ownership result fell through the
   status map to **500** with a distinct message, so a signed-in caller could
   distinguish "backup id exists on someone else's agent" from "does not
   exist". Fix: mapped to the same 404 "No backup found" (gated ≠ owned;
   org-scoping unchanged — the check itself already prevented the restore).
3. **bridge + stream: unguarded `await request.json()`** — an empty or
   malformed body (client abort, curl without body) → SyntaxError → **500**
   instead of the typed 400 the zod schema path returns for every other bad
   body. Fix: `json().catch(() => { throw ValidationError("Invalid JSON body") })`
   (`error-policy:J3`), identical to the create route's existing guard.

## Proof

Unit test `packages/cloud/api/__tests__/eliza-agents-restore-body-guard.test.ts`
— real route modules + real repositories on in-process PGlite
(`pglite://memory`), real `agent_sandboxes` + `agent_sandbox_backups` rows
across TWO orgs; the only mocked seam is `requireAuthOrApiKeyWithOrg`
(same harness as `org-credentials-routes.test.ts` /
`my-agents-characters-search-bio-guard.test.ts`).

- RED without the fix (routes stashed): **6 fail / 3 pass** — bodyless
  restore, malformed restore body, foreign-backupId restore, bodyless bridge,
  malformed bridge, bodyless stream all returned 500.
- GREEN with the fix: **9 pass / 0 fail** (`Ran 9 tests across 1 file`).
- Mutation checks: console `{}` body ≡ no body (404 "No backup found");
  parsed `backupId` still drives the real service path (409
  "Stopped agents can only restore the latest backup" for a non-latest
  backup on a stopped agent); valid-JSON invalid-schema bridge body still
  hits the zod 400 (guard is parse-only).
- `bun run --cwd packages/cloud/api typecheck` clean; `lint` (biome) clean;
  `bun run audit:error-policy-ratchet` → "no new fallback-slop in touched
  files"; neighbor suites green (`agent-bridge-runtime-routing.test.ts` 2/2,
  `pairing-token/route.test.ts` 9/9).

N/A — screenshots/video: backend-only status-code change, no rendered UI
delta (console already sends `{}` and never hit the bodyless path).
N/A — model trajectories: no agent/model behavior touched.

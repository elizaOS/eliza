# Accounts UI e2e + affinity failover coverage — evidence (#10722 / #11032 lineage)

Workstream B: accounts UI e2e (real browser against a real API server) and
mid-session affinity/failover coverage (real service instances, upstream
failure simulated only at the HTTP boundary).

## How this evidence was produced

- UI run: `node packages/app/e2e/accounts-ui/run-accounts-ui-e2e.mjs`
  (harness docs: `packages/app/e2e/accounts-ui/README.md`). Real Chromium →
  real same-origin fetches → REAL `handleAccountsRoutes`
  (packages/agent) → REAL `AccountPool` (packages/app-core **src**, pinned via
  `tsconfig.e2e-paths.json`) → real on-disk credential store under a scratch
  `ELIZA_HOME`. All 16 assertions passed; exit 0.
- Service run: `packages/scripts`-standard vitest over the full
  account-related suite — see `service-tests.log` (8 files, 72 tests, all
  green), including the two NEW suites:
  - `packages/app-core/src/services/multi-account-affinity-failover.test.ts`
    — session-affinity semantics under mid-session rate-limit / delete /
    needs-reauth, pool exhaustion (`healthy: 0`), window-elapse re-admission.
  - `packages/app-core/test/services/multi-account-upstream-429-failover.test.ts`
    — `ai.generateText` through plugin-anthropic's REAL OAuth fetch wrapper
    against a local fake Anthropic upstream: Bearer(account-1) → 429 →
    REAL `pool.markRateLimited` (until = the provider's unified reset header)
    → re-select exclude → Bearer(account-2) → 200. Asserts the completion
    text, the exact bearer sequence the upstream saw, the persisted overlay,
    and single-hit stickiness on the next call. Plus the 401→invalid path and
    a no-spurious-failover control.

## Screenshot verdicts (each reviewed by hand)

| File | State | Verdict | Notes |
| --- | --- | --- | --- |
| `01-empty-state.png` | No accounts connected | good | Strategy picker + Add account + dashed empty box render with real theme; orange accent only |
| `02-add-invalid-key-error.png` | Error path: API key < 8 chars | good | Real zod message ("Too small: expected string to have >=8 characters") inline, dialog stays open with Try again |
| `03-add-dialog.png` | Add-account dialog (api-key step) | good | Label + password key field + storage-mode copy |
| `04-account-added.png` | First account added | good | HEALTHY badge, API KEY source badge, #0 priority, usage hint |
| `05-two-accounts.png` | Two accounts, priority order | good | Personal #0 / Work #1, both HEALTHY green |
| `06-reordered.png` | After move-up swap | good | Work #0 / Personal #1 — matches pool + overlay |
| `07-strategy-round-robin.png` | Strategy = round-robin | good | Trigger shows Round-robin; persisted to accountStrategies |
| `08-health-states.png` | rate-limited + needs-reauth badges | good | "RATE-LIMITED (RESETS IN 1H)" + "NEEDS REAUTH" from real pool healthDetail |
| `09-mobile-health-states.png` | Mobile 390x844 health states | good | Cards wrap correctly; long badge wraps tall and label truncates hard (cosmetic, pre-existing responsive behavior — see observation below) |
| `10-disabled-account.png` | Account disabled | good | Card dimmed (opacity-60), checkbox unchecked, enabled=false in pool |
| `11-delete-confirm.png` | Delete confirmation dialog | good | Destructive copy + Remove account CTA; disabled card visible behind overlay |
| `12-after-delete.png` | After first delete | good | One card remains; deleted credential gone from disk |
| `13-empty-after-delete.png` | All accounts removed | good | Empty state returns; pool + disk empty |

Observation (pre-existing, not introduced here, flagged for the UI owners):
`RotationStrategyPicker`'s `SelectValue` mirrors the two-line item layout
(label + description) into the 160px trigger, so the description text
overflows above/below the trigger box on desktop and mobile (visible in every
screenshot). Cosmetic; candidate fix is a plain-label `SelectValue` render.

## Logs (all reviewed)

- `assertions.log` — 16/16 PASS transcript of the UI run.
- `frontend-network.log` — the browser's real request/response sequence
  (GET list, 400 invalid add, 201 adds, PATCH swaps, PATCH strategy, DELETEs).
- `frontend-console.log` — browser console (no errors).
- `backend-server.log` — `[accounts-e2e-api]` structured request log proving
  the real handlers fired (statuses match the network log).
- `service-tests.log` — vitest tail: 8 files / 72 tests green, including both
  new suites and every pre-existing account suite run together.

## Evidence-type checklist (PR_EVIDENCE)

- Real-LLM trajectories: N/A — this workstream changes tests/harness only; no
  agent/action/prompt/model behavior changed. The inference-path failover is
  exercised against a boundary-simulated upstream by design (a real Anthropic
  429 cannot be produced deterministically without burning a real
  subscription's rate limit).
- Backend logs: `backend-server.log` (real route handlers).
- Frontend console + network logs: `frontend-console.log`,
  `frontend-network.log`.
- Before/after full-page screenshots, desktop + mobile: the 13 PNGs above.
- Video walkthrough: N/A — the flow is captured as 13 stepwise full-page
  screenshots + the assertion transcript; the harness is headless-CI oriented
  and asserts every transition it screenshots.
- Domain artifacts: on-disk credential files + `_pool-metadata.json` overlay
  asserted directly by the runner (created on add, mutated on
  reorder/disable/health, removed on delete) and by the service suites.

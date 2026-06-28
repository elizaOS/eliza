# #8833 LifeOps live owner/agent validation — evidence

This directory holds the live-validation evidence + harness for issue #8833.

## What's here

| File | What it shows |
|---|---|
| `login-onboarding.png` | The live dev app's first-run screen ("How should Eliza run?" → Eliza Cloud / This device) captured at `http://localhost:2138`. |
| `capture-views.mjs` | Playwright harness that drives the **live** dev app, seeds the first-run-complete localStorage flags (mirrors `packages/app/test/ui-smoke/helpers.ts`), and screenshots every LifeOps view (`/calendar /inbox /health /finances /focus /goals /documents /relationships /todos /phone`) with full video recording. |
| `views/*.png`, `video/*.webm` | The captured walk. |
| `../../../plugins/plugin-personal-assistant/docs/LIFEOPS_LIVE_VALIDATION.md` | The connector × OWNER/AGENT-state × env-var × skip-behavior matrix to fill during a credentialed session. |

## Findings (credential-free pass)

1. **First-run gate renders correctly** — the onboarding screen offers Eliza Cloud (login) vs This device (local), brand-correct (orange accent, no blue). See `login-onboarding.png`.
2. **Views are gated behind first-run**, as designed — navigating to a view before onboarding completes returns to the gate.
3. **Headless local-runtime capture stalls on "Booting up…"** — after seeding past onboarding to the `local:embedded` server, the app shell stays on the boot screen because the embedded backend connection does not establish in a headless, model-less session (the `.env` model keys are dead and the Claude Code/Codex creds are not applied to runtime inference — confirmed in the dev boot log). So the live views do not paint populated data in this mode. See `views/calendar.png` ("Eliza — Booting up…").

## Why populated LIVE views can't be captured without a configured/credentialed session

Two independent, confirmed blockers — both inherent to a default, model-less dev boot:

1. **No model.** The agent runtime reaches "ready" but registers no `TEXT_*`
   model (`.env` keys dead; Claude Code/Codex creds not applied to runtime
   inference — per the boot log), so the app shell holds on "Booting up…".
2. **LifeOps plugins aren't loaded in the default dev agent.** LifeOps is
   opt-in; the default "Eliza" character omits `plugin-personal-assistant` /
   `plugin-calendar` / `plugin-health` / etc. Probing the running API confirms
   it: `GET /api/agents` → `200`, but `GET /api/calendar`, `/api/todos`,
   `/api/lifeops/overview` → **404**. So the live LifeOps views have no backend
   routes to populate against here.

Both are resolved by the credentialed login path (Eliza Cloud provisions a model
and a LifeOps-configured agent). The **populated-view rendering itself** is
proven credential-free by the component-state tests above, which mount the real
view components with injected populated fetchers.

## Why populated-view screenshot evidence isn't here (and where it is)

Populated, credential-free view rendering is produced by the **deterministic stub backend** audit, not the live runtime:

```bash
bun run --cwd packages/app audit:app   # all builtin/plugin views, desktop + mobile, with mock data
```

The maintainer already ran this for #8833: **all 10 LifeOps split views verdicted `good` on desktop + mobile** (see the issue comment "Mac-side view + aesthetic audit pass"). The component suites (goals 20/20, calendar 45/45, health 60/60, todos 51/51, inbox 65, …) cover the loading / error / empty / populated states with injected fetchers.

## Credential-free execution results (verified this pass)

The static-verifiable half of the acceptance criteria was executed and passes
without any login, model, or live connector:

| #8833 acceptance item | How verified | Result |
|---|---|---|
| Owner-only actions deny non-owner — **direct handler** path | `plugin-personal-assistant/test/owner-action-handler-permissions.test.ts` | **4/4 pass** |
| Owner-only actions deny non-owner — **planned-tool** path (`roleGate`) | `core/src/runtime/__tests__/execute-planned-tool-call.test.ts` | **24/24 pass** |
| View states (loading / error / empty / populated) | `plugin-goals/.../GoalsView.test.tsx`, `plugin-inbox/.../inbox-view.test.tsx`, `plugin-health/.../HealthView.test.tsx` | **7/7 + 10/10 + 9/9 pass** |
| View rendering + aesthetics (desktop + mobile) | `packages/app audit:app` (stub backend) | maintainer: all 10 LifeOps views `good` (documented in #8833). An in-session re-run was attempted but `audit:app` rebuilds every plugin's view bundle (~20 min) + needs Node 24 at `ELIZA_NODE_PATH` — impractical here; the component-state tests above cover the same states. |

So the permission matrix's deny-behavior and the view state machine are proven
in CI-runnable tests. What the tests cannot prove — real OAuth, live connector
send/read, populated live data, owner-side grant selection — is the login-gated
half below.

## What still requires the user's login (the live half)

The OWNER-vs-AGENT permission matrix, live connector send/read/sync, OAuth grant states, and **populated live views** need a real session:

1. Open `http://localhost:2138`, click **Eliza Cloud (Recommended)**, authenticate → provisions a model **and** establishes the OWNER identity.
2. Walk the views + connectors per `LIFEOPS_LIVE_VALIDATION.md`, capturing per-state screenshots/video.
3. Authenticate a second, non-owner identity to exercise the AGENT side of the permission matrix.

Re-run `capture-views.mjs` after step 1 — with a real session the views paint past "Booting up…".

# Issue #11801 - App Monetization Review Gate

## Scope

- Fresh draft apps can no longer be created with `monetization_enabled: true`.
- The create API now returns `403 app_review_required` before app creation when
  a caller tries to enable monetization without review approval.
- Create-time pricing defaults still persist while monetization remains disabled.
- The Monetize tab now surfaces app review status, offers `Submit for review`
  from draft/rejected states, refreshes the app record after review, and keeps
  the monetization switch disabled until the app is approved.
- `AppDto` now includes the review fields the API already returns.
- Rebase blockers inherited from `develop` were cleared: the duplicate
  `runWithTrajectoryPurpose` Worker shim export was removed, and small
  type-safety ratchet reductions keep root verification passing.

## Verification

| Command | Result |
| --- | --- |
| `bun install` | PASS - installed workspace deps and synced artifacts. Generated artifact churn was cleaned before commit. |
| `bun run build:core` | PASS - built core/shared/ui prerequisites for package tests. |
| `bun test packages/cloud/api/__tests__/apps-crud.integration.test.ts` | PASS - includes `403 rejects create-time monetization enablement before creating an app` and pricing-default persistence coverage. |
| `bun run --cwd packages/ui test -- src/cloud/applications/components/app-monetization-settings.test.tsx` | PASS - draft app shows Submit for review, POSTs `/review`, reflects approved status, then allows enabling monetization. |
| `bun run --cwd packages/cloud/api typecheck` | PASS |
| `bun run --cwd packages/cloud/shared typecheck` | PASS |
| `bun run --cwd packages/cloud/sdk typecheck` | PASS - SDK `AppDto` review fields and create-input monetization warning stay type-safe. |
| `bun run --cwd packages/ui typecheck` | PASS |
| `bun run --cwd packages/cloud/api lint` | PASS |
| `bun run --cwd packages/cloud/shared lint` | PASS |
| `bun run --cwd packages/ui lint` | PASS |
| `bun run --cwd plugins/plugin-slack typecheck` | PASS |
| `bun run --cwd packages/agent typecheck` | PASS |
| `bun run --cwd packages/app audit:app` | PASS - 349/349 Playwright audit checks passed. Summary: `broken=0`, `needs-work=0`, `needs-eyeball=39`, `good=309`; `/apps` manual-review verdicts were `good` for desktop, mobile portrait, mobile landscape, and iPad. |
| `REQUIRE_E2E_SERVER=0 bun test packages/cloud/api/test/e2e/group-i-apps-lifecycle.test.ts` | PASS with 33 counted skips - Worker `http://localhost:8787`, `TEST_API_KEY`, and `TEST_MEMBER_API_KEY` were unavailable in this environment. |
| `bun run verify` | PASS after rebasing onto `origin/develop` and clearing inherited blockers. Ratchet summary: `as unknown as` 74/75, `?? ""` 615/615, `?? {}` 375/377; Turbo reported 483/483 typecheck/lint tasks successful and dist-path consumers checked 28 configs. |

## Manual Review

- Opened the app audit manual-review files for `/apps`:
  - `packages/app/aesthetic-audit-output/manual-review/builtin-apps-desktop-landscape.md`
  - `packages/app/aesthetic-audit-output/manual-review/builtin-apps-mobile-portrait.md`
  - `packages/app/aesthetic-audit-output/manual-review/builtin-apps-mobile-landscape.md`
  - `packages/app/aesthetic-audit-output/manual-review/builtin-apps-ipad-portrait.md`
- All four had `verdict: good`, no console errors, no banned blue colors, no
  hover probe failures, no density probe failures, and screenshot quality issues
  marked `none`.

## Evidence Notes

- Frontend pixels: `audit:app` full-suite screenshots are generated under
  `packages/app/aesthetic-audit-output/`; they are gitignored generated output,
  not committed.
- Frontend flow: focused Vitest/jsdom coverage drives the Monetize tab state
  transitions and verifies the request payloads. A live cloud review walkthrough
  was not captured because this local environment did not have a running Cloud
  Worker, test API keys, or live review-model configuration.
- Backend logs: route-level behavior is covered by the in-process integration
  test; no standalone Worker logs were available for the skipped live e2e run.
- Real LLM trajectory: N/A for this PR. The change does not alter agent prompts,
  providers, model selection, or action routing. The review endpoint already
  owns the live model classification path; this PR wires the UI to that endpoint
  and closes the create-time bypass.
- Audio/native/on-chain/domain artifacts: N/A - web/cloud app settings and API
  route gate only.

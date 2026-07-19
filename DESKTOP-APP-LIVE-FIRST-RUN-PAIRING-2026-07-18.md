# Desktop App Live: first-run runtime choice + pairing

Date: 2026-07-18
Owner: `[sol-orch]`
Umbrella: #16212
Focused issue: #13889

## Boundary

Only the packaged Electrobun first-run runtime chooser and pairing/auth screen were investigated. Token validation and auth policy are unchanged. The packaged desktop launcher, renderer, desktop bridge, and live/mock API fixtures remain real.

## Diagnosis

| Signature | Diagnosis | Evidence |
| --- | --- | --- |
| `choice-__first_run__:runtime:local` missing | Test-state regression, not a removed selector. The packaged-only chooser seam enabled the runtime flag but left `eliza:first-run-complete` rehydrated, so startup skipped the conductor. The live fixture's explicit `firstRunComplete: false` also did not become authoritative until reset. | Current UI still emits the same reserved choice id. Clearing the completion key through `shellLocalStorage` and making the live fixture start reset produces the selector and completes onboarding in the packaged app. |
| `Pairing Required` missing | Stale presentation assumption plus stale controlled-input automation. The default bottom-bar takes the intentional chat-overlay early return and does not mount `StartupScreen`; direct `.value =` did not update React state. | Launching the real packaged full shell renders `Pairing Required`. Using the native input/textarea value setter submits the pairing code, stores the returned token, calls `POST /api/auth/pair`, and reaches `GET /api/auth/me`. |

## Changes

- The packaged-only runtime chooser override clears `eliza:first-run-complete` through privileged `shellLocalStorage` before setting `eliza:enable-runtime-chooser`.
- The live API fixture treats explicit `firstRunComplete: false` as reset from its first probe.
- The focused packaged suite opts into full-shell presentation, leaving bottom-bar behavior to its dedicated suite.
- Pairing automation uses the native controlled-input setter and a bubbling input event.

The reserved-key guard is preserved. No raw production `localStorage` write was added. Auth requirements, token redemption, and token validation were not weakened.

## Evidence

| Command / check | Result |
| --- | --- |
| Packaged build, app renderer + Electrobun launcher | PASS |
| `vitest run --config vitest.config.ts src/runtime-chooser-override.test.ts` | PASS, 3/3 |
| packaged `drives chat-first onboarding` exact test | PASS, 32.2s |
| packaged `pairing auth redeems a code and reaches auth/me` exact test | PASS, 9.8s |
| combined exact grep | First-run PASS; second launcher hit an existing Linux desktop-bridge startup timeout. Standalone retry passed. No assertion failure. |
| reserved-writer guard | Baseline blocker remains at `packages/app/src/main.tsx:479` (`CLOUD_PAIR_SESSION_TOKEN_KEY`), unrelated to this patch. This patch routes its reserved-key removal through `shellLocalStorage`. |

No baselines were changed, no tests were removed, and no checks were suppressed.

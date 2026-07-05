# #13577 — ios-e2e.mjs one-command loud orchestrator: testable decision logic + loud-fail proof

Scope of this branch (`feat/13577-ios-e2e-orchestrator`): the package-script /
CLAUDE.md wiring and the `simctl install` proof already landed on `develop`
(#13639, #13874). This branch adds the remaining task-contract piece: extract
the orchestrator's **pure decision logic** into a unit-tested library and close
a **vacuous-pass hole** so the lane cannot report success without proving a
device path.

## What changed

- `packages/app/scripts/ios-e2e-lib.mjs` — pure, I/O-free decision logic:
  `parseIosE2eArgs`, `planIosE2eSteps`, `assertNonVacuousPlan`,
  `selectBootedUdid`, `resolveTargetDevice`, `extractAppId`, the four leg
  command builders, `classifyStepExit`, `isAppInstalled`.
- `packages/app/scripts/ios-e2e-lib.test.mjs` — 41 unit tests (runs in the
  packages/app vitest suite → root `test:client` lane).
- `packages/app/scripts/ios-e2e.mjs` — refactored to consume the lib; behavior
  identical except the new non-vacuous-plan guard runs before boot.

## Artifacts

| File                                     | Proves                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unit-tests.txt`                         | `bun run --cwd packages/app vitest run scripts/ios-e2e-lib.test.mjs` → **41 passed**. Pins the flag→step-plan map, the loud/vacuous guards, `simctl` booted-udid selection over real JSON shapes, app-id extraction, and the exact argv each real leg is spawned with (incl. `--require-installed` + `--ios-full-bun-smoke` on the chat leg). |
| `vacuous-guard-loud-fail.txt`            | `node scripts/ios-e2e.mjs --skip-build --skip-auth --skip-local-chat` → **exit 1**, `FAILED: refusing to run…`. Skipping every simulator-app verification leg no longer sails to "ALL iOS E2E PASSED".                                                                                                                                        |
| `cloud-only-vacuous-guard-loud-fail.txt` | `node scripts/ios-e2e.mjs --skip-build --skip-auth --skip-local-chat --cloud` → **exit 1**. This closes the false-green hole where optional cloud-only coverage could previously satisfy the non-vacuous guard without build/install, auth, or local-chat.                                                                                    |
| `sim-booted.png`                         | Prior booted iPhone 16 Pro simulator screenshot from the draft evidence set. The replayed branch here updates the unit/guard evidence; full macOS simulator wiring remains pending below.                                                                                                                                                     |

## Pending-hardware / pending-build

- The **full green run** (`ALL iOS E2E PASSED`) requires macOS, a complete
  `build:ios:local:sim` Xcode compile **and** the `eliza-1-2b` GGUF staged for
  the on-device full-Bun chat leg. Not executed in this Linux replay session;
  the nightly `build-ios-local` CI job in `mobile-build-smoke.yml` is the
  designated home for it.
- The **real physical-device** leg is **pending-hardware**: no iOS device is
  attached to this host (simulators only). The orchestrator targets the booted
  simulator; a device run needs `--device <udid>` against attached hardware plus
  a signed `App.app`.

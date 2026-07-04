# #13570 / #13575 - iOS simulator lane hygiene and renderer freshness

## Change

- Added shared iOS simulator defaults hygiene for smoke/auth/runtime keys. It enumerates the simulator defaults domain, deletes both `CapacitorStorage.*` and raw key variants, and flushes `cfprefsd`.
- Added shared renderer stamp verification for iOS `.app` bundles and installed simulator containers. Candidate apps now must match the expected bundle id and the freshly built `dist/eliza-renderer-build.json` before install.
- Wired the helpers into `ios-onboarding-smoke.mjs`, `mobile-local-chat-smoke.mjs`, and `ios-e2e.mjs`, including cleanup in failure paths.
- Added host-side tests for defaults key selection and renderer build-id comparison.

## Verification

- `node --check` on the two new helpers and all three touched scripts passed.
- Pure helper runtime check passed: stale renderer build IDs throw, matching IDs pass, stale smoke keys are selected.

## Evidence notes

- Screenshots/video: N/A - harness integrity change, no rendered UI changed.
- Live model trajectory: N/A - no prompt/model behavior changed.
- Native capture: required for the broader iOS evidence umbrella; this PR specifically makes stale simulator state and stale app installs fail before captures can be trusted.

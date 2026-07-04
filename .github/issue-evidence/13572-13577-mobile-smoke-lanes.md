# #13572 / #13577 - mobile smoke lanes are loud

## Change

- `packages/app` public local-chat simulator scripts now pass `--require-installed`, so missing simulators/apps fail instead of falling through to host-only Vitest coverage.
- `test:e2e:ios` now exposes the existing `scripts/ios-e2e.mjs` orchestrator as a discoverable package lane.
- `packages/app/test/mobile-smoke-scripts.test.ts` guards both contracts.

## Verification

- Static script contract inspected against `packages/app/package.json`.
- The new Vitest contract test is intentionally host-only: it prevents package-script drift. The actual device proof remains the loud `test:e2e:ios` / `test:sim:local-chat:*` lanes, which now require real installed apps.

## Evidence notes

- Screenshots/video: N/A - script contract and simulator lane wiring only; no rendered UI changes.
- Live model trajectory: N/A - no agent prompt/model behavior changed.
- Native/device capture: required when closing the broader native QA umbrella, but this PR specifically removes false-green command wiring so those captures cannot be claimed from missing devices.

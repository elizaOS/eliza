# #13572 / #13577 - mobile smoke lanes are loud

## Change

- `packages/app` public local-chat simulator scripts now pass `--require-installed`, so missing simulators/apps fail instead of falling through to host-only Vitest coverage.
- `test:e2e:ios` and `test:e2e:ios:cloud` now expose the existing `scripts/ios-e2e.mjs` orchestrator as discoverable package lanes.
- `packages/app/CLAUDE.md` / `AGENTS.md` list the new iOS lanes and call out that default local-chat simulator lanes require an installed app.
- `packages/app/test/mobile-smoke-scripts.test.ts` guards both contracts.

## Verification

- Static script contract inspected against `packages/app/package.json`.
- The new Vitest contract test is intentionally host-only: it prevents package-script drift. The actual device proof remains the loud `test:e2e:ios` / `test:sim:local-chat:*` lanes, which now require real installed apps.

## Evidence notes

- Screenshots/video: N/A - script contract and simulator lane wiring only; no rendered UI changes.
- Live model trajectory: N/A - no agent prompt/model behavior changed.
- Native/device capture: still required before #13577 is closed; this PR removes false-green command wiring and exposes the iOS orchestrator, but it does not prove the full build/install/auth/chat/cloud loop on a clean simulator.

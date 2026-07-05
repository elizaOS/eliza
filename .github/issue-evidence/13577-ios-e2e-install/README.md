# #13577 iOS e2e explicit simulator install evidence

## Change

- Added `packages/app/scripts/lib/ios-simulator-app-product.mjs` to select the newest `Debug-iphonesimulator/App.app` from Xcode DerivedData deterministically.
- Updated `packages/app/scripts/ios-e2e.mjs` so the build path no longer assumes `build:ios:local:sim` installed the app. It now:
  - runs `bun run build:ios:local:sim`;
  - locates the newest built simulator `App.app` or accepts `--app-path`;
  - validates the candidate app bundle id and renderer build stamp;
  - terminates/uninstalls the previous simulator app;
  - runs `xcrun simctl install <udid> <App.app>`;
  - verifies the installed app container and renderer build stamp.

The already-fixed package script/doc wiring from prior work remains present on `develop`.

## Verification run locally

```bash
node --check packages/app/scripts/ios-e2e.mjs
node --check packages/app/scripts/lib/ios-simulator-app-product.mjs
node --check packages/app/scripts/lib/ios-simulator-app-product.test.mjs
```

Result: passed.

```bash
bun run --cwd packages/app test -- scripts/lib/ios-simulator-app-product.test.mjs
```

Result: passed, 1 file / 4 tests.

```bash
bunx biome check packages/app/scripts/ios-e2e.mjs packages/app/scripts/lib/ios-simulator-app-product.mjs packages/app/scripts/lib/ios-simulator-app-product.test.mjs
git diff --check
```

Result: passed.

```bash
bun run verify
```

Result: failed before package typecheck/lint in `audit:type-safety-ratchet` on repo-wide baseline drift unrelated to this patch:

- `as unknown as`: 74 current > 73 baseline.
- `?? []` in core/agent/app-core: 582 current > 581 baseline.

## Real iOS e2e attempt

```bash
node packages/app/scripts/ios-e2e.mjs --skip-build --skip-auth --skip-local-chat
```

Result: blocked before this patch's install path because this machine does not have full Xcode/simctl. See `ios-e2e-simctl-failure.txt`.

Commands still required on a macOS host with full Xcode and the staged model:

```bash
bun run --cwd packages/app test:e2e:ios
lsof -i :31338
```

Expected proof: `ios-e2e.mjs` logs the build, candidate renderer stamp, explicit `simctl install`, installed renderer stamp, auth smoke, full-Bun chat smoke, and final `ALL iOS E2E PASSED`.

## Evidence applicability

- Real LLM trajectory: N/A. This is mobile e2e orchestration, not agent prompt/model behavior.
- Backend logs: N/A for this slice; the changed path is simulator app installation before existing auth/chat legs.
- Frontend screenshots/video: blocked locally by missing full Xcode/simctl; required on a simulator runner before closing #13577.
- Domain artifacts: the built and installed `App.app` renderer build stamp is the domain artifact this patch verifies on the real lane.

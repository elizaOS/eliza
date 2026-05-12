# Production Readiness Automation Validation

Date: 2026-05-05

Current native identity: `Eliza` / `app.eliza`

## Automated Work Completed

- Revalidated the production renderer with the deterministic Playwright route/click-safety matrix against `packages/app/dist`.
- Fixed final route-load regressions found by the built-app smoke pass:
  - LifeOps UI now registers its client extension before the LifeOps page renders.
  - Wallet inventory references now resolve through `@elizaos/app-wallet` instead of deleted app-core inventory modules.
  - Wallet package registration now has a real `./register` source/dist export.
  - Steward and LifeOps renderer imports use their UI subpaths, avoiding server route imports in the browser bundle.
- Fixed final package/typecheck regressions found after the route fixes:
  - App-core training routes now delegate to `@elizaos/app-training`.
  - App-core exports the app-shell and widget registry subpaths used by registered app packages.
  - Companion typecheck resolves the wallet app package through explicit workspace paths.
- Rebuilt the production web renderer and both native app shells after the final fixes.
- Revalidated mobile artifact consistency after native sync/build.
- Revalidated the launchdocs gate against the docs-site launchdocs tree.

## Validation Commands

```sh
bun install --lockfile-only
bun install --frozen-lockfile
bun run --cwd packages/app typecheck
bun run --cwd packages/app-core typecheck
bun run --cwd plugins/app-companion typecheck
bun run --cwd plugins/app-lifeops build
bun run --cwd plugins/app-wallet build
bun run --cwd packages/agent build:mobile
bun run --cwd packages/app-core build
bun run --cwd packages/app build:web
node scripts/launch-qa/run-ui-smoke-stub.mjs
node scripts/launch-qa/run.mjs --suite release --continue-on-failure --json
node packages/app-core/scripts/run-mobile-build.mjs android
node packages/app-core/scripts/run-mobile-build.mjs android-system
node packages/app-core/scripts/run-mobile-build.mjs ios
node scripts/launch-qa/check-mobile-artifacts.mjs --json
node scripts/launch-qa/check-docs.mjs --scope=launchdocs --json
```

## Results

- Lockfile integrity: passed.
- App typecheck: passed.
- App-core typecheck: passed.
- Companion typecheck: passed.
- LifeOps package build: passed.
- Wallet package build: passed.
- Mobile agent bundle build: passed, produced the Phase D `agent-bundle.js` payload.
- App-core package build: passed.
- Production renderer build: passed.
- Built-app Playwright route/click-safety matrix: passed, 35 of 35 route entries against the rebuilt `packages/app/dist`.
- Release suite: passed, 12 of 12 tasks. Artifact directory: `/var/folders/1g/77s889gx10n7mtl6z1nfrxzm0000gn/T/launch-qa-QT1Zpu`.
- Android native build: passed, including Capacitor sync and `:app:assembleDebug`.
- Android system build: passed, staged the ElizaOS APK with the Phase D agent bundle.
- iOS native simulator build: passed with `CODE_SIGNING_ALLOWED=NO`.
- Mobile artifact gate after native rebuilds: passed, 14 checks, 0 errors.

## Known Non-Blocking Warnings

- Standard Android/Play Store builds intentionally strip `assets/agent/` for size; the full local-agent payload is preserved for the AOSP privileged-system APK.
- Vite reports existing deprecated alias `customResolver` and ineffective dynamic import warnings.
- Android Gradle reports existing deprecation warnings for Gradle 10 compatibility.
- iOS Capacitor sync reports existing Package.swift/SPM compatibility warnings; the Pod/Xcode simulator build succeeds.
- Cloud API-key invalid-payload e2e logs an expected `ZodError` while asserting the invalid request is rejected.

## Remaining Human Work

- Physical iOS and Android QA on real devices: install, first launch, permissions, backgrounding, notifications, thermal/performance, local model behavior, camera/mic/screen/mobile-signal hardware paths.
- Production cloud QA with real accounts: login, billing/credits, agent creation, cloud-to-desktop/phone migration, real hosted deployment behavior.
- Real OAuth/provider QA: Google/Gmail/Calendar, Discord, Telegram, Signal, WhatsApp, iMessage, X, Shopify, Vincent, and any provider anti-abuse or consent screens.
- Wallet QA only with dedicated test wallets and controlled testnet or tiny-mainnet funds; live token purchase flows must stay manually approved.
- Remote second-device QA on real networks: LAN, mobile network, firewall/NAT behavior, and multi-interface ergonomics.
- Packaged desktop Computer Use QA for macOS TCC prompts, accessibility, screen recording, permission revoke/re-grant, and packaged app signing/notarization behavior.
- App Store / Play Store / notarization / signing-account release management.
- Final product judgment on onboarding clarity, colors/button feel, copy, and model output quality.

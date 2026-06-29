# 10096 Android Manifest Module Split

## Change

- Moved pure Android manifest XML transforms from `packages/app-core/scripts/run-mobile-build.mjs` into `packages/app-core/scripts/mobile/android-manifest.mjs`.
- Kept `run-mobile-build.mjs` as the compatibility re-export surface for existing App Actions tests and downstream imports.
- Left filesystem build orchestration, source stripping, source audits, and artifact audits in `run-mobile-build.mjs`; they still call the split manifest helpers.
- Added focused contract coverage for component removal, permission removal markers, malformed application closure repair, cleartext policy, MainActivity intent filters, and comment stripping.

## Verification

- `node --check packages/app-core/scripts/run-mobile-build.mjs && node --check packages/app-core/scripts/mobile/android-manifest.mjs && node --check packages/app-core/scripts/run-mobile-build-android-manifest.test.mjs && node --check packages/app-core/scripts/run-mobile-build-android-app-actions.test.mjs && node --check packages/app-core/scripts/run-mobile-build-android-targets.test.mjs`
- `bunx biome check packages/app-core/scripts/run-mobile-build.mjs packages/app-core/scripts/mobile/android-manifest.mjs packages/app-core/scripts/run-mobile-build-android-manifest.test.mjs packages/app-core/scripts/run-mobile-build-android-targets.test.mjs .github/issue-evidence/10096-android-manifest-module.md`
- `bun run --cwd packages/app-core test -- scripts/run-mobile-build-android-manifest.test.mjs scripts/run-mobile-build-android-targets.test.mjs`
- `node --test packages/app-core/scripts/run-mobile-build-android-app-actions.test.mjs`

## Not Covered

- This is a pure module split. It does not claim a new full Android device/emulator build; that evidence is already attached to the Android target driver PR for issue #10096.

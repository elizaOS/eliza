# 10096 iOS Pods Module Split

## Change

- Moved the annotated mobile Capacitor plugin manifest and derived pod/package tables from `packages/app-core/scripts/run-mobile-build.mjs` into `packages/app-core/scripts/mobile/ios-pods.mjs`.
- Kept `run-mobile-build.mjs` as a compatibility re-export surface for `MOBILE_CAPACITOR_PLUGIN_MANIFEST`, `ANDROID_OFFICIAL_CAPACITOR_PACKAGES`, `IOS_OFFICIAL_PODS`, `IOS_COCOAPODS_OWNED_SPM_PLUGINS`, and `resolveIosCustomPods`.
- Left Podfile generation behavior unchanged; it now imports the same derived iOS pod lists from the split module.

## Verification

- `node --check packages/app-core/scripts/run-mobile-build.mjs && node --check packages/app-core/scripts/mobile/ios-pods.mjs && node --check packages/app-core/scripts/run-mobile-build-plugin-manifest.test.mjs`
- `bunx biome check packages/app-core/scripts/run-mobile-build.mjs packages/app-core/scripts/mobile/ios-pods.mjs packages/app-core/scripts/run-mobile-build-plugin-manifest.test.mjs .github/issue-evidence/10096-ios-pods-module.md`
- `bun run --cwd packages/app-core test -- scripts/run-mobile-build-plugin-manifest.test.mjs scripts/run-mobile-build-ios-engine-gate.test.mjs`

## Not Covered

- This is a pure module split. It does not claim the full `build:ios` device/simulator proof for the broader `run-mobile-build.mjs` decomposition item.

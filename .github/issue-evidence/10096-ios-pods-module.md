# 10096 iOS Pods and Plist Module Split

## Change

- Moved the annotated mobile Capacitor plugin manifest and derived pod/package tables from `packages/app-core/scripts/run-mobile-build.mjs` into `packages/app-core/scripts/mobile/ios-pods.mjs`.
- Kept `run-mobile-build.mjs` as a compatibility re-export surface for `MOBILE_CAPACITOR_PLUGIN_MANIFEST`, `ANDROID_OFFICIAL_CAPACITOR_PACKAGES`, `IOS_OFFICIAL_PODS`, `IOS_COCOAPODS_OWNED_SPM_PLUGINS`, and `resolveIosCustomPods`.
- Left Podfile generation behavior unchanged; it now imports the same derived iOS pod lists from the split module.
- Moved the iOS Info.plist overlay helpers into `packages/app-core/scripts/mobile/ios-plist.mjs`, including permission strings, Bonjour services, background modes, background-task identifiers, and URL-scheme merging.
- Added plist contract coverage for minimal overlay generation, idempotent second-pass merging, array append-without-duplicate behavior, and XML string escaping.

## Verification

- `node --check packages/app-core/scripts/run-mobile-build.mjs && node --check packages/app-core/scripts/mobile/ios-pods.mjs && node --check packages/app-core/scripts/mobile/ios-plist.mjs && node --check packages/app-core/scripts/run-mobile-build-plugin-manifest.test.mjs && node --check packages/app-core/scripts/run-mobile-build-ios-plist.test.mjs && node --check packages/app-core/scripts/mobile/ios-plist.test.mjs`
- `bunx biome check packages/app-core/scripts/run-mobile-build.mjs packages/app-core/scripts/mobile/ios-pods.mjs packages/app-core/scripts/mobile/ios-plist.mjs packages/app-core/scripts/mobile/ios-plist.test.mjs packages/app-core/scripts/run-mobile-build-plugin-manifest.test.mjs packages/app-core/scripts/run-mobile-build-ios-plist.test.mjs .github/issue-evidence/10096-ios-pods-module.md`
- `bun run --cwd packages/app-core test -- scripts/run-mobile-build-plugin-manifest.test.mjs scripts/run-mobile-build-ios-plist.test.mjs scripts/mobile/ios-plist.test.mjs scripts/run-mobile-build-ios-engine-gate.test.mjs scripts/run-mobile-build-android-targets.test.mjs scripts/run-mobile-build-android-manifest.test.mjs` (6 files, 40 tests)
- `bun run --cwd packages/app build:ios:cloud:sim`

## Full iOS Simulator Build Evidence

`bun run --cwd packages/app build:ios:cloud:sim` completed successfully on this branch after rebasing onto current `origin/develop`.

Reviewed output markers:

- Vite production build completed: `✓ built in 39m 23s`.
- Renderer manifest was regenerated with `buildId=4ee2c1ec5623` and 195 assets.
- Chunk safety passed: `bn.js/crypto graph is confined to lazy vendor chunks (164 chunks scanned)`.
- Capacitor copied web assets to `ios/App/App/public`, generated `capacitor.config.json`, and the stale-web guard overlaid the fresh `packages/app/dist` into the iOS public directory.
- Capacitor sync completed and found 26 iOS plugins.
- Split pod manifest generated the cloud simulator Podfile behavior:
  - `iOS Podfile: omitting llama.cpp pod (ELIZA_IOS_INCLUDE_LLAMA not set)`
  - `iOS Podfile: App Store build keeps local Bun runtime and omits mobile-agent tunnel bridge`
  - `Pod installation complete! There are 25 dependencies from the Podfile and 26 total pods installed.`
- Split plist overlay ran: `[mobile-build] Merged iOS permission strings.`
- Xcode built `App.xcworkspace` for `generic/platform=iOS Simulator` with `-sdk iphonesimulator`, `CODE_SIGNING_ALLOWED=NO`, `ARCHS=arm64`, and `IPHONEOS_DEPLOYMENT_TARGET=16.0`.
- Asset catalog emitted pre-existing missing splash image warnings, then the app target embedded pods, validated embedded extensions, and copied Swift libraries.
- Final Xcode result: `** BUILD SUCCEEDED **`.

## Not Covered

- Device-signed iOS build is not covered here; this evidence covers the simulator build path for the split iOS pod/plist modules.

# Milady iOS — Build Map

The iOS app is a **cloud-hybrid** Capacitor build: Apple forbids
running a JIT-enabled JavaScript runtime (bun, JavaScriptCore at
runtime, etc.) inside an App Store-shipped app, so there is no
on-device bun process. Local inference goes through the
`@elizaos/llama-cpp-capacitor` plugin's iOS framework via the
DeviceBridge JSON-RPC over loopback; everything else is delegated to
Eliza Cloud.

| Build path     | Where the agent runs                                | LLM inference                                                                          |
| -------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| iOS (Capacitor) | Eliza Cloud (managed agent endpoint)                | `LlamaCppCapacitor` Pod — JSC binding to `libllama.dylib` shipped inside the app       |
| Android (AOSP) | bundled bun, /system/priv-app/, ELIZA_LOCAL_LLAMA=1 | bun:ffi against `libllama.so` (static-bundled) via the `eliza_llama_*` shim            |
| Android (Capacitor) | Eliza Cloud OR local — user picks at onboarding | `llama-cpp-capacitor` jniLibs over loopback DeviceBridge                                |

## Generating the iOS project

The project at `apps/app/ios/` is **regenerated from the upstream eliza
template every build** — it's gitignored. The flow is:

```bash
# From the repo root:
node eliza/packages/app-core/scripts/run-mobile-build.mjs ios-overlay
```

Effects (all idempotent):

1. `syncPlatformTemplateFiles("ios")` — copies 37 files from
   `eliza/packages/app-core/platforms/ios/` into `apps/app/ios/`,
   including `App.xcworkspace`, `App.xcodeproj`, the Swift sources
   (`AppDelegate`, `ElizaIntentPlugin`), `Info.plist`,
   `App.entitlements`, `PrivacyInfo.xcprivacy`, the
   WebsiteBlockerContentExtension, and the Podfile / fastlane / Gemfile.
2. `overlayIos()` —
   - Merges Milady-specific permission strings into `Info.plist`
     (camera, microphone, location, contacts, etc.).
   - Rewrites `App.entitlements` to use `group.ai.elizaos.eliza` as
     the App Group ID.
   - Patches xcconfigs to include the Pods xcconfig.
3. `generatePodfile()` — emits `apps/app/ios/App/Podfile` referencing
   the Capacitor core, every `@elizaos/capacitor-*` plugin under
   `eliza/packages/native-plugins/`, and `LlamaCppCapacitor` from the
   workspace.
4. `applyIosAppIdentity()` — rewrites bundle IDs in
   `App.xcodeproj/project.pbxproj` to `ai.elizaos.eliza` (and
   `ai.elizaos.eliza.WebsiteBlockerContentExtension` for the
   content-blocker extension).

After the overlay completes (Linux-friendly, pure file ops), the
remaining steps require macOS + Xcode + CocoaPods:

```bash
# Mac only:
cd apps/app/ios/App
pod install
open App.xcworkspace
# In Xcode: select a development team, choose a target device,
# Product → Build / Run.
```

## On-Demand Resources for GGUFs (planned, mirrors Android DFM)

iOS App Store imposes a **200 MB cellular download limit** per app and
a **4 GB total limit**; the bundled Eliza-1 GGUF can weigh several GB.
Apple's
recommended pattern for shipping on-demand large assets is **On-Demand
Resources (ODR)** — the iOS equivalent of the Android Dynamic Feature
Module that `scripts/miladyos/stage-models-dfm.mjs` already uses for
the AAB build:

| Concept                | Android (AAB)             | iOS (ODR)                                  |
| ---------------------- | ------------------------- | ------------------------------------------ |
| Resource container     | `:models` dynamic feature | Tagged ODR with `NSODRTag`                 |
| Initial install policy | `dist:install-time`       | `Initial install tags`                     |
| Background prefetch    | (always installed)        | `Prefetch tag order`                       |
| On-demand              | `dist:onDemand="true"`    | `Download only on demand`                  |
| Runtime accessor       | `getAssets().open(...)`   | `NSBundleResourceRequest(tags:)`           |

The script `scripts/miladyos/stage-models-odr.mjs` (TODO) should:

1. Move staged GGUFs from
   `apps/app/ios/App/App/agent/models/` (or wherever the iOS staging
   places them) into an ODR-tagged group inside `App.xcodeproj`.
2. Write the ODR tags into `project.pbxproj` so the Asset Catalog
   builder packages them as separate downloadable bundles.
3. Default tag policy: `Prefetch tag order: 1` for the small bundled
   model so it downloads in the background after first launch, no
   user prompt. Larger models (production checkpoint) default to
   `Download only on demand` and require the runtime to explicitly
   request them via `NSBundleResourceRequest`.

The capacitor-llama runtime side already supports model-path
parameterization, so the swap from "look in app bundle" to "look in
ODR-resolved path" is a Swift-side change in
`LlamaCppCapacitor.swift` (call `NSBundleResourceRequest.beginAccessingResources`
before `LLamaContext(modelPath:)` and release once inference is
done).

## OAuth flows (Anthropic + Codex on iOS)

The CodingAgent + Anthropic onboarding flows assume a system browser
hand-off. iOS WebView (WKWebView) can't share cookies with Safari, so
the OAuth callback must use either:

- **Universal Link** (preferred) — the Anthropic / Codex OAuth client
  is registered against `https://milady.app/oauth/callback`, the iOS
  app declares the associated domain in `App.entitlements`, and the
  redirect re-opens the app via the Universal Link handler in
  `AppDelegate.swift`'s `application(_:continue:restorationHandler:)`.
- **Custom URL scheme** (fallback) — `milady://oauth/callback` with
  `CFBundleURLTypes` declaration in `Info.plist`. Less secure (any
  other app can register the same scheme) but doesn't require an
  Apple-approved associated domain.

Status: not yet wired. The Universal Link entitlement and
`CFBundleURLTypes` slot exist in the `Info.plist` template; the
`AppDelegate.swift` handler still needs the OAuth callback dispatch.
Both Anthropic Console and Codex (Cloud Code) use redirect URIs, so
once the iOS callback is wired and registered, the existing
onboarding flows should round-trip.

## Required env / build

| Env / Build flag        | Effect                                                           |
| ----------------------- | ---------------------------------------------------------------- |
| `ELIZA_DISPLAY_NAME`    | Substituted into `CFBundleDisplayName` at build time             |
| `MILADY_BUILD_FORMAT=aab` (Android) | Triggers `stage-models-dfm.mjs` — no iOS equivalent yet |
| `ELIZA_DEVICE_BRIDGE_ENABLED=1` | Already on by default; the Capacitor llama plugin uses it     |
| `ELIZA_REQUIRE_LOCAL_AUTH` | Off by default for parity with Android Capacitor build path     |

## Open items (Task #29)

The iOS overlay step is now reproducible from Linux. Remaining work
needs macOS:

- [ ] `cd apps/app/ios/App && pod install` — verify
      `LlamaCppCapacitor`, `ElizaosCapacitorAgent`, and the rest of
      the Pods resolve.
- [ ] Open `App.xcworkspace`, configure a development team, build
      against an iOS 15+ simulator and a real device.
- [ ] Wire the OAuth callback in `AppDelegate.swift` and add the
      `applinks:milady.app` associated domain in
      `App.entitlements`.
- [ ] Implement `scripts/miladyos/stage-models-odr.mjs` (mirrors
      `stage-models-dfm.mjs`) and update
      `LlamaCppCapacitor.swift` to call
      `NSBundleResourceRequest.beginAccessingResources(completionHandler:)`
      before model load.
- [ ] Test the full Anthropic + Codex OAuth round-trips on a real
      device (needs sandbox API keys + the Universal Link domain
      configured).

Pair this with `SETUP_AOSP.md` for the Android side — the Capacitor
build path is shared between iOS and Android (just the pod / jniLib
binary differs), so most of the runtime code paths are exercised on
both platforms simultaneously.

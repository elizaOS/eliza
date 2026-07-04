# #12185 sub-issue 2 — iOS Live Activity for voice/dictation + audio background mode

Extends the merged `ElizaWidgets` extension (PR #12295) with an ActivityKit Live
Activity for a voice/dictation session (Lock Screen + Dynamic Island), a
first-party ActivityKit Capacitor bridge, and the D10 background-mode/plist
alignment. Xcode 26.4.1, iPhoneSimulator 26.4 SDK, deployment target iOS 16.0.

## Build verification

| Artifact | What it proves |
|---|---|
| `build-elizawidgets-sim.log` | Real `xcodebuild` of the `ElizaWidgets` extension for the simulator SDK: `ElizaDictationAttributes.swift` + `ElizaDictationLiveActivity.swift` (ActivityConfiguration + Dynamic Island + iOS 18 Stop/Save `Button(intent:)`) compile clean under `APPLICATION_EXTENSION_API_ONLY=YES`, the appex links (arm64 + x86_64), and `appintentsmetadataprocessor --validate-assistant-intents` validates the Stop/Save App Intents. **BUILD SUCCEEDED.** |
| `typecheck-activitykit-bridge-surface.log` | `swiftc -typecheck` of the App-target ActivityKit calls (`Activity.request`/`update`/`end`, `ActivityAuthorizationInfo`, `ActivityContent`) against the real shared `ElizaDictationAttributes` at the iOS 16.0 simulator target — exit 0. The `ElizaLiveActivityBridge` Capacitor wrapper (`CAPPlugin`/`CAPBridgedPlugin`/`CAPPluginCall`) is byte-identical to the already-shipping `ElizaIntentPlugin`, so only the novel ActivityKit surface is re-verified. |

Additional checks (run in the PR, not screenshotted here):

- `plutil -lint project.pbxproj` → OK; `xcodebuild -list` shows the `ElizaWidgets`
  target/scheme intact and the shared attributes file as a dual-target member.
- `packages/app test -- ios-app-intents-registration` → 14 passed (pins the
  ActivityConfiguration/ActivityAttributes presence, the bridge, dual-target
  membership, and `NSSupportsLiveActivities` + `audio` plist alignment).
- `packages/ui` `ios-live-activity.test.ts` → 10 passed (status→phase mapping,
  transcript trimming, start/update/end throttle + ordering, disabled/off-iOS
  no-op, failure swallow).
- `packages/app-core` `run-mobile-build-ios-plist` + `ios-plist` → 16 passed
  (plist merger idempotency with the new `audio` + `NSSupportsLiveActivities`).

## How the voice session drives it

`useContinuousChat` calls `useDictationLiveActivity({ active, status,
transcript })`. On iOS it starts the Live Activity when the session goes active,
pushes the `phase` (recording / transcribing / thinking / speaking) and partial
transcript as the turn progresses (throttled to the ActivityKit budget), and
ends it when the session stops. The Lock Screen / Dynamic Island tap and the
iOS 18 Stop/Save buttons route the same `elizaos://voice?source=ios-live-activity`
deep-link spine (D1) so logs prove the entry point.

## N/A rows (with reasons)

- **Live simulator capture of the running Live Activity (Lock Screen + Dynamic
  Island pixels): N/A this session.** Rendering a *running* activity requires the
  full app booted and driving the `ElizaLiveActivity` bridge. The full-app build
  lane (`build:ios:cloud:sim`) is blocked in this worktree by a pre-existing,
  unrelated dependency-build failure — `@elizaos/logger` fails `tsc` with
  `TS2688: Cannot find type definition file for 'node'` **before** xcodebuild is
  reached (a worktree `@types/node` resolution gap, not this change). The novel
  Swift (the extension's Live Activity views + the app-side ActivityKit calls) is
  proven to compile by the two logs above; the AppUITests target (which the
  ios-widgets sibling used for SpringBoard capture) is owned by a sibling agent
  and out of scope here. Re-run `build:ios:cloud:sim` on a clean tree, launch the
  app, start a voice session, and screenshot the Lock Screen + Dynamic Island to
  fill this row.
- **Real device capture: N/A.** No signing-provisioned device in the loop; the
  extension is target-/entitlement-identical on device (automatic signing, same
  `group.ai.elizaos.app`), and the widget brand-rewrite + version threading in
  `run-mobile-build.mjs` already cover `ElizaWidgets`.
- **Real-LLM trajectory: N/A.** No agent/action/provider/prompt/model behavior
  changed — this adds a native OS presentation surface that mints the same
  `elizaos://` deep links as the existing (already-shipped) entry points.

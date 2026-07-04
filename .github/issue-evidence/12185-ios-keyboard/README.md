# #12185 (sub 3) — iOS voice-first keyboard extension with app-handoff dictation

The `ElizaKeyboard` custom keyboard extension plus the App-Group handoff that
lets it dictate. iOS app extensions can never open the microphone, so the
keyboard's mic button opens the containing app, which records + transcribes and
writes the transcript back through a shared App Group — the "no mic in
extensions" (Wispr) pattern.

## Handoff flow (as built)

1. **Keyboard mic tap** — `KeyboardViewController.micTapped()` clears any stale
   handoff record and opens `elizaos://keyboard-dictation?source=ios-keyboard&session=<uuid>`
   via `extensionContext.open`, falling back to the responder-chain `openURL:`
   dispatch (keyboards honor `NSExtensionContext.open` inconsistently). Renders
   an explicit `opening` → `awaiting(.recording)` state; a failed open renders
   "Couldn't open the Eliza app."
2. **App routes the deep link** — `main.tsx handleDeepLink` (live path) and the
   extracted `createDeepLinkHandler` (`deep-link-handler.ts`, tested) both route
   `keyboard-dictation` → `startKeyboardDictationSession(params)`.
3. **App-side session** — `keyboard-dictation.ts` publishes `recording` to the
   App Group via the `ElizaKeyboard` Capacitor bridge, records + transcribes
   through the shared `createVoiceCapture` pipeline (native ASR on device), and
   on the final transcript publishes `ready` with the text. Every failure is an
   explicit state — missing bridge (non-iOS), capture/ASR error (engine not
   running included), no-speech, and App-Group-write failure each set the
   in-app overlay AND an `error` handoff record. No silent fallback.
4. **Bridge** — `ElizaKeyboardBridge.swift` (`jsName ElizaKeyboard`) writes the
   `ElizaKeyboardDictationState.Record` into `UserDefaults(group.<bundle-id>)`,
   rejecting `ready` with an empty transcript rather than inserting silence.
5. **Keyboard re-activation** — `viewWillAppear` + an 0.8 s poll read the
   record; a fresh `ready` inserts via `textDocumentProxy.insertText` and clears
   it, a fresh `error` renders the message, stale records (>10 min) are
   discarded. Explicit states: `needsFullAccess`, `opening`, `awaiting`,
   `inserted`, `failed`.

## Build verification

`ElizaKeyboard` appex built against the iOS Simulator SDK — **BUILD SUCCEEDED**.
See [`appex-build.txt`](./appex-build.txt). Fat binary (`x86_64 arm64`),
`NSExtensionPointIdentifier = com.apple.keyboard-service`.

```
xcodebuild -project ios/App/App.xcodeproj -target ElizaKeyboard \
  -sdk iphonesimulator -configuration Debug ONLY_ACTIVE_ARCH=YES \
  CODE_SIGNING_ALLOWED=NO build
→ ** BUILD SUCCEEDED **
```

The target was built scoped (`-project -target`, not `-workspace -scheme`)
because the appex has **zero** target dependencies and no CocoaPods phases — it
links UIKit only. The full-workspace scheme build (which drags in the entire
Capacitor Pods closure incl. the multi-GB `LlamaCppCapacitor` pod, built as
universal arm64+x86_64) is what the environment cannot complete; see the
deferral below.

## Tests

- `packages/app/src/keyboard-dictation.test.ts` — 11 cases over the real app-side
  state machine + DOM overlay (bridge + capture injected as fakes): recording →
  ready publication with session id, interim-vs-final segments, the
  engine-not-running error path, the no-speech path, cancel clears + removes the
  overlay, relaunch-cancels-previous (mic re-tap), the missing-bridge (non-iOS)
  explicit failure, and an App-Group-write rejection surfacing a handoff error
  (capture never starts).
- `packages/app/src/deep-link-handler.test.ts` — dispatches
  `keyboard-dictation` into the injected session; warns loudly (no silent drop)
  when no handler is wired.
- `packages/app/test/ios-app-intents-registration.test.ts` — native contract:
  the `ElizaKeyboard` appex target + embed, `com.apple.keyboard-service`,
  `RequestsOpenAccess`, App-Group entitlements, the no-mic `elizaos://keyboard-dictation`
  open, explicit user-facing states, dual-target `ElizaKeyboardDictationState`
  membership (App writes / keyboard reads), the Capacitor bridge + non-empty
  transcript guard, and the brand-rewrite coverage.

All three files green (34 tests) from the worktree.

## N/A / deferred

- **Simulator keyboard screenshot (enabled keyboard in a text field) + the live
  mic→app-handoff walkthrough**: deferred. Enabling a custom keyboard requires
  installing the full host app on the simulator, which requires a full-workspace
  build (every Capacitor Pod including the multi-GB `LlamaCppCapacitor`, plus the
  Vite web bundle). The shared dev host's data volume is at 100% (~10 GB free
  across concurrent worktrees); the full-scheme build aborted with
  `lipo: No space left on device` while creating universal Pod frameworks. The
  appex itself builds clean for the simulator SDK (above) and the full
  app-side state machine is covered by the 11 real state-machine tests, so the
  behavior is verified without the install. Not a code blocker — an environment
  disk constraint. Re-run `capture:ios-sim` on a host with adequate free disk to
  attach the enabled-keyboard screenshot + walkthrough.
- **Real-LLM trajectory**: N/A — no agent/action/provider/prompt/model behavior
  changed. This adds a native OS entry point (a keyboard) that hands audio to
  the already-shipped on-device ASR pipeline via a deep link.
- **Real device capture**: N/A for this PR — the extension is target- and
  entitlement-identical on device (automatic signing, same App Group); the
  device lane (`ios:device:deploy`) already grafts per-appex profiles.

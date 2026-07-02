# D2 — zero-warning iOS boot (simulator, backend + frontend)

Leg D2 of the iOS agent-boot-automation epic: every known boot warning fixed at
its root (no log-level suppression), proven with before/after boot consoles on
the simulator. Branch `feat/ios-agent-boot-automation`. No physical-device
access in this leg (device runs are D1/phase B).

## Capture setup

- Simulator: iPhone 16, iOS 18.1, udid `39F890C2-072D-4BFE-9144-5327AF30B10A` (booted).
- Build lane: `bun run --cwd packages/app build:ios:local:sim`
  (`ELIZA_IOS_FULL_BUN_ENGINE=1`, destination `generic/platform=iOS Simulator`,
  sdk `iphonesimulator`), then `xcrun simctl install … App.app` from
  DerivedData `Debug-iphonesimulator`.
- Console capture: `xcrun simctl launch --console-pty <udid> ai.elizaos.app`
  (90 s before / 120 s after).
- Build-under-test proof: `boot-console-before.log` shows
  `[renderer-build] 54b7f5a1dd24 built 2026-07-02T02:50:54Z`;
  `boot-console-after.log` shows `[renderer-build] 1b42c91d2f46 built
  2026-07-02T04:13:50Z` — the after capture is the freshly built + reinstalled
  tree, not a stale install.

## Files

| File | What it is |
|---|---|
| `boot-console-before.log` | Full 90 s sim boot console BEFORE the fixes (all warnings present) |
| `boot-console-after.log` | Full 120 s sim boot console AFTER rebuild+reinstall (target warnings gone) |
| `boot-console-after-reverify.log` | Independent second 120 s cold-launch capture of the same installed build (`renderer-build 1b42c91d2f46`), taken in a fresh session: 0 `enableBackgroundDelivery` failures, 1 skip info line, 0 blocker warnings, 0 `JS Eval error`, agent reaches `state:"running"`. The `NSMapGet` notice did not occur at all this run — consistent with nondeterministic Apple-internal sim noise (see row 4). |
| `boot-console-after-reverify2.log` | Third independent 100 s cold-launch capture (fresh session, after the D2 commit `aa0f19da97f` landed; same installed build `1b42c91d2f46`): 0 `enableBackgroundDelivery` failures, 1 skip info line, 0 blocker warnings, 0 `JS Eval error`, 0 `NSMapGet`, agent `state:"running"`. Only remaining non-info lines: AgentWatchdog probe loop (leg D1 seam). |
| `nsmapget-null-backtrace.txt` | lldb backtrace of the exact `NSMapGet(NULL)` call (breakpoint `NSMapGet` with condition `$x0 == 0`) |
| `js-eval-error-first-eval-backtrace.txt` | lldb trace of the first `-[WKWebView evaluateJavaScript:]` at cold boot — the eval that threw "JS Eval error" |

## Warning → root cause → fix table

| # | Boot console line | Root cause | Fix / justified N/A | After-console result |
|---|---|---|---|---|
| 1 | `[MobileSignalsPlugin] enableBackgroundDelivery(<type>) failed: Missing com.apple.developer.healthkit entitlement.` ×6 (before log lines 4–9) | `MobileSignalsPlugin.load()` re-arms HealthKit background delivery for 6 sample types on every cold boot. Simulator / non-store lanes build with code signing disabled, so the binary is not signed with `com.apple.developer.healthkit` and **every one of the 6 registrations fails identically**, logging once per type. iOS has no public API to read own entitlements, so nothing gated the fan-out. | Probe-first gate: the first sample type doubles as the entitlement probe. `HealthBackgroundDeliveryGate.probeOutcome(...)` (new platform-agnostic contract target, `plugins/plugin-native-mobile-signals/ios/Sources/MobileSignalsHealthContract/HealthBackgroundDeliveryGate.swift`) classifies the probe result; on `entitlementMissing` the remaining 5 registrations are skipped behind ONE info line. Genuine per-type failures keep individual diagnostics. Plugin: `plugins/plugin-native-mobile-signals/ios/Sources/MobileSignalsPlugin/MobileSignalsPlugin.swift`. Tests: `ios/Tests/MobileSignalsHealthContractTests/HealthBackgroundDeliveryGateTests.swift` (10 XCTests, `swift test` in `plugins/plugin-native-mobile-signals/ios`, same pattern as swabble/talkmode contract targets). | 6 warnings → 1 info line: `HealthKit background delivery skipped: binary lacks the com.apple.developer.healthkit entitlement (expected for simulator and non-store dev builds)` (after log line 5). |
| 2 | `⚡️ [warn] - [Eliza] Blocker backends plugin not available: e.registerNativeWebsiteBlockerBackend is not a function.` (before log line 84) | REAL wiring bug, renderer side. `vite.config.ts`'s dynamic app-plugin browser aliases resolve the bare `@elizaos/plugin-blocker` specifier via `resolveAppPluginBrowserEntry` (src/ui.ts → src/ui/index.ts → **src/register.ts** → src/index.ts). Commit `b1a0eeb3c35` added `src/register.ts` (Focus terminal-view side-effect module, **zero exports**) to plugin-blocker, silently repointing the alias from the full barrel to the empty module — so `main.tsx`'s `import("@elizaos/plugin-blocker")` got no registrars and mobile BLOCK enforcement wiring died. tsc never caught it because `packages/app` mapped the specifier to a hand-written `declare module` claiming the registrars exist (`backend: unknown`). | New browser-safe subpath `@elizaos/plugin-blocker/native` (`plugins/plugin-blocker/src/native.ts`); the website-blocker registry extracted to node-free `services/website-blocker/native-backend.ts` (engine re-exports it, same module instance in each realm); `main.tsx` imports the subpath; explicit vite alias + tsconfig path map it to source; the lying `declare module` replaced with `export {}` so root-specifier misuse now FAILS typecheck, and the `/native` import typechecks against the real types. Tests: `plugins/plugin-blocker/src/native.test.ts` (registration-identity into the real engine dispatch + esbuild browser-bundle safety gate). | Warning gone; bundle now contains `native-*.js` chunk with both registrars (verified in `App.app/public/assets/`). |
| 3 | Device-only: `[persistence] failed to fetch server favorite apps: iOS cloud builds cannot use local-agent IPC unless local runtime mode is active` | `useAppShellState` fires `fetchServerFavoriteApps()` at mount; on iOS cloud builds the local-agent IPC transport rejects with the mode-gate policy error until runtime-mode reconciliation (#11030) settles — an expected boot phase, but `persistence.ts` logged it at WARN and never retried. | `fetchServerFavoriteApps` now classifies the failure with `isTerminalIosNativeAgentBootErrorMessage` (the transport's own terminal-policy classifier): mode-gate → `logger.debug` + null; real failures still warn. `useAppShellState` re-fetches exactly ONCE after the native `eliza:agent-ready` document event when the boot-time attempt did not hydrate (no re-fetch when hydrated / after unmount / on repeat events). Files: `packages/ui/src/state/persistence.ts`, `packages/ui/src/state/useAppShellState.ts`. Tests: `persistence.favorite-apps-gate.test.ts` (5) + `useAppShellState.favorites-retry.test.tsx` (3). | Line never occurs on sim (device-only, cloud-mode). Behavior covered by 8 unit tests; device re-verification belongs to phase B. |
| 4 | `void * _Nullable NSMapGet(NSMapTable * _Nonnull, const void * _Nullable): map table argument is NULL` (before line 14 / after line 9) | **Apple framework-internal, proven by symbolication.** lldb breakpoint on `NSMapGet` conditioned on `$x0 == 0` (`nsmapget-null-backtrace.txt`): the NULL-map-table call is CoreUI's `_LookupThemeProvider` theme-registry lookup during `+[UIImage imageNamed:]` for a system keyboard assistant-bar symbol, reached from UIKit keyboard setup after `-[WKWebView becomeFirstResponder]` — which is invoked by stock Capacitor `CAPBridgeViewController.viewDidAppear`. Every frame between our app's `main` and the NULL call is Apple UIKit/WebKit/CoreUI; no elizaOS or plugin code is on the stack, and the sim's CoreUI theme registry being unprimed at first keyboard setup is the trigger. | **N/A with proof** — not our code; "fixing" it would mean suppressing Capacitor's standard first-responder behavior. Backtrace committed as evidence. | Still present (expected; Apple sim-side noise). |
| 5a | `⚡️ JS Eval error A JavaScript exception occurred` (before line 15) | Cold-launch `UIApplication.willEnterForegroundNotification` fired Capacitor's cordova-compat `resume` document event **before the initial page load injected `window.Capacitor`**. Proven live: lldb breakpoint on `-[WKWebView evaluateJavaScript:completionHandler:]` shows the first eval of the boot is `window.Capacitor.triggerEvent('resume', 'document')` from `CapacitorBridge.eval` (`js-eval-error-first-eval-backtrace.txt`). | Already fixed at root by the #11030 leg-C patch `patches/@capacitor%2Fios@8.4.1.patch` (commit `e38516e0539`): gates the resume/pause evals on `webViewLoadingState == .subsequentLoad`. The BEFORE install predated the patched pod; this leg's rebuild compiles the patched development pod (Podfile `:path => node_modules`) and verifies the fix on-sim. | Gone in after log (0 occurrences). |
| 5b | `[AgentWatchdog] local agent health probe failed (n/3 consecutive)` + restart requests (both logs, tail) | Native `Agent getStatus` reports `state:"running"` while `ElizaBunRuntime getStatus` stays `ready:false` — the watchdog probes the wrong/never-ready readiness source on sim builds. This is the AgentPlugin/watchdog agent-state seam. | **Owned by leg D1** (startup-phase-poll / AgentPlugin / watchdog are explicitly out of D2's file ownership). Documented here as cross-reference, not silenced. | Still present (D1 scope). |
| 5c | `DiskCookieStorage changing policy from 2 to 0`, `Loading network plugin`, `KeyboardPlugin: resize mode - body`, `Reachable via WiFi`, `Accessory bar visible change 1`, `[ElizaStartupTrace] iOS startupTraceId=…`, `⚡️ To Native/TO JS …` bridge traffic | Informational framework/plugin lines — none is a warning or error. | N/A — info-level by design. | Unchanged. |

## Verification commands

```bash
# Swift entitlement-gate contract tests (10/10 pass)
cd plugins/plugin-native-mobile-signals/ios && swift test

# Blocker registration seam + browser-safety (5/5 pass; full plugin suite 47/47)
cd plugins/plugin-blocker && bunx vitest run src/native.test.ts

# Favorites gating + retry-after-ready (8/8 pass; full ui state folder 522/522)
cd packages/ui && bunx vitest run src/state/persistence.favorite-apps-gate.test.ts \
  src/state/useAppShellState.favorites-retry.test.tsx

# Typechecks (all green)
bun run --cwd plugins/plugin-blocker typecheck
bun run --cwd packages/ui typecheck
bun run --cwd packages/app typecheck

# Sim rebuild + reinstall + after capture
bun run --cwd packages/app build:ios:local:sim
xcrun simctl install 39F890C2-072D-4BFE-9144-5327AF30B10A <DerivedData>/Debug-iphonesimulator/App.app
xcrun simctl launch --console-pty 39F890C2-072D-4BFE-9144-5327AF30B10A ai.elizaos.app
```

## After-console summary (manual review)

`boot-console-after.log`, reviewed line by line: **zero renderer `[warn]`/`[error]`
lines**, zero `JS Eval error`, zero `enableBackgroundDelivery(...) failed`
spam, zero blocker-backend warnings. Remaining non-info lines are exactly the
two documented above: the Apple-internal `NSMapGet` sim notice (N/A with
backtrace proof) and the AgentWatchdog probe loop (leg D1's agent-readiness
seam).

Independently re-verified in a second session (`boot-console-after-reverify.log`,
fresh cold launch of the same installed build): identical result — the only
remaining non-info lines are the AgentWatchdog probe loop (D1 seam). Installed
build under test cross-checked by hand: `App.app/public/eliza-renderer-build.json`
buildId `1b42c91d2f46…` (commit `8abbb50e940`) matches the `[renderer-build]`
console stamp; `App.app/public/assets/native-*.js` contains BOTH
`registerNativeWebsiteBlockerBackend` and `registerNativeAppBlockerBackend`
with zero `node:` builtins; `strings App.debug.dylib` contains the new
"HealthKit background delivery skipped" gate line (and retains the per-type
`enableBackgroundDelivery(%@) failed: %@` diagnostic for genuine failures).

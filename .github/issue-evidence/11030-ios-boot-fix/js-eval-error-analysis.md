# Root cause: boot-time `⚡️  JS Eval error A JavaScript exception occurred` (issue #11030, leg C)

Every real-device cold launch logs, between `Loading app at capacitor://localhost...`
(+ `Reachable via WiFi`) and `WebView loaded`:

```
⚡️  Loading app at capacitor://localhost...
Reachable via WiFi
⚡️  JS Eval error A JavaScript exception occurred
⚡️  WebView loaded
```

Reproduced identically in both captured device logs
(`.github/issue-evidence/10726-voice-delarp/ios-sim/ios-device-console.log:12-15`
and `ios-device-agent-running-console.log:12-15`, MoonCycles iPhone 16 Pro Max,
iOS 18.7.8) — exactly once per boot, always in that position.

## Exact native eval chain (file + line)

All paths are `@capacitor/ios@8.4.1` (byte-identical to the 8.3.1 the device
build compiled — `diff` of `CapacitorBridge.swift` between the two versions is
empty). `packages/app/package.json` pins `@capacitor/ios: 8.4.1`.

1. **The only two log sites for this string** are
   `Capacitor/Capacitor/CapacitorBridge.swift:645` (`evalWithPlugin`) and
   `:661` (`eval(js:)`): `CAPLog.print("⚡️  JS Eval error", error.localizedDescription)`.
   `"A JavaScript exception occurred"` is the `localizedDescription` of
   `WKError.javaScriptExceptionOccurred` (WKError code 4) — the evaluated JS
   **threw**; the eval itself ran fine.
2. **Who evals in the boot window.** Exhaustive enumeration of every native
   caller of `eval(js:)` / `evalWithPlugin` / the `triggerJSEvent` family across
   every pod in the device app (`packages/app/ios/App/Podfile` +
   `Podfile.lock`: Capacitor core, App, BackgroundRunner, BarcodeScanner,
   Browser, Haptics, Keyboard, Network, Preferences, PushNotifications,
   StatusBar, LlamaCpp*, all 15 `ElizaosCapacitor*` pods from
   `packages/native/plugins/*` → `plugins/plugin-native-*`, and our app shell
   `packages/app-core/platforms/ios/App/App/*.swift`):

   | Caller | Can it fire in `[load start, didFinish]` with no user action? |
   |---|---|
   | `CapacitorBridge.setupCordovaCompatibility` resume/pause observers (`CapacitorBridge.swift:273-278`) | **YES — fires on every cold launch** (see 3) |
   | `@capacitor/keyboard` `Keyboard.m:116,150,163,170,202` (`triggerWindowJSEvent`/`evalWithJs`) | No — requires `UIKeyboard*Notification`; no keyboard exists at boot |
   | `@capacitor/status-bar` `StatusBar.swift:26` (`statusTap`) | No — requires a status-bar tap |
   | `@capacitor/network` `NetworkPlugin.swift:17-23` | **No eval at all** — `notifyListeners` with zero listeners returns before touching the webview (`CAPPlugin.m:82-94`, early return when `listenersForEvent` is empty and `retain == NO`). `Reachable via WiFi` (`NetworkPlugin.swift:59`) is only `CAPLog` of the initial `NWPathMonitor` path — a **red herring** adjacent in time, not the eval source |
   | `@capacitor/app` `AppPlugin.swift` (`appStateChange`/`pause`/`resume`/`appUrlOpen`) | No eval — all `notifyListeners` (same zero-listener no-op pre-load) |
   | `CapacitorBridge.toJs`/`toJsError` (`:580-613`) | No — logged as `⚡️  TO JS` (absent in the window; first plugin call `Preferences get` happens after `WebView loaded`), and their failure path prints the raw error object, never the `JS Eval error` prefix |
   | Our shell `AgentWatchdog.swift:411-423` | No — fires only on watchdog restart requests, JS body is `try { … } catch (e) {}`, `completionHandler: nil` (never logs), and the currently-installed device shell doesn’t wire it |
   | `plugin-native-canvas` `CanvasPlugin.swift:891,1039,1086,1853` | No — plugin-method-triggered, custom completion logging |

   No other native source in the compiled pod set calls the bridge eval paths
   (verified by grep across all pods listed in `Podfile.lock`).

3. **The trigger.** `CapacitorBridge.init` (`CapacitorBridge.swift:223`) calls
   `setupCordovaCompatibility()` (`:268`). With no Cordova plugins
   (`injectCordovaFiles == false`) it registers:

   ```swift
   observers.append(NotificationCenter.default.addObserver(
       forName: UIApplication.willEnterForegroundNotification, ...) { [weak self] _ in
       self?.triggerDocumentJSEvent(eventName: "resume")   // :274
   })
   ```

   `triggerDocumentJSEvent` → `triggerJSEvent` (`:683-685` → `:667-669`) →
   `eval(js: "window.Capacitor.triggerEvent('resume', 'document')")` (`:657-665`).

   Our app uses the **UIScene lifecycle**
   (`packages/app-core/platforms/ios/App/App/SceneDelegate.swift` +
   `UIApplicationSceneManifest` in `Info.plist`; mirrored into the generated
   `packages/app/ios/App/App/`). Under the scene lifecycle, a cold launch
   transitions the scene background → foreground, so UIKit posts
   `UIApplication.willEnterForegroundNotification` **during launch** — unlike
   the old app-delegate-only lifecycle (and unlike Capacitor’s stock template,
   which has no SceneDelegate; that is why stock Capacitor apps don’t log this
   on every boot, but ours does).

4. **The throw.** The notification lands between `loadWebView()`
   (`CAPBridgeViewController.swift:167-180`, prints `⚡️  Loading app at …` at
   `:177`) and `didFinish` (`WebViewDelegationHandler.swift:123-129`, prints
   `⚡️  WebView loaded` at `:128`). At that instant the WKWebView’s JS context
   is the pre-commit empty document — the `atDocumentStart` user script that
   defines `window.Capacitor` (`JSExport.exportCapacitorGlobalJS`, wired in
   `CapacitorBridge.exportCoreJS` `:245-255`) has not run yet. Evaluating
   `window.Capacitor.triggerEvent('resume', 'document')` throws
   `TypeError: undefined is not an object` → `WKError.javaScriptExceptionOccurred`
   → `CapacitorBridge.swift:661` prints the error line.

5. **Why device-only.** It is a race between (a) the main-queue
   `evaluateJavaScript` scheduled by the launch-time notification and (b) the
   first navigation committing (which injects `window.Capacitor`). On real
   hardware, spawning the WKWebView content process + serving
   `capacitor://localhost` from flash loses the race deterministically; on the
   M-series-hosted simulator the commit usually wins, so the line doesn’t
   appear there. Same code path, different race outcome.

6. **Why the renderer proceeds normally afterwards.** The throw happens inside
   a native-initiated eval against the throwaway pre-load context; nothing
   subscribes to the result (the completion handler only logs). The app page
   that loads moments later is a fresh document — a boot-time `resume` event
   is meaningless to it (there is no state to resume), so the event was
   already being dropped; it was just dropped *loudly*. Benign in effect, but
   guaranteed noise on every device boot — so it is fixed, not waved through.

## Fix

`patches/@capacitor%2Fios@8.4.1.patch` (registered in root `package.json`
`patchedDependencies` and `bun.lock`; `patches/CHECKSUMS.sha256` regenerated
via `scripts/security/verify-patches.sh --generate`). It gates **both** the
`resume` and `pause` document-event observers in
`CapacitorBridge.setupCordovaCompatibility` on the bridge’s own page-load
state machine:

```swift
guard let self = self, case .subsequentLoad = self.webViewDelegationHandler.webViewLoadingState else {
    return
}
self.triggerDocumentJSEvent(eventName: "resume")
```

`webViewLoadingState` (`WebViewDelegationHandler.swift:10-16`) is `.unloaded`
until `willLoadWebview` (`:29-39`), `.initialLoad` until the first
`didFinish`/`didFail` (`:123-137`), then `.subsequentLoad` forever — i.e. the
guard means “the initial page load has completed at least once”, exactly the
bridge’s own signal that `window.Capacitor` exists. Post-first-load
resume/pause behavior is byte-identical; pre-first-load the events are dropped
silently instead of dropped-with-a-WKError. The eval could never succeed in
that window, so no behavior is lost.

- Applies cleanly to the pristine npm tarball with both `git apply --check`
  and BSD `patch --dry-run` (bun applies it at install; pods compile the
  patched source via `pod 'Capacitor', :path => node_modules/@capacitor/ios`).
- `swiftc -parse` passes on the patched file.
- Upstreamable: same shape as the fix requested in
  [ionic-team/capacitor-plugins#2357](https://github.com/ionic-team/capacitor-plugins/issues/2357)
  (identical eval, identical WKError, “defer resume until WebView ready”);
  their scenario is resume-after-webview-process-kill, ours is
  scene-lifecycle cold launch — one guard covers both.

## Regression coverage

`packages/app-core/test/capacitor-ios-boot-eval-guard.test.ts` (runs in the
app-core vitest suite → `test:server` CI lane):

- fails if `packages/app` bumps `@capacitor/ios` without carrying the patch
  registration forward (the silent-drop failure mode of patch-based fixes);
- pins the patch content to keep guarding **both** observers;
- pins `bun.lock`’s `patchedDependencies` entry and the SOC2 checksum in
  `patches/CHECKSUMS.sha256` to the actual patch bytes;
- when the installed `node_modules/@capacitor/ios` matches the declared
  version (always true on CI after `bun install`), asserts the installed
  `CapacitorBridge.swift` really contains the guard — proving the patch was
  applied, not merely registered. On a stale local install the check skips
  *visibly* (never a vacuous pass).

Local run: `5 passed | 1 skipped` (the skip is the installed-copy check —
this machine still has the pre-bump 8.3.1 in `node_modules`).

## Residual

- The line will disappear from device consoles only after the next
  `bun install` (applies the patch to 8.4.1) + `pod install` + device rebuild;
  the current sideloaded build predates the fix. Re-capture boot logs with the
  next device build to confirm the line is gone (expected sequence:
  `Loading app at …` → `Reachable via WiFi` → `WebView loaded`, no eval error).
- `Podfile.lock` still pins Capacitor 8.3.1 from the last machine build; the
  next `pod install` moves it to the patched 8.4.1 — no action needed beyond
  the normal mobile build lane.

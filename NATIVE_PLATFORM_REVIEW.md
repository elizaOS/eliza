# Native platform quality review

Review started 2026-09-23 (America/Los_Angeles), baseline `435deee5637f30dd698eba9a8534961325fe36a1`.

## Scope and evidence standard

This review covers all 33 `plugin-native-*` workspaces, the Android host's startup and default-app integration, and Linux implementations and fallbacks. Bootable AOSP/Linux distributions belong to the separate `elizaOS/os` repository; app changes cannot establish that an entire OS image is validated. Findings below distinguish source-confirmed defects, current-checkout tests, and observations of an older installed APK. This is a living implementation and verification report, not a claim that every capability has passed.

Two connected devices identify as `eliza_cf_x86_64_phone` on Android 17/Baklava. Device `172.17.0.2:6522` is the primary test target. Its existing app is `/system/priv-app/Eliza`, version 1.0.0; baseline bridge observations are not evidence that the final changes are installed. Bun 1.3.14, Node 24.15.0, JDK 21, Android SDK and KVM are available. Raw evidence is outside git under `/tmp/eliza-native-review`; Gradle output is `/tmp/eliza-native-gradle-tests.log`.

## Baseline results

- All 98 available package test/typecheck/read-only-lint commands passed across 33 workspaces. There were 676 passing tests and five macOS-only skipped tests. The shared-types package has no test command.
- The Android wiring gate includes all 21 declared Android native plugins. A 22nd Android module, network-policy, is not an app dependency and is absent from the installed native bridge.
- Current-checkout Gradle compilation passed for all 21 shipped Android modules. Instrumentation XML reports contain 78 tests: 74 passed and four skipped (location fix, SMS fixture, two usage-stat cases); no failures. JVM suites also passed.
- Existing installed-app bridge calls returned native system roles/settings, call permission/default dialer, camera devices, Wi-Fi state, blocker state, Bun readiness, agent state, tunnel state, mobile-signal permission state, screen-capture support, speech state and Android Keystore availability.
- Those status reads do not prove camera recording, audio recognition, actual calls, SMS delivery, blocking enforcement, reconnection, or lifecycle recovery. Each needs an explicit behavioral test.

## Package inventory

`Checks` means the package commands above, not hardware validation. Native Android tests operate on actual platform APIs but some existing assertions skip when their prerequisites are missing.

| Workspace | Android module | iOS source | Baseline checks | Android native test classes |
| --- | --- | --- | --- | --- |
| `plugin-native-activity-tracker` | No | No | Pass | 0 |
| `plugin-native-agent` | Yes | Yes | Pass | 1 |
| `plugin-native-appblocker` | Yes | Yes | Pass | 2 |
| `plugin-native-browser-surface` | Yes | Yes | Pass | 3 |
| `plugin-native-bun-runtime` | Yes | Yes | Pass | 1 |
| `plugin-native-calendar` | No | Yes | Pass | 0 |
| `plugin-native-camera` | Yes | Yes | Pass | 1 |
| `plugin-native-canvas` | Yes | Yes | Pass | 1 |
| `plugin-native-contacts` | Yes | No | Pass | 1 |
| `plugin-native-desktop` | No | No | Pass | 0 |
| `plugin-native-eliza-tasks` | No | Yes | Pass | 0 |
| `plugin-native-filesystem` | No | No | Pass | 0 |
| `plugin-native-gateway` | Yes | Yes | Pass | 1 |
| `plugin-native-inference` | No | No | Pass | 0 |
| `plugin-native-llama` | No | No | Pass | 0 |
| `plugin-native-location` | Yes | Yes | Pass | 2 |
| `plugin-native-macosalarm` | No | No | Pass | 0 |
| `plugin-native-messages` | Yes | No | Pass | 1 |
| `plugin-native-mlkit-text` | Yes | No | Pass | 1 |
| `plugin-native-mobile-agent-bridge` | Yes | Yes | Pass | 1 |
| `plugin-native-mobile-signals` | Yes | Yes | Pass | 1 |
| `plugin-native-network-policy` | Yes | Yes | Pass | 1 |
| `plugin-native-phone` | Yes | No | Pass | 1 |
| `plugin-native-reminders` | No | No | Pass | 0 |
| `plugin-native-screencapture` | Yes | Yes | Pass | 1 |
| `plugin-native-secure-store` | Yes | Yes | Pass | 0 |
| `plugin-native-settings` | No | No | Pass | 0 |
| `plugin-native-shared-types` | No | No | Pass | 0 |
| `plugin-native-swabble` | Yes | Yes | Pass | 3 |
| `plugin-native-system` | Yes | No | Pass | 1 |
| `plugin-native-talkmode` | Yes | Yes | Pass | 2 |
| `plugin-native-websiteblocker` | Yes | Yes | Pass | 2 |
| `plugin-native-wifi` | Yes | No | Pass | 1 |

The iOS source column describes directory layout only: macOS-specific helpers and inference adapters have other native owners. An absent Android module is not automatically dead code. Calendar/tasks have iOS bridges; Android features may instead be host-owned. Desktop/filesystem/activity tracking and inference have separate Linux paths requiring their own integration review.

## Confirmed findings and implementation plan

### 1. AOSP geolocation requires an unavailable Google service — high priority

`LocationPlugin` and `LocationFixReader` use `FusedLocationProviderClient` exclusively. The tested AOSP image has no `com.google.android.gms` package. The only fix-retrieval instrumentation test skips after waiting instead of proving a location result. `watchPosition` also resolves its watch ID before registration succeeds, discarding asynchronous errors.

Implement Android framework provider reads and watches, preserving coarse permission, result shape, explicit timeouts, caching and teardown. Prefer one framework implementation over two competing provider paths. Remove the Google location dependency, duplicate Gradle test dependencies, unused cached state and superseded test-only fused helpers. Validate with real LocationManager test-provider injection, coordinates read back through production code, watch cancellation, invalid options and unavailable providers. Physical GNSS reception remains a separate hardware check. Tracking: [issue 32519](https://github.com/elizaOS/eliza/issues/32519).

### 2. SMS retrieval silently omits history — high priority

`MessagesPlugin.listMessages` defaults to 100 and rejects limits above 500; `MessagesReader` stops at that limit. Neither response tells the consumer that data was omitted. This differs from phone/contacts and the repository's complete-context requirement. Web validation accepts fractional values by truncating them.

Implement complete reads when no limit is requested and explicit positive integer limits without an arbitrary 500 ceiling. Reject malformed inputs before querying. Preserve complete SMS bodies. Exercise more than 500 fixture messages through the real Android provider with cleanup restricted to test-created rows. Update the guide and public API documentation together. Tracking: [issue 32518](https://github.com/elizaOS/eliza/issues/32518).

### 3. SMS outbound completion can hang or misreport failure — high priority

The multipart receiver has no deadline or plugin-destroy cleanup. It remembers only a boolean failure but formats the final part's result code, which may be successful. A missing receipt can retain the receiver and leave the caller unresolved. The sent-folder write also needs to distinguish the default SMS app's persistence responsibility from platform-owned persistence.

Implement one request owner with exactly-once settlement, unique part receipts, preserved failure codes, deadline and lifecycle cleanup. Timeout must say that send status is unknown and must never automatically resend. Validate multipart success, partial failure, duplicate/late receipts, timeout and teardown; distinguish radio handoff from remote carrier delivery.

### 4. Wi-Fi connection requests combine two different Android APIs — medium priority

`WiFiPlugin.connectViaSuggestion` installs an Internet network suggestion, then also requests a local peer network using `WifiNetworkSpecifier` and a singleton callback that is never unregistered. The public contract already says success means suggestion acceptance, not connection. Repeated requests can leak callbacks and trigger unnecessary consent. `getConnectedNetwork` additionally reports every connection as unsecured without checking its security type.

Simplify to the documented suggestion contract or explicitly own a connection request lifecycle where required. Verify the UI's consumption before changing result semantics. Report actual security or an explicit unavailable representation instead of fabricated `secured: false`.

### 5. Capability tests can pass without exercising the capability — medium priority

The inbox marker test skips if missing. The location fix test skips when its Google-dependent provider cannot produce a fix. Usage-stat tests can skip without usage access. Keep optional hardware smoke separate from required deterministic platform tests: a requested acceptance lane must fail when its required fixture/setup is absent. Never count a skip as device proof.

## Cuttlefish telephony validation

The container ships `cvd_send_sms`, which injects via the modem simulator rather than inserting directly into the SMS database. Container identity must be resolved before choosing the modem instance: `eliza-aosp69-cuttlefish` owns `172.17.0.2`, and its ADB port 6522 maps to instance 3. The separate draft container uses instance 2. Initial injection targeted the wrong container; corrected injection delivered `Eliza-9967-SMS-roundtrip` from synthetic sender `+15555550100` to the primary device’s real SMS provider.

Use two distinct layers: provider fixtures for repeatable bridge read/write contracts, and modem injection for RIL → Telephony → default-SMS receiver → provider → bridge. Record the marker and query only test-owned rows. For calls, validate Telecom roles and CallLog/transcript behavior independently of simulated call signaling. Never equate `TelecomManager.placeCall` returning with a connected call. No physical carrier send/call is necessary for this review.

## Startup and AOSP integration review

The installed launcher first screen shows the branded wallpaper, chat sheet and cloud sign-in. The native agent simultaneously reports running and Bun ready. Source review resolved the apparent mismatch: `packages/ui/src/first-run/first-run-runtime-flag.ts` deliberately defaults production onboarding to Cloud, and `use-first-run-conductor.test.ts` exercises that policy. `runtimeMode=local` describes available hosting, not permission to bypass onboarding. The existing explicit `VITE_ELIZA_ENABLE_RUNTIME_CHOOSER=1` build option permits a deliberate local/remote image policy; do not silently change the global product default. The AndroidX splash installation precedes `super.onCreate`, avoiding the known leftover action-bar launch theme. Boot receiver already guards credential-encrypted state until user unlock and reconciles WorkManager jobs.

The main activity previously kept the display awake whenever foregrounded, preventing ordinary Home idle sleep. The implemented role-aware policy clears that flag while Home is held; actual device sleep/resume passed. Explicit recording, voice and kiosk owners retain responsibility for their own wake requirements.

Eliza already integrates with Home, Dialer and Assistant roles; SMS role reporting differed between the native read and shell RoleManager query during baseline collection and needs diagnosis. Improve truthful capability reporting before adding new privileged services. Reuse existing boot/work scheduling, role consent, accessibility, notification and voice-interaction owners. Do not introduce competing schedulers or parallel native state stores.

## Linux and removal review

Linux package-level checks passed, but they do not prove real desktop capture/input, portals, audio, filesystem permission handling or native inference. Inspect both Wayland and X11 paths, platform-unavailable behavior, process cleanup and native binary discovery. macOS-only alarm/reminder helpers should remain explicitly unavailable on Linux, not be removed because this host cannot run them. Five macOS integration skips remain accurately classified.

Removal candidates must have caller searches and behavioral justification. Confirmed opportunities currently include the superseded Google-only location path, duplicate location test dependencies and the unnecessary Wi-Fi network request/callback. The unshipped network-policy plugin requires consumer/runtime analysis before choosing integration or removal; absence from a package list is not proof of dead code.

## Completion requirements

For each implemented finding, record changed behavior and focused regression results here. Run affected package test/typecheck/lint plus guide parity and root verify. Install the current build before final native captures. Inspect each screenshot, recording and log, including startup, error/unavailable states and the requested real native operations. Run the app visual audit for any app/shared-UI change. Publish through a PR against develop with exact-revision evidence. This report remains in progress until those conditions and the remaining native/Linux review are resolved.

## Implemented changes and current verification

| Finding | Implemented behavior | Evidence inspected |
| --- | --- | --- |
| AOSP location, #32519 | Framework LocationManager; coarse/fine provider selection, monotonic cached age, owned timeout/cancellation; removed Google dependency and duplicate Gradle test dependencies | Eight real-device tests passed without skips, including injected fixes, timeout, caching, and cancelled watches |
| Complete SMS and outbound settlement, #32518 | No implicit read cap; integer validation; full bodies; default-SMS admission; per-request receiver, unique part receipts, preserved failure code, exactly-once timeout/teardown with unknown-send result | Six device tests passed without skips: 502 real provider rows and five receipt lifecycle tests; 17 web tests passed |
| Wi-Fi request ownership, #32520 | Only Internet network suggestions; no leaked peer-network callback; explicit SSID/password validation; real security type or unavailable error | Real WifiManager repeated-suggestion/update test passed; native compilation passed |
| Linux speech, #32521 | Prefer espeak-ng; complete text over stdin; validate subprocess exit and remote audio; cancel processes/streams; stale completions cannot reset newer speech | 37 focused tests passed; real espeak-ng generated a PCM 16-bit mono 22050 Hz WAV |
| Desktop file watcher, #32522 | Apply ignore rules inside watched root, so hidden/build-named ancestors do not discard every event | 23 tests passed, including real Linux fs.watch delivery and an explicit hidden-ancestor regression |
| Home screen timeout, #32524 | Clear KEEP_SCREEN_ON while Home role is held; retain ordinary foreground-app behavior; recompute on resume/focus | Installed smoke APK cleared the window flag, reached Android Asleep with stay-awake disabled, and resumed to an inspected launch screen; original power settings restored |
| Native calls, #32526 | Native call screen independent of WebView startup; Telecom owns ringing; callback/notification teardown; answer, decline, mute, end, hold and DTMF controls; route controls require supported destinations; Play builds strip the privileged surfaces | Current APK passed incoming → answer → connected → mute → end and asleep → incoming → decline; no active call/notification after decline. Hold reached real HOLDING; resume remains simulator-limited |
| Role membership, #32525 | RoleManager owns held status; retain default-handler lookup for other packages | Two real-device system-reader tests passed against live RoleManager; installed host bridge reports Home/Dialer/SMS/Assistant all held, matching the device |

The Android 17 SMS provider marks non-default-app inserts restricted by default. The deterministic test explicitly makes only its synthetic fixture rows readable on API 37, then deletes those rows. That fixture repair does not bypass production SMS permissions. Synthetic modem receipt and provider fixtures are separate evidence layers; no physical carrier message was sent.

Guide parity passed for all 157 tracked pairs. The root `bun run verify` gate passed all 382 Turbo tasks and the subsequent repository audits after formatting corrections and dependency builds. The initial desktop suite had ten file-watcher failures plus a missing secure-store build export; the ten behavioral failures were reproduced and fixed by the root-relative ignore change. The final desktop suite passed 147 files / 1,480 tests, with 18 platform-specific skips. Root verification rebuilt dependencies and passed desktop typecheck; the earlier missing declaration failures are superseded.

## Additional integration findings from real simulation

Incoming modem call `6529` reached Telecom RINGING and became missed-call row `_id=1`, duration zero, on the primary emulator. The inspected screenshot showed the existing browser, with no incoming-call screen. Telecom’s bound-service dump selected `ai.elizaos.app/com.android.incallui.InCallServiceImpl`, a nonexistent component; the host actually declares `ai.elizaos.app.ElizaInCallService`. The OS default-dialer package overlay and Telecom’s default in-call class are inconsistent. The host also claims `IN_CALL_SERVICE_RINGING=true` although its service has no ringtone owner, and its static answer/reject helpers have no bridge callers. These boundaries are now addressed by the native screen/service and a Telecom resource overlay in the isolated OS checkout `/home/shaw/.codex/worktrees/native-os-review/os`, branch `fix/native-aosp-call-integration`. The OS overlay names the actual in-call service and dial activity. OS install and verification passed. Device behavioral checks used the supported temporary `cmd telecom set-system-dialer ai.elizaos.app/ai.elizaos.app.ElizaInCallService` override; a rebuilt OS image remains necessary to validate overlay packaging. A missed-call database row alone is not working phone UI.

## Build and evidence constraints

The canonical android-system renderer and mobile agent bundle built successfully, including the bundle module-load smoke. Full system packaging then failed closed because the RISC-V Bun artifact/hash was not supplied. A scoped Cuttlefish/native iteration with the documented RISC-V opt-out passed runtime staging but found the OS manifest at a sibling path absent in this worktree. Supplying a copy of the real sibling OS capability manifest in a temporary staging tree resolved that path. Packaging subsequently stopped because the required ARM64 fused inference library was absent. None of these failures is a successful whole-image acceptance result.

A separate current-source debug native smoke APK built with the documented fused-library skip. Its purpose is bridge, lifecycle and UI validation only; it cannot validate native inference or serve as a distributable AOSP image. Build-generated icon/manifest/Gradle changes were restored to baseline after capture; authored fixes remain.

The network-policy workspace has a real Android implementation but no mobile app bootstrap import or native app dependency. Its renderer-global shim also cannot by itself reach the separate Bun runtime’s model updater. Retain the plugin pending a deliberate cross-process policy contract; adding an import alone would not establish metered-download protection. Existing unknown-network policy must remain conservative. No macOS-only plugin is removed merely because Linux/Cuttlefish cannot exercise it.

## Installed smoke validation and remaining work

The smoke APK was signed with the emulator’s matching public AOSP platform test key and installed on the separate draft device `172.17.0.3:6521`, preserving app data. It passed real Capacitor calls for corrected role status, synthetic SMS retrieval, fractional-SMS-limit rejection, invalid location timeout/watch rejection, invalid Wi-Fi credential rejection, and secure-store invalid-key rejection. Wi-Fi was called through the actual `connectToNetwork` method; an initial probe accidentally used a nonexistent method and timed out, which was a harness error rather than a connect result.

The Home window dump contained no KEEP_SCREEN_ON flag. With charging stay-awake temporarily disabled and screen timeout set to 1,000 ms, the device reached `mWakefulness=Asleep` after Android’s minimum idle interval; wake/resume returned to the inspected launch screen. Power settings were restored. The original platform APK was restored after smoke testing because the test build omits inference libraries. Screenshots, native bridge receipts, settings snapshots, APK backup and install/restore logs remain in the external evidence directory.

Host JVM tests initially failed to compile because two fixtures used Files.readString/writeString outside the Android compile API. They now use complete UTF-8 byte reads/writes with unchanged assertions; the host JVM lane and smoke APK both passed. The final location lifecycle cleanup also confines permission admission to the main looper and settles permission-waiting calls on destruction.

Production Cloud-first onboarding is intentional and covered by existing tests; image-specific local onboarding can use the existing explicit chooser flag. Remaining acceptance includes rebuilt OS overlay packaging, complete native inference artifacts, cross-process metered policy, and broader hardware/write paths. No PR or whole-platform completion is claimed yet.

## Native call acceptance and simulator limits

The final native smoke APK compiled with the Android host JVM lane, was platform-test-signed, installed and exercised on the separate draft Cuttlefish device. Real modem injection reached Telecom and the native UI. Inspected screenshots and Telecom dumps establish incoming, connected, muted and ended states. A separate asleep-device injection displayed the incoming screen; Decline removed the call and its active notification. The emulator advertises speaker-only communication audio, so the final screen does not offer an unsupported earpiece switch. Physical audio quality, Bluetooth routing, carrier delivery and emergency calling are not established by these tests.

Real testing caught an Android notification failure after Answer: an ongoing CallStyle notification from this Telecom-bound service was rejected because it was not a foreground service and did not carry a full-screen intent. The service now uses incoming CallStyle only for ringing and an ordinary ongoing notification for connected calls. The fresh answer/mute/end run completed without that crash. Play/cloud packaging tests passed 32 cases across three Vitest files; the separate App Actions Node lane passed 14 cases. Root verification again passed 382 tasks and repository audits.

Hold reached platform HOLDING. Resume sent `SWITCH_WAITING_OR_HOLDING_AND_ACTIVE`, but the next radio `GET_CURRENT_CALLS` returned an empty set and Telecom removed the call. Goldfish RadioVoice's switch requester does not visibly consume the terminal AT acknowledgment before returning; an acknowledgment/read race is a hypothesis, not a confirmed root cause. The screen correctly follows removal. Do not count resume as passed or hide the failed acceptance run.

A subsequent cleanup attempt using a second REM0 connection caused the host `modem_simulator` to SIGSEGV; the kernel timestamp and coredump inventory confirm the process failure. No accessible symbolic stack established its cause. The simulator was recovered using its existing Cuttlefish data, and cleanup now uses the Android end-call path without opening another modem connection. The later basic and decline runs passed. The earlier failed harness checks (initial UI timing and an assumed earpiece route) are retained in external evidence and superseded only by the specific corrected checks.

Acceptance logs include `call-basic-controls-result.log`, `call-locked-decline-result.log`, `incall-route-build.log`, `incall-route-install.log`, `incall-packaging-vitest.log`, `incall-root-verify.log`, and `os-verify.log` under `/tmp/eliza-native-review`. `call-muted-verified.png`, `call-ended-verified.png`, and `call-locked-ringing-verified.png` were visually inspected. The immediate connected capture caught a transient layout frame; the subsequent stable muted capture shows the correctly spaced keypad. Full native UI audit and reproducible long-running telephony acceptance still require further work.


The remaining two baseline UsageStats assumption skips were also exercised with their real prerequisite: the isolated instrumentation package received AppOps Usage Access, then both production-reader tests passed on the draft Android 17 device (`usage-granted-instrumentation.log`, `OK (2 tests)`). The test package was subsequently uninstalled, removing that temporary grant. This validates provider reads with actual foreground history; it does not prove all monitoring/background or Health Connect behavior. The original draft APK restoration completed successfully (`incall-original-restore.log`) and the temporary system-dialer override was reset to default.

Final verification after the supported-audio-route correction completed successfully: `final-native-call-verify.log` records 382/382 Turbo tasks and clean repository audits (exit 0). `git diff --check` also passed.

## Camera preview and recording repair (#32536)

The real Capacitor probe failed before preview on Android 17 with dynamic-range profile `8192`. CameraX 1.3.1 did not recognize the profile; Android's [release notes](https://developer.android.com/jetpack/androidx/releases/camera#1.5.2) identify this exact defect. Updating the default to stable 1.5.3 restored preview on the same Cuttlefish device. The standalone compile-SDK fallback is now 36 for the newer dependencies.

After preview worked, a real three-second gallery recording reproduced an empty output path and zero reported bytes. Stop previously returned before CameraX Finalize and only read a cache-file field, which gallery recording never populated. One main-thread session now owns start, recording and finalization. Start settles on CameraX Start; concurrent stop calls settle from the same Finalize result. Actual output metadata supplies dimensions, CameraX supplies recorded duration, and the finalized file/descriptor supplies its byte size. Gallery output preserves its content URI. Native duration/file-size limits replace polling; automatic-limit results remain retrievable by stop. Requested audio permission denial rejects rather than silently dropping audio, and destruction settles pending calls.

Removed the unused permission-call field, recording polling timer/coroutine scope, and unused direct coroutine/camera-extensions dependencies. Gallery recording below Android 10 explicitly reports unavailable instead of silently saving only to cache.

Four device tests passed without skips using the production plugin, a real Capacitor activity, Android cameras/codecs and MediaStore; only the JavaScript reply transport is intercepted. Coverage includes enumeration, finalized cache video, overlapping-start rejection, concurrent-stop agreement, duration-limited gallery recording, real photo decoding and invalid-limit rejection. MediaExtractor reads video samples immediately and compares returned dimensions with the actual track; test videos are deleted. Package tests passed 26 cases, typecheck and lint passed, and the host debug build/JVM gate passed. Evidence is under `/tmp/eliza-native-review/camera-*`.

Remaining camera acceptance includes the microphone-denial dialog, preview cancellation/destruction races, quality/bitrate/frame-rate option parity, switching during recording, and physical audio/image quality. Those paths are not counted as verified by the new tests.

The installed host bridge returned a real gallery URI after the repair. `ffprobe` verified H.264, 1280×720 and a 2.77-second playable container; an extracted frame was inspected and showed the Cuttlefish synthetic scene. Inspection exposed that CameraX's byte statistic excludes container overhead, so final results now read the actual file/descriptor size; the device regression also asserts exact equality with that artifact. The initial full root gate was terminated with exit 137 in unrelated `plugin-inbox` typecheck, without a TypeScript diagnostic; the isolated typecheck passed, and a full retry is recorded separately. The termination cause was not established.

The final camera suite, including exact finalized-byte-size checks, completed with `OK (4 tests)` in 8.277 seconds (`camera-final-instrumentation.log`). An intermediate run was invalidated by premature test-package cleanup and is retained as `camera-interrupted-by-cleanup.log`; it is not counted as a pass. The full root retry passed 382/382 tasks plus repository audits, exit 0 (`camera-root-verify-retry.log`). The exported host-test video was removed from MediaStore after inspection; instrumentation artifacts are deleted by the tests, and the isolated test package and this review's three CDP forwards were removed after terminal success.

Original draft APK restoration succeeded after camera acceptance (`camera-original-restore.log`). Final guide parity passed all 157 tracked pairs, and `git diff --check` passed. The broader native-platform goal remains active; the camera repair is verified only to the boundaries above.


## Camera lifecycle and option follow-through

The next source review found preview startup was not owned: after stop, a pending CameraX provider callback could recreate the preview and camera. Preview admission and permission callbacks now share one main-thread-owned call. Stop/replacement/destruction settles pending admission; late callbacks cannot bind resources. Setup failures tear down partial resources, and missing WebView/provider collaborators fail explicitly. A real-device stop-during-startup regression also verifies successful reuse afterward.

Android recording previously ignored quality, bitrate and frame rate. Each recording now configures a fresh CameraX recorder/video use case with supported-quality fallback and requested bitrate/frame-rate targets. Numeric values must be finite positive values within native ranges (integer where required); unknown quality and wrong-type values reject before recording effects. Configuration does not leak into the next default recording. Switching cameras while starting, recording or finalizing now rejects explicitly so it cannot silently interrupt the active video.

The current device suite passed six tests without skips in 13.2 seconds (`camera-lifecycle-options-instrumentation.log`). New behavioral checks cover startup cancellation/reuse, malformed options, encoded low-versus-default quality, and rejected switching while the original recording remains readable. Bitrate/frame rate are targets rather than promises of exact encoder output. Microphone-denial dialog and broader physical/hardware acceptance remain open. This replaces the earlier report's unimplemented option-parity and preview-cancellation findings with implemented, scoped device evidence.


A further queued-toggle regression found camera selection was computed before main-thread admission. Two bridge-thread toggles could therefore both select front. Selection and provider admission now happen as each main-thread operation executes. The final current-source native suite passed seven tests without skips in 15.427 seconds (`camera-lifecycle-final-instrumentation.log`), including two queued toggles returning front then back. The host debug build and JVM lane passed (`camera-lifecycle-final-build.log`); package tests remained 26 passing, with typecheck and lint clean. The isolated test package was removed only after terminal success; this phase did not replace the restored host APK.

Frame-event semantics still need review: Android's existing 500 ms timer emits dimensions/timestamps while a camera reference exists, rather than observing an actual camera frame. This is not proof of real frame delivery. Permission-denial, destruction during capture and hardware-specific behavior also remain explicit gaps.

The lifecycle/options pass completed full root verification successfully: 382/382 Turbo tasks and clean repository audits, exit 0 (`camera-options-root-verify.log`). `git diff --check` also passed. No whole-platform completion or PR readiness is claimed while the remaining report items are open.


## Real camera frame notifications and permission denial (#32541)

Android's frame timer has been removed, along with its unused counter. Sampled notifications now originate from Camera2 capture completion, report CameraX's negotiated preview dimensions, and carry wall-clock completion time. A preview epoch rejects queued callbacks from stopped/replaced previews. The existing ~2 Hz notification rate remains; these are capture metadata notifications, not image buffers or display acknowledgments.

The real-device regression waits for Android CameraState.CLOSED after pausing the activity and verifies no frame events, then checks capture notifications resume and cease again after stop. This passed with the existing video/photo/lifecycle tests. A fresh isolated instrumentation package also exercised Android's actual microphone permission dialog: Deny settled the requested audio call once with MICROPHONE_DENIED and did not start silent recording. No permissions or credentials in the installed Eliza app were changed.

The suite reached nine passing device tests without skips in 20.991 seconds (`camera-denial-instrumentation.log`). The subsequent final verification records include the capture-completion timestamp adjustment. The native microphone-denial and frame-timer findings are now implemented and device-verified. Web fallback frame notification parity remains absent and is documented explicitly; physical hardware quality and capture/destruction edge cases remain open.

The final current-source frame/denial suite completed with `OK (9 tests)` in 39.882 seconds (`camera-frame-final-instrumentation.log`), and the host debug/JVM build passed (`camera-frame-final-build.log`). Package tests remained 26 passing with typecheck/lint clean. Test-package absence was checked before cleanup; an earlier uninstall error corresponded to an already-absent package, not a running test, and the next verification used a fresh install. This phase left the installed Eliza APK and its permissions unchanged.

Full repository verification for the frame/permission pass completed successfully: 382/382 tasks and clean audits, exit 0 (`camera-frame-root-verify.log`). Guide parity and `git diff --check` passed. Remaining report items continue to belong to the active native-platform review.

## Secure-store recovery and bridge concurrency (#32544)

Real Android tests reproduced two persistence defects: a backup-only AtomicFile value was reported missing before Android could recover it, and removing that value reported `deleted: false`. Reads now allow Android's legacy backup recovery, while removal checks and verifies all base/backup/pending artifacts. The encrypted format, key alias and account allowlist remain unchanged. A source-literal deletion assertion was replaced by this behavioral native coverage.

A further cold-start test registered two real Capacitor bridge instances in the same test process. Both concurrent writes reported success, but one complete value was unreadable because independent locks allowed conflicting Keystore key creation. A shared process lock now serializes key creation and ciphertext operations. This establishes same-process admission only; cross-process use and physical hardware-backed protection are not claimed.

The baseline native suite failed its two recovery cases; the independent concurrency baseline also failed. After the fixes, all seven real-device tests passed without skips in 10.356 seconds (`secure-store-final-instrumentation.log`). The suite also validates complete 262,144-byte Unicode values across activity recreation, explicit oversize rejection preserving existing values, randomized ciphertext, account-name authentication, malformed ciphertext and sanitized failures. It runs under an isolated test UID with synthetic credentials and does not access installed Eliza credentials. The host debug build, JVM lane and instrumentation build passed (`secure-store-final-build.log`). Package and repository verification follow below.

Secure-store verification completed: 12 package tests passed; typecheck and read-only lint passed. The full root gate passed 382/382 tasks and repository audits with exit 0 (`secure-store-root-verify.log`). Guide parity checked 157 pairs; Markdown link validation, documented source/build/artifact paths and `git diff --check` passed. The isolated instrumentation package was uninstalled only after terminal `OK (7 tests)` and its absence was verified. The installed Eliza APK and credentials were unchanged in this phase.

## Call keypad ownership and renewed radio acceptance

The native screen's original generation-only timer could leave the first call's DTMF tone running after a user selected another call and pressed a digit. Screen teardown also stopped the selected call rather than the tone owner. A call-bound tone session now stops the previous owner before replacement, stops on selection/non-active-state changes and screen exit, and makes stale deadlines harmless. A main-looper Handler owns the deadline independently of replaced keypad views. Four deterministic JVM tests exercise the production ownership component with a recording Telecom boundary; they do not claim radio audio proof.

The host debug build/JVM suite passed. A fresh platform-signed APK was installed on the draft Cuttlefish device for actual keypad acceptance. Incoming UI passed, but after Answer the radio acknowledged ANSWER then returned an empty GET_CURRENT_CALLS set, and Telecom classified the call as missed. No keypad acceptance is claimed for this run. The source in the local AOSP Goldfish RadioVoice implementation also explicitly returns unsupported for startDtmf and stopDtmf; audible continuous tone delivery cannot be established on this simulator. The request/response race remains a hypothesis rather than a confirmed root cause. Logs are `incall-tone-device.log`, `incall-tone-radio-failure.log`, and `incall-tone-telecom-failure.txt`. The test ended the call and reset the temporary system-dialer override; original APK restoration and final gates are recorded below when complete.

The final four tone JVM regressions passed (`incall-tone-final-jvm.log`). Packaging first identified the new JVM test as referencing stripped privileged code; adding it to the existing Cloud test-strip list restored all 32 packaging tests (`incall-tone-packaging-final.log`). The fresh incoming-call screenshot was inspected. Original APK restoration completed successfully (`incall-tone-restore.log`), the dialer override was reset, and a subsequent Telecom dump showed no calls. No main-app data was cleared.

Root verification completed with 382/382 successful tasks and clean repository audits, exit 0 (`incall-tone-root-verify.log`). Final app-core read-only lint, Markdown link validation and `git diff --check` passed. The overall native-platform goal remains in progress; emulator tone delivery and renewed connected-call acceptance are not established by these passing code gates.

## Native OCR confidence (#32556)

The bundled Android OCR reader assigned confidence 100 to every word, although its resolved ML Kit API exposes real element confidence. This gave renderer/native OCR consumers fabricated certainty. The reader now preserves actual scores, including fractional precision, on the existing numeric 0–100 JavaScript scale. Text, geometry and grouping remain unchanged. The [official ML Kit element contract](https://developers.google.com/android/reference/com/google/mlkit/vision/text/Text.Element) defines the engine's 0–1 score; the resolved local dependency exposes that method.

The real-engine baseline test failed: HELLO had engine confidence 83.04687738418579 but the reader returned 100. After the mapping correction, all three device tests passed without skips (`ocr-confidence-final.log`), comparing actual engine scores and retaining recognized text, bounding-box, grouping and blank-image checks. The draft Android 17 device has no com.google.android.gms package, so this also confirms the bundled OCR engine operates on this AOSP image. The test uses synthetic rendered text and an isolated instrumentation UID. Package test/typecheck/lint and the Android host debug/JVM build passed. Raw red/green logs are under `/tmp/eliza-native-review/ocr-confidence-*`; full repository verification follows below.

## Open screen-recording finalization finding (#32559)

Further source review found Android ScreenCapture catches MediaRecorder.stop failure and still returns an ordinary video result. That can expose an empty/unfinalized recording as success. Concurrent stop ownership relies on the nullable timer rather than an explicit finalization session; permission-pending starts also share mutable admission fields. Existing device tests cover recording configuration rather than the actual MediaProjection/MediaRecorder path. The next acceptance work must use the real native recording path, verify readable output, and exercise competing starts/stops, denial and teardown. This finding is recorded before implementation and is not yet fixed or device-verified.

OCR root verification passed 382/382 tasks and repository audits with exit 0 (`ocr-confidence-root-verify.log`). Guide parity, Markdown links and `git diff --check` passed. The OCR test package was removed after terminal `OK (3 tests)`; this phase did not replace the installed Eliza APK. The full native-platform goal remains open, including the screen-recording finding above.

## Screen-recording finalization repair and real native harness (#32559)

A new isolated Capacitor activity exercises Android's actual consent dialog, foreground service, MediaProjection and MediaRecorder. The successful path verifies a readable encoded video sample, dimensions and exact file size, plus the existing post-stop state. Cache eviction already rejected through the recorder error path; that behavior is retained as coverage rather than claimed as a newly fixed defect.

Fault injection resets the real recorder before Stop without replacing either the recorder or production plugin. The baseline then returned success despite native finalization failure. Finalization now rejects with RECORDING_FINALIZATION_FAILED, publishes inactive/error state, releases the recorder and removes unfinished output. Missing/empty outputs also cannot become successful paths. Successful recordings preserve the previous post-stop file-size state.

The final suite passed all nine device tests without skips in 14.362 seconds (`screen-finalization-final.log`), including six configuration tests and three real recording/error cases. Package tests passed 28 cases, typecheck and read-only lint passed, and host debug/JVM build passed. Exported evidence `screen-recording-evidence.mp4` contains H.264 at 720×1280, duration 2.007933 seconds and 14,449 bytes. An extracted frame was inspected and showed the synthetic test screen and Android recording indicator. The isolated package was uninstalled after terminal success; the installed Eliza APK was unchanged.

An earlier attempt collided with a separate worktree's instrumentation on the same emulator, producing a UiAutomation registration failure and interrupted test. It is not acceptance evidence. The harness now handles its own consent, verifies the dialog belongs to its test app, and documents exclusive-device use. The later final tests ran after that other test process ended. Concurrent admission, automatic-limit result retrieval, permission denial and broader lifecycle races remain open parts of #32559; this pass fixes finalization truthfulness only.

Screen-recording root verification completed successfully: 382/382 tasks and clean repository audits, exit 0 (`screen-finalization-root-verify.log`). Guide parity, Markdown links and `git diff --check` passed. The broader native-platform goal and remaining screen-recording acceptance remain active.

## Screen-recording limit retrieval and Stop ownership

The real duration-limit baseline reproduced another #32559 defect: recording stopped automatically, but Stop returned Not recording and discarded access to the completed result. Android now retains the last completion until the next recording starts. Stop admission runs on the main looper; concurrent/repeated stops share the completed result instead of invoking native finalization again. Failed finalization remains an explicit failure. Only result metadata is retained; callers still own the returned file's lifetime.

The final native suite passed ten tests without skips in 17.647 seconds (`screen-limit-final.log`). It includes actual duration-triggered stop with readable output, two Stop calls queued together returning identical results, and the previous native failure/eviction regressions. Host debug/JVM build passed (`screen-limit-final-build.log`), and the package's 28 tests, typecheck and read-only lint passed. File-size-limit triggering, concurrent start/consent admission and broader lifecycle acceptance remain open; duration testing does not prove those paths.

The limit/Stop pass completed full root verification: 382/382 tasks and repository audits passed with exit 0 (`screen-limit-root-verify.log`). Markdown link validation and `git diff --check` passed. The isolated test app was removed after the final successful suite; the installed Eliza APK was unchanged. The overall goal remains active.

## Screen-capture consent ownership and queued destruction

The pending-consent baseline failed because a competing recording request did not settle and opened another consent flow. Main-thread admission now owns one screenshot/recording call through consent and startup. Competing requests report CAPTURE_BUSY, Android consent denial releases admission, and destroyed owners report CAPTURE_DESTROYED. Typed action state replaces the shared action string. Microphone denial now rejects before requesting projection. Foreground-service startup failure rejects immediately rather than continuing toward projection acquisition.

Delayed projection/screenshot callbacks check their owner and destroyed state; old projection callbacks cannot clear a replacement session. Starting recording releases a warm screenshot projection first. Screenshot setup failures release admission. Teardown settles the pending request, removes recording timers, and logs recorder cleanup failures rather than swallowing them. Queued admissions are deliberately allowed to reach the destroyed guard: blanket handler cancellation would strand their callers.

The final current-source native suite passed fourteen tests without skips in 31.89 seconds (`screen-admission-current.log`). New real-device coverage checks recording/screenshot competitors during consent, actual projection-consent Cancel followed by successful retry, ActivityScenario destruction during consent, and teardown before queued admission. The last ordering uses a test-only reflective call to the real lifecycle handler; the other cases use real activity lifecycle and Android UI. Existing readable-video, duration-limit, concurrent Stop and failure regressions still pass. Host debug/JVM build passed (`screen-admission-current-build.log`); package tests remained 28 passing with typecheck/lint clean. Active-recording destruction, microphone-dialog denial, file-size-limit triggering and broader screenshot reuse remain distinct acceptance gaps.

The consent-ownership pass completed root verification successfully: 382/382 tasks and repository audits passed, exit 0 (`screen-admission-root-verify.log`). Documentation links and `git diff --check` passed. The isolated instrumentation package was removed only after final terminal success; the installed Eliza APK was unchanged. Remaining native-platform acceptance stays open.

## Screenshot scale changes within one consent session

The new real-device regression reproduced a SecurityException when a second screenshot changed scale. The code released its virtual display and attempted another createVirtualDisplay call using the same projection token. Android 14+ explicitly permits only one display creation per session ([platform guidance](https://developer.android.com/media/grow/media-projection)). Scale changes now resize the existing display and replace its ImageReader surface, closing the previous reader after the surface transition.

The final suite passed fifteen tests without skips in 34.457 seconds (`screenshot-scale-final.log`), with decoded full-size → half-size → restored-size screenshots and all existing recording/consent/error cases. The host debug/JVM build passed; package tests remained 28 passing, with typecheck and lint clean. A focused export rerun also passed (`screenshot-scale-export.log`). All three exported PNGs were visually inspected: 720×1280, 360×640 and 720×1280, showing the synthetic test screen at the requested scales. They are retained under `/tmp/eliza-native-review/screenshot-{full,half,restored}.png`.

The first export attempt happened after the isolated package was already absent; its files contained command errors and were rejected as evidence. The successful focused rerun replaced them with verified PNGs, and cleanup then succeeded. The installed Eliza APK was unchanged. Device rotation, partial-app sharing and other previously recorded gaps remain unverified by this scale-only test.

Screenshot-scale verification completed: root `verify` passed 382/382 tasks and repository audits with exit 0 (`screenshot-scale-root-verify.log`). Markdown links and `git diff --check` passed. This closes scale-change reuse within the tested consent session, not the broader native-platform goal.


## Screen-recording byte limits and dedicated Cuttlefish isolation

A dedicated instance now owns this review's Android UI tests: Docker container `eliza-native-review-cuttlefish`, Cuttlefish instance 4, ADB `172.17.0.5:6523`, Android 17/Baklava, 720×1280. It uses existing read-only base images and its own fresh writable userdata. Other worktrees were running instrumentation against the former draft instance; package removal and UiAutomation disconnection invalidated two attempted runs. Those attempts are not acceptance evidence. The successful launch uses the display/WebRTC path; the initial headless attempt did not complete boot. Only this review's container was restarted. No claim is made about the underlying headless-launch cause.

The test APK uses a run-local Gradle init script to set application ID `ai.eliza.review.screencapture.test`; repository defaults remain unchanged. Consent displays the explicit synthetic label “Eliza capture test.” Fresh installation restores microphone permission prompting. The test app uses only its own files and synthetic screen content.

The first uncontended run passed 17 of 18 tests and exposed a real byte-limit defect (`screen-lifecycle-limits-dedicated.log`). A 128 KiB request recorded 637 frames without stopping; MediaRecorder logged an implicit unlimited limit. Capacitor's getLong accepts only a boxed Long, whereas ordinary JSON byte counts deserialize as Integer. Android now validates the supplied number as a positive JavaScript-safe integer and converts it explicitly. Invalid, fractional, zero, negative, string, boolean, null and unsafe values reject before consent instead of becoming unlimited. Invalid requests release admission for a valid retry.

The final suite passed **19 tests without skips in 49.748 seconds**, including readable file-size-limited output, real microphone denial followed by recording without microphone, and active-recording destruction checked against Android's media-projection service. The encoder log confirms `limits: 131072/0 bytes/us`. Evidence is retained in `screen-byte-limit-final.log` and `screen-byte-limit-final-logcat.txt` under `/tmp/eliza-native-review`. Host debug/JVM build passed (`screen-byte-limit-build.log`), as did all 28 package tests, typecheck and lint.

These results close the listed limit, denial and active-destruction gaps. Rotation, partial-app sharing, system-audio capability accuracy and the broader remaining platform work still require follow-through.

Byte-limit/lifecycle verification completed: root `bun run verify` passed all 382 tasks and repository audits with exit 0 (`screen-byte-limit-root-verify.log`). Markdown link validation and `git diff --check` passed. After terminal instrumentation success, the isolated test package was uninstalled; Android reports no active media projection. The dedicated emulator remains available for the continuing review.


## Android screen-recording audio capability accuracy

Android advertised system_audio on API 29+ although its MediaRecorder path only configures microphone audio. A new real-device test reproduced that an explicit system-audio request opened consent instead of rejecting (`screen-audio-baseline.log`). The bridge now omits the unsupported capability and rejects explicit captureSystemAudio=true before consent with SYSTEM_AUDIO_UNSUPPORTED. It releases admission so the caller can retry without system audio. The dead Android recording-config field was removed; TypeScript documents the boundary, and the README example selects system audio only when advertised. No system-audio implementation is claimed.

The final dedicated-device suite passed **20 tests without skips in 56.56 seconds** (`screen-audio-final.log`), including unsupported-audio rejection followed by real consent and a readable recording with exact output metadata. Android debug/JVM build passed; package tests, typecheck and lint passed.

## Contacts boundary finding for follow-through

Tracking: [issue 32571](https://github.com/elizaOS/eliza/issues/32571).

ContactsPlugin.listContacts uses Capacitor getInt for limit, whose strict boxed-Integer check silently maps malformed/fractional/large values to omission. The resulting Int.MAX_VALUE also encodes an implicit default cap rather than explicit absence. ContactsReader returns empty phone/email arrays on null provider cursors, hiding unavailable child data. Existing native tests directly exercise a reader with one provider-inserted row, leaving the bridge validation path untested. The next pass must validate positive safe-integer limits, retain complete default reads, and surface child-query failure distinctly from valid empty results, with a real bridge/provider harness. These findings are source-confirmed; device regression and implementation remain pending.

Screen-audio capability verification completed: root `bun run verify` passed all 382 tasks and repository audits with exit 0 (`screen-audio-root-verify.log`). Documentation links and `git diff --check` passed. The isolated test package was removed after final suite completion and Android reports no active projection. The contacts finding and broader platform acceptance remain open.


## Contacts bridge validation and provider failures (#32571)

The new Cuttlefish harness reproduced three baseline failures (`contacts-baseline.log`): a numeric 1.0 limit returned both matching contacts, a null phone query returned an empty list, and the existing zero-limit rejection did not use the new structured error code. The zero-limit case already rejected before this fix; that code assertion is not an independently discovered behavior defect. Valid empty cursors and the existing provider round-trip already passed.

The bridge now validates a positive JavaScript-safe integer limit without relying on Capacitor's strict boxed-Integer accessor. Omitted limits remain absent through the reader rather than becoming Int.MAX_VALUE; a caller-requested limit is applied only after matching. Missing phone/email cursors throw, and the bridge translates provider failure to CONTACTS_UNAVAILABLE without returning accumulated partial records. INVALID_LIMIT is returned for malformed explicit limits. The redundant result counter and misleading extraction-history comments were removed. API comments now correctly state that web permission operations are unavailable.

The final dedicated Cuttlefish run passed **five tests without skips in 3.445 seconds** (`contacts-final.log`). Real BridgeActivity/Capacitor/ContactsProvider coverage creates synthetic contacts through the production bridge, reads complete names/phones/emails, searches by email, tests integer and floating-point integer limits, accepts a large safe-integer limit, and rejects malformed limits. Cleanup identifies raw rows by unique test names, so aggregated contact IDs cannot broaden deletion. Null/empty child-query coverage injects a minimal provider response into the actual reader; that failure injection is not represented as a platform outage or full end-to-end failure test.

The host debug/JVM build passed (`contacts-final-build.log`). All nine package tests, typecheck and lint passed. vCard interoperability, write-failure settlement, and permission-revocation races remain separate review surfaces; the five tests do not prove those paths.

Contacts verification completed: root `bun run verify` passed all 382 tasks and repository audits with exit 0 (`contacts-root-verify.log`). Paired guides, documentation links and `git diff --check` passed. The isolated contacts test package was removed after terminal suite success. Broader native-platform work remains active.


## Phone history limits and complete transcripts (#32573)

Tracking: [issue 32573](https://github.com/elizaOS/eliza/issues/32573). The real bridge/provider baseline reproduced four failures: numeric 1.0 ignored the requested limit, fractional input returned data, transcript/summary whitespace was trimmed, and malformed saved JSON escaped without settling the bridge call. Baseline evidence is `phone-history-baseline.log`. The initial fixture also tried deleting CallLog item URIs, which this provider rejects; corrected cleanup uses the collection URI with exact inserted IDs. The four leftover synthetic rows from that first attempt were inspected, individually bounded by their IDs/date range, removed, and absence was verified. No pre-existing call history was touched.

Android now accepts positive JavaScript-safe integer limits independently of JSON boxing, rejects invalid values with INVALID_LIMIT, and keeps omitted limits absent rather than Int.MAX_VALUE. Read failures settle with CALL_HISTORY_UNAVAILABLE and no partial result or raw transcript text in the error. Saved transcript records must have valid text and timestamp fields; malformed JSON, wrong storage types and invalid field types are explicit failures. Transcript and summary storage preserves complete whitespace and Unicode. The redundant result counter was removed.

The final dedicated Cuttlefish run passed **five tests without skips in 5.715 seconds** (`phone-history-final.log`): actual CallLog ordering/filtering, complete and limited reads, invalid limits, exact transcript round-trip with 2,048 repeated Unicode lines plus leading/trailing whitespace, and corrupt-storage rejection. The status-reader test still passes. This validates the data path, not physical call audio or carrier delivery. The host debug/JVM build and all eleven package tests, typecheck and lint passed. A post-run CallLog query returned no rows, confirming synthetic fixture cleanup.

The test preferences belong to the isolated test app. Transcript persistence across process death/disk failures and the web fallback's misleading empty-history/granted-permission behavior remain separate follow-through items; they are not proven by this in-process native pass.

Phone-history verification completed: root `bun run verify` passed all 382 tasks and repository audits with exit 0 (`phone-history-root-verify.log`). Paired guides, markdown links and `git diff --check` passed. The isolated phone test APK was removed after terminal instrumentation success. The complete native-platform goal remains active.


## Phone fallback and consumer error-state follow-through

The non-Android PhoneWeb bridge previously returned empty history and granted phone permissions despite having no provider. A real-fallback baseline failed four cases (`phone-fallback-baseline.log`). History, mutations and permission operations now reject with Capacitor UNAVAILABLE after input validation; getStatus still truthfully reports disabled capabilities. Twelve fallback tests, typecheck and lint pass.

Caller review found PhoneView swallowed permission/status errors and fabricated call readiness on missing status. It now preserves the bridge error for display and requires a successful status read. A new rendered consumer regression additionally exposed enabled Call controls while the view reported call-blocked. Dialer and recent-row Call controls now honor the actual readiness state. All 93 consumer tests pass, including error-to-success refresh recovery; consumer typecheck and lint pass. These are controlled bridge/DOM tests, not real carrier-call acceptance. The completed visual and root results are recorded in the final Phone verification section below.

The first app-audit attempt could not launch Chromium: this checkout required Playwright browser revision 1234 while only 1243 was cached. It was explicitly interrupted after that repeated setup failure (exit 130), and produced no usable visual findings. The exact browser revision was then installed successfully. The audit was restarted with E2E_RECORD=1, capturing videos/traces plus desktop/mobile screenshots under `/tmp/eliza-native-review/phone-fallback-app-audit-final`; its completed Phone captures were reviewed and exposed the semantic issue described below.

Fallback/consumer root verification passed all 382 tasks and repository audits with exit 0 (`phone-fallback-root-verify.log`). The later visual pass below validates the corrected history states.


## Transcript persistence acknowledgment (#32573)

While the visual audit continued, a real Cuttlefish storage-failure test reproduced saveCallTranscript reporting success when its SharedPreferences directory was unwritable (`phone-durability-baseline.log`). The fault injection changes permissions only on the isolated test UID's preferences directory, verifies the actual writer fails, and restores the original mode in finally. Android now waits for a successful commit and rejects with TRANSCRIPT_SAVE_FAILED without a saved timestamp if persistence fails.

The full native phone suite passed **six tests without skips in 7.461 seconds** (`phone-durability-final.log`), including actual XML-file inspection immediately after successful save acknowledgment and the failed-write regression. The host debug/JVM build passed. This proves the tested disk acknowledgment boundary; sudden power loss and arbitrary filesystem corruption are not claimed as covered.


## Manual Phone visual review and explicit history states

The first completed all-view capture run passed **230 Playwright tests** and produced 224 viewport findings. All four Phone views were DOM-good and OCR-verified, with no horizontal overflow, console errors or hover-probe failures. Manual inspection of desktop, mobile portrait, mobile landscape and tablet captures nevertheless found a semantic defect: the unavailable-history error was accompanied by “0 recent” and “None.” Automated layout/OCR success did not establish correct product state.

PhoneSnapshot now carries an explicit loading/ready/unavailable history state. Loading and unavailable views cannot display the designed-empty result or a fabricated count. The data wrapper sets that state from real read outcomes, and the existing Phone stories represent the same contract. The 93 consumer tests still pass, including assertions that failed/loading reads do not show “None” or “0 recent.” The completed repeat audit and focused story validation are recorded below.

The first OCR gate returned nonzero for one untouched Background desktop capture: missing expected “Desert Dusk.” That label is visibly present in the inspected PNG. Its summary was 215 verified, eight needs-eyeball, one broken out of 224; the Phone entries were all verified. This is recorded as an OCR miss, not waived or reported as a green whole-app audit. The initial story catalog build failed while a generated cloud SDK browser-contract file was absent; the file subsequently exists after the workspace build. After the workspace build completed, the retry succeeded without a source change.


## Completed Phone UI verification

The corrected revision passed all **230 app Playwright tests** in 12.4 minutes (`phone-state-app-audit.log`). All four Phone viewport entries are DOM-good and OCR-verified. Manually inspected desktop, mobile portrait, mobile landscape and tablet PNGs now show explicit unavailable history, disabled calling, no fabricated recent count and no designed-empty label. The built PhoneView bundle hash is `sha256-elSAVpsQAK8GSwbVD7AyEUqyc3ibTuvkimXyShJ0kkU=`. The Phone hover probes reported no violations or failures, and the recording contact sheets were inspected. MP4 recordings and original Playwright traces are preserved under `/tmp/eliza-native-review/phone-state-videos`. These are browser fallback/fixture captures, not Android radio acceptance.

The full app OCR gate still exits nonzero solely for the unchanged Background desktop “Desert Dusk” recognition miss (215 verified, eight needs-eyeball, one broken). No expectation was weakened or exclusion added; the whole-app gate is not reported as green. The earlier recordings were overwritten by the audit runner before preservation; only the final recordings are retained.

The static story build retry and focused Phone story gate passed: five good stories, zero broken, zero console errors, zero accessibility failures (`phone-state-stories.log`). Empty, populated, loading, denied and load-error captures were each opened and inspected. The full UI package suite passed **1,320 files / 14,424 tests**, with seven skips (`phone-state-ui-tests.log`). Root verification completed 382 successful tasks and the repository audits (`phone-state-root-verify.log`). Native fallback and consumer package tests/typecheck/lint remain green at 12 and 93 tests respectively.


## Required nullable Phone wire values (#32573)

A real CallLog/Capacitor baseline reproduced a missing `agentTranscript` key when no transcript exists (`phone-null-baseline.log`). Passing Kotlin null to JSONObject.put removed required nullable values from the serialized response. Android now uses JSONObject.NULL for absent nullable call-history and default-dialer fields. Existing non-null values remain unchanged. The provider round-trip now covers absent native metadata and agent transcript fields after JSON serialization, plus saving a transcript without an optional summary. No new schema or optional-field workaround was introduced.

The full dedicated Cuttlefish suite passed **six tests in 7.532 seconds without skips** (`phone-null-final.log`); the host debug/JVM build passed. Twelve package tests, typecheck and lint passed. The status reader remains covered against actual Telecom; this run does not simulate a missing Telecom service.

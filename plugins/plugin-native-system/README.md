# @elizaos/capacitor-system

A Capacitor plugin that bridges Android system-role status and device-settings control
into the elizaOS mobile runtime.

See [bridge definitions](src/definitions.ts) for the native API. Native targets require their SDKs, registered bridge, and OS permissions.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-native-system build  # build
```

## Android device verification

From the repository root, run `node packages/app/scripts/android-native-plugins.ts --serial <emulator> --plugin plugin-native-system --system-controls` on an isolated stock emulator without the user app. This verifies real brightness and music-volume changes, clamping, permission denial/revocation, and restoration against Android settings and AudioManager. A second instrumentation process verifies recovery of persisted original settings after the first process exits with changes outstanding. Reports include bridge receipts and native observations. Home/SMS/assistant role flows and physical-device behavior require separate coverage.

The installed-app hosted lane (`ELIZA_ANDROID_BACKEND=host node
packages/app/scripts/android-e2e.ts --serial <emulator> --build --skip-local-chat
--host-emulator-probes --start-host-agent --no-emulator-boot`) checks all five
settings intents against actual Android screens, including an existing Wi-Fi task
covered by Sound settings. It also verifies invalid roles, dialer-picker cancellation,
grant and already-held results, restores the original phone app, and reattaches to
the app after permission revocation. The role tests use a separate session. This lane
requires an isolated stock emulator and exports native screenshots and observations.

The baseline native-plugin runner also verifies flashlight input rejection before
permissions, actual camera permission denial/grant, and torch on/off against
CameraManager callbacks when the emulator exposes flash hardware. It exports
native dialog screenshots, capabilities and receipts, then restores the torch and
removes the test package. A device without flash must reject explicitly; emulator
callbacks do not certify physical light output.

The native-only `setup.DeviceSetup` helper reports installed/default browser and
Autofill-provider packages and opens host-approved settings/app destinations.
Hosts supply supported package sets, their selected browser/certificate trust
verifier, and an Activity launch callback. The helper snapshots package policy,
rejects unlisted app destinations and uses separate Android tasks. It never reads
credentials, proves vault readiness or changes defaults silently. It adds no
`ElizaSystem` bridge methods or permission grants. A host that exposes it to
JavaScript can use the `DeviceSetup`, `DeviceSetupReadiness`, `DeviceSetupTarget`
and `DeviceSetupOutcome` types, which use the Java JSON fields and enum names.
`DeviceSetupInstrumentedTest`
checks independent host policy against Android observations while capturing
navigation instead of launching screens or changing roles. Real settings/provider
journeys and physical-device behavior require separate acceptance.

Android hosts can use `SystemLauncherApps.list(context)` for launcher discovery.
Declare an `ACTION_MAIN`/`CATEGORY_LAUNCHER` package visibility query in the host
manifest. Each entry is one launcher activity, identified by package, activity
and Android user. Work, private and clone profile entries come from
`LauncherApps` and carry `user`, `profile` and `locked`. Discovery excludes the
host, disabled apps, unexported activities and Android's app-details stand-in.
`SystemLauncherApps.resolve(context, packageName, activityName, user)` checks
the exact entry again before a launch. It refuses a removed, disabled or locked
entry with a stable code instead of opening another activity.
`SystemLauncherApps.watch(context, listener)` reports package and profile
changes, and the host reads the list again. `launchIntent(context, packageName)`
remains for package-only callers. Resolution does not launch an activity; the
host retains its user-intent and foreground policy.

`SystemAppIntents` resolves the dialer and default messaging destinations and
opens a gallery through a host-supplied launch callback. Only a missing gallery
triggers the image-viewer fallback; permission denial never triggers another
gallery destination. Results describe dispatch or failure, not user completion.
Hosts retain foreground/user-intent policy and presentation. Instrumentation tests
capture dispatch without opening apps, placing calls or sending messages.

The `ElizaSystem` bridge also exposes `listLauncherApps`, `launchApp`,
`resolveDefaultApp` and `openDefaultApp`, and emits `launcherAppsChanged`.
`launchApp` with `activityName` (and `user`) opens exactly the listed entry.
Icons are optional PNG data URLs, badged for another profile.
The default-app role is currently `dial`, with an empty dial pad. Hosts must
also declare an `ACTION_DIAL` query with the `tel` scheme. Default handoffs use
an explicit eligible activity or a chooser of eligible activities. The host,
disabled apps and unexported activities cannot be destinations. Web fallback
reports no handlers and rejects launch requests. Hosts retain user-intent policy.

`@elizaos/capacitor-system/launcher` exposes the browser-safe installed-app controller,
identity/search helpers, favorites persistence and package/resume observation. Hosts
inject their native bridge and rerender on the change callback. Use `localFavorites`
with the existing host storage key and default-policy marker when migrating a
product; omission uses the Eliza defaults. Builtin view IDs remain distinct from
Android package/activity/profile IDs. `observeLauncher` does not start the initial
inventory read; hosts call `load` when their launcher opens. On cleanup, stop the
observer and call `cancelPending` to discard late reads and handoff responses. The
controller remains reusable when the host opens again. Observe only while the
host needs native updates. Run `bun run --cwd
plugins/plugin-native-system test` for the shared controller and migration cases.

## Shared image listener

`Sense` is the `ElizaSense` bridge for the separately installed image listener.
It reports status, pauses, turns off and opens the listener's own settings. It
cannot enable or resume capture. The native `SenseListenerClient` verifies the
listener package, matching signer and control permission. Settings metadata is
read only from that admitted APK; the target must be an enabled exported
activity in the same package and UID. Hosts may keep a legacy bridge-name alias.

`createSenseInvocationController` binds an opaque digest of the current
authenticated owner/agent/session tuple before consuming native invocations.
Native origin comes only from Android's caller identity and a same-signer check;
caller extras and deep-link parameters never authorize a microphone. A pending
wake expires after five seconds, is consumed once, and cannot cross a lock,
background state or owner change. Once an authenticated session is bound, a warm
wake can start the existing shell voice controller. Hosts must supply live
authority reads and re-check readiness.

The invocation is `listener` for a wake from the same-signer listener, `system`
for an assistant gesture (press-and-hold power, the assist gesture, a long press
on Home or the navigation handle) that Android reports as launched by the
platform-signed `com.android.systemui`, and `assist` for every other launch.
`listener` and `system` may start a voice turn under the same session, lock,
foreground, window and owner rules; `assist` only opens the assistant. Stock
SystemUI does not share its identity with the assistant activity it launches, so
on such images the caller is unknown and a power-button hold stays `assist`. An
image that applies the shared `assist` SystemUI bundle
(`packages/os/android/sense/systemui/assist`) shares it, and only that platform
package can produce `system`.

A wake that arrives before any authenticated binding (a cold process, or a
renderer that is not signed in yet) only opens the assistant unless the host's
native code registers `SenseListenerClient.admitOwner(...)` at startup. That
admission returns a non-secret native owner identity (for example a durable
account-binding generation, never a token). With it, a listener wake or system
gesture that arrived unlocked is held for `COLD_WINDOW_MS` (15 seconds), keeping
its origin: the first authenticated
binding claims it only if the native owner at that binding equals the owner
recorded at arrival, and the take still requires the same session, the same
native owner, no lock and foreground. An owner change, expiry, a later
non-listener launch, reset or a stale renderer generation drops it. Renderer
input never fills the gap; a host without an admission keeps assist-only cold
starts.

Each renderer mount has an opaque binding ID and monotonic generation. Native
plugin instances also have a process-local monotonic generation. Old mount or
WebView bind/read/cleanup calls cannot change a newer binding, even for the same
owner. The renderer serializes bridge operations and bounds each wait to ten
seconds; a timed-out late native operation remains subject to those generation
checks. Failure to complete never authorizes capture. A later focus/invocation
check can retry; a WebView recreation receives a new native plugin lifetime.

`node --test plugins/plugin-native-system/test/sense.test.mjs` exercises the
shared native policy, client refusal rules, Android API compilation and renderer
authority race. These tests do not prove installed-device microphone handoff.

### Protected Power entry

A native permission-protected host activity may call
`SenseListenerClient.recordProtectedPower()` only for a fresh warm invocation on
its already bound bridge. The receipt's origin is `power`, a voice origin alongside
`listener` and `system`; unlike those it is never held for a cold binding, even
with an `admitOwner(...)` admission. A weak Activity-to-bridge association is registered only
after a matching bind, and the native hook verifies the actual exported, enabled,
nonalias Activity component requires `STATUS_BAR_SERVICE`. An old Activity cannot
mint or clear an invocation belonging to a newer bridge. It is not a JavaScript method and accepts no caller
Intent extras. The existing bridge, renderer generation, binding id and owner/session
lease must already exist. A new activity/WebView, cold start, owner change, reset,
unbind or disposal clears authority; no pending gesture is promoted at first bind.
The warm API never promotes a cold invocation. Hosts may separately opt into the
protected launch authorization below; otherwise cold entry stays surface-only.

The typed controller treats a matching fresh Power receipt as one-shot, just like
an authenticated listener receipt. If hidden, modal, not ready or already recording,
it calls the optional owner-bound `discardProtectedPowerInvocation` bridge method.
Native foreground refusal also discards only that matching pending Power receipt,
so later focus cannot revive it. That method can clear only the current lease's pending Power origin, never create
an origin, clear another binding, reset a session or discard listener delivery.
Actual OS caller permission enforcement, hardware dispatch and speech require
separate native/device qualification.

### Fresh protected launch authorization

A host can authorize a first Power press separately from the warm invocation
receipt. Its protected Activity calls native-only `beginProtectedPowerLaunch`
exactly once on a fresh creation, with a native `PowerLaunchValidator`. No
JavaScript method can create or refresh that grant. It is Activity-local,
process-local and valid for five seconds from the actual launch. It is never
saved in an Intent, saved state, or storage.

The native validator pins an already admitted account and a monotonic account
mutation epoch. `authorize(accountRef, consume)` must check that pin and match
the renderer's canonical verified account identity under the host's existing
authorization locks, then invoke `consume` synchronously under those locks.
The SDK calls host policy without holding SDK locks. The guarded action checks
the exact current bridge, renderer, binding and session, foreground focus,
unlocked keyguard and deadline, and can succeed once. A failed attempt spends
the grant too. The first plugin bridge attaches once; replacement, pause,
destruction, changed renderer/session or focus loss invalidates it.

Hosts must forward native window focus changes and cancel on their native
lifecycle changes. The optional controller fields `initialRestorePending` and
`powerAccountRef` distinguish bounded automatic restoration from interactive
authentication. A modal, hidden page, active recording, interactive sign-in,
failed readiness or account change discards the launch. Ordinary listener
receipts, cold binds, public Assist and the legacy UI hint gain no new authority.
Source tests do not prove Binder enforcement or installed-device audio.

## System facts and settings handoffs

`getSystemFacts()` returns the switch states an ordinary app can read without a
permission it does not hold: Wi-Fi, Bluetooth, airplane mode, location, mobile
data, Do Not Disturb (interruption filter) and adaptive brightness, plus the
active transport and battery/power-saver state (`SystemFacts.read`). A key is
present only when Android answered; an absent key is unknown, never off. The
plugin changes none of these. `openSettingsPage({ page })` opens one allowlisted
Android page (`SystemSettingsPages.PAGES`) and resolves `specific: false` when
only a broader fallback page exists on that image, so the caller can say so.
`openNotificationShade()` asks Android to expand its shade for a host acting as
the launcher (`canExpandNotificationShade()`: by default, holding Android's HOME
role; overridable) that declares `EXPAND_STATUS_BAR`; outcomes are `opened` (accepted, not proof the shade is
visible), `standalone`, `permission-missing`, `unsupported` and `not-in-front`.
The web fallback reports no facts, opens no page and answers `unsupported`.

`@elizaos/capacitor-system/settings` (`src/settings.ts`) is the shared, browser-safe
presentation for those facts: `parseSystemFacts`, `systemSwitchRows` (row wording
that says "Not reported by Android" instead of guessing), quick-setting tile state,
accessible names that announce handoff tiles as buttons carrying their state,
`broaderPageNotice` and a one-handoff-per-gesture gate. The Device Settings app
(`plugin-native-settings`) renders these rows. `test/settings.test.mjs` runs the
reader, page fallbacks and shade outcomes against host-JVM stand-ins; the readable
settings and the pages an image provides still differ by Android version and vendor
and need device qualification.

## Assistant entry tile

`AssistantEntryTile` is the shared Quick Settings tile that opens a host's assistant
entry. It is an action, never a toggle: it always reports `STATE_INACTIVE`, so it
never suggests that an agent, a connection or the microphone is on. A tap on a locked
device asks Android to unlock first and opens the entry only afterwards; Android 14
and later receive an immutable `PendingIntent`, earlier versions the `Intent`
overload. A tap grants no permission and starts no capture. Hosts subclass it under
their installed component name, return an explicit `entryIntent()` and may supply a
label, a lock-aware subtitle, a spoken description, an icon and a request code;
otherwise the manifest label and icon stay. The library declares no tile: each host
declares its service with `android.permission.BIND_QUICK_SETTINGS_TILE` and
`TOGGLEABLE_TILE=false`. The Eliza app's `ElizaVoiceTileService` uses it.
`test/assistant-tile.test.mjs` runs both on a host JVM; SystemUI placement, unlock
and collapse need device qualification.

## App data reset

`reset.DataReset` resets a host app's own data through Android's
`ActivityManager.clearApplicationUserData()`, which is scoped to that package and
Android user: it stops the package's processes, cancels its jobs, alarms and
notifications, clears its private data and its UID Keystore namespace. It never
enumerates files and never touches shared media, other apps or remote account
data, and nothing reports a returned request as completed deletion.

A host builds one `DataReset` with its installed identities and shares it:

- `DataReset.builder(markerName, RecoveryActivity.class)` names the pending marker
  (`<markerName>.pending` and `<markerName>.failures` in device-protected no-backup
  storage) and the recovery activity. Keep both stable across releases.
- `beforeDispatch(...)` optionally adds bounded, best-effort work that runs only
  while a confirmed reset is pending, such as revoking this device's remote
  sign-in. It never blocks or cancels the local reset beyond its budget. Eliza
  Cloud hosts pass `CloudKeyRevocation.resetStep(() -> registration,
  Store::readSlot)::run` from `@elizaos/auth` (Android `ai.eliza.auth.cloud`):
  it revokes each registered environment's saved key on an interrupted daemon
  worker, capped at 8 seconds.
- The same-signer image listener (`SenseListenerClient.resetForData()`) must
  acknowledge first. An installed listener that does not durably acknowledge
  consent revocation keeps the marker and all app data; an absent listener is
  safe to reset.
- The failure record keeps the last failed attempt's outcome, so the recovery
  screen explains what actually happened (Android refused the clear, or the
  listener did not acknowledge) rather than guessing from the listener's
  current install state.
- `attempt(...)` acts only while a confirmed request is pending. Without the
  marker it returns `DEFERRED` and neither asks the listener to withdraw consent
  nor asks Android to clear data, so a stale retry cannot erase unconfirmed data.

Wire it in three places:

1. `Application.attachBaseContext`: after `super`, call
   `admitBeforeStartup(this, getProcessName())` before providers and initializers
   run. It returns in isolated processes, the recovery process and when nothing is
   pending; otherwise it retries the reset and stops the process. Return early
   from `onCreate` in the recovery process.
2. A `reset.DataResetPlugin` subclass with the host's own
   `@CapacitorPlugin(name = ...)`. `review()` takes no arguments: a native
   disclosure, then a fresh device-credential confirmation
   (`ResetAuthorization`) authorize the reset, and the request is recorded before
   any pre-dispatch work. Results are only `cancelled` or `unavailable`; a confirmed
   reset stops the app. `src/reset.ts` (`@elizaos/capacitor-system/reset`) gives the
   renderer `reviewDataReset`, which never reports completion.
3. A `reset.DataResetRecoveryActivity` subclass declared unexported,
   `excludeFromRecents`, `singleTask` with its own task affinity, and in the
   process named by `recoveryProcessSuffix` (default `:reset_recovery`). That
   process installs none of the host's providers. It explains that the reset has
   not finished and offers a fresh retry, the listener's validated settings
   activity, the dialer and Android Settings.

`DataResetCopy.forProduct(name)` supplies the text; hosts may replace the
disclosure, the progress message and a note about remote steps. Automatic
attempts at launch are bounded (three per minute; unreadable attempt state defers
them until the user retries), and starts Android attributes to jobs, alarms,
broadcasts, pushes, providers or services stop without opening recovery over the
app in front. `test/reset.test.mjs` covers authorization, bounded admission,
background starts, interrupted dispatch and single dispatch against host-JVM
stand-ins. Real self-clear, the listener's provider IPC and the recovery task
returning instead of HOME require installed and device qualification.

## Problem log

`crash.CrashLog` is a privacy-bounded local problem log for Settings
diagnostics. It records failure classes only: an uncaught exception's class and
root-cause class, Android's recorded problem exit reasons (Android 11+, read once
each; ordinary user, update and clean exits are skipped) and renderer failure
kinds. It never stores messages, stack traces, exit descriptions, trace files,
URLs or user content. The log is one `AtomicFile` at
`no_backup/crash-log/v1.json`, bounded to 50 entries, 30 days and 256 KiB; a
damaged file starts again. `export(context)` re-applies the field allowlist for
a support bundle.

A host calls `CrashLog.install(this)` in its main process's `Application`, and
exposes `read`, `recordRenderer` and `clear` through its bridge, calling
`collectExitReasons` before a read. The Eliza app's `ElizaAgentService` records
its exit-reason read here too. `src/crash-log.ts`
(`@elizaos/capacitor-system/crash-log`) re-sanitizes whatever the bridge or
browser storage returns (`sanitizeCrashEntries`), names renderer errors
(`errorClassOf`), describes entries and builds the redacted export.
`test/crash-log.test.mjs` covers both on a host JVM and Node; a real crash and
Android's exit history need an instrumented run.

## Clock handoff

`clock.ClockHandoff` builds the standard Android Clock intents (`set`, `show`,
`dismiss`, `snooze`) for a reviewed request and starts the resolved external
handler as an explicit component. The host itself never receives its own
handoff. Dismiss and snooze carry no target, and `EXTRA_SKIP_UI` is always
false. A launched Activity is not a receipt: the strongest result is `opened`,
which only means Clock received the request. `launch(...)` adds a host form's
checks: reviewed, host in front, phone unlocked, and an unchanged time zone for
a set.

`clock.ClockDays` admits repeat days (`java.util.Calendar` values, Sunday = 1).
`strict` takes a host form's unique ascending list. `agent` takes an agent
operation's days in any order, sorts and de-duplicates them, and reads an empty
list as a one-time alarm. `explicit` keeps a reviewed request's order.
`clock.ClockProfile` names what a host advertises: `HANDOFF_ONLY`
(`clock.handoff.v1,clock.handoff.v2`, Android Clock owns alarms) or
`OWNED_ALARMS` (`clock.alarms.v1`, the Eliza app's `ElizaAlarms`). A host that
leaves `OWNED_ALARMS` must also choose a `SavedAlarms` path for alarms it
already saved. `test/clock.test.mjs` runs on a host JVM; real Clock apps need
an instrumented run.

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
background state or owner change. A cold process has no bound owner: the wake
opens the assistant but does not start a voice turn automatically. Once an
authenticated session is bound, a warm wake can start the existing shell voice
controller. Hosts must supply live authority reads and re-check readiness.
Cold-start automatic voice remains a parity gap until the native owner can bind
an authenticated session before launch; renderer extras must never fill that gap.

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
its already bound bridge. A weak Activity-to-bridge association is registered only
after a matching bind, and the native hook verifies the actual exported, enabled,
nonalias Activity component requires `STATUS_BAR_SERVICE`. An old Activity cannot
mint or clear an invocation belonging to a newer bridge. It is not a JavaScript method and accepts no caller
Intent extras. The existing bridge, renderer generation, binding id and owner/session
lease must already exist. A new activity/WebView, cold start, owner change, reset,
unbind or disposal clears authority; no pending gesture is promoted at first bind.
The first cold Power entry remains surface-only: use the existing Talk action or a
later warm Power invocation. Cold one-gesture voice is not fulfilled by this API.

The typed controller treats a matching fresh Power receipt as one-shot, just like
an authenticated listener receipt. If hidden, modal, not ready or already recording,
it calls the optional owner-bound `discardProtectedPowerInvocation` bridge method.
Native foreground refusal also discards only that matching pending Power receipt,
so later focus cannot revive it. That method can clear only the current lease's pending Power origin, never create
an origin, clear another binding, reset a session or discard listener delivery.
Actual OS caller permission enforcement, hardware dispatch and speech require
separate native/device qualification.

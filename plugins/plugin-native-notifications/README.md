# Notification mirror (Android)

An opt-in mirror of other apps' active notifications for an Eliza phone host. Android grants
notification-listener access; the owner separately enables the mirror, chooses at most 20
launcher apps (each pinned to its signing certificate), chooses per app whether previews are
shown, and may opt into a 24-hour history of post/remove events encrypted with an Android
Keystore AES-GCM key. Notification text, PendingIntents and foreign notification keys are never
persisted, and this module forwards nothing off the device or to an agent.

## Host integration

Include `android/` as a library module. Create one `NotificationMirror` for the process with an
immutable `NotificationMirrorConfig`:

- `preferencesName`: SharedPreferences file for the owner policy and pause state.
- `historyKeyAlias`: Android Keystore alias, also the AES-GCM associated data.
- `historyFileName`: no-backup file holding the encrypted history.
- `listener`: the host's concrete `NotificationMirrorListenerService` subclass.

These names are migration-sensitive. A host adopting this module keeps the values it already
used so installed owners keep their policy and history meaning.

Extend `NotificationMirrorListenerService`, return the shared mirror from `mirror()`, and declare
the subclass in the host manifest (exported, `android:permission="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE"`,
`android.service.notification.NotificationListenerService` intent filter). The host's own bridge
(Capacitor or otherwise) calls `status`, `apps`, `update`, `pause`, `list`, `action`, `history`,
`clearHistoryBoundary` and `redact` from foreground, owner-initiated UI only, and calls `redact()`
when its UI pauses.

## Semantics

- `update` requires the policy revision the owner reviewed and purges history and row identities
  before acknowledging a new policy. Selecting a changed app (signature mismatch) is refused until
  the owner removes and selects it again.
- Rows come only from another package for the same Android user, from that package's own uid,
  with a still-matching pinned signature. A locked device, disabled or paused policy, revoked
  access, screen off returns no rows. A full callback queue invalidates row identities.
- `action(open)` sends only a content intent created by the posting app's uid and never for a
  secret notification; `action(dismiss)` cancels only a clearable row.
- More than 100 active selected notifications is an explicit refusal; the library never returns a partial active list.
- History keeps label, time and state for still-selected apps, at most 100 events for 24 hours.

## Tests

`node --test test/native-host/policy.node.mjs` runs the framework-free policy tests on a JDK.
The repository Turbo task forwards the SDK and JDK locations and reruns this native
compile check without cache because the installed toolchains live outside the workspace.
`test/native-host/android-compile.node.mjs` compiles every Android source against the SDK
`android.jar`. This check requires `ANDROID_HOME` or `ANDROID_SDK_ROOT` with an API 33+ platform; a missing SDK is an error.

`test/android-consumer` builds a host and two synthetic notification producers.
Build `:host:assembleDebug`, `:host:assembleDebugAndroidTest`,
`:fixture:assembleSelectedDebug` and `:fixture:assembleExcludedDebug` with Gradle 8.13,
Java 21 and Android SDK 36. Install them only on a disposable API 35 emulator;
grant `POST_NOTIFICATIONS` to both fixture packages. Run the host instrumentation
with `-e disposableMirrorFixture 1`. Synthetic preview markers use letters so Android 15 does not mistake test UUID
digits for a one-time code. Android can still redact real sensitive previews.
The test grants and revokes access for its own listener, posts synthetic notifications, verifies redaction and encrypted history,
and dismisses one exact row. Uninstall all four APKs afterward. This does not
certify physical-device behavior or a product's foreground policy.

## Host notification receipts

`NoticeDelivery` is a native-only ledger for the host's own notifications. It does
not read other apps' notifications. Supply durable `Storage`, a `Poster` backed
by the host's notification channels, and `Config` with the existing receipt slot
names, redacted approval text and maximum approval lifetime. Keep these inputs
stable across upgrades. Storage must commit before returning; all callers in one
process share a lock. Cross-process writers need external serialization.

A new notice records intent before posting. Repeated calls check the retained
binding and content digest and never post again, including after dismissal or an
uncertain result. `receipt` may resolve uncertainty from an exact active notice.
Permission denial is retained as failure. This is not exactly-once delivery:
process loss between intent and dispatch can leave a notice permanently unknown.
Approval IDs have the form `approval-` plus 64 lowercase hex characters. Call `withdrawApproval(id, now)` before dropping a decided approval route, even
if no notice was published. A withdrawal before publish stores an opaque-ID receipt
for the configured maximum approval lifetime; it needs no missing binding or content.
A known receipt retains its original expiry. Both forms prevent delayed publication. Expiry removes approval receipts. Step receipts are bounded at 512
and approval receipts at 256; reaching capacity refuses new entries.

`NoticeDeliveryTest` in the Android consumer exercises actual NotificationManager
posting, dismissal, receipt reopening, digest mismatch, approval withdrawal and
expiry. Grant the host `POST_NOTIFICATIONS` in its disposable test user and run
that class with `-e disposableMirrorFixture 1`. It uses synthetic data and removes
its channels, notifications and preference file. Reopening a ledger in this test
is not process-death or product integration acceptance.

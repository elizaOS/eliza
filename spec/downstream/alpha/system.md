# Alpha native system contracts

Alpha commit `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` pins Eliza
`c518127a025ab173874af9c7d304f26b25213b0d`. Its
`android/consumer-host.json` admits `eliza-system` from
`plugins/plugin-native-system/android`. `MainActivity` registers
`AlphaSystemPlugin`, `AlphaResetPlugin`, `AlphaDevicePlugin` and
`ElizaSense`. The Android Settings routes, native reset and problem log
are release routes. Android shade dispatch is launcher only. The browser
shade stand-in requires the development surfaces flag. The release
`externalVoiceInvocationEnabled` flag is false. App startup asks the
installed listener to turn off, and the optional external voice controller
stays dormant. The [Alpha inventory](../alphaBaseline.json) records
the pinned source identities.

## Story: Review and erase Alpha's installed data safely

### A confirmed reset keeps old startup fenced until Android clears the app

Alpha Settings requests the native `review()` bridge. Only one review
can be open. Native disclosure and a fresh successful Android device
credential challenge must belong to that review and the same live
Activity. Cancellation, Activity destruction, an obsolete callback or
missing device authentication cannot create a reset marker. The renderer
accepts cancelled or unavailable with a nonblank message of at most
500 characters. A rejected or malformed bridge response is unavailable.
A renderer result never proves deletion.

The installed marker `reset-alpha.pending` and attempt file
`reset-alpha.failures` live in device-protected no-backup storage.
Alpha can reject before creating the marker when a trusted listener is
installed but cannot be reached. After the marker is durable, other
app startup stops before providers or background workers. The
provider-free `:reset_recovery` process can inspect the marker.
On a failed attempt, an app start in view can present recovery and a
background start cannot raise it. A reserved OPEN attempt survives a
process loss. The next automatic entry consumes its already-reserved
slot and defers before retrying. A later startup may retry within budget.
There are at most three automatic attempts per 60-second window. The person
can retry through the native recovery surface. Preserve the marker and
scope bytes when the listener has not acknowledged or Android refuses.

Alpha's bounded pre-dispatch work handles its local Calendar and
device Cloud sign-in while credentials still exist. Interactive
dispatch is scheduled once, by worker completion or an 8-second
deadline. Visible startup recovery budgets up to 4 seconds before
dispatch and background startup does not wait on the network.
Listener reset acknowledgement is required immediately before calling
Android's package and user scoped clear. Android acceptance is a
dispatch receipt. A replacement process confirms fresh storage only
from the removed marker and fresh scope. Android resets Alpha alone
and leaves other apps, device-wide files and Cloud data untouched.

The model abstracts a successful durable marker write and a serialized
attempt reservation as separate steps. It records a surviving OPEN marker
after a process exit when Android accepted but did not clear the scope. Filesystem atomicity, process
exits, parallel worker scheduling and restart visibility are adapter
obligations. The pinned Alpha reference is `ResetRecovery`.

```quint
type ResetPhase = Resting | Disclosure | Credential | Confirmed | PendingReset | AttemptOpen | Recover | Dispatched | Fresh
type ResetOutcome = ListenerMissing | AndroidRefused | AndroidAccepted
type Reset = { phase: ResetPhase, ticket: int, marker: bool, attempts: int }
pure val initial: Reset = { phase: Resting, ticket: 0, marker: false, attempts: 0 }
pure def canReviewReset(s: Reset): bool = s.phase == Resting
pure def reviewReset(s: Reset): Reset = { ...s, phase: Disclosure, ticket: s.ticket + 1 }
pure def canConfirmDisclosure(s: Reset, reviewId: int): bool = s.phase == Disclosure and reviewId == s.ticket
pure def confirmDisclosure(s: Reset, reviewId: int): Reset = { ...s, phase: Credential }
pure def canCredentialResult(s: Reset, reviewId: int, accepted: bool): bool = s.phase == Credential and reviewId == s.ticket
pure def credentialResult(s: Reset, reviewId: int, accepted: bool): Reset =
  { ...s, phase: if (accepted) Confirmed else Resting }
pure def canRetireReview(s: Reset): bool = s.phase == Disclosure or s.phase == Credential
pure def retireReview(s: Reset): Reset = { ...s, phase: Resting }
pure def canRecordMarker(s: Reset, listenerReachable: bool, markerCommitted: bool): bool = s.phase == Confirmed
pure def recordMarker(s: Reset, listenerReachable: bool, markerCommitted: bool): Reset =
  { ...s, marker: listenerReachable and markerCommitted,
    phase: if (listenerReachable and markerCommitted) PendingReset else Resting }
pure def canReserveAttempt(s: Reset, explicitRetry: bool, nextWindow: bool): bool =
  s.marker and (s.phase == PendingReset or s.phase == Recover) and
    (explicitRetry or nextWindow or s.attempts < 3)
pure def reserveAttempt(s: Reset, explicitRetry: bool, nextWindow: bool): Reset =
  { ...s, phase: AttemptOpen, attempts: if (nextWindow) 1 else s.attempts + 1, ticket: s.ticket + 1 }
pure def canCloseAttempt(s: Reset, attemptId: int, report: ResetOutcome): bool =
  s.phase == AttemptOpen and s.marker and attemptId == s.ticket
pure def closeAttempt(s: Reset, attemptId: int, report: ResetOutcome): Reset =
  { ...s, phase: if (report == AndroidAccepted) Dispatched else Recover }
pure def canRecoverInterrupted(s: Reset, markerPresent: bool): bool =
  s.marker and markerPresent and (s.phase == AttemptOpen or s.phase == Dispatched)
pure def recoverInterrupted(s: Reset, markerPresent: bool): Reset = { ...s, phase: Recover }
pure def canObserveFresh(s: Reset, markerAbsent: bool, freshScope: bool): bool = s.phase == Dispatched and markerAbsent and freshScope
pure def observeFresh(s: Reset, markerAbsent: bool, freshScope: bool): Reset =
  { ...s, phase: Fresh, marker: false, attempts: 0 }
pure def mayStartRuntime(s: Reset): bool = not(s.marker)
pure def alwaysResetFencesPending(s: Reset): bool =
  s.marker == (s.phase == PendingReset or s.phase == AttemptOpen or s.phase == Recover or s.phase == Dispatched)
pure def alwaysNonnegativeReserve(s: Reset): bool = s.attempts >= 0 and s.ticket >= 0
pure def stepDispatchRequiresReservation(before: Reset, via: str, after: Reset): bool =
  after.phase == Dispatched and before.phase != Dispatched implies via == "closeAttempt" and before.marker and before.phase == AttemptOpen
pure def stepMarkerOnlyFollowsCredential(before: Reset, via: str, after: Reset): bool =
  after.marker and not(before.marker) implies via == "recordMarker" and before.phase == Confirmed
pure def lawNoOldStartupWithMarker(s: Reset): bool = s.marker implies not(mayStartRuntime(s))
pure def lawNoUnpromptedReplayOfOpen(s: Reset, nextWindow: bool): bool =
  s.phase == AttemptOpen implies not(canReserveAttempt(s, false, nextWindow))
pure def lawStaleResetResultCannotApply(s: Reset, attemptId: int, report: ResetOutcome): bool =
  attemptId != s.ticket implies not(canCloseAttempt(s, attemptId, report))
pure def sometimesResetRecovery(s: Reset): bool = s.phase == Recover and s.marker
pure def sometimesFreshAfterDispatch(s: Reset): bool = s.phase == Fresh and not(s.marker)
pure val reviewIdValues = Set(1, 2, 3, 4)
pure val attemptIdValues = Set(2, 3, 4, 5, 6)
pure val weight_confirmDisclosure = 6
pure val weight_credentialResult = 6
pure val weight_recordMarker = 6
pure val weight_reserveAttempt = 6
pure val weight_closeAttempt = 6
pure val weight_observeFresh = 6
```

## Story: See why Alpha failed without exposing personal data

### Problem entries are projected through the native and renderer allowlists

The main application process installs the native log and delegates to
the previous uncaught handler. Alpha's `AlphaDevice` bridge routes reads,
renderer failure records and clear through a serialized diagnostics worker.
A retired worker rejects unavailable. Native records include uncaught
class and root class, safe process suffix and main/background thread;
renderer records include a supported kind and plain class; exit records
include an Android reason and safe process label. Input, display and
export pass allowlists. Messages, stacks, URLs, component trees and user
content have no output fields. At most 50 entries are retained for
30 days. The native file read cap is 256 KiB. The renderer accepts usable
timestamps up to 30 days ahead under its pinned clock policy and
normalizes Java and JavaScript class names. It suppresses matching
renderer kind/class repeats within a minute of the last record.
Alpha also permits a finite v1 Cloud inference diagnostic vocabulary,
stored locally by the renderer. It admits known categories and bounded
counts, with future skew of at most 60 seconds.

Native clear removes journal rows and keeps the last exit cursor so an
old Android exit does not reappear. Alpha clear success also needs
the browser copy write, while preserving the last seen inference time.
An unavailable read in Settings is distinct from an observed empty log.
The reference `NativeCrashJournal` models native append, exit ingest,
redaction, restart and clear. This specification establishes field
observation and retention policy. Actual journal encoding, ordering,
exit history APIs and clear durability require the native fixtures.

```quint
type CrashEntrySource = RendererFailure | NativeUncaught | AndroidExit | AlphaInference | UnknownEntry
type CrashViewField = Timestamp | Source | Kind | FailureClass | RootClass | ExitReason | ProcessLabel | Thread | InferenceFacts | Message | Stack | Address | UserContent
pure def crashFieldAllowed(sourceKind: CrashEntrySource, viewField: CrashViewField): bool =
  sourceKind != UnknownEntry and (viewField == Timestamp or viewField == Source or
    (sourceKind == RendererFailure and (viewField == Kind or viewField == FailureClass or viewField == ProcessLabel)) or
    (sourceKind == NativeUncaught and (viewField == FailureClass or viewField == RootClass or viewField == ProcessLabel or viewField == Thread)) or
    (sourceKind == AndroidExit and (viewField == ExitReason or viewField == ProcessLabel)) or
    (sourceKind == AlphaInference and viewField == InferenceFacts))
pure def crashRetain(at: int, now: int, sourceKind: CrashEntrySource): bool =
  sourceKind != UnknownEntry and at > now - 2592000000 and at <= now + (if (sourceKind == AlphaInference) 60000 else 2592000000)
pure def crashClearAccepted(nativeBuild: bool, clearedNative: bool, clearedLocal: bool): bool =
  clearedLocal and (not(nativeBuild) or clearedNative)
pure def lawNoCrashContent(sourceKind: CrashEntrySource, viewField: CrashViewField): bool =
  (viewField == Message or viewField == Stack or viewField == Address or viewField == UserContent) implies not(crashFieldAllowed(sourceKind, viewField))
pure def lawOldCrashIsExcluded(at: int, now: int, sourceKind: CrashEntrySource): bool =
  at <= now - 2592000000 implies not(crashRetain(at, now, sourceKind))
pure def lawNativeClearRequiresBoth(clearedNative: bool, clearedLocal: bool): bool =
  crashClearAccepted(true, clearedNative, clearedLocal) implies clearedNative and clearedLocal
```

## Story: Open the actual Android surface and see what Android reports

### Android Settings and shade hand off without claiming a completed system change

Settings validates exact page names. The shared list is accounts, wifi,
bluetooth, mobile, airplane, location, display, sound, battery, about,
developer, notifications, privacy, default-apps and dnd. The host owns
a separate explicit system Settings home. Specific launch succeeds
before any fallback. Only mobile, airplane and dnd may try their
allowlisted broader page when the first fails. Notification Settings
carries Alpha's package extra and privacy uses Alpha's package URI.
The launcher opens specific page handoffs in a separate Android task.
The host serializes slider handoffs and suppresses repeated events inside
a two-second window. A rejected launch
has no opened receipt. A successful launch identifies the page and
whether the actual destination was specific. Existing role and switch
labels never infer off or absence from a missing read. Browser settings
simulators cannot grant native system permission.

An eligible empty Home pull starts at or below 44 canvas pixels, with
no edit, keyboard, scroll offset, app, drawer, lock, assistant or
expanded chat or voice. Downward motion strictly exceeds 46 pixels and
one and a half times its horizontal magnitude. This rule complements
[Alpha shell gesture arbitration](./navigation.md). The launcher can
also ask through its visible native control. The native side rechecks a
present Activity and its focus on the UI thread. A standalone build
does not ask. The renderer waits five seconds for a response and ignores
a late reply. A launcher needs EXPAND_STATUS_BAR, then Android's native
status bar service must accept the call. Opened is dispatch acceptance
and every refusal renders the fallback. The development simulation
never substitutes for the Android shade in a native build.

```quint
type SettingsPage = SystemHome | Accounts | Wifi | Bluetooth | Mobile | Airplane | Location | Display | Sound | Battery | About | Developer | AppNotifications | AppPrivacy | DefaultApps | Dnd | UnsupportedPage
type SettingsReply = SpecificPage | BroaderPage | UnavailablePage
pure def allowsBroader(page: SettingsPage): bool = page == Mobile or page == Airplane or page == Dnd
pure def settingsHandoff(page: SettingsPage, primaryStarted: bool, fallbackStarted: bool): SettingsReply =
  if (page == UnsupportedPage) UnavailablePage else if (primaryStarted) SpecificPage
  else if (allowsBroader(page) and fallbackStarted) BroaderPage else UnavailablePage
type ShadeDispatch = NotInFront | Standalone | PermissionMissing | ShadeUnsupported | ShadeOpened
pure def shadeDispatch(focused: bool, launcherBuild: bool, hasPermission: bool, androidAccepted: bool): ShadeDispatch =
  if (not(focused)) NotInFront else if (not(launcherBuild)) Standalone else if (not(hasPermission)) PermissionMissing
  else if (androidAccepted) ShadeOpened else ShadeUnsupported
pure def lawBroaderOnlyAfterSpecificFailure(page: SettingsPage, primaryStarted: bool, fallbackStarted: bool): bool =
  settingsHandoff(page, primaryStarted, fallbackStarted) == BroaderPage implies allowsBroader(page) and not(primaryStarted) and fallbackStarted
pure def lawShadeOnlyReportsAccepted(focused: bool, launcherBuild: bool, hasPermission: bool, androidAccepted: bool): bool =
  shadeDispatch(focused, launcherBuild, hasPermission, androidAccepted) == ShadeOpened implies
    focused and launcherBuild and hasPermission and androidAccepted
```

## Story: Keep native wake listening off in Alpha and honor the bridge contract if enabled

### Listener evidence and assistant entry authority are separate

The released Alpha app keeps external voice entry disabled and requests
`turnOff` at Android startup. Only an available OFF response with both
listening and microphoneOpen false confirms it. Bridge absence, timeout,
malformed status and incomplete acknowledgement leave a visible
unconfirmed stop. The bridge can read status, pause, turn off and hand
off to the installed listener's own settings. It cannot enable or
resume capture. The trusted native package must match its signer and
control permission. An enabled exported settings activity must belong
to that package and UID. The quick settings service in the main
manifest is disabled.

If the optional wake entry policy is enabled, Android supplies caller
identity. Recognized origins are a verified listener, platform-signed
SystemUI with identity published, or a permission-protected warm
Power entry. Other callers merely open the assistant. Warm arrivals
have a five-second window. A cold trusted listener or SystemUI arrival
can be held for up to 15 seconds when native startup admitted the same
nonsecret owner as the later authenticated session. Cold Power is
refused. Lock at arrival or consumption, background, changed scope,
obsoleted native bridge or renderer generation, unavailable voice
controller and an already consumed wake refuse a voice start.
The optional renderer controller serializes operations with a
ten-second bridge deadline and cannot use a timed-out callback to
replace a current session. The native bridge binds an opaque digest,
and the host rechecks foreground and conversation readiness before
starting its voice controller. This rule checks normalized authority
evidence. Android signer, callbacks, actual clock reads and microphone
state remain platform observations.

```quint
type WakeOrigin = VerifiedListener | VerifiedSystem | ProtectedPower | OrdinaryAssist
type WakeEvidence = { policyOn: bool, currentBinder: bool, freshScope: bool, unlocked: bool, inFront: bool, ready: bool, unused: bool, cold: bool, matchedNativeOwner: bool, age: int }
pure val wakeValues = Set(
  { policyOn: false, currentBinder: true, freshScope: true, unlocked: true, inFront: true, ready: true, unused: true, cold: false, matchedNativeOwner: true, age: 100 },
  { policyOn: true, currentBinder: true, freshScope: true, unlocked: true, inFront: true, ready: true, unused: true, cold: true, matchedNativeOwner: true, age: 15000 },
  { policyOn: true, currentBinder: false, freshScope: false, unlocked: false, inFront: false, ready: false, unused: false, cold: true, matchedNativeOwner: false, age: 15001 }
)
pure def voiceAuthorized(origin: WakeOrigin, wake: WakeEvidence): bool =
  wake.policyOn and wake.currentBinder and wake.freshScope and wake.unlocked and wake.inFront and wake.ready and wake.unused and
    origin != OrdinaryAssist and wake.age >= 0 and
    (if (wake.cold) origin != ProtectedPower and wake.matchedNativeOwner and wake.age <= 15000 else wake.age <= 5000)
pure def listenerStopped(available: bool, reportedOff: bool, listening: bool, microphoneOpen: bool): bool =
  available and reportedOff and not(listening or microphoneOpen)
pure def lawNoNativeWakeWhenPolicyOff(origin: WakeOrigin, wake: WakeEvidence): bool =
  not(wake.policyOn) implies not(voiceAuthorized(origin, wake))
pure def lawColdWakeNeedsNativeOwner(origin: WakeOrigin, wake: WakeEvidence): bool =
  wake.cold and voiceAuthorized(origin, wake) implies wake.matchedNativeOwner and origin != ProtectedPower
pure def lawNoStopClaimWithOpenMicrophone(available: bool, reportedOff: bool, listening: bool): bool =
  not(listenerStopped(available, reportedOff, listening, true))
```

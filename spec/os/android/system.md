# Native system contracts

A consumer's host descriptor admits `eliza-system` from
`plugins/plugin-native-system/android` ([bridge composition](./bridge.md)),
and its `MainActivity` registers the system, reset and device plugins. The
Android Settings routes, native reset and problem log ship in release
builds; Android shade dispatch only in builds that manage the device.
[Voice wake](../voice/wake.md) owns the wake listener's entry, status and
the stop the system bridge requests at startup.

## Story: Review and erase the app's installed data safely

> As the person, I want to erase the app's data on this device only after
> I reviewed it and proved it is me, so that a reset is never accidental
> and never half done.

### A confirmed reset keeps old startup fenced until Android clears the app

Settings requests the native `review()` bridge. Only one review
can be open. Native disclosure and a fresh successful Android device
credential challenge must belong to that review and the same live
Activity. Cancellation, Activity destruction, an obsolete callback or
missing device authentication cannot create a reset marker. The renderer
accepts cancelled or unavailable with a nonblank message of at most
500 characters. A rejected or malformed bridge response is unavailable.
A renderer result never proves deletion.

The reset marker and attempt file live in device-protected no-backup
storage. The app can reject before
creating the marker when a trusted listener is
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

Bounded pre-dispatch cleanup runs while credentials still exist, and
background startup never waits on the network for it. Listener reset
acknowledgement is required immediately before calling
Android's package and user scoped clear. Android acceptance is a
dispatch receipt. A replacement process confirms fresh storage only
from the removed marker and fresh scope. Android resets the app alone
and leaves other apps, device-wide files and Cloud data untouched.

The model takes the durable marker write and the serialized attempt
reservation as separate steps, and records a surviving OPEN marker after a
process exit when Android accepted but did not clear the scope. Filesystem
atomicity, process exits and restart visibility are adapter obligations.

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
```

## Story: See why the app failed without exposing personal data

> As the person, I want to see why the app failed without the log
> exposing anything I said or stored, so that I can share it safely.

### Problem entries are projected through the native and renderer allowlists

The main application process installs the native log and delegates to
the previous uncaught handler. The device bridge routes reads,
renderer failure records and clear through a serialized diagnostics worker.
A retired worker rejects unavailable. Native records include uncaught
class and root class, safe process suffix and main/background thread;
renderer records include a supported kind and plain class; exit records
include an Android reason and safe process label. Input, display and
export pass allowlists. Messages, stacks, URLs, component trees and user
content have no output fields. At most 50 entries are retained for
30 days. The native file read cap is 256 KiB. The renderer accepts usable
timestamps up to 30 days ahead and
normalizes Java and JavaScript class names. It suppresses matching
renderer kind/class repeats within a minute of the last record.
A consumer may also permit a finite v1 Cloud inference diagnostic vocabulary,
stored locally by the renderer. It admits known categories and bounded
counts, with future skew of at most 60 seconds.

Native clear removes journal rows and keeps the last exit cursor so an
old Android exit does not reappear. Clear success also needs
the browser copy write, while preserving the last seen inference time.
An unavailable read in Settings is distinct from an observed empty log.
Journal encoding, ordering, exit history and clear durability are
adapter obligations.

```quint
type CrashEntrySource = RendererFailure | NativeUncaught | AndroidExit | CloudInference | UnknownEntry
type CrashViewField = Timestamp | Source | Kind | FailureClass | RootClass | ExitReason | ProcessLabel | Thread | InferenceFacts | Message | Stack | Address | UserContent
pure def crashFieldAllowed(sourceKind: CrashEntrySource, viewField: CrashViewField): bool =
  sourceKind != UnknownEntry and (viewField == Timestamp or viewField == Source or
    (sourceKind == RendererFailure and (viewField == Kind or viewField == FailureClass or viewField == ProcessLabel)) or
    (sourceKind == NativeUncaught and (viewField == FailureClass or viewField == RootClass or viewField == ProcessLabel or viewField == Thread)) or
    (sourceKind == AndroidExit and (viewField == ExitReason or viewField == ProcessLabel)) or
    (sourceKind == CloudInference and viewField == InferenceFacts))
pure def crashRetain(at: int, now: int, sourceKind: CrashEntrySource): bool =
  sourceKind != UnknownEntry and at > now - 2592000000 and at <= now + (if (sourceKind == CloudInference) 60000 else 2592000000)
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

> As the person, I want a settings shortcut to open the real Android
> screen and show only what Android reports, so that the app never claims
> a system change it did not see.

### Android Settings and shade hand off without claiming a completed system change

Settings validates exact page names. The shared list is accounts, wifi,
bluetooth, mobile, airplane, location, display, sound, battery, about,
developer, notifications, privacy, default-apps and dnd. The host owns
a separate explicit system Settings home. Specific launch succeeds
before any fallback. Only mobile, airplane and dnd may try their
allowlisted broader page when the first fails. Notification Settings
carries the app's package extra and privacy uses the app's package URI.
A device-managing build opens specific page handoffs in a separate Android task.
The host serializes slider handoffs and suppresses repeated events inside
a two-second window. A rejected launch has no opened receipt; a successful
one identifies the page and whether it was the specific destination. A
missing read never shows a role or switch as off or absent.

Opening the Android shade rechecks a present, focused Activity on the UI
thread; a build that does not manage the device never asks. It needs
EXPAND_STATUS_BAR, and then Android's status bar service must accept the
call. Opened means only that Android accepted the dispatch, and every
refusal shows the fallback.

```quint
type SettingsPage = SystemHome | Accounts | Wifi | Bluetooth | Mobile | Airplane | Location | Display | Sound | Battery | About | Developer | AppNotifications | AppPrivacy | DefaultApps | Dnd | UnsupportedPage
type SettingsReply = SpecificPage | BroaderPage | UnavailablePage
pure def allowsBroader(page: SettingsPage): bool = page == Mobile or page == Airplane or page == Dnd
pure def settingsHandoff(page: SettingsPage, primaryStarted: bool, fallbackStarted: bool): SettingsReply =
  if (page == UnsupportedPage) UnavailablePage else if (primaryStarted) SpecificPage
  else if (allowsBroader(page) and fallbackStarted) BroaderPage else UnavailablePage
type ShadeDispatch = NotInFront | Standalone | PermissionMissing | ShadeUnsupported | ShadeOpened
pure def shadeDispatch(focused: bool, managesDevice: bool, hasPermission: bool, androidAccepted: bool): ShadeDispatch =
  if (not(focused)) NotInFront else if (not(managesDevice)) Standalone else if (not(hasPermission)) PermissionMissing
  else if (androidAccepted) ShadeOpened else ShadeUnsupported
pure def lawBroaderOnlyAfterSpecificFailure(page: SettingsPage, primaryStarted: bool, fallbackStarted: bool): bool =
  settingsHandoff(page, primaryStarted, fallbackStarted) == BroaderPage implies allowsBroader(page) and not(primaryStarted) and fallbackStarted
pure def lawShadeOnlyReportsAccepted(focused: bool, managesDevice: bool, hasPermission: bool, androidAccepted: bool): bool =
  shadeDispatch(focused, managesDevice, hasPermission, androidAccepted) == ShadeOpened implies
    focused and managesDevice and hasPermission and androidAccepted
```

### System facts are reported only as Android answered them

The system bridge reads the Wi-Fi, Bluetooth, airplane, location and
mobile data switches, the interruption filter, adaptive brightness, the
active transport and Internet validation, and battery level, charging
and power saving, with no permission the app does not hold. Each fact is
added only when Android answers; a missing or unrecognized value means
unknown, never off. The Wi-Fi switch reads on for 1 and 2 (kept on in
airplane mode) and off for 0 and 3; a Bluetooth adapter turning on or off
is unknown. Nothing here changes a setting: a settings surface shows the
fact and hands off to Android's own page.

```quint
type SwitchFact = FactOn | FactOff | FactUnknown
pure def wifiSwitchFact(reading: int): SwitchFact =
  if (reading == 1 or reading == 2) FactOn else if (reading == 0 or reading == 3) FactOff else FactUnknown
pure def binarySwitchFact(reading: int): SwitchFact = if (reading == 1) FactOn else if (reading == 0) FactOff else FactUnknown
pure def lawUnrecognizedSwitchIsUnknown(reading: int): bool =
  (reading < 0 or reading > 3) implies wifiSwitchFact(reading) == FactUnknown and binarySwitchFact(reading) == FactUnknown
pure def lawOffNeedsAnOffReading(reading: int): bool =
  (wifiSwitchFact(reading) == FactOff implies reading == 0 or reading == 3) and (binarySwitchFact(reading) == FactOff implies reading == 0)
```

### App info opens Android's own details page for exactly the entry the person chose

App info for a launcher entry first checks the entry: another app's
package with a well-formed activity, and a profile serial that names a
profile other than the current one. A malformed entry, or a serial of the
current profile, refuses before any lookup. A personal-profile entry
looks the package up including disabled apps and opens Android's app
details settings for that package in a new task. A work-profile entry
needs the profile still present (running, paused or locked) and opens
that profile's details for the chosen component. A removed app answers
not installed, a removed profile unavailable, and a refused read failed,
each without a launch. Resolved means Android started the page; a refused
launch keeps its attempt and answers invalid or failed.

```quint
type AppEntryKind = PersonalEntry | WorkEntry | MalformedEntry | CurrentProfileSerial
type ProfilePresence = ProfileVisible | ProfileGone | ProfileReadRefused
type AppPresence = AppInstalled | AppRemoved | AppReadRefused
type InfoLaunch = InfoLaunchAllowed | InfoLaunchInvalid | InfoLaunchFailed
type AppInfoReply = InfoInvalid | InfoProfileUnavailable | InfoFailed | InfoNotInstalled | InfoResolved
type AppInfoHandoff = { infoReply: AppInfoReply, lookedUp: bool, launched: bool, detailsPage: bool, newTask: bool }
pure def appInfoHandoff(entry: AppEntryKind, profile: ProfilePresence, app: AppPresence, launch: InfoLaunch): AppInfoHandoff = {
  val refused = { infoReply: InfoInvalid, lookedUp: false, launched: false, detailsPage: false, newTask: false }
  val personal = entry == PersonalEntry
  val looked = { ...refused, lookedUp: true }
  if (entry == MalformedEntry) refused
  else if (entry == CurrentProfileSerial) { ...refused, infoReply: InfoProfileUnavailable }
  else if (not(personal) and profile == ProfileReadRefused) { ...refused, infoReply: InfoFailed }
  else if (not(personal) and profile == ProfileGone) { ...refused, infoReply: InfoProfileUnavailable }
  else if (app == AppRemoved) { ...looked, infoReply: InfoNotInstalled }
  else if (app == AppReadRefused) { ...looked, infoReply: InfoFailed }
  else { ...looked, launched: true, detailsPage: personal, newTask: personal,
    infoReply: if (launch == InfoLaunchAllowed) InfoResolved else if (launch == InfoLaunchInvalid) InfoInvalid else InfoFailed }
}
pure def lawNoLaunchWithoutAnInstalledApp(entry: AppEntryKind, profile: ProfilePresence, app: AppPresence, launch: InfoLaunch): bool =
  (appInfoHandoff(entry, profile, app, launch).infoReply == InfoNotInstalled or appInfoHandoff(entry, profile, app, launch).infoReply == InfoProfileUnavailable)
    implies not(appInfoHandoff(entry, profile, app, launch).launched)
pure def lawRefusedEntryNeverLooksUp(profile: ProfilePresence, app: AppPresence, launch: InfoLaunch): bool =
  not(appInfoHandoff(MalformedEntry, profile, app, launch).lookedUp) and not(appInfoHandoff(CurrentProfileSerial, profile, app, launch).lookedUp)
pure def lawResolvedMeansStarted(entry: AppEntryKind, profile: ProfilePresence, app: AppPresence, launch: InfoLaunch): bool =
  appInfoHandoff(entry, profile, app, launch).infoReply == InfoResolved implies appInfoHandoff(entry, profile, app, launch).launched and launch == InfoLaunchAllowed
pure def lawWorkEntryNeverOpensPersonalDetails(profile: ProfilePresence, app: AppPresence, launch: InfoLaunch): bool =
  not(appInfoHandoff(WorkEntry, profile, app, launch).detailsPage)
```

### The assistant entry tile is an action that opens the entry only after the owner unlocks

A host's Quick Settings tile opens its assistant entry. It is never a
toggle: it always reports inactive, so it never implies that an agent,
inference, a connection or the microphone is active. A tap on a locked
device asks Android to unlock and opens the entry only after the owner
unlocks; no tap grants a permission, starts capture or carries data into
the app. Only the system interface can bind the tile, and a host keeps its
installed component name across updates.

```quint
type TileTap = TileOpensEntry | TileAwaitsUnlock
type TileReport = { tileActive: bool, opened: bool, capture: bool, grant: bool }
pure def tileTap(locked: bool, ownerUnlocked: bool): TileReport =
  { tileActive: false, opened: not(locked) or ownerUnlocked, capture: false, grant: false }
pure def tileTapKind(locked: bool): TileTap = if (locked) TileAwaitsUnlock else TileOpensEntry
pure def lawTileNeverReportsActive(locked: bool, ownerUnlocked: bool): bool =
  not(tileTap(locked, ownerUnlocked).tileActive) and not(tileTap(locked, ownerUnlocked).capture) and not(tileTap(locked, ownerUnlocked).grant)
pure def lawLockedTapOpensOnlyAfterUnlock(ownerUnlocked: bool): bool =
  tileTap(true, ownerUnlocked).opened implies ownerUnlocked
```

## Story: Hand an alarm to the system clock and know only what it received

> As the person, I want the assistant to set, show, snooze or dismiss an
> alarm by opening my phone's clock with the request filled in, so that
> the clock shows its own review and nothing claims an alarm changed that
> I did not see.

### A clock handoff opens the system clock with one reviewed request and never reports an alarm change

A handoff is set, show, dismiss or snooze; anything else is refused. Set
needs an hour of 0 to 23, a minute of 0 to 59 and a label of at most 200
characters with no control characters, and may carry repeat days: one to
seven distinct days, each 1 (Sunday) to 7 (Saturday), in ascending order,
or none for a one-time alarm; days are refused for any other action. Show
and dismiss carry no options; snooze carries only 1 to 60 minutes. No
request targets all alarms or a deep-linked alarm, and the clock always
shows its own review. A handoff starts only after the owner reviewed it,
with the host focused and the phone unlocked, and a set that named a time
zone fails when the phone's zone changed since. The receiving activity is
resolved and bound explicitly, and the host itself never receives it.
Opened means only that the clock received the request; the outcome is
opened, unavailable, denied, failed or unknown, and is never reported as
an applied alarm change.

```quint
type ClockRequestKind = ClockSet | ClockShow | ClockDismiss | ClockSnooze | ClockOther
type ClockLaunch = ClockStarted | ClockNotFound | ClockSecurityRefused | ClockStartFailed
type ClockOutcome = ClockOpened | ClockUnavailable | ClockDenied | ClockFailed | ClockUnknown
type ClockRequest = { clockKind: ClockRequestKind, hour: int, minute: int, labelLength: int, labelPlain: bool, snoozeMinutes: int, dayCount: int, daysAscendingInRange: bool }
pure def clockRequestAdmitted(q: ClockRequest): bool =
  if (q.clockKind == ClockSet)
    q.hour >= 0 and q.hour <= 23 and q.minute >= 0 and q.minute <= 59 and q.labelLength >= 0 and q.labelLength <= 200 and q.labelPlain and
    q.snoozeMinutes == 0 and (q.dayCount == 0 or (q.dayCount >= 1 and q.dayCount <= 7 and q.daysAscendingInRange))
  else if (q.clockKind == ClockSnooze) q.dayCount == 0 and q.snoozeMinutes >= 1 and q.snoozeMinutes <= 60
  else if (q.clockKind == ClockShow or q.clockKind == ClockDismiss) q.dayCount == 0 and q.snoozeMinutes == 0
  else false
pure def clockHandoff(reviewed: bool, admitted: bool, focusedUnlocked: bool, zoneUnchanged: bool, otherReceiver: bool, launch: ClockLaunch): ClockOutcome =
  if (not(reviewed and admitted and focusedUnlocked)) ClockFailed
  else if (not(otherReceiver)) ClockUnavailable
  else if (not(zoneUnchanged)) ClockFailed
  else if (launch == ClockStarted) ClockOpened
  else if (launch == ClockNotFound) ClockUnavailable
  else if (launch == ClockSecurityRefused) ClockDenied
  else ClockUnknown
pure def handoffReportsAppliedChange(clockOutcome: ClockOutcome): bool = false
pure val setRequest: ClockRequest = { clockKind: ClockSet, hour: 7, minute: 30, labelLength: 5, labelPlain: true, snoozeMinutes: 0, dayCount: 0, daysAscendingInRange: true }
pure val qValues = Set(setRequest, { ...setRequest, hour: 24 }, { ...setRequest, dayCount: 8 }, { ...setRequest, dayCount: 2, daysAscendingInRange: false },
  { ...setRequest, clockKind: ClockSnooze, snoozeMinutes: 10 }, { ...setRequest, clockKind: ClockSnooze, snoozeMinutes: 61 },
  { ...setRequest, clockKind: ClockDismiss, dayCount: 1 }, { ...setRequest, clockKind: ClockOther }, { ...setRequest, labelLength: 201 })
pure def lawDaysOnlyForANewAlarm(q: ClockRequest): bool = (clockRequestAdmitted(q) and q.dayCount > 0) implies q.clockKind == ClockSet
pure def lawOpenedNeedsReviewAndAnotherReceiver(reviewed: bool, admitted: bool, focusedUnlocked: bool, zoneUnchanged: bool, otherReceiver: bool, launch: ClockLaunch): bool =
  clockHandoff(reviewed, admitted, focusedUnlocked, zoneUnchanged, otherReceiver, launch) == ClockOpened implies
    reviewed and admitted and focusedUnlocked and zoneUnchanged and otherReceiver and launch == ClockStarted
pure def lawHandoffIsNeverAnAlarmReceipt(clockOutcome: ClockOutcome): bool = not(handoffReportsAppliedChange(clockOutcome))
```

### A booted image's clock is verified only against the exact image and user

The system clock every image keeps is checked on a booted device for an
explicit Android user and an exact expected image fingerprint: the clock
package is installed and enabled for that user, and each of the set,
show, snooze and dismiss alarm intents resolves to it. Handler
availability is not evidence that an alarm rings.

```quint
type ClockImageEvidence = { handlersVerified: bool, ringingVerified: bool }
pure def clockImageEvidence(explicitUser: bool, fingerprintMatches: bool, clockEnabled: bool, handlersResolved: int): ClockImageEvidence =
  { handlersVerified: explicitUser and fingerprintMatches and clockEnabled and handlersResolved == 4, ringingVerified: false }
pure val handlersResolvedValues = Set(0, 3, 4)
pure def lawClockCheckNeedsTheExactImage(explicitUser: bool, clockEnabled: bool, handlersResolved: int): bool =
  not(clockImageEvidence(explicitUser, false, clockEnabled, handlersResolved).handlersVerified)
pure def lawHandlersNeverProveRinging(explicitUser: bool, fingerprintMatches: bool, clockEnabled: bool, handlersResolved: int): bool =
  not(clockImageEvidence(explicitUser, fingerprintMatches, clockEnabled, handlersResolved).ringingVerified)
```

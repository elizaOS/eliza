# Android system surfaces

What the system and location bridges (`ElizaSystem`, `ElizaLocation`) may claim
about handoffs, device facts, volume and brightness, and default roles. A
handoff reports the [bridge](./bridge.md)'s `HandoffOutcome`: `Opened` means
Android showed its screen, never that the owner changed anything there.
[Wi-Fi](../index.md) uses the Internet panel handoff and the facts defined here.

## Story: Hand me to Android's own screens and apps

> As an owner, I want a shortcut to open Android's real screen or app, so that
> the app never claims a change I did not make there myself.

### A Settings page opens its specific page first and a broader page only where one is listed

A name outside the list is refused before Android is asked. Only mobile,
airplane, do-not-disturb and the Internet panel have a broader page (Network
and internet, priority mode, Wi-Fi settings), tried only after the specific
page failed to start. The reply says which page opened.

```quint
import bridge.* from "./bridge"
type SettingsPage = PageHome | PageAccounts | PageWifi | PageBluetooth | PageMobile | PageAirplane | PageLocation
  | PageDisplay | PageSound | PageBattery | PageAbout | PageDeveloper | PageNotifications | PagePrivacy
  | PageDefaultApps | PageDnd | PageWriteSettings | PageInternet
type PageReply = SpecificPage | BroaderPage | NoPage
pure def hasBroaderPage(page: SettingsPage): bool = page == PageMobile or page == PageAirplane or page == PageDnd or page == PageInternet
pure def pageReply(page: SettingsPage, specificStarted: bool, broaderStarted: bool): PageReply =
  if (specificStarted) SpecificPage else if (hasBroaderPage(page) and broaderStarted) BroaderPage else NoPage
pure def pageHandoff(reply: PageReply): HandoffOutcome = if (reply == NoPage) Refused else Opened
pure def lawBroaderPageOnlyAfterTheSpecificFailed(page: SettingsPage, specificStarted: bool, broaderStarted: bool): bool =
  pageReply(page, specificStarted, broaderStarted) == BroaderPage implies (hasBroaderPage(page) and not(specificStarted) and broaderStarted)
pure def lawPageOpensOnlyWhenAndroidStartedIt(page: SettingsPage, specificStarted: bool, broaderStarted: bool): bool =
  (pageHandoff(pageReply(page, specificStarted, broaderStarted)) == Opened) iff (specificStarted or (hasBroaderPage(page) and broaderStarted))
```

### The shade opens only from a focused launcher build that holds the status bar permission

An ordinary app never asks. A launcher build rechecks its window focus on the UI
thread and asks the status bar service, which needs `EXPAND_STATUS_BAR`; every
refusal is a reply the renderer answers with its fallback (Android's top-edge
swipe). `ShadeOpened` means Android accepted the call.

```quint
type ShadeReply = ShadeNotInFront | ShadeStandalone | ShadePermissionMissing | ShadeUnsupported | ShadeOpened
pure def shadeReply(focused: bool, launcherBuild: bool, hasPermission: bool, androidAccepted: bool): ShadeReply =
  if (not(focused)) ShadeNotInFront else if (not(launcherBuild)) ShadeStandalone
  else if (not(hasPermission)) ShadePermissionMissing else if (androidAccepted) ShadeOpened else ShadeUnsupported
pure def shadeHandoff(reply: ShadeReply): HandoffOutcome = if (reply == ShadeOpened) Opened else Refused
pure def lawShadeOpensOnlyWithEveryCondition(focused: bool, launcherBuild: bool, hasPermission: bool, androidAccepted: bool): bool =
  shadeHandoff(shadeReply(focused, launcherBuild, hasPermission, androidAccepted)) == Opened iff (focused and launcherBuild and hasPermission and androidAccepted)
```

### A default-app handoff opens one eligible app other than this one, or is refused

The dial pad and messaging handoffs carry no data. Eligible handlers are
exported, enabled activities of other enabled apps. The handoff names one
destination: Android's preferred handler when eligible, else the only eligible
handler, else Android's chooser of the eligible ones. Photos opens the gallery,
and the image viewer only when no gallery exists, never after a denial.

```quint
type DefaultApp = DialPad | Messaging | Photos
type HandlerChoice = PreferredHandler | OnlyHandler | AndroidChooser | NoHandler
type LaunchReply = LaunchStarted | LaunchNotFound | LaunchDenied | LaunchFailed
pure def chooseHandler(preferredEligible: bool, eligibleCount: int): HandlerChoice =
  if (eligibleCount <= 0) NoHandler else if (preferredEligible) PreferredHandler else if (eligibleCount == 1) OnlyHandler else AndroidChooser
pure def defaultAppHandoff(choice: HandlerChoice, launch: LaunchReply): HandoffOutcome =
  if (choice != NoHandler and launch == LaunchStarted) Opened else Refused
pure def triesImageViewer(gallery: LaunchReply): bool = gallery == LaunchNotFound
pure def photosHandoff(gallery: LaunchReply, viewer: LaunchReply): HandoffOutcome =
  if (gallery == LaunchStarted or (triesImageViewer(gallery) and viewer == LaunchStarted)) Opened else Refused
pure def lawNoHandlerIsRefused(launch: LaunchReply): bool = defaultAppHandoff(chooseHandler(false, 0), launch) == Refused
pure def lawChooserOnlyForSeveralHandlers(preferredEligible: bool, eligibleCount: int): bool =
  chooseHandler(preferredEligible, eligibleCount) == AndroidChooser implies (eligibleCount >= 2 and not(preferredEligible))
pure def lawDeniedGalleryIsNotReplaced(viewer: LaunchReply): bool = not(triesImageViewer(LaunchDenied)) and photosHandoff(LaunchDenied, viewer) == Refused
```

### App info opens Android's details page for exactly the entry the owner chose

A malformed entry, or a profile serial of the current profile, is refused
before any lookup. A personal entry opens its package's details in a new task;
a work entry needs its profile still present and opens that profile's details
for the chosen component. A removed app, a removed profile or a refused read
answers without a launch.

```quint
type AppEntry = PersonalEntry | WorkEntry | MalformedEntry | CurrentProfileSerial
type ProfilePresence = ProfileVisible | ProfileGone | ProfileReadRefused
type AppPresence = AppInstalled | AppRemoved | AppReadRefused
type DetailsPage = PersonalDetails | WorkProfileDetails | NoDetails
type AppInfoReply = InfoInvalid | InfoProfileUnavailable | InfoFailed | InfoNotInstalled | InfoOpened
pure def detailsPage(entry: AppEntry, profile: ProfilePresence, app: AppPresence): DetailsPage =
  if (entry == MalformedEntry or entry == CurrentProfileSerial or app != AppInstalled) NoDetails
  else if (entry == PersonalEntry) PersonalDetails else if (profile == ProfileVisible) WorkProfileDetails else NoDetails
pure def appInfoReply(entry: AppEntry, profile: ProfilePresence, app: AppPresence, launch: LaunchReply): AppInfoReply =
  if (entry == MalformedEntry) InfoInvalid else if (entry == CurrentProfileSerial) InfoProfileUnavailable
  else if (entry == WorkEntry and profile == ProfileReadRefused) InfoFailed
  else if (entry == WorkEntry and profile == ProfileGone) InfoProfileUnavailable
  else if (app == AppRemoved) InfoNotInstalled else if (app == AppReadRefused) InfoFailed
  else if (launch == LaunchStarted) InfoOpened else if (launch == LaunchNotFound) InfoInvalid else InfoFailed
pure def lawOpenedShowsTheChosenEntry(entry: AppEntry, profile: ProfilePresence, app: AppPresence, launch: LaunchReply): bool =
  appInfoReply(entry, profile, app, launch) == InfoOpened implies (launch == LaunchStarted and
    ((entry == PersonalEntry and detailsPage(entry, profile, app) == PersonalDetails) or (entry == WorkEntry and detailsPage(entry, profile, app) == WorkProfileDetails)))
```

### The assistant entry tile opens the entry only after the owner unlocks

The Quick Settings tile is an action, never a toggle: it always shows inactive,
and a tap grants nothing, starts no capture and carries no data. On a locked
device it asks Android to unlock first.

```quint
type TileTap = EntryOpened | EntryAwaitsUnlock
pure def tileTap(locked: bool, ownerUnlocked: bool): TileTap = if (not(locked) or ownerUnlocked) EntryOpened else EntryAwaitsUnlock
pure def lawLockedTapWaitsForUnlock(ownerUnlocked: bool): bool = (tileTap(true, ownerUnlocked) == EntryOpened) iff ownerUnlocked
```

### A clock handoff sends one reviewed request and never reports an alarm change

Set has an hour of 0 to 23, a minute of 0 to 59, a plain label of at most 200
characters and optional ascending repeat days 1 (Sunday) to 7; snooze carries 1
to 60 minutes; show and dismiss carry nothing. The request starts only after the
owner reviewed it, with the host focused and the phone unlocked, toward an
explicitly resolved clock that is not this app, and a set that named a time zone
fails when the zone changed since. The clock shows its own review.

```quint
type ClockRequest = ClockSet({ hour: int, minute: int, labelLength: int, labelPlain: bool, days: List[int] })
  | ClockShow | ClockDismiss | ClockSnooze({ minutes: int })
type ClockReply = ClockOpened | ClockUnavailable | ClockDenied | ClockFailed | ClockUnknown
pure def daysAscending(days: List[int]): bool =
  days.foldl({ previous: 0, ordered: true }, (acc, d) => { previous: d, ordered: acc.ordered and d > acc.previous and d <= 7 }).ordered
pure def clockRequestAdmitted(clockRequest: ClockRequest): bool = match clockRequest {
  | ClockSet(x) => x.hour >= 0 and x.hour <= 23 and x.minute >= 0 and x.minute <= 59 and x.labelLength >= 0 and x.labelLength <= 200 and x.labelPlain and daysAscending(x.days)
  | ClockSnooze(x) => x.minutes >= 1 and x.minutes <= 60
  | _ => true
}
pure def clockReply(reviewed: bool, clockRequest: ClockRequest, facts: HostFacts, otherReceiver: bool, zoneHolds: bool, launch: LaunchReply): ClockReply =
  if (not(reviewed and clockRequestAdmitted(clockRequest) and meetsNeed(WithFocus, facts))) ClockFailed
  else if (not(otherReceiver)) ClockUnavailable else if (not(zoneHolds)) ClockFailed
  else if (launch == LaunchStarted) ClockOpened else if (launch == LaunchNotFound) ClockUnavailable
  else if (launch == LaunchDenied) ClockDenied else ClockUnknown
pure def clockHandoff(reply: ClockReply): HandoffOutcome = if (reply == ClockOpened) Opened else Refused
pure val wakeAt = { hour: 7, minute: 30, labelLength: 5, labelPlain: true, days: List() }
pure val clockRequestValues = Set(ClockSet(wakeAt), ClockSet({ ...wakeAt, hour: 24 }), ClockSet({ ...wakeAt, days: List(2, 4, 6) }),
  ClockSet({ ...wakeAt, days: List(3, 3) }), ClockSet({ ...wakeAt, labelLength: 201 }), ClockShow, ClockSnooze({ minutes: 10 }), ClockSnooze({ minutes: 61 }))
pure val daysValues = Set(List(), List(1), List(1, 7), List(2, 2), List(0, 3), List(5, 4), List(1, 2, 3, 4, 5, 6, 7))
pure def lawClockOpensOnlyAReviewedAdmittedRequest(reviewed: bool, clockRequest: ClockRequest, facts: HostFacts, otherReceiver: bool, zoneHolds: bool, launch: LaunchReply): bool =
  clockHandoff(clockReply(reviewed, clockRequest, facts, otherReceiver, zoneHolds, launch)) == Opened implies
    (reviewed and clockRequestAdmitted(clockRequest) and facts.focused and facts.unlocked and otherReceiver and zoneHolds and launch == LaunchStarted)
pure def lawRepeatDaysAreDistinctWeekdays(days: List[int]): bool =
  daysAscending(days) implies (days.length() <= 7 and days.every(d => d >= 1 and d <= 7))
```

### Device setup opens only a listed browser or password manager, or Android's own defaults pages

Readiness only reads: the listed browsers and password managers installed, and
Android's default browser and autofill provider as Android names them, each
marked supported only when listed. Nothing changes a default. The credential
provider page falls back to Settings home.

```quint
type SetupTarget = BrowserDefaults | CredentialProviders | BrowserApp | PasswordManagerApp | SetupAppDetails
type PackageListing = ListedBrowser | ListedPasswordManager | Unlisted
type SetupReply = SetupOpened | UnsupportedBrowser | UnsupportedPasswordManager | UnsupportedPackage | SetupUnavailable
pure def setupReply(target: SetupTarget, listing: PackageListing, installed: bool, started: bool, homeStarted: bool): SetupReply =
  if (target == BrowserApp and listing != ListedBrowser) UnsupportedBrowser
  else if (target == PasswordManagerApp and listing != ListedPasswordManager) UnsupportedPasswordManager
  else if (target == SetupAppDetails and (listing == Unlisted or not(installed))) UnsupportedPackage
  else if ((target == BrowserApp or target == PasswordManagerApp) and not(installed)) SetupUnavailable
  else if (started or (target == CredentialProviders and homeStarted)) SetupOpened else SetupUnavailable
pure def lawSetupOpensOnlyListedApps(target: SetupTarget, listing: PackageListing, installed: bool, started: bool, homeStarted: bool): bool =
  setupReply(target, listing, installed, started, homeStarted) == SetupOpened implies
    ((target == BrowserApp implies (listing == ListedBrowser and installed)) and (target == PasswordManagerApp implies (listing == ListedPasswordManager and installed))
      and (target == SetupAppDetails implies (listing != Unlisted and installed)))
```

## Story: Report device facts honestly

> As an owner, I want every report to show only what Android answered, so that
> an unknown is never shown as off and nothing personal leaks.

### A fact is reported only as Android answered it, and unknown is never off

The facts are the Wi-Fi, Bluetooth, airplane, location and mobile-data
switches, the interruption filter, adaptive brightness, the active transport,
Internet validation and captive portal, and battery, read with no permission
the app lacks. A missing, refused or unrecognized answer is unknown. Wi-Fi reads
on for 1 and 2 (kept on in airplane mode), off for 0 and 3.

```quint
type SwitchFact = FactOn | FactOff | FactUnknown
pure def wifiSwitchFact(reading: int): SwitchFact =
  if (reading == 1 or reading == 2) FactOn else if (reading == 0 or reading == 3) FactOff else FactUnknown
pure def binarySwitchFact(reading: int): SwitchFact = if (reading == 1) FactOn else if (reading == 0) FactOff else FactUnknown
pure def answeredFact(answered: bool, value: bool): SwitchFact = if (not(answered)) FactUnknown else if (value) FactOn else FactOff
pure def lawOffNeedsAnOffReading(reading: int): bool =
  (wifiSwitchFact(reading) == FactOff iff (reading == 0 or reading == 3)) and (binarySwitchFact(reading) == FactOff iff reading == 0)
pure def lawUnansweredIsUnknown(value: bool): bool = answeredFact(false, value) == FactUnknown
```

### A location fix needs a grant at the time of the read, and a cached fix is never older than asked

Without a grant the read fails with `PERMISSION_DENIED` and reads nothing. A
cached fix, marked cached, is returned only when its monotonic age is at most
the requested maximum age; zero always reads afresh. Approximate access is never
reported precise; a slow read fails with `TIMEOUT`.

```quint
type LocationAccess = PreciseAccess | ApproximateAccess | NoAccess
type LocationRead = PositionFresh | PositionCached | PermissionDenied | PositionTimeout | PositionUnavailable
type LocationAsk = { maxAgeMs: int, timeoutMs: int, wantsPrecise: bool }
type FixFacts = { access: LocationAccess, hasCached: bool, cachedAgeMs: int, fixAvailable: bool, fixWithinMs: int }
pure def readLocation(ask: LocationAsk, fix: FixFacts): LocationRead =
  if (fix.access == NoAccess) PermissionDenied
  else if (ask.maxAgeMs > 0 and fix.hasCached and fix.cachedAgeMs >= 0 and fix.cachedAgeMs <= ask.maxAgeMs) PositionCached
  else if (not(fix.fixAvailable)) PositionUnavailable else if (fix.fixWithinMs > ask.timeoutMs) PositionTimeout else PositionFresh
pure def reportedPrecise(ask: LocationAsk, fix: FixFacts): bool = ask.wantsPrecise and fix.access == PreciseAccess
pure val askValues = Set({ maxAgeMs: 0, timeoutMs: 10000, wantsPrecise: true }, { maxAgeMs: 60000, timeoutMs: 10000, wantsPrecise: false })
pure val fixValues = Set({ access: PreciseAccess, hasCached: true, cachedAgeMs: 30000, fixAvailable: true, fixWithinMs: 2000 },
  { access: ApproximateAccess, hasCached: true, cachedAgeMs: 90000, fixAvailable: true, fixWithinMs: 20000 },
  { access: NoAccess, hasCached: true, cachedAgeMs: 0, fixAvailable: true, fixWithinMs: 0 },
  { access: PreciseAccess, hasCached: false, cachedAgeMs: 0, fixAvailable: false, fixWithinMs: 0 })
pure def lawNoReadWithoutGrant(ask: LocationAsk, fix: FixFacts): bool = (fix.access == NoAccess) iff (readLocation(ask, fix) == PermissionDenied)
pure def lawCachedIsNeverTooOld(ask: LocationAsk, fix: FixFacts): bool =
  readLocation(ask, fix) == PositionCached implies (ask.maxAgeMs > 0 and fix.cachedAgeMs >= 0 and fix.cachedAgeMs <= ask.maxAgeMs)
pure def lawApproximateIsNeverReportedPrecise(ask: LocationAsk, fix: FixFacts): bool = fix.access != PreciseAccess implies not(reportedPrecise(ask, fix))
```

### A problem entry shows only the fields its source allows

The problem log keeps at most 50 entries for 30 days. Messages, stacks,
addresses and user content have no output field. An entry older than 30 days,
or more than 30 days ahead (an inference diagnostic, 60 seconds), is dropped.

```quint
type ProblemSource = RendererFailure | NativeUncaught | AndroidExit | InferenceDiagnostic
type ProblemField = Timestamp | SourceName | Kind | FailureClass | RootClass | ExitReason | ProcessLabel | Thread
  | InferenceFacts | Message | Stack | Address | UserContent
pure val problemRetentionMs = 2592000000
pure def problemFieldAllowed(source: ProblemSource, field: ProblemField): bool =
  field == Timestamp or field == SourceName or
    (source == RendererFailure and (field == Kind or field == FailureClass or field == ProcessLabel)) or
    (source == NativeUncaught and (field == FailureClass or field == RootClass or field == ProcessLabel or field == Thread)) or
    (source == AndroidExit and (field == ExitReason or field == ProcessLabel)) or (source == InferenceDiagnostic and field == InferenceFacts)
pure def problemRetained(source: ProblemSource, at: int, now: int): bool =
  at > now - problemRetentionMs and at <= now + (if (source == InferenceDiagnostic) 60000 else problemRetentionMs)
pure def lawNoPersonalContentInAProblem(source: ProblemSource, field: ProblemField): bool =
  (field == Message or field == Stack or field == Address or field == UserContent) implies not(problemFieldAllowed(source, field))
pure def lawOldProblemIsDropped(source: ProblemSource, now: int): bool = not(problemRetained(source, now - problemRetentionMs, now))
```

## Story: Change volume, mute or brightness and see what Android applied

> As an owner, I want to see the level Android applied, so that the app never
> shows one it did not.

### A volume, mute or brightness change reports only the value Android read back

A volume asks one stream for a level clamped to 0 through that stream's
maximum; mute asks for 0. The report is the level read back after the write;
an unreadable readback is `AndroidUnknown`, never the requested level. Muted is
a readback of 0.

```quint
type VolumeStream = MusicStream | RingStream | AlarmStream | NotificationStream | SystemStream | CallStream
type VolumeAsk = SetLevel({ level: int }) | Mute
type LevelReadback = LevelRead({ level: int }) | LevelUnreadable
type ControlReport = AndroidReports({ level: int }) | AndroidUnknown | ChangeFailed | ChangeNotAllowed
pure def clampLevel(level: int, streamMax: int): int = if (level < 0) 0 else if (level > streamMax) streamMax else level
pure def volumeTarget(volumeAsk: VolumeAsk, streamMax: int): int = match volumeAsk { | SetLevel(x) => clampLevel(x.level, streamMax) | _ => 0 }
pure def controlReport(allowed: bool, writeThrew: bool, readback: LevelReadback): ControlReport =
  if (not(allowed)) ChangeNotAllowed else if (writeThrew) ChangeFailed
  else match readback { | LevelRead(r) => AndroidReports({ level: r.level }) | _ => AndroidUnknown }
pure def mutedFact(report: ControlReport): SwitchFact = match report { | AndroidReports(r) => if (r.level == 0) FactOn else FactOff | _ => FactUnknown }
pure val readbackValues = Set(LevelRead({ level: 0 }), LevelRead({ level: 4 }), LevelUnreadable)
pure val volumeAskValues = Set(SetLevel({ level: -1 }), SetLevel({ level: 4 }), SetLevel({ level: 30 }), Mute)
pure def lawUnreadableIsUnknown(allowed: bool, writeThrew: bool, readback: LevelReadback): bool =
  (controlReport(allowed, writeThrew, readback) == AndroidUnknown) iff (allowed and not(writeThrew) and readback == LevelUnreadable)
pure def lawUnreadableIsNeverMutedOrUnmuted(allowed: bool, writeThrew: bool): bool = mutedFact(controlReport(allowed, writeThrew, LevelUnreadable)) == FactUnknown
pure def lawVolumeTargetIsWithinRange(volumeAsk: VolumeAsk, streamMax: int): bool =
  streamMax >= 0 implies (volumeTarget(volumeAsk, streamMax) >= 0 and volumeTarget(volumeAsk, streamMax) <= streamMax)
```

### Brightness changes system-wide only with the write-settings grant, and otherwise only this app's focused window

`WRITE_SETTINGS` is granted only by the owner on Android's page
(`PageWriteSettings`); a system change turns adaptive brightness off and sets
0 to 255. Without it the app sets only its own focused window's brightness.

```quint
type BrightnessScope = SystemBrightness | WindowBrightness
pure def brightnessAllowed(scope: BrightnessScope, writeSettingsGranted: bool, focused: bool): bool =
  if (scope == SystemBrightness) writeSettingsGranted else focused
pure def brightnessTarget(level: int): int = clampLevel(level, 255)
pure def lawSystemBrightnessNeedsTheGrant(focused: bool, writeThrew: bool, readback: LevelReadback): bool =
  controlReport(brightnessAllowed(SystemBrightness, false, focused), writeThrew, readback) == ChangeNotAllowed
```

## Story: Ask for a default role

> As an owner, I want the app to ask Android to make it my home, phone, messages
> or assistant app, and to show it as the default only when Android says so.

### A role is asked through Android's role request and reported held only from Android's readback

A role the product does not offer, or Android lacks, is refused without a
prompt; a role already held answers held. Otherwise the request is
`RoleManager.createRequestRoleIntent`; on return the offer is checked again and
held comes only from `RoleManager.isRoleHeld`, never the result code. The
status read also names the other holder Android's default-handler APIs report.

```quint
type DefaultRole = HomeRole | DialerRole | SmsRole | AssistantRole
type RoleResult = RoleHeld | RoleNotHeld | RoleNotOffered | RoleUnavailableHere
pure def asksAndroidForRole(offered: bool, available: bool, heldBefore: bool): bool = offered and available and not(heldBefore)
pure def roleResult(offered: bool, available: bool, heldBefore: bool, offeredAfter: bool, heldAfter: bool): RoleResult =
  if (not(offered)) RoleNotOffered else if (not(available)) RoleUnavailableHere else if (heldBefore) RoleHeld
  else if (not(offeredAfter)) RoleNotOffered else if (heldAfter) RoleHeld else RoleNotHeld
pure def lawHeldOnlyFromAndroid(offered: bool, available: bool, heldBefore: bool, offeredAfter: bool, heldAfter: bool): bool =
  roleResult(offered, available, heldBefore, offeredAfter, heldAfter) == RoleHeld implies (offered and available and (heldBefore or (offeredAfter and heldAfter)))
pure def lawPromptedRoleIsDecidedByTheReadback(offered: bool, available: bool, heldBefore: bool, heldAfter: bool): bool =
  asksAndroidForRole(offered, available, heldBefore) implies ((roleResult(offered, available, heldBefore, true, heldAfter) == RoleHeld) iff heldAfter)
```

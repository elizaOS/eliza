# Android system surfaces

What the system and location bridges may claim about handoffs, device facts,
volume, brightness and default roles. A handoff reports the [bridge](./bridge.md)'s
`HandoffOutcome`: `Opened` means Android showed its screen, never that the owner
changed anything there. [Wi-Fi](./wifi.md) uses the Internet panel and facts here.

## Story: Hand me to Android's own screens and apps

> As an owner, I want a shortcut to open Android's real screen or app, so that
> the app never claims a change I did not make there myself.

### A Settings page opens its specific page first and a broader page only where one is listed

A name outside the list is refused before Android is asked. Only mobile,
airplane, do-not-disturb and the Internet panel have a broader page, tried only
after the specific page failed to start. The reply says which page opened.

```quint
import bridge.* from "./bridge"
type SettingsPage = PageHome | PageAccounts | PageWifi | PageBluetooth | PageMobile | PageAirplane | PageLocation | PageDisplay | PageSound
  | PageBattery | PageAbout | PageDeveloper | PageNotifications | PagePrivacy | PageDefaultApps | PageDnd | PageWriteSettings | PageInternet
type PageReply = SpecificPage | BroaderPage | NoPage
pure def hasBroaderPage(page: SettingsPage): bool = page == PageMobile or page == PageAirplane or page == PageDnd or page == PageInternet
pure def pageReply(page: SettingsPage, specificStarted: bool, broaderStarted: bool): PageReply =
  if (specificStarted) SpecificPage else if (hasBroaderPage(page) and broaderStarted) BroaderPage else NoPage
pure def pageHandoff(reply: PageReply): HandoffOutcome = if (reply == NoPage) Refused else Opened
pure def lawBroaderPageOnlyAfterTheSpecificFailed(page: SettingsPage, specificStarted: bool, broaderStarted: bool): bool =
  (pageReply(page, specificStarted, broaderStarted) == BroaderPage implies (hasBroaderPage(page) and not(specificStarted) and broaderStarted))
    and ((pageHandoff(pageReply(page, specificStarted, broaderStarted)) == Opened) iff (specificStarted or (hasBroaderPage(page) and broaderStarted)))
```

### The shade opens only from a focused launcher build that holds the status bar permission

An ordinary app never asks; the renderer answers every refusal with Android's
top-edge swipe. `ShadeOpened` means the status bar service accepted the call.

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

Handoffs carry no data. Eligible handlers are enabled activities of other apps:
Android's preferred one, else the only one, else Android's chooser. Photos tries
the image viewer only when no gallery exists, never after a denial.

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
pure def lawChooserOnlyForSeveralHandlers(preferredEligible: bool, eligibleCount: int, launch: LaunchReply): bool = (eligibleCount <= 0 implies defaultAppHandoff(chooseHandler(preferredEligible, eligibleCount), launch) == Refused)
  and (chooseHandler(preferredEligible, eligibleCount) == AndroidChooser implies (eligibleCount >= 2 and not(preferredEligible)))
pure def lawDeniedGalleryIsNotReplaced(viewer: LaunchReply): bool = not(triesImageViewer(LaunchDenied)) and photosHandoff(LaunchDenied, viewer) == Refused
```

### App info opens Android's details page for exactly the entry the owner chose

A malformed entry or a serial of the current profile is refused before any
lookup. A work entry needs its profile still present and opens that profile's
details for the chosen component. A removed app or profile launches nothing.

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

The Quick Settings tile always shows inactive; a tap grants and captures nothing.

```quint
type TileTap = EntryOpened | EntryAwaitsUnlock
pure def tileTap(locked: bool, ownerUnlocked: bool): TileTap = if (not(locked) or ownerUnlocked) EntryOpened else EntryAwaitsUnlock
pure def lawLockedTapWaitsForUnlock(ownerUnlocked: bool): bool = (tileTap(true, ownerUnlocked) == EntryOpened) iff ownerUnlocked
```

### A clock handoff sends one reviewed request and never reports an alarm change

Set has an hour 0-23, a minute 0-59, a plain label of at most 200 characters
and ascending repeat days 1 (Sunday) to 7; snooze has 1-60 minutes. It starts
only after review, focused and unlocked, toward a resolved clock that is not
this app; a set naming a time zone fails if the zone changed since.

```quint
type AlarmSetting = { hour: int, minute: int, labelLength: int, labelPlain: bool, days: List[int] }
type ClockRequest = ClockSet(AlarmSetting) | ClockShow | ClockDismiss | ClockSnooze({ minutes: int })
type ClockReply = ClockOpened | ClockUnavailable | ClockDenied | ClockFailed | ClockUnknown
type DayScan = { previous: int, ordered: bool }
pure def scanDay(scan: DayScan, day: int): DayScan = { previous: day, ordered: scan.ordered and day > scan.previous and day <= 7 }
pure def daysAscending(days: List[int]): bool = days.foldl({ previous: 0, ordered: true }, scanDay).ordered
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
pure val clockRequestValues = Set(ClockShow, ClockSnooze({ minutes: 10 }), ClockSnooze({ minutes: 61 }), ClockSet({ hour: 24, minute: 0, labelLength: 201, labelPlain: true, days: List() }),
  ClockSet({ hour: 7, minute: 30, labelLength: 5, labelPlain: true, days: List(2, 4, 6) }),
  ClockSet({ hour: 6, minute: 0, labelLength: 0, labelPlain: false, days: List(3, 3) }))
pure val dayValues = Set(-1, 0, 1, 7, 8)
pure def lawClockOpensOnlyAReviewedAdmittedRequest(reviewed: bool, clockRequest: ClockRequest, facts: HostFacts, otherReceiver: bool, zoneHolds: bool, launch: LaunchReply): bool =
  clockHandoff(clockReply(reviewed, clockRequest, facts, otherReceiver, zoneHolds, launch)) == Opened implies
    (reviewed and clockRequestAdmitted(clockRequest) and facts.focused and facts.unlocked and otherReceiver and zoneHolds and launch == LaunchStarted)
pure def lawRepeatDaysAreDistinctWeekdays(day: int): bool =
  not(daysAscending(List(day, day))) and (daysAscending(List(day)) iff (day >= 1 and day <= 7))
```

### Device setup opens only a listed browser or password manager, or Android's own defaults pages

Readiness only reads installed apps and Android's default browser and autofill
provider; nothing changes a default. Credential providers fall back to Settings.

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

Switches, interruption filter, transport, Internet validation, captive portal
and battery alike: a missing, refused or unrecognized answer is unknown. Wi-Fi
is on for 1 and 2, off for 0 and 3.

```quint
type SwitchFact = FactOn | FactOff | FactUnknown
pure def wifiSwitchFact(reading: int): SwitchFact =
  if (reading == 1 or reading == 2) FactOn else if (reading == 0 or reading == 3) FactOff else FactUnknown
pure def binarySwitchFact(reading: int): SwitchFact = if (reading == 1) FactOn else if (reading == 0) FactOff else FactUnknown
pure def answeredFact(answered: bool, value: bool): SwitchFact = if (not(answered)) FactUnknown else if (value) FactOn else FactOff
pure def lawOffNeedsAnOffReading(reading: int, answered: bool, value: bool): bool =
  (wifiSwitchFact(reading) == FactOff iff (reading == 0 or reading == 3)) and (binarySwitchFact(reading) == FactOff iff reading == 0)
    and (answeredFact(answered, value) == FactOff iff (answered and not(value)))
```

### A location fix needs a grant at the time of the read, and a cached fix is never older than asked

Without a grant the read fails with `PERMISSION_DENIED`. A cached fix is
returned only when its monotonic age is at most the requested maximum age (zero
always reads afresh). Approximate access is never reported precise.

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
pure val fixValues = Set({ access: PreciseAccess, hasCached: true, cachedAgeMs: 30000, fixAvailable: true, fixWithinMs: 2000 }, { access: NoAccess, hasCached: true, cachedAgeMs: 0, fixAvailable: true, fixWithinMs: 0 },
  { access: ApproximateAccess, hasCached: true, cachedAgeMs: 90000, fixAvailable: true, fixWithinMs: 20000 }, { access: PreciseAccess, hasCached: false, cachedAgeMs: 0, fixAvailable: false, fixWithinMs: 0 })
pure def lawNoReadWithoutGrant(ask: LocationAsk, fix: FixFacts): bool = (fix.access == NoAccess) iff (readLocation(ask, fix) == PermissionDenied)
pure def lawCachedIsNeverTooOld(ask: LocationAsk, fix: FixFacts): bool =
  readLocation(ask, fix) == PositionCached implies (ask.maxAgeMs > 0 and fix.cachedAgeMs >= 0 and fix.cachedAgeMs <= ask.maxAgeMs)
pure def lawApproximateIsNeverReportedPrecise(ask: LocationAsk, fix: FixFacts): bool = fix.access != PreciseAccess implies not(reportedPrecise(ask, fix))
```

### A problem entry shows only the fields its source allows

Messages, stacks, addresses and user content have no output field. An entry
older than 30 days, or over 30 days (diagnostics: 60 seconds) ahead, is dropped.

```quint
type ProblemSource = RendererFailure | NativeUncaught | AndroidExit | InferenceDiagnostic
type ProblemField = Timestamp | SourceName | Kind | FailureClass | RootClass | ExitReason | ProcessLabel | Thread
  | InferenceFacts | Message | Stack | Address | UserContent
pure val problemRetentionMs = 2592000000
pure def problemFieldAllowed(source: ProblemSource, entryField: ProblemField): bool =
  entryField == Timestamp or entryField == SourceName or
    (source == RendererFailure and (entryField == Kind or entryField == FailureClass or entryField == ProcessLabel)) or
    (source == NativeUncaught and (entryField == FailureClass or entryField == RootClass or entryField == ProcessLabel or entryField == Thread)) or
    (source == AndroidExit and (entryField == ExitReason or entryField == ProcessLabel)) or (source == InferenceDiagnostic and entryField == InferenceFacts)
pure def problemRetained(source: ProblemSource, at: int, now: int): bool =
  at > now - problemRetentionMs and at <= now + (if (source == InferenceDiagnostic) 60000 else problemRetentionMs)
pure def lawNoPersonalContentInAProblem(source: ProblemSource, entryField: ProblemField): bool =
  (entryField == Message or entryField == Stack or entryField == Address or entryField == UserContent) implies not(problemFieldAllowed(source, entryField))
pure def lawOldProblemIsDropped(source: ProblemSource, now: int): bool = not(problemRetained(source, now - problemRetentionMs, now))
```

## Story: Change volume, mute or brightness and see what Android applied

> As an owner, I want to see the level Android applied, so that the app never
> shows one it did not.

### A volume, mute or brightness change reports only the value Android read back

A volume asks one stream for a level clamped to its range; mute asks for 0. An
unreadable readback is `AndroidUnknown`, never the level asked or a mute state.

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
pure def lawReportIsTheReadback(allowed: bool, writeThrew: bool, readback: LevelReadback): bool = {
  val report = controlReport(allowed, writeThrew, readback)
  (report == AndroidUnknown iff (allowed and not(writeThrew) and readback == LevelUnreadable)) and
    (readback == LevelUnreadable implies mutedFact(report) == FactUnknown) and
    match report { | AndroidReports(r) => readback == LevelRead({ level: r.level }) | _ => true }
}
pure def lawVolumeTargetIsWithinRange(volumeAsk: VolumeAsk, streamMax: int): bool =
  streamMax >= 0 implies (volumeTarget(volumeAsk, streamMax) >= 0 and volumeTarget(volumeAsk, streamMax) <= streamMax)
```

### Brightness changes system-wide only with the write-settings grant, and otherwise only this app's focused window

The owner grants `WRITE_SETTINGS` on `PageWriteSettings`; a system change sets 0-255.

```quint
type BrightnessScope = SystemBrightness | WindowBrightness
pure def brightnessAllowed(scope: BrightnessScope, writeSettingsGranted: bool, focused: bool): bool =
  if (scope == SystemBrightness) writeSettingsGranted else focused
pure def brightnessTarget(level: int): int = clampLevel(level, 255)
pure def lawSystemBrightnessNeedsTheGrant(focused: bool, writeThrew: bool, readback: LevelReadback): bool =
  controlReport(brightnessAllowed(SystemBrightness, false, focused), writeThrew, readback) == ChangeNotAllowed
  and controlReport(brightnessAllowed(WindowBrightness, false, false), writeThrew, readback) == ChangeNotAllowed
```

## Story: Ask for a default role

> As an owner, I want the app to ask Android to make it my home, phone, messages
> or assistant app, and to show it as the default only when Android says so.

### A role is asked through Android's role request and reported held only from Android's readback

A role not offered or missing is refused without a prompt. Otherwise the app
sends `RoleManager.createRequestRoleIntent`, checks the offer again on return,
and takes held only from `RoleManager.isRoleHeld`, never the result code.

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

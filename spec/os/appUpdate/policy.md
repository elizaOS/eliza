# App update policy

When the updater looks for an app update, downloads it, activates a
prepared one and reboots, and when it tells the owner that updates fall
behind. One policy run serves one scheduled job (`DiscoveryJob`,
`DownloadJob`, `ActivationJob`) and returns the plan for the scheduler: the
next discovery, the download job and the next activation check, with the
gate decision, the outcome and the alert of the run. The ledger is what the
runs remember between jobs. Sources: develop's updater policy
(`plugins/plugin-native-agent/android/.../updater/policy/{PolicyEngine,OtaGates,DeviceSignals,ComfortWindow,PolicyLedger,PolicyStore,OtaPolicy}.java`),
kept as the framework-free policy classes of `android/app-update`.

Two clocks are involved. Signed time is the lower bound of the updater's
qualified time interval (the one admission reads, `appUpdate/admission.md`);
zero or less means no usable signed time. It alone decides trust and alert
ages. The local wall clock is for comfort only: the 02:00-05:00 window, the
idle measure and the alarm horizon; a wrong local clock can move an
activation to an uncomfortable hour and never authorizes one. Times here are
whole minutes; the Java keeps milliseconds. The local clock reads UTC
minutes since the epoch here; on a device the shell resolves the window in
the device's zone.

The shell binds the ports of `PolicyEngine`: signed clock, comfort clock,
device signals (an unreadable signal is unknown), discovery, the pending
plan (the installation journal's verified plan, `appUpdate/install.md`), the
activation that hands the plan to the installation journal, a uniform jitter
and the job's cancellation. It shares one engine per ledger and keeps the
ledger in one private file, replaced atomically after an fsync; unreadable
or inconsistent state is replaced by a reset ledger. The policy constants
are the defaults of `OtaPolicy`; metered downloads and an unattended reboot
route are off.

## Story: Update my apps only when it is safe and on time

> As a device owner, I want my apps checked for updates regularly, updates
> downloaded only on a network I allow, and installed only while my phone is
> charging, cool, idle and unused, preferably overnight, and I want to be
> told when updates fall behind, so that updating never disturbs me and
> never silently stops.

### Discovery runs every 6 hours, within its jitter, and checks only with signed time

A discovery run always schedules the next discovery 6 hours from now, moved
by the jitter of up to 15 minutes either way. Without signed time it defers
and checks nothing. A check that reached the source records the signed time
of the check. A queued transfer schedules the download job one minute
later.

```quint
import install as I from "./install"
import admission as A from "./admission"
type Job = DiscoveryJob | DownloadJob | ActivationJob
type Flag = FlagUnknown | FlagSet | FlagClear
type Gauge = GaugeUnknown | GaugeAt({ value: int })
type Network = NetUnmetered | NetMetered | NetNone | NetUnknown
type Alarm = AlarmUnread | NoAlarmSet | AlarmIn({ alarmMinutes: int })
type Signals = { charging: Flag, battery: Gauge, thermal: Gauge, idle: Gauge, network: Network, call: Flag, media: Flag, camera: Flag, recording: Flag, cast: Flag, navigation: Flag, criticalTask: Flag, nextAlarm: Alarm }
type Blocker = PendingUnknown | SignedTimeUnavailable | ChargingUnknown | NotCharging | BatteryUnknown | BatteryLow | ThermalUnknown | ThermalUnsafe | IdleUnknown | NotIdle | CallUnknown | CallActive | MediaUnknown | MediaActive | CameraUnknown | CameraActive | RecordingUnknown | RecordingActive | CastUnknown | CastActive | NavigationUnknown | NavigationActive | CriticalTaskUnknown | CriticalTaskActive | OutsideWindow | AlarmUnknown | AlarmSoon | NoQualifiedRebootRoute | NetworkMetered | NetworkNone | NetworkUnknown | ActivationNotEnabled
type Decision = Undecided | Decided({ blockers: List[Blocker] })
type DiscoveryResult = DiscoveryChecked | TransferQueued | SourceUnavailable
type ActivationResult = NotEnabled | ActivationStarted | ActivationFailed
type PendingReading = NothingPending | Prepared({ preparedPlan: int }) | PendingUnreadable
type Outcome = NoOutcome | DiscoveryDeferred | Discovered({ discovered: DiscoveryResult }) | DownloadDeferred | Downloaded({ downloaded: DiscoveryResult }) | NoPendingActivation | ActivationDeferred | Activated({ activation: ActivationResult })
type ComfortWindow = Overnight | DaytimeFallback | WindowClosed
type AlertLevel = AlertNone | AlertRaised | AlertEscalated
type AlertReason = ActivationLate | ActivationOverdue | ChecksLate | ChecksOverdue | StateReset | SignedTimeMissing | StateUnsaved
type Alert = { level: AlertLevel, reasons: List[AlertReason], current: bool }
type DiscoveryPlan = DiscoveryUnchanged | DiscoveryAfter({ discoveryDelay: int })
type DownloadPlan = DownloadUnchanged | DownloadCancelled | DownloadAfter({ downloadDelay: int })
type ActivationPlan = ActivationCancelled | ActivationAfter({ activationDelay: int })
type RunPlan = { job: Job, discovery: DiscoveryPlan, download: DownloadPlan, activation: ActivationPlan, alert: Alert, decision: Decision, outcome: Outcome }
type Ledger = { trackingSince: int, lastCheck: int, pending: int, pendingSince: int, pendingSinceWall: int, windowsThroughWall: int, missedWindows: int, resetSince: int, resetPending: bool, alertLevel: AlertLevel, alertReasons: List[AlertReason], lastOutcome: Outcome, lastDecision: Decision }
type LedgerStep = { state: Ledger, out: List[RunPlan] }
type RunParts = { ledger: Ledger, aborted: bool, discovery: DiscoveryPlan, download: DownloadPlan, activation: ActivationPlan, decision: Decision, outcome: Outcome }
pure val discoveryInterval = 360
pure val discoveryJitter = 15
pure val retryDelay = 1
pure val recheckDelay = 15
pure val initial: Ledger = { trackingSince: 0, lastCheck: 0, pending: 0, pendingSince: 0, pendingSinceWall: 0, windowsThroughWall: 0, missedWindows: 0, resetSince: 0, resetPending: false, alertLevel: AlertNone, alertReasons: List(), lastOutcome: NoOutcome, lastDecision: Undecided }
pure def greatest(a: int, b: int): int = if (a > b) a else b
pure def least(a: int, b: int): int = if (a < b) a else b
pure def signedSeen(signedNow: int, l: Ledger): Ledger =
  if (signedNow <= 0) l
  else { ...l, trackingSince: if (l.trackingSince == 0) signedNow else l.trackingSince, pendingSince: if (l.pending != 0 and l.pendingSince == 0) signedNow else l.pendingSince, resetSince: if (l.resetPending) signedNow else l.resetSince, resetPending: false }
pure def checkedAt(signedNow: int, found: DiscoveryResult, l: Ledger): Ledger =
  if (found == SourceUnavailable) l else { ...l, lastCheck: greatest(l.lastCheck, signedNow) }
pure def partsOf(outcome: Outcome, l: Ledger): RunParts =
  { ledger: l, aborted: false, discovery: DiscoveryUnchanged, download: DownloadUnchanged, activation: ActivationCancelled, decision: Undecided, outcome: outcome }
pure def discoveryPart(signedNow: int, found: DiscoveryResult, jitter: int, cancelled: bool, l: Ledger): RunParts = {
  val nextDiscovery = DiscoveryAfter({ discoveryDelay: discoveryInterval - discoveryJitter + jitter })
  val deferred = partsOf(DiscoveryDeferred, l)
  val checked = partsOf(Discovered({ discovered: found }), checkedAt(signedNow, found, l))
  if (signedNow <= 0) { ...deferred, discovery: nextDiscovery }
  else { ...checked, aborted: cancelled, discovery: nextDiscovery, download: if (found == TransferQueued) DownloadAfter({ downloadDelay: retryDelay }) else DownloadUnchanged }
}
pure def discoveryDelayOf(d: DiscoveryPlan): int = match d { | DiscoveryAfter(x) => x.discoveryDelay | _ => -1 }
pure def fetched(o: Outcome): bool = match o { | Discovered(x) => true | Downloaded(x) => true | _ => false }
pure val jitterValues = Set(0, 15, 30)
pure val signedLowerValues = Set(0, 1, 4400, 10100)
pure def stepDiscoveryEverySixHours(before: Ledger, after: Ledger, out: List[RunPlan]): bool =
  out.every(p => if (p.job == DiscoveryJob) discoveryInterval - discoveryJitter <= discoveryDelayOf(p.discovery) and discoveryDelayOf(p.discovery) <= discoveryInterval + discoveryJitter else p.discovery == DiscoveryUnchanged)
pure def stepChecksNeedSignedTime(before: Ledger, after: Ledger, out: List[RunPlan]): bool =
  out.every(p => fetched(p.outcome) implies p.alert.current) and (after.lastCheck != before.lastCheck implies out.some(p => p.alert.current and fetched(p.outcome)))
pure def sometimesTransferQueued(l: Ledger): bool = l.lastOutcome == Discovered({ discovered: TransferQueued })
```

### A download proceeds only with signed time on an unmetered network

Metered downloads are off, so a metered, missing or unknown network defers
the download and looks again 15 minutes later. A download that ran keeps
its job scheduled while a transfer is still queued or the source was
unavailable, and cancels it once the source reports nothing more.

```quint
pure def downloadGate(n: Network): List[Blocker] =
  if (n == NetUnmetered) List() else if (n == NetMetered) List(NetworkMetered) else if (n == NetNone) List(NetworkNone) else List(NetworkUnknown)
pure def downloadPart(signedNow: int, n: Network, found: DiscoveryResult, cancelled: bool, l: Ledger): RunParts = {
  val unsigned: List[Blocker] = if (signedNow > 0) List() else List(SignedTimeUnavailable)
  val blockers = unsigned.concat(downloadGate(n))
  val deferred = partsOf(DownloadDeferred, l)
  val ran = partsOf(Downloaded({ downloaded: found }), checkedAt(signedNow, found, l))
  if (blockers.length() > 0) { ...deferred, download: DownloadAfter({ downloadDelay: recheckDelay }), decision: Decided({ blockers: blockers }) }
  else { ...ran, aborted: cancelled, decision: Decided({ blockers: List() }),
    download: if (found == DiscoveryChecked) DownloadCancelled else if (found == TransferQueued) DownloadAfter({ downloadDelay: retryDelay }) else DownloadAfter({ downloadDelay: recheckDelay }) }
}
pure def downloaded(o: Outcome): bool = match o { | Downloaded(x) => true | _ => false }
pure def lawDownloadNeedsUnmetered(n: Network): bool = (downloadGate(n).length() == 0) iff (n == NetUnmetered)
pure def stepDownloadsOnlyWhenAllowed(before: Ledger, after: Ledger, out: List[RunPlan]): bool =
  out.every(p => downloaded(p.outcome) implies p.decision == Decided({ blockers: List() }))
pure def sometimesDownloadDeferred(l: Ledger): bool = l.lastOutcome == DownloadDeferred
```

### The activation and reboot gates return every blocker in a fixed order, and an unknown signal blocks

Both gates need charging, a known battery level at their minimum (40 % to
activate, 60 % to reboot), a thermal status no higher than light, the screen
off for 15 minutes and no call, media, camera, recording, cast, navigation
or critical task. Activation also needs a comfort window that is not
closed; a reboot needs no alarm within 60 minutes and a qualified
unattended recovery route. A missing pending reading and missing signed
time come first. Every signal the device could not read blocks as unknown.

```quint
pure val activationMinBattery = 40
pure val rebootMinBattery = 60
pure val maxThermal = 1
pure val thermalCeiling = 6
pure val idleMinutes = 15
pure val rebootAlarmHorizon = 60
pure def gaugeWithin(g: Gauge, low: int, high: int): bool = match g { | GaugeAt(x) => low <= x.value and x.value <= high | _ => false }
pure def gaugeFrom(g: Gauge, low: int): bool = match g { | GaugeAt(x) => low <= x.value | _ => false }
pure def gaugeValue(g: Gauge): int = match g { | GaugeAt(x) => x.value | _ => 0 }
pure def flagBlockers(f: Flag, unknown: Blocker, active: Blocker): List[Blocker] =
  if (f == FlagUnknown) List(unknown) else if (f == FlagSet) List(active) else List()
pure def deviceBlockers(s: Signals, minimumBattery: int): List[Blocker] = {
  val charging: List[Blocker] = if (s.charging == FlagUnknown) List(ChargingUnknown) else if (s.charging == FlagClear) List(NotCharging) else List()
  val battery: List[Blocker] = if (not(gaugeWithin(s.battery, 0, 100))) List(BatteryUnknown) else if (gaugeValue(s.battery) < minimumBattery) List(BatteryLow) else List()
  val thermal: List[Blocker] = if (not(gaugeWithin(s.thermal, 0, thermalCeiling))) List(ThermalUnknown) else if (gaugeValue(s.thermal) > maxThermal) List(ThermalUnsafe) else List()
  val idle: List[Blocker] = if (not(gaugeFrom(s.idle, 0))) List(IdleUnknown) else if (gaugeValue(s.idle) < idleMinutes) List(NotIdle) else List()
  charging.concat(battery).concat(thermal).concat(idle)
    .concat(flagBlockers(s.call, CallUnknown, CallActive)).concat(flagBlockers(s.media, MediaUnknown, MediaActive))
    .concat(flagBlockers(s.camera, CameraUnknown, CameraActive)).concat(flagBlockers(s.recording, RecordingUnknown, RecordingActive))
    .concat(flagBlockers(s.cast, CastUnknown, CastActive)).concat(flagBlockers(s.navigation, NavigationUnknown, NavigationActive))
    .concat(flagBlockers(s.criticalTask, CriticalTaskUnknown, CriticalTaskActive))
}
pure def activationGate(s: Signals, window: ComfortWindow): List[Blocker] =
  deviceBlockers(s, activationMinBattery).concat(if (window == WindowClosed) List(OutsideWindow) else List())
pure def alarmBlockers(a: Alarm): List[Blocker] =
  match a { | AlarmIn(x) => if (x.alarmMinutes <= rebootAlarmHorizon) List(AlarmSoon) else List() | _ => if (a == AlarmUnread) List(AlarmUnknown) else List() }
pure def rebootGate(s: Signals, qualifiedRoute: bool): List[Blocker] =
  deviceBlockers(s, rebootMinBattery).concat(alarmBlockers(s.nextAlarm)).concat(if (qualifiedRoute) List() else List(NoQualifiedRebootRoute))
pure def blockerRank(b: Blocker): int =
  if (b == PendingUnknown) 0 else if (b == SignedTimeUnavailable) 1 else if (b == ChargingUnknown or b == NotCharging) 2
  else if (b == BatteryUnknown or b == BatteryLow) 3 else if (b == ThermalUnknown or b == ThermalUnsafe) 4 else if (b == IdleUnknown or b == NotIdle) 5
  else if (b == CallUnknown or b == CallActive) 6 else if (b == MediaUnknown or b == MediaActive) 7 else if (b == CameraUnknown or b == CameraActive) 8
  else if (b == RecordingUnknown or b == RecordingActive) 9 else if (b == CastUnknown or b == CastActive) 10 else if (b == NavigationUnknown or b == NavigationActive) 11
  else if (b == CriticalTaskUnknown or b == CriticalTaskActive) 12 else if (b == OutsideWindow) 13 else if (b == AlarmUnknown or b == AlarmSoon) 14
  else if (b == NoQualifiedRebootRoute) 15 else if (b == NetworkMetered or b == NetworkNone or b == NetworkUnknown) 16 else 17
pure def inOrder(bs: List[Blocker]): bool = bs.foldl({ last: -1, sorted: true }, (acc, b) => { last: blockerRank(b), sorted: acc.sorted and acc.last < blockerRank(b) }).sorted
pure def decisionInOrder(d: Decision): bool = match d { | Decided(x) => inOrder(x.blockers) | _ => true }
pure def someSignalUnknown(s: Signals): bool =
  s.charging == FlagUnknown or not(gaugeWithin(s.battery, 0, 100)) or not(gaugeWithin(s.thermal, 0, thermalCeiling)) or not(gaugeFrom(s.idle, 0)) or
  s.call == FlagUnknown or s.media == FlagUnknown or s.camera == FlagUnknown or s.recording == FlagUnknown or s.cast == FlagUnknown or s.navigation == FlagUnknown or s.criticalTask == FlagUnknown
pure val safeSignals: Signals = { charging: FlagSet, battery: GaugeAt({ value: 80 }), thermal: GaugeAt({ value: 0 }), idle: GaugeAt({ value: 30 }), network: NetUnmetered, call: FlagClear, media: FlagClear, camera: FlagClear, recording: FlagClear, cast: FlagClear, navigation: FlagClear, criticalTask: FlagClear, nextAlarm: NoAlarmSet }
pure val unknownSignals: Signals = { charging: FlagUnknown, battery: GaugeUnknown, thermal: GaugeUnknown, idle: GaugeUnknown, network: NetUnknown, call: FlagUnknown, media: FlagUnknown, camera: FlagUnknown, recording: FlagUnknown, cast: FlagUnknown, navigation: FlagUnknown, criticalTask: FlagUnknown, nextAlarm: AlarmUnread }
pure val sValues = Set(safeSignals, unknownSignals,
  { ...safeSignals, charging: FlagClear, battery: GaugeAt({ value: 50 }), nextAlarm: AlarmIn({ alarmMinutes: 30 }) },
  { ...safeSignals, call: FlagSet, thermal: GaugeAt({ value: 3 }), network: NetMetered, battery: GaugeAt({ value: 101 }) },
  { ...safeSignals, network: NetNone, idle: GaugeAt({ value: 5 }), criticalTask: FlagUnknown })
pure val signalsValues = sValues
pure def lawGatesListBlockersInOrder(s: Signals, window: ComfortWindow, qualifiedRoute: bool): bool =
  inOrder(activationGate(s, window)) and inOrder(rebootGate(s, qualifiedRoute)) and inOrder(downloadGate(s.network))
pure def lawUnknownSignalBlocks(s: Signals, window: ComfortWindow, qualifiedRoute: bool): bool =
  (someSignalUnknown(s) implies (activationGate(s, window).length() > 0 and rebootGate(s, qualifiedRoute).length() > 0)) and
  (s.network == NetUnknown implies downloadGate(s.network).length() > 0) and (s.nextAlarm == AlarmUnread implies rebootGate(s, qualifiedRoute).length() > 0)
pure def stepDecisionsListBlockersInOrder(before: Ledger, after: Ledger, out: List[RunPlan]): bool = out.every(p => decisionInOrder(p.decision))
```

### The comfort window never authorizes by itself, and missed windows are counted

Inside 02:00-05:00 local time the window is open; outside it, it opens for
the day only after two windows ended with the same activation still
pending. The window is one blocker among the activation gates and never
lifts another. Window ends are counted on the local clock from when the
plan became pending; a clock set back counts nothing and never uncounts,
and the count stops at 1000. A closed window looks again when it next
opens, at least a minute later; an open one every 15 minutes.

```quint
pure val windowStart = 120
pure val windowEnd = 300
pure val dayMinutes = 1440
pure val missedBeforeDaytime = 2
pure val missedCap = 1000
pure def floorDiv(a: int, b: int): int = if (b <= 0) 0 else if (a >= 0) a / b else 0 - ((0 - a + b - 1) / b)
pure def minuteOfDay(wall: int): int = wall - floorDiv(wall, dayMinutes) * dayMinutes
pure def inWindow(wall: int): bool = minuteOfDay(wall) >= windowStart and minuteOfDay(wall) < windowEnd
pure def comfortWindow(wall: int, missed: int): ComfortWindow =
  if (inWindow(wall)) Overnight else if (missed >= missedBeforeDaytime) DaytimeFallback else WindowClosed
pure def untilOpen(wall: int): int =
  if (inWindow(wall)) 0 else if (minuteOfDay(wall) < windowStart) windowStart - minuteOfDay(wall) else dayMinutes - minuteOfDay(wall) + windowStart
pure def windowEndsThrough(t: int): int = floorDiv(t - windowEnd, dayMinutes)
pure def windowsEnded(since: int, until: int): int = if (until <= since) 0 else least(windowEndsThrough(until) - windowEndsThrough(since), missedCap)
pure def windowsCounted(wall: int, l: Ledger): Ledger =
  if (l.pending == 0) l
  else { ...l, missedWindows: least(missedCap, l.missedWindows + windowsEnded(greatest(l.pendingSinceWall, l.windowsThroughWall), wall)), windowsThroughWall: greatest(l.windowsThroughWall, wall) }
pure val sinceValues = Set(0, 130, 310, 1570)
pure val untilValues = Set(0, 300, 1740, 3200)
pure val wallValues = Set(0, 130, 310, 1570, 3200)
pure def lawWindowNeverAuthorizesAlone(s: Signals, window: ComfortWindow): bool =
  activationGate(s, window).length() == 0 implies deviceBlockers(s, activationMinBattery).length() == 0
pure def lawEveryDayEndsOneWindow(since: int, until: int): bool =
  until >= since implies windowsEnded(since, until + dayMinutes) == least(windowsEnded(since, until) + 1, missedCap)
pure def alwaysMissedWindowsBelongToAPendingPlan(l: Ledger): bool =
  l.pending >= 0 and 0 <= l.missedWindows and l.missedWindows <= missedCap and
  (l.pending == 0 implies (l.pendingSince == 0 and l.pendingSinceWall == 0 and l.windowsThroughWall == 0 and l.missedWindows == 0))
pure def stepMissedWindowsNeverUncount(before: Ledger, after: Ledger): bool =
  (before.pending == after.pending and after.pending != 0) implies after.missedWindows >= before.missedWindows
pure def sometimesDaytimeFallback(l: Ledger): bool = l.missedWindows >= missedBeforeDaytime
```

### Activation is handed to the installation journal only when every gate holds

The pending plan is the installation journal's verified plan, read through
the shell; an unreadable reading, or a plan id that is not positive, is
unknown, keeps the plan remembered and blocks. Activation is tried only on
the activation job. A host that has not enabled installation answers
`NotEnabled`, which blocks. With nothing pending the activation check is
cancelled, unless the reading was unknown: then it looks again in 15
minutes.

```quint
pure def pendingFrom(j: I::Journal): PendingReading = if (j.phase == I::Verified) Prepared({ preparedPlan: j.plan.id }) else NothingPending
pure def pendingKnown(p: PendingReading): bool = match p { | Prepared(x) => x.preparedPlan > 0 | _ => p == NothingPending }
pure def pendingSeen(p: PendingReading, signedNow: int, wall: int, l: Ledger): Ledger = match p {
  | Prepared(x) =>
    if (x.preparedPlan <= 0 or x.preparedPlan == l.pending) l
    else { ...l, pending: x.preparedPlan, pendingSince: signedNow, pendingSinceWall: wall, windowsThroughWall: wall, missedWindows: 0 }
  | _ => if (p == NothingPending) { ...l, pending: 0, pendingSince: 0, pendingSinceWall: 0, windowsThroughWall: 0, missedWindows: 0 } else l
}
pure def activationPart(job: Job, signedNow: int, wall: int, s: Signals, activated: ActivationResult, cancelled: bool, known: bool, r: RunParts): RunParts = {
  val window = comfortWindow(wall, r.ledger.missedWindows)
  val unknownPending: List[Blocker] = if (known) List() else List(PendingUnknown)
  val unsigned: List[Blocker] = if (signedNow > 0) List() else List(SignedTimeUnavailable)
  val blockers = unknownPending.concat(unsigned).concat(activationGate(s, window))
  val evaluated = job == ActivationJob
  val allowed = blockers.length() == 0
  if (r.ledger.pending != 0) { ...r,
    aborted: r.aborted or (evaluated and allowed and cancelled),
    activation: ActivationAfter({ activationDelay: if (window == WindowClosed) greatest(retryDelay, untilOpen(wall)) else recheckDelay }),
    decision: if (not(evaluated)) r.decision else if (not(allowed)) Decided({ blockers: blockers }) else if (activated == NotEnabled) Decided({ blockers: List(ActivationNotEnabled) }) else Decided({ blockers: List() }),
    outcome: if (not(evaluated)) r.outcome else if (allowed) Activated({ activation: activated }) else ActivationDeferred }
  else if (not(known)) { ...r,
    activation: ActivationAfter({ activationDelay: recheckDelay }),
    decision: if (evaluated) Decided({ blockers: List(PendingUnknown) }) else r.decision,
    outcome: if (evaluated) ActivationDeferred else r.outcome }
  else r
}
pure def activationTried(o: Outcome): bool = match o { | Activated(x) => true | _ => false }
pure val pendingValues = Set(NothingPending, Prepared({ preparedPlan: 1 }), Prepared({ preparedPlan: 2 }), Prepared({ preparedPlan: 0 }), PendingUnreadable)
pure def stepActivatesOnlyWhenEveryGateHolds(before: Ledger, after: Ledger, out: List[RunPlan]): bool =
  out.every(p => activationTried(p.outcome) implies (p.job == ActivationJob and
    (p.decision == Decided({ blockers: List() }) or (p.decision == Decided({ blockers: List(ActivationNotEnabled) }) and p.outcome == Activated({ activation: NotEnabled })))))
pure def sometimesActivationStarted(l: Ledger): bool = l.lastOutcome == Activated({ activation: ActivationStarted })
pure def sometimesPendingUnknownBlocks(l: Ledger): bool = l.pending != 0 and l.lastOutcome == ActivationDeferred and match l.lastDecision { | Decided(x) => x.blockers.includes(PendingUnknown) | _ => false }
```

### The ledger keeps the pending activation and the check ages in signed time

An activation pending for 72 hours of signed time raises an alert and for 7
days escalates; so does the time since the last check that reached the
source, counted from when tracking began if there was none. A reset ledger
raises an alert for 7 days of signed time. Without signed time the last
level stands, marked not current, and says signed time is missing.

```quint
pure val alertAfter = 4320
pure val escalateAfter = 10080
pure def ageLevel(age: int, level: AlertLevel): AlertLevel =
  if (age >= escalateAfter) AlertEscalated else if (age >= alertAfter and level != AlertEscalated) AlertRaised else level
pure def ageReasons(age: int, late: AlertReason, overdue: AlertReason): List[AlertReason] =
  if (age >= escalateAfter) List(overdue) else if (age >= alertAfter) List(late) else List()
pure def currentAlert(signedNow: int, l: Ledger): Alert = {
  val pendingAged = l.pending != 0 and l.pendingSince > 0
  val reference = if (l.lastCheck > 0) l.lastCheck else l.trackingSince
  val resetShown = l.resetSince > 0 and signedNow - l.resetSince < escalateAfter
  val afterPending = if (pendingAged) ageLevel(signedNow - l.pendingSince, AlertNone) else AlertNone
  val afterChecks = if (reference > 0) ageLevel(signedNow - reference, afterPending) else afterPending
  val pendingReasons: List[AlertReason] = if (pendingAged) ageReasons(signedNow - l.pendingSince, ActivationLate, ActivationOverdue) else List()
  val checkReasons: List[AlertReason] = if (reference > 0) ageReasons(signedNow - reference, ChecksLate, ChecksOverdue) else List()
  val resetReasons: List[AlertReason] = if (resetShown) List(StateReset) else List()
  { level: if (resetShown and afterChecks == AlertNone) AlertRaised else afterChecks, reasons: pendingReasons.concat(checkReasons).concat(resetReasons), current: true }
}
pure def staleAlert(l: Ledger): Alert =
  { level: l.alertLevel, reasons: if (l.alertReasons.includes(SignedTimeMissing)) l.alertReasons else l.alertReasons.append(SignedTimeMissing), current: false }
pure val resetLedger: Ledger = { ...initial, resetPending: true }
pure def corruptLedger(l: Ledger): Ledger = resetLedger
pure def alwaysAgesAreSignedTime(l: Ledger): bool =
  l.trackingSince >= 0 and l.lastCheck >= 0 and l.pendingSince >= 0 and l.pendingSinceWall >= 0 and l.windowsThroughWall >= 0 and l.resetSince >= 0 and
  ((l.pendingSince > 0 or l.lastCheck > 0 or l.resetSince > 0 or l.alertLevel != AlertNone) implies l.trackingSince > 0)
pure def alwaysAlertNamesItsReasons(l: Ledger): bool =
  ((l.alertLevel == AlertNone) iff (l.alertReasons.length() == 0)) and not(l.alertReasons.includes(SignedTimeMissing)) and not(l.alertReasons.includes(StateUnsaved))
pure def sometimesEscalated(l: Ledger): bool = l.alertLevel == AlertEscalated
pure def sometimesResetAlerted(l: Ledger): bool = l.alertReasons.includes(StateReset)
pure def sometimesActivationLate(l: Ledger): bool = l.alertReasons.includes(ActivationLate)
```

### An unsaved ledger still returns the plan, with an alert

A run whose ledger could not be saved leaves the stored ledger as it was
and still returns its plan, with the alert raised for the unsaved state. A
cancelled job stops before its first effect, saves nothing and returns no
plan; a job cancelled after its effects, or with none to run, completes.
The jitter is uniform in its span and the local clock is after the epoch.

```quint
pure def unsavedAlert(a: Alert): Alert = { ...a, level: if (a.level == AlertNone) AlertRaised else a.level, reasons: a.reasons.append(StateUnsaved) }
pure def evaluate(job: Job, signedLower: int, wall: int, s: Signals, found: DiscoveryResult, pending: PendingReading, activated: ActivationResult, jitter: int, cancelled: bool, saved: bool, l: Ledger): LedgerStep = {
  val signedNow = if (signedLower > 0) signedLower else 0
  val seen = signedSeen(signedNow, l)
  val parts = if (job == DiscoveryJob) discoveryPart(signedNow, found, jitter, cancelled, seen) else if (job == DownloadJob) downloadPart(signedNow, s.network, found, cancelled, seen) else partsOf(NoPendingActivation, seen)
  val counted = windowsCounted(wall, pendingSeen(pending, signedNow, wall, parts.ledger))
  val finished = activationPart(job, signedNow, wall, s, activated, cancelled, pendingKnown(pending), { ...parts, ledger: counted })
  val alert = if (signedNow > 0) currentAlert(signedNow, finished.ledger) else staleAlert(finished.ledger)
  val recorded = { ...finished.ledger, alertLevel: alert.level, alertReasons: if (signedNow > 0) alert.reasons else finished.ledger.alertReasons, lastOutcome: finished.outcome, lastDecision: finished.decision }
  val plan = { job: job, discovery: finished.discovery, download: finished.download, activation: finished.activation, alert: if (saved) alert else unsavedAlert(alert), decision: finished.decision, outcome: finished.outcome }
  if (finished.aborted) { state: l, out: List() } else if (saved) { state: recorded, out: List(plan) } else { state: l, out: List(plan) }
}
pure def runnable(wall: int, jitter: int): bool = wall >= 0 and 0 <= jitter and jitter <= 2 * discoveryJitter
pure def canRunJob(l: Ledger, wall: int, jitter: int): bool = runnable(wall, jitter)
pure def runJob(l: Ledger, job: Job, signedLower: int, wall: int, signals: Signals, found: DiscoveryResult, pending: PendingReading, activated: ActivationResult, jitter: int): LedgerStep =
  evaluate(job, signedLower, wall, signals, found, pending, activated, jitter, false, true, l)
pure def canRunUnsaved(l: Ledger, wall: int, jitter: int): bool = runnable(wall, jitter)
pure def runUnsaved(l: Ledger, job: Job, signedLower: int, wall: int, signals: Signals, found: DiscoveryResult, pending: PendingReading, activated: ActivationResult, jitter: int): LedgerStep =
  evaluate(job, signedLower, wall, signals, found, pending, activated, jitter, false, false, l)
pure def canRunCancelled(l: Ledger, wall: int, jitter: int): bool = runnable(wall, jitter)
pure def runCancelled(l: Ledger, job: Job, signedLower: int, wall: int, signals: Signals, found: DiscoveryResult, pending: PendingReading, activated: ActivationResult, jitter: int): LedgerStep =
  evaluate(job, signedLower, wall, signals, found, pending, activated, jitter, true, true, l)
pure val weight_runJob = 8
pure def stepUnsavedRunKeepsTheLedgerAndAlerts(before: Ledger, after: Ledger, out: List[RunPlan]): bool =
  out.length() <= 1 and out.every(p => p.alert.reasons.includes(StateUnsaved) implies (after == before and p.alert.level != AlertNone))
pure def signedLowerOf(trusted: A::Interval): int = trusted.lower
```

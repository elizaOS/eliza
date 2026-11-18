# App update policy

When the updater looks for an app update, downloads it, activates a
prepared one, and tells the owner that updates fall behind. One policy run
serves one scheduled job and returns the plan for the scheduler: the next
discovery, the download job, the next activation check, the gate decision,
the outcome and the alert. The ledger is what the runs remember between
jobs. Source: develop's
`updater/policy/{PolicyEngine,OtaGates,DeviceSignals,ComfortWindow,PolicyLedger,PolicyStore,OtaPolicy}.java`,
kept as the framework-free policy classes of `android/app-update`. The
constants are the defaults of `OtaPolicy`: metered downloads and the
unattended reboot route are off.

Signed time is the lower bound of the updater's qualified time interval
(the `Interval` of `appUpdate/admission.md`); zero or less means none. It
alone decides alert ages. The local wall clock is for comfort only (the
02:00-05:00 window, idle and the alarm horizon) and never authorizes an
activation. Times are whole minutes; the local clock is minutes since the
epoch, which the shell resolves in the device's zone.

The shell binds the ports: both clocks, the device signals (an unreadable
signal is unknown), discovery, the installation journal's pending plan
(`appUpdate/install.md`), the activation hand-off, the jitter and the job's
cancellation. It shares one engine per ledger and keeps the ledger in one
private file, replaced atomically; unreadable state becomes a reset ledger.

## Story: Update my apps only when it is safe and on time

> As a device owner, I want my apps checked for updates regularly, updates
> downloaded only on a network I allow, and installed only while my phone is
> charging, cool, idle and unused, preferably overnight, and I want to be
> told when updates fall behind, so that updating never disturbs me and
> never silently stops.

### Discovery runs every 6 hours, within its jitter, and checks only with signed time

Without signed time a discovery run defers and checks nothing. A check that
reached the source records its signed time; a queued transfer schedules the
download job one minute later.

```quint
import install as I from "./install"
import admission as A from "./admission"
type Job = DiscoveryJob | DownloadJob | ActivationJob
type Flag = FlagUnknown | FlagSet | FlagClear
type Gauge = GaugeUnknown | GaugeAt({ value: int })
type NetworkKind = NetUnmetered | NetMetered | NetNone | NetUnknown
type NextAlarm = AlarmUnread | NoAlarmSet | AlarmIn({ alarmMinutes: int })
type Signals = { charging: Flag, battery: Gauge, thermal: Gauge, idle: Gauge, network: NetworkKind, call: Flag, media: Flag, camera: Flag, recording: Flag, cast: Flag, navigation: Flag, criticalTask: Flag, nextAlarm: NextAlarm }
type Signal = Charging | Battery | Thermal | Idle | Call | Media | Camera | Recording | Cast | Navigation | CriticalTask | Comfort | Alarm | RebootRoute | Connectivity
type Blocker = PendingUnknown | SignedTimeUnavailable | SignalUnknown({ signal: Signal }) | SignalUnmet({ signal: Signal }) | NetworkMetered | NetworkNone | ActivationNotEnabled
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
type RunPlan = { job: Job, discovery: DiscoveryPlan, download: DownloadPlan, activation: ActivationPlan, alert: Alert, decision: Decision, runOutcome: Outcome }
type RunEnd = Saved | Unsaved | Cancelled
type Ledger = { trackingSince: int, lastCheck: int, pending: int, pendingSince: int, pendingSinceWall: int, windowsThroughWall: int, missedWindows: int, resetSince: int, resetPending: bool, alertLevel: AlertLevel, alertReasons: List[AlertReason], lastOutcome: Outcome, lastDecision: Decision }
type LedgerStep = { state: Ledger, out: List[RunPlan] }
type RunParts = { ledger: Ledger, aborted: bool, discovery: DiscoveryPlan, download: DownloadPlan, activation: ActivationPlan, decision: Decision, runOutcome: Outcome }
pure val discoveryInterval = 360
pure val discoveryJitter = 15
pure val retryDelay = 1
pure val recheckDelay = 15
pure val initial: Ledger = { trackingSince: 0, lastCheck: 0, pending: 0, pendingSince: 0, pendingSinceWall: 0, windowsThroughWall: 0, missedWindows: 0, resetSince: 0, resetPending: false, alertLevel: AlertNone, alertReasons: List(), lastOutcome: NoOutcome, lastDecision: Undecided }
pure def greatest(a: int, b: int): int = if (a > b) a else b
pure def least(a: int, b: int): int = if (a < b) a else b
pure def signedLowerOf(trusted: A::Interval): int = if (trusted.lower > 0) trusted.lower else 0
pure def signedSeen(signedNow: int, l: Ledger): Ledger =
  if (signedNow <= 0) l
  else { ...l, trackingSince: if (l.trackingSince == 0) signedNow else l.trackingSince, pendingSince: if (l.pending != 0 and l.pendingSince == 0) signedNow else l.pendingSince, resetSince: if (l.resetPending) signedNow else l.resetSince, resetPending: false }
pure def checkedAt(signedNow: int, found: DiscoveryResult, l: Ledger): Ledger =
  if (found == SourceUnavailable) l else { ...l, lastCheck: greatest(l.lastCheck, signedNow) }
pure def partsOf(runOutcome: Outcome, l: Ledger): RunParts =
  { ledger: l, aborted: false, discovery: DiscoveryUnchanged, download: DownloadUnchanged, activation: ActivationCancelled, decision: Undecided, runOutcome: runOutcome }
pure def discoveryPart(signedNow: int, found: DiscoveryResult, jitter: int, cancelled: bool, l: Ledger): RunParts = {
  val nextDiscovery = DiscoveryAfter({ discoveryDelay: discoveryInterval - discoveryJitter + jitter })
  val checked = partsOf(Discovered({ discovered: found }), checkedAt(signedNow, found, l))
  if (signedNow <= 0) { ...partsOf(DiscoveryDeferred, l), discovery: nextDiscovery }
  else { ...checked, aborted: cancelled, discovery: nextDiscovery, download: if (found == TransferQueued) DownloadAfter({ downloadDelay: retryDelay }) else DownloadUnchanged }
}
pure def discoveryDelayOf(d: DiscoveryPlan): int = match d { | DiscoveryAfter(x) => x.discoveryDelay | _ => -1 }
pure def fetched(o: Outcome): bool = match o { | Discovered(x) => true | Downloaded(x) => true | _ => false }
pure val jitterValues = Set(0, 15, 30)
pure val signedLowerValues = Set(0, 1, 4400, 10100)
pure def stepDiscoveryEverySixHours(before: Ledger, after: Ledger, out: List[RunPlan]): bool =
  out.every(p => if (p.job == DiscoveryJob) discoveryInterval - discoveryJitter <= discoveryDelayOf(p.discovery) and discoveryDelayOf(p.discovery) <= discoveryInterval + discoveryJitter else p.discovery == DiscoveryUnchanged)
pure def stepChecksNeedSignedTime(before: Ledger, after: Ledger, out: List[RunPlan]): bool =
  out.every(p => fetched(p.runOutcome) implies p.alert.current) and (after.lastCheck != before.lastCheck implies out.some(p => p.alert.current and fetched(p.runOutcome)))
pure def sometimesTransferQueued(l: Ledger): bool = l.lastOutcome == Discovered({ discovered: TransferQueued })
```

### A download proceeds only with signed time on an unmetered network

A blocked download looks again in 15 minutes. A download that ran keeps its
job while a transfer is still queued or the source was unavailable, and
cancels it once the source reports nothing more.

```quint
pure def downloadGate(n: NetworkKind): List[Blocker] =
  if (n == NetUnmetered) List() else if (n == NetMetered) List(NetworkMetered) else if (n == NetNone) List(NetworkNone) else List(SignalUnknown({ signal: Connectivity }))
pure def downloadPart(signedNow: int, n: NetworkKind, found: DiscoveryResult, cancelled: bool, l: Ledger): RunParts = {
  val unsigned: List[Blocker] = if (signedNow > 0) List() else List(SignedTimeUnavailable)
  val blockers = unsigned.concat(downloadGate(n))
  val ran = partsOf(Downloaded({ downloaded: found }), checkedAt(signedNow, found, l))
  if (blockers.length() > 0) { ...partsOf(DownloadDeferred, l), download: DownloadAfter({ downloadDelay: recheckDelay }), decision: Decided({ blockers: blockers }) }
  else { ...ran, aborted: cancelled, decision: Decided({ blockers: List() }),
    download: if (found == DiscoveryChecked) DownloadCancelled else if (found == TransferQueued) DownloadAfter({ downloadDelay: retryDelay }) else DownloadAfter({ downloadDelay: recheckDelay }) }
}
pure def downloaded(o: Outcome): bool = match o { | Downloaded(x) => true | _ => false }
pure def lawDownloadNeedsUnmetered(n: NetworkKind): bool = (downloadGate(n).length() == 0) iff (n == NetUnmetered)
pure def stepDownloadsOnlyWhenAllowed(before: Ledger, after: Ledger, out: List[RunPlan]): bool =
  out.every(p => downloaded(p.runOutcome) implies p.decision == Decided({ blockers: List() }))
pure def sometimesDownloadDeferred(l: Ledger): bool = l.lastOutcome == DownloadDeferred
```

### The activation and reboot gates return every blocker in a fixed order, and an unknown signal blocks

Both gates need charging, a battery level at their minimum (40 % to
activate, 60 % to reboot), a thermal status no higher than light, the
screen off for 15 minutes and no call, media, camera, recording, cast,
navigation or critical task. Activation also needs a comfort window that is
not closed; a reboot needs no alarm within 60 minutes and the qualified
recovery route. An unknown pending plan and missing signed time come first.

```quint
pure val activationMinBattery = 40
pure val rebootMinBattery = 60
pure val maxThermal = 1
pure val thermalCeiling = 6
pure val idleMinutes = 15
pure val rebootAlarmHorizon = 60
pure val gateOrder: List[Signal] = List(Charging, Battery, Thermal, Idle, Call, Media, Camera, Recording, Cast, Navigation, CriticalTask, Comfort, Alarm, RebootRoute, Connectivity)
pure def signalRank(g: Signal): int = gateOrder.foldl(0, (n, x) => if (n >= 100) n else if (x == g) n + 100 else n + 1) - 100
pure def blockerRank(b: Blocker): int = match b {
  | SignalUnknown(x) => 2 + signalRank(x.signal)
  | SignalUnmet(x) => 2 + signalRank(x.signal)
  | _ => if (b == PendingUnknown) 0 else if (b == SignedTimeUnavailable) 1 else if (b == ActivationNotEnabled) 2 + gateOrder.length() else 2 + signalRank(Connectivity)
}
pure def inOrder(bs: List[Blocker]): bool = bs.foldl(-1, (previous, b) => if (previous < blockerRank(b)) blockerRank(b) else 99) < 99
pure def decisionInOrder(d: Decision): bool = match d { | Decided(x) => inOrder(x.blockers) | _ => true }
pure def gaugeWithin(g: Gauge, low: int, high: int): bool = match g { | GaugeAt(x) => low <= x.value and x.value <= high | _ => false }
pure def gaugeValue(g: Gauge): int = match g { | GaugeAt(x) => x.value | _ => 0 }
pure def flagBlocks(f: Flag, g: Signal): List[Blocker] = if (f == FlagUnknown) List(SignalUnknown({ signal: g })) else if (f == FlagSet) List(SignalUnmet({ signal: g })) else List()
pure def gaugeBlocks(known: bool, met: bool, g: Signal): List[Blocker] = if (not(known)) List(SignalUnknown({ signal: g })) else if (not(met)) List(SignalUnmet({ signal: g })) else List()
pure def deviceBlockers(s: Signals, minimumBattery: int): List[Blocker] =
  gaugeBlocks(s.charging != FlagUnknown, s.charging == FlagSet, Charging)
    .concat(gaugeBlocks(gaugeWithin(s.battery, 0, 100), gaugeValue(s.battery) >= minimumBattery, Battery))
    .concat(gaugeBlocks(gaugeWithin(s.thermal, 0, thermalCeiling), gaugeValue(s.thermal) <= maxThermal, Thermal))
    .concat(gaugeBlocks(s.idle != GaugeUnknown and gaugeValue(s.idle) >= 0, gaugeValue(s.idle) >= idleMinutes, Idle))
    .concat(flagBlocks(s.call, Call)).concat(flagBlocks(s.media, Media)).concat(flagBlocks(s.camera, Camera)).concat(flagBlocks(s.recording, Recording))
    .concat(flagBlocks(s.cast, Cast)).concat(flagBlocks(s.navigation, Navigation)).concat(flagBlocks(s.criticalTask, CriticalTask))
pure def activationGate(s: Signals, window: ComfortWindow): List[Blocker] =
  deviceBlockers(s, activationMinBattery).concat(if (window == WindowClosed) List(SignalUnmet({ signal: Comfort })) else List())
pure def alarmBlocks(a: NextAlarm): List[Blocker] =
  match a { | AlarmIn(x) => gaugeBlocks(true, x.alarmMinutes > rebootAlarmHorizon, Alarm) | _ => gaugeBlocks(a != AlarmUnread, true, Alarm) }
pure def rebootGate(s: Signals, qualifiedRoute: bool): List[Blocker] =
  deviceBlockers(s, rebootMinBattery).concat(alarmBlocks(s.nextAlarm)).concat(gaugeBlocks(true, qualifiedRoute, RebootRoute))
pure def someSignalUnknown(s: Signals): bool =
  s.charging == FlagUnknown or not(gaugeWithin(s.battery, 0, 100)) or not(gaugeWithin(s.thermal, 0, thermalCeiling)) or s.idle == GaugeUnknown or gaugeValue(s.idle) < 0 or
  s.call == FlagUnknown or s.media == FlagUnknown or s.camera == FlagUnknown or s.recording == FlagUnknown or s.cast == FlagUnknown or s.navigation == FlagUnknown or s.criticalTask == FlagUnknown
pure val safeSignals: Signals = { charging: FlagSet, battery: GaugeAt({ value: 80 }), thermal: GaugeAt({ value: 0 }), idle: GaugeAt({ value: 30 }), network: NetUnmetered, call: FlagClear, media: FlagClear, camera: FlagClear, recording: FlagClear, cast: FlagClear, navigation: FlagClear, criticalTask: FlagClear, nextAlarm: NoAlarmSet }
pure val signalsValues = Set(safeSignals,
  { charging: FlagUnknown, battery: GaugeUnknown, thermal: GaugeUnknown, idle: GaugeUnknown, network: NetUnknown, call: FlagUnknown, media: FlagUnknown, camera: FlagUnknown, recording: FlagUnknown, cast: FlagUnknown, navigation: FlagUnknown, criticalTask: FlagUnknown, nextAlarm: AlarmUnread },
  { ...safeSignals, charging: FlagClear, battery: GaugeAt({ value: 50 }), nextAlarm: AlarmIn({ alarmMinutes: 30 }) },
  { ...safeSignals, call: FlagSet, thermal: GaugeAt({ value: 3 }), network: NetMetered, battery: GaugeAt({ value: 101 }), idle: GaugeAt({ value: -1 }) },
  { ...safeSignals, network: NetNone, idle: GaugeAt({ value: 5 }), criticalTask: FlagUnknown })
pure def lawGatesListBlockersInOrder(signals: Signals, window: ComfortWindow, qualifiedRoute: bool): bool =
  inOrder(activationGate(signals, window)) and inOrder(rebootGate(signals, qualifiedRoute)) and inOrder(downloadGate(signals.network))
pure def lawUnknownSignalBlocks(signals: Signals, window: ComfortWindow, qualifiedRoute: bool): bool =
  (someSignalUnknown(signals) implies (activationGate(signals, window).length() > 0 and rebootGate(signals, qualifiedRoute).length() > 0)) and
  (signals.network == NetUnknown implies downloadGate(signals.network).length() > 0) and (signals.nextAlarm == AlarmUnread implies rebootGate(signals, qualifiedRoute).length() > 0)
pure def stepDecisionsListBlockersInOrder(before: Ledger, after: Ledger, out: List[RunPlan]): bool = out.every(p => decisionInOrder(p.decision))
```

### The comfort window never authorizes by itself, and missed windows are counted

Inside 02:00-05:00 local time the window is open; outside it, it opens for
the day only after two windows ended with the same activation pending.
Window ends are counted on the local clock from when the plan became
pending; a clock set back counts nothing and never uncounts, and the count
stops at 1000. A closed window looks again when it next opens, at least a
minute later; an open one every 15 minutes.

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
pure def windowsEnded(since: int, until: int): int =
  if (until <= since) 0 else least(floorDiv(until - windowEnd, dayMinutes) - floorDiv(since - windowEnd, dayMinutes), missedCap)
pure def windowsCounted(wall: int, l: Ledger): Ledger =
  if (l.pending == 0) l
  else { ...l, missedWindows: least(missedCap, l.missedWindows + windowsEnded(greatest(l.pendingSinceWall, l.windowsThroughWall), wall)), windowsThroughWall: greatest(l.windowsThroughWall, wall) }
pure val sinceValues = Set(0, 130, 310, 1570)
pure val untilValues = Set(0, 300, 1740, 3200)
pure val wallValues = Set(0, 130, 310, 1570, 3200)
pure def lawWindowNeverAuthorizesAlone(signals: Signals, window: ComfortWindow): bool =
  activationGate(signals, window).length() == 0 implies deviceBlockers(signals, activationMinBattery).length() == 0
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

The pending plan is the installation journal's verified plan; an
unreadable reading, or a plan id that is not positive, is unknown, keeps
the remembered plan and blocks. Activation is tried only on the activation
job; a host that has not enabled installation answers `NotEnabled`, which
blocks. With nothing pending the activation check is cancelled, unless the
reading was unknown: then it looks again in 15 minutes.

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
    runOutcome: if (not(evaluated)) r.runOutcome else if (allowed) Activated({ activation: activated }) else ActivationDeferred }
  else if (not(known)) { ...r,
    activation: ActivationAfter({ activationDelay: recheckDelay }),
    decision: if (evaluated) Decided({ blockers: List(PendingUnknown) }) else r.decision,
    runOutcome: if (evaluated) ActivationDeferred else r.runOutcome }
  else r
}
pure def activationTried(o: Outcome): bool = match o { | Activated(x) => true | _ => false }
pure def decisionBlocks(d: Decision, b: Blocker): bool = match d { | Decided(x) => x.blockers.includes(b) | _ => false }
pure val pendingValues = Set(NothingPending, Prepared({ preparedPlan: 1 }), Prepared({ preparedPlan: 2 }), Prepared({ preparedPlan: 0 }), PendingUnreadable)
pure def stepActivatesOnlyWhenEveryGateHolds(before: Ledger, after: Ledger, out: List[RunPlan]): bool =
  out.every(p => activationTried(p.runOutcome) implies (p.job == ActivationJob and
    (p.decision == Decided({ blockers: List() }) or (p.decision == Decided({ blockers: List(ActivationNotEnabled) }) and p.runOutcome == Activated({ activation: NotEnabled })))))
pure def sometimesActivationStarted(l: Ledger): bool = l.lastOutcome == Activated({ activation: ActivationStarted })
pure def sometimesPendingUnknownBlocks(l: Ledger): bool = l.pending != 0 and l.lastOutcome == ActivationDeferred and decisionBlocks(l.lastDecision, PendingUnknown)
```

### The ledger keeps the pending activation and the check ages in signed time

An activation pending for 72 hours of signed time raises an alert and for 7
days escalates; so does the time since the last check that reached the
source, counted from when tracking began if there was none. A reset ledger
raises an alert for 7 days. Without signed time the last level stands,
marked not current, and says signed time is missing.

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
  { level: if (resetShown and afterChecks == AlertNone) AlertRaised else afterChecks, reasons: pendingReasons.concat(checkReasons).concat(if (resetShown) List(StateReset) else List()), current: true }
}
pure def staleAlert(l: Ledger): Alert =
  { level: l.alertLevel, reasons: if (l.alertReasons.includes(SignedTimeMissing)) l.alertReasons else l.alertReasons.append(SignedTimeMissing), current: false }
pure def replaceUnreadable(l: Ledger): Ledger = { ...initial, resetPending: true }
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
and returns its plan with the unsaved alert. A job cancelled before its
first effect saves nothing and returns no plan; one cancelled with no
effect left to run completes. The jitter is uniform in its span.

```quint
pure def unsavedAlert(a: Alert): Alert = { ...a, level: if (a.level == AlertNone) AlertRaised else a.level, reasons: a.reasons.append(StateUnsaved) }
pure def canRunJob(l: Ledger, wall: int, jitter: int): bool = wall >= 0 and 0 <= jitter and jitter <= 2 * discoveryJitter
pure def runJob(l: Ledger, job: Job, signedLower: int, wall: int, signals: Signals, found: DiscoveryResult, pending: PendingReading, activated: ActivationResult, jitter: int, ending: RunEnd): LedgerStep = {
  val signedNow = if (signedLower > 0) signedLower else 0
  val cancelled = ending == Cancelled
  val seen = signedSeen(signedNow, l)
  val parts = if (job == DiscoveryJob) discoveryPart(signedNow, found, jitter, cancelled, seen) else if (job == DownloadJob) downloadPart(signedNow, signals.network, found, cancelled, seen) else partsOf(NoPendingActivation, seen)
  val counted = windowsCounted(wall, pendingSeen(pending, signedNow, wall, parts.ledger))
  val finished = activationPart(job, signedNow, wall, signals, activated, cancelled, pendingKnown(pending), { ...parts, ledger: counted })
  val alert = if (signedNow > 0) currentAlert(signedNow, finished.ledger) else staleAlert(finished.ledger)
  val recorded = { ...finished.ledger, alertLevel: alert.level, alertReasons: if (signedNow > 0) alert.reasons else finished.ledger.alertReasons, lastOutcome: finished.runOutcome, lastDecision: finished.decision }
  val plan = { job: job, discovery: finished.discovery, download: finished.download, activation: finished.activation, alert: if (ending == Unsaved) unsavedAlert(alert) else alert, decision: finished.decision, runOutcome: finished.runOutcome }
  if (finished.aborted) { state: l, out: List() } else if (ending == Unsaved) { state: l, out: List(plan) } else { state: recorded, out: List(plan) }
}
pure val weight_runJob = 8
pure def stepUnsavedRunKeepsTheLedgerAndAlerts(before: Ledger, after: Ledger, out: List[RunPlan]): bool =
  out.length() <= 1 and out.every(p => p.alert.reasons.includes(StateUnsaved) implies (after == before and p.alert.level != AlertNone))
```

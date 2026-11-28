# Wake listener

The privileged wake listener app runs one microphone foreground service,
decides from consent, permissions, crashes, the user, calls and SystemUI's
indicator lease (`I`) whether to hold the microphone, and opens the host's
assistant surface when it hears its name. Source: develop
`packages/app/platforms/android/sense/*`. The shell authenticates callers and
supplies observations and clocks; audio, recognizer and store stay in it.

## Story: Keep wake listening on the device under my control

> As the device owner, I want wake listening to run only in a listener I
> consented to, with no special exemptions, and to stop when I pause or turn
> it off, so that my phone never listens without my say.

### Only I turn listening on, in an admitted listener with my consent and no exemption

The image admitted the listener (`spec/os/image/listener.md`: two privileged
permissions, its own SELinux domain, no indicator-exempt role, no battery
exemption), and I gave the current consent, `RECORD_AUDIO` and notifications
in its own screen. Turning on and resuming need the keyguard unlocked. A
new process needs fresh consent before listening. Renewing consent after a
restart preserves recent crashes unless the listener has already stopped
after errors. An explicit turn-on from off or from that stop clears the
crash record. Resuming an enabled, consented listener clears its pause,
recent crashes and lost-indicator stop.

```quint
import indicatorLease as I from "./indicatorLease"
type Caller = Owner | HostApp | StatusChip | SystemUiLease | OtherApp
type ListenerGrant = { imageAdmitted: bool, consented: bool, recordAudioGranted: bool, notificationsGranted: bool }
type Device = { recordAudio: bool, notificationsVisible: bool, userForeground: bool, unlocked: bool, keyguardLocked: bool,
  speechUnavailable: bool, inCall: bool, otherAppRecording: bool, micSilenced: bool, speechPlaying: bool, screenInteractive: bool }
type Pause = NotPaused | UntilResumed | UntilClock({ at: int })
type Promotion = NoPromotion | Promoted | PromotionRefused
type WakeOutcome = NoWake | AssistantOpened | IgnoredWhileLocked | PausedBySpeech
type ListenerService = { enabled: bool, processConsent: bool, pause: Pause, tripped: bool, recentExits: List[int], indicatorLost: bool,
  device: Device, lease: I::IndicatorLease, unsilencedSince: int, queued: int, delivered: int, stopped: bool,
  foreground: bool, capturing: bool, promotion: Promotion, stopConfirmed: bool, lastWake: WakeOutcome }
pure val unknownDevice: Device = { recordAudio: false, notificationsVisible: false, userForeground: false, unlocked: false,
  keyguardLocked: true, speechUnavailable: false, inCall: false, otherAppRecording: false, micSilenced: false,
  speechPlaying: false, screenInteractive: true }
pure val initial: ListenerService = { enabled: false, processConsent: false, pause: NotPaused, tripped: false, recentExits: List(), indicatorLost: false,
  device: unknownDevice, lease: I::initial, unsilencedSince: -1, queued: 0, delivered: 0, stopped: true,
  foreground: false, capturing: false, promotion: NoPromotion, stopConfirmed: false, lastWake: NoWake }
pure def admitted(g: ListenerGrant): bool = g.imageAdmitted and g.consented and g.recordAudioGranted and g.notificationsGranted
pure val admittedGrant: ListenerGrant = { imageAdmitted: true, consented: true, recordAudioGranted: true, notificationsGranted: true }
pure val grantValues = Set(admittedGrant, { ...admittedGrant, imageAdmitted: false }, { ...admittedGrant, consented: false })
pure def canTurnOn(s: ListenerService, by: Caller, grant: ListenerGrant): bool =
  by == Owner and admitted(grant) and not(s.device.keyguardLocked)
pure def turnOn(s: ListenerService, by: Caller, grant: ListenerGrant): ListenerService = {
  val reauthorizing = s.enabled and not(s.processConsent) and not(s.tripped)
  val t = { ...s, enabled: true, processConsent: true, pause: NotPaused, tripped: false,
    recentExits: if (reauthorizing) s.recentExits else List(), indicatorLost: false, stopConfirmed: false }
  { ...t, indicatorLost: lossLatches(t, t) }
}
pure def canResume(s: ListenerService, by: Caller): bool = by == Owner and not(s.device.keyguardLocked)
pure def resume(s: ListenerService, by: Caller): ListenerService = {
  val authorized = s.enabled and s.processConsent
  val t = { ...s, pause: NotPaused, tripped: s.tripped and not(authorized),
    recentExits: if (authorized) List() else s.recentExits, indicatorLost: false }
  { ...t, indicatorLost: lossLatches(t, t) }
}
pure def sometimesListening(s: ListenerService): bool = decide(s) == Listening and s.capturing
```

### The listener reads audio only while listening and keeps its service running while paused

The first condition that fails names the state. A silenced recording stays
open only so Android reports its release; its frames are never read.

```quint
type ListenerState = Off | PermissionRequired | NotificationsRequired | StoppedAfterErrors | StoppedIndicatorLost
  | PausedOtherUser | WaitingForUnlock | SpeechUnavailable | IndicatorUnavailable | PausedUser | PausedCall
  | PausedMicInUse | PausedIndicatorHidden | PausedMicUnavailable | Listening
pure def pausedAt(p: Pause, now: int): bool = match p { | NotPaused => false | UntilResumed => true | UntilClock(u) => now < u.at }
pure def decide(s: ListenerService): ListenerState = {
  val d = s.device
  val v = leaseVerdict(s)
  if (s.enabled and s.tripped) StoppedAfterErrors
  else if (not(s.enabled and s.processConsent)) Off
  else if (not(d.recordAudio)) PermissionRequired
  else if (not(d.notificationsVisible)) NotificationsRequired
  else if (s.indicatorLost) StoppedIndicatorLost
  else if (not(d.userForeground)) PausedOtherUser
  else if (not(d.unlocked)) WaitingForUnlock
  else if (d.speechUnavailable) SpeechUnavailable
  else if (pausedAt(s.pause, s.lease.now)) PausedUser
  else if (d.inCall) PausedCall
  else if (d.otherAppRecording) PausedMicInUse
  else if (I::isPause(v)) PausedIndicatorHidden
  else if (v != I::Permits) IndicatorUnavailable
  else if (d.micSilenced) PausedMicUnavailable
  else Listening
}
pure def holdsMicrophone(st: ListenerState): bool = st == Listening or st == PausedMicUnavailable
pure def runsInForeground(st: ListenerState): bool =
  st == Listening or st == PausedUser or st == PausedCall or st == PausedMicInUse or st == PausedIndicatorHidden or st == PausedMicUnavailable
pure def observeDevice(s: ListenerService, d: Device): ListenerService = {
  val since = if (not(s.capturing) or d.micSilenced) -1 else if (s.unsilencedSince >= 0) s.unsilencedSince else s.lease.now
  val after = { ...s, device: d, unsilencedSince: since }
  { ...after, indicatorLost: s.indicatorLost or lossLatches(s, after) }
}
pure val readyDevice: Device = { ...unknownDevice, recordAudio: true, notificationsVisible: true, userForeground: true, unlocked: true, keyguardLocked: false }
pure val dValues = Set(readyDevice, { ...readyDevice, inCall: true }, { ...readyDevice, keyguardLocked: true },
  { ...readyDevice, micSilenced: true }, { ...readyDevice, speechPlaying: true }, unknownDevice)
```

### The status chip and host can pause listening, and the host can also turn it off

The chip sends the listener's own immutable pause action and the host holds
only the listener-control permission; their pause lasts until I resume. In
the listener's own screen I may also pause for a time on the monotonic clock
(15 minutes or an hour), which then ends by itself. Turning off also ends a
pause. Nothing else raises what the listener may do.

```quint
pure def canPause(s: ListenerService, by: Caller, forMs: int): bool =
  (by == Owner and forMs >= 0) or ((by == HostApp or by == StatusChip) and forMs == 0)
pure def pause(s: ListenerService, by: Caller, forMs: int): ListenerService =
  { ...s, pause: if (forMs == 0) UntilResumed else UntilClock({ at: s.lease.now + forMs }) }
pure val forMsValues = Set(0, 1000)
pure def canTurnOff(s: ListenerService, by: Caller): bool = by == Owner or by == HostApp
pure def turnOff(s: ListenerService, by: Caller): ListenerService = { ...s, enabled: false, pause: NotPaused }
pure def timed(p: Pause): bool = match p { | UntilClock(u) => true | _ => false }
pure def stepOnlyTheOwnerRaisesListening(before: ListenerService, via: str, after: ListenerService): bool =
  (after.enabled and (not(before.enabled) or (not(before.processConsent) and after.processConsent)
    or (before.tripped and not(after.tripped)) or (before.indicatorLost and not(after.indicatorLost))
    or (pausedAt(before.pause, before.lease.now) and not(pausedAt(after.pause, after.lease.now)))))
  implies (via == "turnOn" or via == "resume" or (via == "advanceClock" and timed(before.pause) and after.pause == before.pause))
pure def sometimesPausedWithServiceRunning(s: ListenerService): bool = decide(s) == PausedUser and s.foreground
pure def sometimesTimedPauseEnded(s: ListenerService): bool = timed(s.pause) and decide(s) == Listening
```

### Capture needs the foreground service, and a refused promotion is diagnosed and holds nothing

Each delivered start is owed one promotion attempt, even if listening was
turned off meanwhile; a convergence of the running service is not. A refusal
stops the service, ends any capture and emits a diagnostic.

```quint
type ListenerEffect = OpenAssistant | ForegroundRefused
type ListenerStep = { state: ListenerService, out: List[ListenerEffect] }
pure def applyPolicy(owed: bool, s: ListenerService, refuses: bool): ListenerStep = {
  val st = decide(s)
  val attempted = runsInForeground(st) or owed
  val keep = runsInForeground(st) and not(refuses)
  val holds = keep and holdsMicrophone(st)
  val since = if (not(holds)) -1 else if (s.capturing) s.unsilencedSince else if (s.device.micSilenced) -1 else s.lease.now
  { state: { ...s, foreground: keep, capturing: holds, unsilencedSince: since, stopped: not(keep) and s.delivered == s.queued,
      promotion: if (not(attempted)) NoPromotion else if (refuses) PromotionRefused else Promoted },
    out: if (attempted and refuses) List(ForegroundRefused) else List() }
}
pure def canDeliverStart(s: ListenerService): bool = s.delivered < s.queued
pure def deliverStart(s: ListenerService, refuses: bool): ListenerStep = applyPolicy(true, { ...s, delivered: s.delivered + 1 }, refuses)
pure def canConverge(s: ListenerService): bool = not(s.stopped)
pure def converge(s: ListenerService, refuses: bool): ListenerStep = applyPolicy(false, s, refuses)
pure def alwaysCaptureNeedsForeground(s: ListenerService): bool =
  (s.capturing implies s.foreground) and (s.promotion == PromotionRefused implies not(s.foreground))
pure def stepRefusedPromotionIsDiagnosed(before: ListenerService, via: str, after: ListenerService, out: List[ListenerEffect]): bool =
  (via == "deliverStart" or via == "converge") implies (after.promotion == PromotionRefused iff out.includes(ForegroundRefused))
pure def sometimesRefusedPromotion(s: ListenerService): bool = s.promotion == PromotionRefused and s.delivered >= 1
```

### An older start never stops a newer one, and every queued start is applied

Each control asks Android for a start when the new state runs the service,
which stops itself only for the newest queued start.

```quint
pure def canRequestStart(s: ListenerService): bool = runsInForeground(decide(s))
pure def requestStart(s: ListenerService): ListenerService = { ...s, queued: s.queued + 1, stopped: false }
pure def alwaysStoppedServiceHoldsNothing(s: ListenerService): bool =
  s.delivered >= 0 and s.delivered <= s.queued and (s.stopped implies s.delivered == s.queued and not(s.foreground) and not(s.capturing))
pure def sometimesNewerStartRetained(s: ListenerService): bool = s.delivered >= 1 and s.delivered < s.queued and not(s.foreground)
pure val fair_deliverStart = "weak"
pure def leadsToEveryStartApplied(s: ListenerService, later: ListenerService): bool = later.delivered >= s.queued
```

### A stop is confirmed only by a timely OFF reply with the microphone closed

At startup the host turns the listener off and reads its reply; a timed-out
or failed call never confirms, whatever arrives later.

```quint
type StopSettlement = ReplyInTime | TimedOut | BridgeFailed
pure def confirmsStop(settlement: StopSettlement, reported: ListenerState, microphoneOpen: bool): bool =
  settlement == ReplyInTime and reported == Off and not(microphoneOpen)
pure def canConfirmStop(s: ListenerService, by: Caller): bool = by == HostApp
pure def confirmStop(s: ListenerService, by: Caller, settlement: StopSettlement): ListenerService = {
  val t = { ...s, enabled: false, pause: NotPaused }
  { ...t, stopConfirmed: confirmsStop(settlement, decide(t), t.capturing) }
}
pure def alwaysConfirmedStopHoldsNoMicrophone(s: ListenerService): bool = s.stopConfirmed implies not(s.enabled) and not(s.capturing)
pure def sometimesStopConfirmedAfterRunning(s: ListenerService): bool = s.stopConfirmed and s.delivered >= 1
```

### Three crashes while capturing within ten minutes stop listening until I turn it on

Android restarts the persistent listener after every end. Only a crash with
a capture session open and `RECORD_AUDIO` granted counts, stamped on the wall
clock; exits ten minutes old or in the future drop out, and a trip is sticky.
The new process holds neither consent nor a lease. An enabled listener
shows a crash stop even before consent is renewed. After a reboot a timed
pause lasts until I resume, as the monotonic clock restarted.
The three-crash check starts from the initial state, renews consent and the
indicator lease before each capture, and checks that every step is allowed.

```quint
type ProcessEnd = Crash | Reboot | PackageUpdate
pure val crashLimit = 3
pure val crashWindowMs = 600000
pure def exitsAfter(exits: List[int], unclean: bool, now: int): List[int] = {
  val kept = exits.select(t => t <= now and now - t < crashWindowMs)
  if (unclean) kept.append(now) else kept
}
pure def restartProcess(s: ListenerService, cause: ProcessEnd, now: int): ListenerService = {
  val exits = exitsAfter(s.recentExits, cause == Crash and s.capturing and s.device.recordAudio, now)
  val t = { ...s, processConsent: false, recentExits: exits, tripped: s.tripped or exits.length() >= crashLimit, lease: { ...I::initial, now: s.lease.now },
    pause: if (cause == Reboot and timed(s.pause)) UntilResumed else s.pause, foreground: false, capturing: false, unsilencedSince: -1 }
  val queued = if (runsInForeground(decide(t))) t.queued + 1 else t.queued
  { ...t, queued: queued, stopped: t.delivered == queued }
}
pure val nowValues = Set(0, 1000, 700000)
pure def lawThirdUncleanExitWithinTheWindowTrips(now: int): bool =
  exitsAfter(exitsAfter(exitsAfter(List(), true, now), true, now), true, now).length() >= crashLimit
pure def lawOldAndFutureExitsNoLongerCount(now: int): bool = exitsAfter(List(now - crashWindowMs, now + 1), false, now) == List()
pure def stepRestartRetiresProcessConsent(before: ListenerService, via: str, after: ListenerService): bool =
  via == "restartProcess" implies not(after.processConsent) and not(after.capturing) and after.lease == { ...I::initial, now: before.lease.now }
pure def alwaysTrippedListenerHoldsNoMicrophone(s: ListenerService): bool = s.tripped implies not(s.capturing)
pure def sometimesUncleanExitCounted(s: ListenerService): bool = s.recentExits.length() >= 1 and not(s.tripped)
type CrashCycle = { admitted: bool, after: ListenerService }
pure def capturingCrash(now: int, s: ListenerService): CrashCycle = {
  val consent = turnOn(s, Owner, admittedGrant)
  val acquired = acquireLease(consent, SystemUiLease, I::admittedListener, true)
  val visible = renewLease(acquired, SystemUiLease, I::admittedListener, I::visibleRecording, true)
  val requested = requestStart(visible)
  val live = deliverStart(requested, false).state
  { admitted: canTurnOn(s, Owner, admittedGrant) and canAcquireLease(consent, SystemUiLease, I::admittedListener)
      and canRenewLease(acquired, SystemUiLease, I::admittedListener) and canRequestStart(visible)
      and canDeliverStart(requested) and live.capturing and live.device.recordAudio,
    after: restartProcess(live, Crash, now) }
}
pure def lawThreeCapturingCrashesReachTheStop(now: int): bool = {
  val first = capturingCrash(now, observeDevice(initial, readyDevice))
  val second = capturingCrash(now + 1000, first.after)
  val third = capturingCrash(now + 1000, second.after)
  first.admitted and second.admitted and third.admitted
    and first.after.recentExits == List(now) and not(first.after.tripped)
    and second.after.recentExits == List(now, now + 1000) and not(second.after.tripped)
    and third.after.recentExits == List(now, now + 1000, now + 1000)
    and third.after.tripped and decide(third.after) == StoppedAfterErrors
}
```

### Wake audio never leaves the device and opens only the assistant, while unlocked

Audio is analysed in memory only while `Listening` and no speech plays.
Hearing the name opens the host's assistant surface with no transcript or
audio, and is ignored behind the keyguard; the spoken pause works while locked.

```quint
type Phrase = WakeName | PauseCommand | OtherSpeech
pure def canHearPhrase(s: ListenerService, phrase: Phrase): bool = s.capturing and decide(s) == Listening and not(s.device.speechPlaying)
pure def hearPhrase(s: ListenerService, phrase: Phrase): ListenerStep =
  if (phrase == WakeName and not(s.device.keyguardLocked)) { state: { ...s, lastWake: AssistantOpened }, out: List(OpenAssistant) }
  else if (phrase == WakeName) { state: { ...s, lastWake: IgnoredWhileLocked }, out: List() }
  else if (phrase == PauseCommand) { state: { ...s, pause: UntilResumed, lastWake: PausedBySpeech }, out: List() }
  else { state: s, out: List() }
pure def stepWakeOpensOnlyTheAssistant(before: ListenerService, via: str, after: ListenerService, out: List[ListenerEffect]): bool =
  out.includes(OpenAssistant) implies
    (via == "hearPhrase" and out.length() == 1 and before.capturing and decide(before) == Listening and not(before.device.keyguardLocked))
pure def sometimesAssistantOpened(s: ListenerService): bool = s.lastWake == AssistantOpened
pure def sometimesPausedBySpeech(s: ListenerService): bool = s.lastWake == PausedBySpeech and decide(s) == PausedUser
```

## Story: Listen only while the indicator shows it

> As the device owner, I want capture to stop the moment the system stops
> showing that the listener is listening, so that nothing listens to me
> unseen.

### Capture continues only under a fresh, attributed indicator lease

SystemUI's lease events reach the listener through `I`. Attribution is
required once capture has run unsilenced for 2,500 ms. A loss while the
microphone is held, or while an explained pause keeps it released, latches
`StoppedIndicatorLost` at once, before the service converges and closes the
microphone; a lease that returns never resumes it. A lease lapsing while the
screen sleeps through a display-off pause is not a loss.

```quint
pure def leaseVerdict(s: ListenerService): I::Verdict =
  I::verdict(s.lease, I::requiresAttribution(s.capturing and s.unsilencedSince >= 0, s.unsilencedSince, s.lease.now), s.device.screenInteractive)
pure def lossLatches(before: ListenerService, after: ListenerService): bool = {
  val was = leaseVerdict(before)
  val v = leaseVerdict(after)
  val asleep = not(after.capturing) and was == I::PausedDisplayOff and (v == I::LostExpired or v == I::LostPending)
  (after.capturing or I::isPause(was)) and v != I::Permits and not(I::isPause(v)) and not(asleep)
}
pure def withLease(l: I::IndicatorLease, s: ListenerService): ListenerService = {
  val after = { ...s, lease: l }
  { ...after, indicatorLost: s.indicatorLost or lossLatches(s, after) }
}
pure def canAcquireLease(s: ListenerService, by: Caller, listener: I::ListenerIdentity): bool =
  by == SystemUiLease and I::canAcquire(s.lease, I::SystemUi, listener)
pure def acquireLease(s: ListenerService, by: Caller, listener: I::ListenerIdentity, replied: bool): ListenerService =
  withLease(I::acquire(s.lease, I::SystemUi, listener, replied), s)
pure def canRenewLease(s: ListenerService, by: Caller, listener: I::ListenerIdentity): bool =
  by == SystemUiLease and I::canRenew(s.lease, I::SystemUi, listener)
pure def renewLease(s: ListenerService, by: Caller, listener: I::ListenerIdentity, m: I::Measurement, replied: bool): ListenerService =
  withLease(I::renew(s.lease, I::SystemUi, listener, m, replied), s)
pure def canRevokeLease(s: ListenerService, by: Caller): bool = by == SystemUiLease and I::canRevoke(s.lease, I::SystemUi)
pure def revokeLease(s: ListenerService, by: Caller): ListenerService = withLease(I::revoke(s.lease, I::SystemUi), s)
pure def systemUiDied(s: ListenerService): ListenerService = withLease(I::systemUiDied(s.lease), s)
pure def canAdvanceClock(s: ListenerService, ms: int): bool = ms > 0
pure def advanceClock(s: ListenerService, ms: int): ListenerService = withLease(I::advance(s.lease, ms), s)
pure def alwaysLostIndicatorIsLatched(s: ListenerService): bool =
  s.capturing and leaseVerdict(s) != I::Permits and not(I::isPause(leaseVerdict(s))) implies s.indicatorLost
pure def sometimesIndicatorLossStopsListening(s: ListenerService): bool = decide(s) == StoppedIndicatorLost and not(s.capturing)
pure def sometimesExplainedPauseKeepsServiceRunning(s: ListenerService): bool = decide(s) == PausedIndicatorHidden and s.foreground and not(s.capturing)
```

### A latched loss closes the microphone when the service converges

```quint
pure val fair_converge = "weak"
pure def leadsToLostIndicatorClosesMicrophone(s: ListenerService, later: ListenerService): bool =
  (s.capturing and s.indicatorLost) implies not(later.capturing)
pure val weight_acquireLease = 10
pure val weight_renewLease = 10
pure val weight_requestStart = 10
pure val weight_deliverStart = 10
```

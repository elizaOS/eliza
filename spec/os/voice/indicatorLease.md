# Listening indicator lease

The wake listener may hold the microphone only while SystemUI shows its
listening indicator. SystemUI, which measures its own views, proves this
with a lease: it acquires a generation from the listener's lease provider and
renews it with what it measured. The listener stamps each renewal with its
own monotonic clock and asks `verdict` whether capture may continue
(`spec/os/voice/listener.md` imports this machine as `I`). The lease carries
visibility facts only: it can withhold capture and never starts listening.

This machine holds both halves: the listener's lease (`phase`, `generation`,
`expiresAt`, `ack`, `ended`) and the generation SystemUI holds (`held`, `-1`
for none). Sources: develop `SenseListeningPolicy.java` and
`SenseListeningLease.java` (SystemUI chip patch) and the listener's
`IndicatorLease.java` and `IndicatorLeaseProvider.java`. The content-provider
call, the token binder, the view measurement and the 1,000 ms renewal timer
stay in the shells. The lease lives in the listener's memory only, so it
never outlives the process or the boot.

## Story: Never listen without a visible indicator

> As the device owner, I want the wake listener to capture audio only while
> the system shows that it is listening, so that nothing listens to me
> unseen.

### Only SystemUI, platform-signed and alone on its UID, moves the lease

The provider admits a caller only when Android reports it holds
`STATUS_BAR_SERVICE`, its UID is a system-user UID that maps to exactly the
SystemUI package, and that package has the platform signer. The shell maps
these facts to the sender with `leaseCaller`; the host app, which holds only
the listener-control permission, is `OtherCaller` and is refused.

```quint
type LeaseCaller = SystemUi | OtherCaller
type ControllerFacts = { holdsStatusBarService: bool, callerUid: int, solePackageIsSystemUi: bool, platformSigned: bool }
pure def leaseCaller(c: ControllerFacts): LeaseCaller =
  if (c.holdsStatusBarService and c.callerUid >= 1000 and c.callerUid < 100000 and c.solePackageIsSystemUi and c.platformSigned) SystemUi
  else OtherCaller
```

### Acquiring starts a new generation that is pending until SystemUI acknowledges a visible indicator

SystemUI acquires only when it holds no generation and the listener it reads
is admitted. A lease that was still live is replaced and can never be renewed
again. SystemUI keeps the generation only if the reply reaches it.

```quint
type LeasePhase = Unleased | Pending | Acknowledged
type EndCause = NeverAcquired | Expired | BinderDied | Revoked
type Display = DisplayOn | DisplayDoze | DisplayOff | DisplayUnknown
type HiddenReason = NoReason | ReasonDisplayOff | ReasonAod | ReasonTransition | ReasonShade | ReasonFullscreen
type Ack = { surface: bool, chip: bool, recording: bool, display: Display, reason: HiddenReason }
type IndicatorLease = { now: int, generation: int, phase: LeasePhase, expiresAt: int, ack: Ack, ended: EndCause, held: int }
pure val noAck: Ack = { surface: false, chip: false, recording: false, display: DisplayOn, reason: NoReason }
pure val initial: IndicatorLease = { now: 0, generation: 0, phase: Unleased, expiresAt: 0, ack: noAck, ended: NeverAcquired, held: -1 }
pure def canAcquire(s: IndicatorLease, by: LeaseCaller, listener: ListenerIdentity): bool =
  by == SystemUi and s.held < 0 and admitsListener(listener)
pure def acquire(s: IndicatorLease, by: LeaseCaller, listener: ListenerIdentity, replied: bool): IndicatorLease =
  { ...s, generation: s.generation + 1, phase: Pending, expiresAt: 0, ack: noAck, held: if (replied) s.generation + 1 else -1 }
pure def sometimesReplacedLeaseStartsOver(s: IndicatorLease): bool = s.generation >= 2 and s.phase == Pending and s.held < 0
```

### An ended generation is never live again

Only `acquire` makes a lease live, and it always opens a newer generation.

```quint
pure def stepEndedGenerationStaysEnded(before: IndicatorLease, after: IndicatorLease): bool =
  after.generation >= before.generation and
  (before.phase == Unleased and after.phase != Unleased implies after.generation == before.generation + 1)
```

### A refused renewal is never retried on the same generation

The listener accepts a renewal only for its live generation. SystemUI drops
the generation when the listener refuses it or the reply is lost, and must
acquire a new one before it renews again.

```quint
pure def canRenew(s: IndicatorLease, by: LeaseCaller, listener: ListenerIdentity): bool =
  by == SystemUi and s.held >= 0 and admitsListener(listener)
pure def alwaysSystemUiHoldsOnlyTheLatestGeneration(s: IndicatorLease): bool =
  s.generation >= 0 and (s.held == -1 or s.held == s.generation)
pure def stepRefusedRenewalDropsTheGeneration(before: IndicatorLease, via: str, after: IndicatorLease): bool =
  via == "renew" and before.phase == Unleased implies after.held == -1 and after.phase == Unleased
```

### A renewal that shows the indicator or explains why it is hidden extends the lease by 3,000 ms

SystemUI renews every `renewMs`; a lease not extended within `ttlMs` (three
renewals) expires. A visible surface, an unknown display state, or a hidden
indicator with an explained pause extends it. Any other renewal is accepted
and recorded, but does not extend the lease, and leaves a pending lease
pending.

```quint
pure val renewMs = 1000
pure val ttlMs = 3 * renewMs
pure def extendsLease(a: Ack): bool = a.surface or a.display == DisplayUnknown or isPause(hiddenVerdict(a))
pure def renew(s: IndicatorLease, by: LeaseCaller, listener: ListenerIdentity, m: Measurement, replied: bool): IndicatorLease = {
  val a = acknowledge(listener, m)
  val leased =
    if (s.phase == Unleased) s
    else if (extendsLease(a)) { ...s, phase: Acknowledged, ack: a, expiresAt: s.now + ttlMs }
    else if (s.phase == Acknowledged) { ...s, ack: a }
    else s
  { ...leased, held: if (s.phase != Unleased and replied) s.held else -1 }
}
pure def canAdvance(s: IndicatorLease, ms: int): bool = ms > 0
pure def advance(s: IndicatorLease, ms: int): IndicatorLease =
  if (s.phase == Acknowledged and s.now + ms >= s.expiresAt) { ...s, now: s.now + ms, phase: Unleased, ack: noAck, expiresAt: 0, ended: Expired }
  else { ...s, now: s.now + ms }
pure val msValues = Set(500, 1000, 3000)
pure def alwaysAcknowledgedLeaseIsUnexpired(s: IndicatorLease): bool =
  s.phase == Acknowledged implies s.now < s.expiresAt and s.expiresAt <= s.now + ttlMs
pure def alwaysOnlyAnAcknowledgedLeaseCarriesFacts(s: IndicatorLease): bool =
  s.phase != Acknowledged implies s.ack == noAck
pure def sometimesLeaseExpired(s: IndicatorLease): bool = s.phase == Unleased and s.ended == Expired
pure def sometimesRenewedAfterALoss(s: IndicatorLease): bool = s.generation >= 2 and s.phase == Acknowledged
```

### SystemUI revokes its generation when it cannot read its source or the listener is not admitted

```quint
pure def canRevoke(s: IndicatorLease, by: LeaseCaller): bool = by == SystemUi and s.held >= 0
pure def revoke(s: IndicatorLease, by: LeaseCaller): IndicatorLease =
  if (s.phase == Unleased) { ...s, held: -1 }
  else { ...s, phase: Unleased, ack: noAck, expiresAt: 0, ended: Revoked, held: -1 }
pure def sometimesRevoked(s: IndicatorLease): bool = s.ended == Revoked
```

### SystemUI dying ends its lease at once

Its token binder dies, so the listener ends the live generation without
waiting for expiry; a restarted SystemUI holds no generation.

```quint
pure def systemUiDied(s: IndicatorLease): IndicatorLease =
  if (s.phase == Unleased) { ...s, held: -1 }
  else { ...s, phase: Unleased, ack: noAck, expiresAt: 0, ended: BinderDied, held: -1 }
pure def sometimesSystemUiDied(s: IndicatorLease): bool = s.ended == BinderDied
```

### Capture is permitted only under a live, acknowledged lease whose indicator is shown and attributed

`requireAttribution` is true once the listener has captured unsilenced for
`attributionGraceMs`; from then on SystemUI must also observe the recording
and acknowledge the chip. `screenInteractive` is the listener's own view of
the screen, used only for an unknown display state. An explained hidden
indicator is a pause, which releases the microphone until a fresh visible
acknowledgement; everything else that withholds capture is a loss.

```quint
type Verdict = Permits | PausedDisplayOff | PausedFullscreen | PausedShade | PausedTransition
  | LostNeverAcquired | LostPending | LostExpired | LostBinderDied | LostRevoked
  | LostSurfaceHidden | LostChipHidden | LostUnattributed | LostUnknownDisplay
pure val attributionGraceMs = 2500
pure def requiresAttribution(capturingUnsilenced: bool, unsilencedSince: int, now: int): bool =
  capturingUnsilenced and unsilencedSince >= 0 and now - unsilencedSince >= attributionGraceMs
pure def isPause(v: Verdict): bool = v == PausedDisplayOff or v == PausedFullscreen or v == PausedShade or v == PausedTransition
pure def shown(a: Ack): bool = a.surface and (not(a.recording) or a.chip)
pure def hiddenVerdict(a: Ack): Verdict =
  if (a.display == DisplayOff or a.display == DisplayDoze) PausedDisplayOff
  else if (a.reason == ReasonFullscreen) PausedFullscreen
  else if (a.reason == ReasonShade) PausedShade
  else if (a.reason == ReasonTransition) PausedTransition
  else if (a.surface) LostChipHidden
  else LostSurfaceHidden
pure def endedVerdict(e: EndCause): Verdict =
  if (e == Expired) LostExpired else if (e == BinderDied) LostBinderDied else if (e == Revoked) LostRevoked else LostNeverAcquired
pure def verdict(s: IndicatorLease, requireAttribution: bool, screenInteractive: bool): Verdict =
  if (s.phase == Unleased) endedVerdict(s.ended)
  else if (s.phase == Pending) LostPending
  else if (s.ack.display == DisplayUnknown) (if (screenInteractive) LostUnknownDisplay else PausedDisplayOff)
  else if (s.ack.display == DisplayOff) PausedDisplayOff
  else if (not(shown(s.ack))) hiddenVerdict(s.ack)
  else if (requireAttribution and not(s.ack.recording and s.ack.chip)) LostUnattributed
  else Permits
pure def alwaysCaptureOnlyUnderAShownIndicator(s: IndicatorLease): bool =
  Set(true, false).forall(attributed => Set(true, false).forall(interactive =>
    verdict(s, attributed, interactive) == Permits implies
      s.phase == Acknowledged and s.now < s.expiresAt and shown(s.ack) and (attributed implies s.ack.recording and s.ack.chip)))
pure def sometimesAttributedCapture(s: IndicatorLease): bool = verdict(s, true, true) == Permits
pure def sometimesExplainedPause(s: IndicatorLease): bool = isPause(verdict(s, false, true)) and s.phase == Acknowledged
pure def sometimesUnexplainedHiddenIsLost(s: IndicatorLease): bool = verdict(s, false, true) == LostSurfaceHidden
```

## Story: Acknowledge only what SystemUI itself measures

> As the device owner, I want the indicator to reflect what the system sees,
> not what the listener says about itself, so that a misbehaving listener
> cannot fake its own indicator.

### Only an admitted listener is acknowledged

The listener must run as user 0, the primary user, with an app UID from
10000 to 19999; be a system, privileged app; have the signer whose digest the
image admitted (`signerAdmitted`: the shell compares the 64-hex SHA-256
digests); match the host's signer; be the sole package of its UID; and own
the lease provider SystemUI calls, under the same UID.

```quint
type ListenerIdentity = { foregroundUser: int, primaryUser: bool, uid: int, systemApp: bool, privileged: bool,
  signerAdmitted: bool, matchesHost: bool, solePackage: bool, providerPackageMatches: bool, providerUid: int }
pure def isAppUidOfOwner(uid: int): bool = uid >= 10000 and uid < 20000
pure def admitsListener(l: ListenerIdentity): bool =
  l.foregroundUser == 0 and l.primaryUser and isAppUidOfOwner(l.uid) and l.systemApp and l.privileged
  and l.signerAdmitted and l.matchesHost and l.solePackage and l.providerPackageMatches and l.providerUid == l.uid
pure val admittedListener: ListenerIdentity = { foregroundUser: 0, primaryUser: true, uid: 10050, systemApp: true, privileged: true,
  signerAdmitted: true, matchesHost: true, solePackage: true, providerPackageMatches: true, providerUid: 10050 }
pure val listenerValues = Set(admittedListener, { ...admittedListener, privileged: false })
```

### A recording counts only for the admitted listener's UID and only while not silenced

```quint
pure def recordingCounts(admittedUid: int, recordingUid: int, silenced: bool): bool =
  isAppUidOfOwner(admittedUid) and recordingUid == admittedUid and not(silenced)
```

### A surface counts as visible only when attached, shown, at least half opaque and 90 percent on screen

The shell measures each indicator view with `effectivelyVisible` and reports
whether a surface and a chip that count for the current screen are visible.

```quint
type SurfaceView = { attached: bool, windowVisible: bool, viewShown: bool, aggregatedVisible: bool, alphaMille: int, area: int, visibleArea: int }
pure def effectivelyVisible(v: SurfaceView): bool =
  v.attached and v.windowVisible and v.viewShown and v.aggregatedVisible and v.alphaMille >= 500
  and v.area > 0 and v.visibleArea > 0 and v.visibleArea <= v.area and v.visibleArea * 100 >= v.area * 90
```

### A hidden indicator is explained by the first of display off, AOD, transition, shade and fullscreen

A transition is a report within 1,000 ms of a keyguard, doze or display
change; fullscreen is an app hiding the status bar while the keyguard is not
showing. A hidden indicator with none of these has no reason, and the
lease treats it as a loss.

```quint
type Measurement = { surface: bool, chip: bool, recordingUid: int, silenced: bool, display: Display,
  msSinceTransition: int, shadeExpanded: bool, statusBarHidden: bool, keyguardShowing: bool }
pure val transitionDebounceMs = 1000
pure def hiddenReason(isShown: bool, m: Measurement): HiddenReason =
  if (isShown) NoReason
  else if (m.display == DisplayOff) ReasonDisplayOff
  else if (m.display == DisplayDoze) ReasonAod
  else if (m.msSinceTransition >= 0 and m.msSinceTransition < transitionDebounceMs) ReasonTransition
  else if (m.shadeExpanded) ReasonShade
  else if (m.statusBarHidden and not(m.keyguardShowing)) ReasonFullscreen
  else NoReason
pure def alwaysShownIndicatorHasNoHiddenReason(s: IndicatorLease): bool = shown(s.ack) implies s.ack.reason == NoReason
pure val visibleRecording: Measurement = { surface: true, chip: true, recordingUid: 10050, silenced: false, display: DisplayOn,
  msSinceTransition: -1, shadeExpanded: false, statusBarHidden: false, keyguardShowing: false }
pure val mValues = Set(visibleRecording, { ...visibleRecording, surface: false, chip: false },
  { ...visibleRecording, surface: false, display: DisplayOff }, { ...visibleRecording, surface: false, statusBarHidden: true },
  { ...visibleRecording, silenced: true }, { ...visibleRecording, display: DisplayUnknown })
```

### The chip is acknowledged only while SystemUI itself observes the recording

```quint
pure def acknowledge(l: ListenerIdentity, m: Measurement): Ack = {
  val recording = recordingCounts(l.uid, m.recordingUid, m.silenced)
  val chip = recording and m.chip
  { surface: m.surface, chip: chip, recording: recording, display: m.display, reason: hiddenReason(m.surface and (not(recording) or chip), m) }
}
pure def alwaysChipOnlyWhileRecording(s: IndicatorLease): bool = s.ack.chip implies s.ack.recording
pure def sometimesSilencedRecordingIsNotAttributed(s: IndicatorLease): bool =
  s.phase == Acknowledged and s.ack.surface and not(s.ack.recording) and verdict(s, true, true) == LostUnattributed
```

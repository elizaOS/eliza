# Wake listener foreground service

The [wake](./wake.md) listener runs its capture in an Android foreground
service. Android delivers each start command to the service, and the
service decides on the current listening policy whether to promote itself
to the foreground and capture, or to stop. Starts are numbered as Android
queues them; the service applies the newest one it has been delivered.
Android's token and foreground-service rules are explicit host ports here:
the platform may refuse a foreground promotion.

## Story: Run the wake listener only as a visible foreground service

> As a person with wake listening on, I want the listener to capture only
> while its foreground notification is showing, and to stop cleanly when I
> turn it off, without an old start command stopping a newer one.

### Capture needs the foreground service

A delivered start that Android requires to reach the foreground is owed
one promotion attempt, even when listening was turned off in the
meantime. The attempt shows the foreground notification unless Android
refuses it; capture starts only when the policy still allows listening and
the promotion succeeded. A refused promotion also ends any capture already
running, because capture needs the foreground.

```quint
type ListenerPhase = StartPending | Applying | CaptureAdmitted | StoppingListener | ListenerSettled
type ListenerService = { pending: int, delivered: int, owed: bool, policy: bool, refused: bool,
  foreground: bool, capture: bool, stopped: bool, phase: ListenerPhase, attempted: bool, diagnosed: bool }
pure val initial: ListenerService = { pending: 1, delivered: 0, owed: false, policy: true, refused: false,
  foreground: false, capture: false, stopped: false, phase: StartPending, attempted: false, diagnosed: false }
pure def canRevokeListening(l: ListenerService): bool = l.policy
pure def revokeListening(l: ListenerService): ListenerService = { ...l, policy: false }
pure def canDeliverStart(l: ListenerService): bool = l.delivered < l.pending
pure def deliverStart(l: ListenerService): ListenerService =
  { ...l, delivered: l.pending, owed: true, phase: Applying, attempted: false }
pure def canAttemptForeground(l: ListenerService): bool = l.phase == Applying and (l.policy or l.owed)
pure def attemptForeground(l: ListenerService, platformRefuses: bool): ListenerService =
  { ...l, owed: false, attempted: true, refused: platformRefuses, foreground: not(platformRefuses),
    capture: l.capture and not(platformRefuses), diagnosed: l.diagnosed or platformRefuses,
    phase: if (l.policy and not(platformRefuses)) CaptureAdmitted else StoppingListener }
pure def canSkipForeground(l: ListenerService): bool = l.phase == Applying and not(l.policy) and not(l.owed)
pure def skipForeground(l: ListenerService): ListenerService = { ...l, phase: StoppingListener }
pure def canStartListenerCapture(l: ListenerService): bool = l.phase == CaptureAdmitted and l.policy and l.foreground
pure def startListenerCapture(l: ListenerService): ListenerService = { ...l, capture: true, phase: ListenerSettled }
pure def canRetireCapture(l: ListenerService): bool = l.phase == CaptureAdmitted and not(l.policy)
pure def retireCapture(l: ListenerService): ListenerService = { ...l, phase: StoppingListener }
pure def alwaysCaptureNeedsForeground(l: ListenerService): bool = l.capture implies l.foreground
pure def sometimesListenerCapturing(l: ListenerService): bool = l.capture and l.phase == ListenerSettled
```

### A refused foreground promotion is always diagnosed

When Android refuses the promotion, the service records a diagnostic and
stops instead of capturing without its notification.

```quint
pure def alwaysRefusalIsDiagnosed(l: ListenerService): bool = l.refused implies l.diagnosed
pure def sometimesRefusedStopSettles(l: ListenerService): bool =
  l.stopped and l.diagnosed and not(l.capture)
```

### An older start never stops a newer one

Stopping releases capture and the foreground. The service counts itself
stopped only when the start it applied is the newest one Android queued;
a newer start that arrives keeps it running until that start is applied.
The current settled start can be applied again while the service runs.

```quint
pure def canQueueNewerStart(l: ListenerService): bool = l.delivered == l.pending
pure def queueNewerStart(l: ListenerService): ListenerService = { ...l, pending: l.pending + 1, stopped: false }
pure def canReapplyStart(l: ListenerService): bool = l.phase == ListenerSettled and not(l.stopped)
pure def reapplyStart(l: ListenerService): ListenerService = { ...l, phase: Applying, attempted: false }
pure def canStopListener(l: ListenerService): bool = l.phase == StoppingListener
pure def stopListener(l: ListenerService): ListenerService =
  { ...l, capture: false, foreground: false, stopped: l.delivered == l.pending, phase: ListenerSettled }
pure def alwaysOldStartCannotStopNewer(l: ListenerService): bool =
  l.delivered >= 0 and l.delivered <= l.pending and (l.delivered < l.pending implies not(l.stopped))
pure def alwaysStoppedOwnsNoCapture(l: ListenerService): bool = l.stopped implies not(l.capture) and l.phase == ListenerSettled
pure def sometimesNewerStartRetained(l: ListenerService): bool =
  l.delivered < l.pending and l.phase == ListenerSettled and not(l.stopped) and l.delivered > 1
```

### Every delivered start settles

When the service keeps applying what it was delivered, every start it
receives reaches a settled state: capturing, or stopped.

```quint
pure val fair_deliverStart = "weak"
pure val fair_attemptForeground = "weak"
pure val fair_skipForeground = "weak"
pure val fair_startListenerCapture = "weak"
pure val fair_retireCapture = "weak"
pure val fair_stopListener = "weak"
pure def leadsToStartSettles(l: ListenerService, later: ListenerService): bool =
  l.phase != ListenerSettled implies later.phase == ListenerSettled
```

# Agent health verdicts

How the agent service reads the agent's health and decides that a running
agent must be replaced. This library holds no state and changes no phase:
the service lifecycle (`spec/os/agentService/lifecycle.md`) keeps a `HealthWatch` per launch,
folds each observation into it with `afterObservation`, and kills and
restarts the child (`restartUnhealthy`) when `verdict` is `Restart`; it waits
`restartDelay(attempt)` before each restart. The post-update health check
reads `classify` for the agent half of its evidence. Sources: the develop
watchdog policy `ElizaAgentWatchdogPolicy.java` and its service loop, and the
agent's `GET /api/health` answer `{ready, runtime, agentState, epoch}`
(`spec/agent/host/process.md`). The socket request, its 30 s timeout, the
JSON parsing and the process checks stay in the shell; the probe runs every
`probeIntervalMs` and the connect check every `connectCheckIntervalMs`.

## Story: Tell a busy agent from an absent one

> As a device owner, I want an agent that is busy in a long native call to
> keep running, and an agent that stopped answering or is gone to be
> restarted, so that my agent is neither killed mid-work nor left dead.

### A probe is Ok only for a ready answer of the current launch

A 2xx answer whose body says ready, runtime `ok`, agent state `running` and
the epoch of this launch is `Ok`. Any other answer, an unready one or a
ready one from a stale child of an earlier launch, is `Dead`. No answer
(a timeout or a refused request) is `Busy` while the child is alive or its
socket still accepts connects, and `Dead` otherwise.

```quint
type Probe = Ok | Busy | Dead
type HealthBody = Unparsed | Parsed({ ready: bool, runtime: str, agentState: str, epoch: int })
type ProbeReply = Answered({ status: int, body: HealthBody }) | Unanswered({ childAlive: bool, socketAccepts: bool })
pure val probeIntervalMs = 600000
pure val connectCheckIntervalMs = 30000
pure def readyBody(body: HealthBody, epoch: int): bool = match body {
  | Parsed(b) => b.ready and b.runtime == "ok" and b.agentState == "running" and b.epoch == epoch
  | Unparsed => false
}
pure def classify(reply: ProbeReply, epoch: int): Probe = match reply {
  | Answered(a) => if (a.status >= 200 and a.status < 300 and readyBody(a.body, epoch)) Ok else Dead
  | Unanswered(u) => if (u.childAlive or u.socketAccepts) Busy else Dead
}
pure val epochValues = Set(1, 2)
pure val replyValues = Set(
  Answered({ status: 200, body: Parsed({ ready: true, runtime: "ok", agentState: "running", epoch: 1 }) }),
  Answered({ status: 200, body: Parsed({ ready: true, runtime: "ok", agentState: "running", epoch: 2 }) }),
  Answered({ status: 200, body: Parsed({ ready: true, runtime: "starting", agentState: "running", epoch: 1 }) }),
  Answered({ status: 503, body: Parsed({ ready: false, runtime: "ok", agentState: "", epoch: 1 }) }),
  Answered({ status: 200, body: Unparsed }),
  Unanswered({ childAlive: true, socketAccepts: false }),
  Unanswered({ childAlive: false, socketAccepts: true }),
  Unanswered({ childAlive: false, socketAccepts: false })
)
pure def lawStaleLaunchIsNeverOk(reply: ProbeReply, epoch: int): bool =
  classify(reply, epoch) == Ok implies not(classify(reply, epoch + 1) == Ok)
pure def lawSilenceIsNeverOk(childAlive: bool, socketAccepts: bool, epoch: int): bool =
  classify(Unanswered({ childAlive: childAlive, socketAccepts: socketAccepts }), epoch) != Ok
pure def lawSilentLiveChildIsBusy(socketAccepts: bool, epoch: int): bool =
  classify(Unanswered({ childAlive: true, socketAccepts: socketAccepts }), epoch) == Busy
```

### Three busy probes or three dead probes since the last Ok probe restart the agent

`Busy` adds no strike: the agent is alive, usually inside a native call. It
counts a busy tick, and three busy ticks mean the agent is wedged. `Dead`
adds a strike, and three strikes restart. Neither result clears the other
count. `Ok` resets both. A `Restart` verdict starts a fresh watch for the
next launch.

```quint
type HealthWatch = { strikes: int, busyTicks: int, refusals: int }
type JournaledChild = NoJournal | Journaled({ childEpoch: int, alive: bool })
type Observation = Probed({ reply: ProbeReply }) | ConnectChecked({ refused: bool, child: JournaledChild })
type Verdict = KeepRunning | Restart
pure val freshWatch: HealthWatch = { strikes: 0, busyTicks: 0, refusals: 0 }
pure val restartStrikes = 3
pure val busyRestartTicks = 3
pure val absenceRefusals = 2
pure def absenceProven(refusals: int, child: JournaledChild, epoch: int): bool = match child {
  | Journaled(c) => refusals >= absenceRefusals and c.childEpoch == epoch and not(c.alive)
  | NoJournal => false
}
pure def probeVerdict(w: HealthWatch, result: Probe): Verdict =
  if ((result == Busy and w.busyTicks + 1 >= busyRestartTicks) or (result == Dead and w.strikes + 1 >= restartStrikes)) Restart else KeepRunning
pure def afterProbe(w: HealthWatch, result: Probe): HealthWatch =
  if (result == Ok) { ...w, strikes: 0, busyTicks: 0 } else if (result == Busy) { ...w, busyTicks: w.busyTicks + 1 } else { ...w, strikes: w.strikes + 1 }
pure def verdict(w: HealthWatch, seen: Observation, epoch: int): Verdict = match seen {
  | Probed(p) => probeVerdict(w, classify(p.reply, epoch))
  | ConnectChecked(c) => if (c.refused and absenceProven(w.refusals + 1, c.child, epoch)) Restart else KeepRunning
}
pure def afterObservation(w: HealthWatch, seen: Observation, epoch: int): HealthWatch =
  if (verdict(w, seen, epoch) == Restart) freshWatch
  else match seen {
    | Probed(p) => afterProbe(w, classify(p.reply, epoch))
    | ConnectChecked(c) => if (c.refused) { ...w, refusals: w.refusals + 1 } else { ...w, refusals: 0 }
  }
pure def watchBounded(w: HealthWatch): bool =
  w.strikes >= 0 and w.strikes < restartStrikes and w.busyTicks >= 0 and w.busyTicks < busyRestartTicks and w.refusals >= 0
pure val wValues = Set(freshWatch, { strikes: 2, busyTicks: 0, refusals: 0 }, { strikes: 0, busyTicks: 2, refusals: 1 }, { strikes: 1, busyTicks: 1, refusals: 2 })
pure val childValues = Set(NoJournal, Journaled({ childEpoch: 1, alive: false }), Journaled({ childEpoch: 1, alive: true }), Journaled({ childEpoch: 2, alive: false }))
pure def lawBusyAddsNoStrike(w: HealthWatch, reply: ProbeReply, epoch: int): bool =
  (watchBounded(w) and classify(reply, epoch) == Busy) implies afterObservation(w, Probed({ reply: reply }), epoch).strikes <= w.strikes
pure def lawOkClearsBothCounts(w: HealthWatch, reply: ProbeReply, epoch: int): bool =
  classify(reply, epoch) == Ok implies (verdict(w, Probed({ reply: reply }), epoch) == KeepRunning and afterObservation(w, Probed({ reply: reply }), epoch).strikes == 0 and afterObservation(w, Probed({ reply: reply }), epoch).busyTicks == 0)
pure def lawProbeRestartNeedsThreeOfOneKind(w: HealthWatch, reply: ProbeReply, epoch: int): bool =
  (watchBounded(w) and verdict(w, Probed({ reply: reply }), epoch) == Restart) implies (w.busyTicks == busyRestartTicks - 1 or w.strikes == restartStrikes - 1)
pure def lawWatchStaysBounded(w: HealthWatch, reply: ProbeReply, refused: bool, child: JournaledChild, epoch: int): bool =
  watchBounded(w) implies (watchBounded(afterObservation(w, Probed({ reply: reply }), epoch)) and watchBounded(afterObservation(w, ConnectChecked({ refused: refused, child: child }), epoch)))
```

### Absence needs two refused connects in a row and the dead journaled child of this launch

A refused connect alone is only a trigger: it may be a socket being
recreated. The agent is absent, and restarted, only when the connect check
was refused twice in a row and the child journaled for this launch (pid and
epoch) is no longer alive. A timeout or an unready answer never counts
toward absence, and an accepted connect clears the refusals.

```quint
pure def lawAbsenceNeedsBothFacts(w: HealthWatch, refused: bool, child: JournaledChild, epoch: int): bool =
  verdict(w, ConnectChecked({ refused: refused, child: child }), epoch) == Restart implies (refused and w.refusals + 1 >= absenceRefusals and child == Journaled({ childEpoch: epoch, alive: false }))
pure def lawProbeNeverCountsTowardAbsence(w: HealthWatch, reply: ProbeReply, epoch: int): bool =
  watchBounded(w) implies afterObservation(w, Probed({ reply: reply }), epoch).refusals <= w.refusals
pure def lawAcceptedConnectClearsRefusals(w: HealthWatch, child: JournaledChild, epoch: int): bool =
  afterObservation(w, ConnectChecked({ refused: false, child: child }), epoch).refusals == 0
```

## Story: Wait longer after each restart

> As a device owner, I want a crashing agent restarted after a growing
> pause, so that a loop of crashes does not drain my battery.

### The delay before restart attempt n is 1, 2, 4, 8, 16, 32 s and then 60 s

The lifecycle restarts after every crash and resets the count after
`stableRunMs` of running; the table's tail caps every longer count at 60 s,
so a crash loop starts the agent at most once a minute.

```quint
pure val stableRunMs = 300000
pure def restartDelay(n: int): int = List(1000, 2000, 4000, 8000, 16000, 32000, 60000).nthOr(n, 60000)
pure val nValues = Set(0, 1, 2, 3, 4, 5, 6, 7, 8)
pure def lawDelayGrowsAndIsCapped(n: int): bool =
  n >= 0 implies (restartDelay(n) >= 1000 and restartDelay(n) <= 60000 and restartDelay(n) <= restartDelay(n + 1))
```

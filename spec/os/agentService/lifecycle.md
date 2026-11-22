# Agent service lifecycle

The Android foreground service that runs the one agent Node child. Each
start is a launch with a new epoch: the service checks the payload, reaps a
child an earlier launch left behind, runs the consumer's launch hook,
spawns the agent with the launch frame of `spec/agent/host/launch.md`, and
serves once the agent answers ready for that epoch. It restarts a crashed or
unhealthy agent within the budget of [health](./health.md), follows the
device key of [credential](../signIn/credential.md), keeps a failed store's
records until the owner moves them aside, and holds the agent for an app
update. Spawning, the socket, the pid and epoch journal, the notification
and the files stay in the Java shell, which reports only what the child of
the current launch did.

## Story: Start the agent after checking its payload

> As a device owner, I want my agent started only from a checked payload
> and a held key, and seen as running only once it answers, so that a
> broken install or a half-started agent never serves me.

### A start begins a new launch only from Stopped or Failed, and a start asked during a stop runs after the exit

No start is taken while an update holds the agent. The shell runs the
check (`BeginCheck`) after the delay it names; an explicit start (also on
boot or package replacement) renews the restart budget.

```quint
import health as H from "./health"
import launch as L from "../../agent/host/launch"
import credential as C from "../signIn/credential"
type StartStep = Checking | Spawned
type FailureCause = Payload | Storage | Config | Credential | Agent | Crashed | Runtime
type AfterExit = ToStopped | ToStart | ToRestart | ToCredentialFailure
type ServicePhase = Stopped | Starting({ step: StartStep }) | Running | Stopping({ onExit: AfterExit }) | Failed({ cause: FailureCause })
type Child = NoChild | Owned({ ownedEpoch: int }) | Stale({ staleEpoch: int })
type KeyView = NoKey | Key({ version: int, account: C::Account })
type Review = NoReview | Reviewed({ token: int, reviewEpoch: int })
type UpdateHold = NotHeld | HeldFor({ target: int })
type ServiceEffect = BeginCheck({ epoch: int, delayMs: int }) | KillChild | PushCredential({ pushEpoch: int, version: int }) | ArchiveData
type AgentService = { phase: ServicePhase, epoch: int, attempt: int, child: Child, readyEpoch: int, key: KeyView, newestVersion: int,
  delivered: int, launched: C::Account, watch: H::HealthWatch, review: Review, tokens: int, hold: UpdateHold }
type ServiceStep = { state: AgentService, out: List[ServiceEffect] }
pure val initial: AgentService = { phase: Stopped, epoch: 0, attempt: 0, child: NoChild, readyEpoch: 0, key: NoKey, newestVersion: 0,
  delivered: 0, launched: C::noAccount, watch: H::freshWatch, review: NoReview, tokens: 0, hold: NotHeld }
pure def isFailed(p: ServicePhase): bool = match p { | Failed(_) => true | _ => false }
pure def isStopping(p: ServicePhase): bool = match p { | Stopping(_) => true | _ => false }
pure def isStarting(p: ServicePhase): bool = match p { | Starting(_) => true | _ => false }
pure def enter(p: ServicePhase, s: AgentService): AgentService = { ...s, phase: p, review: NoReview }
pure def emit(out: List[ServiceEffect], s: AgentService): ServiceStep = { state: s, out: out }
pure def launch(attempt: int, delayMs: int, s: AgentService): ServiceStep = {
  val entered = enter(Starting({ step: Checking }), s)
  emit(List(BeginCheck({ epoch: s.epoch + 1, delayMs: delayMs })), { ...entered, epoch: s.epoch + 1, attempt: attempt, watch: H::freshWatch })
}
pure def canStart(s: AgentService): bool = s.hold == NotHeld and (s.phase == Stopped or isFailed(s.phase) or isStopping(s.phase))
pure def start(s: AgentService): ServiceStep =
  if (isStopping(s.phase)) emit(List(), { ...s, phase: Stopping({ onExit: ToStart }) }) else launch(0, 0, s)
pure def isBeginCheck(e: ServiceEffect): bool = match e { | BeginCheck(_) => true | _ => false }
pure def stepEachLaunchIsOneNewEpoch(before: AgentService, via: str, after: AgentService, out: List[ServiceEffect]): bool =
  if (after.epoch != before.epoch)
    after.epoch == before.epoch + 1 and after.phase == Starting({ step: Checking })
      and out == List(BeginCheck({ epoch: after.epoch, delayMs: if (after.attempt == before.attempt + 1) H::restartDelay(before.attempt) else 0 }))
      and (after.attempt == 0 or after.attempt == before.attempt + 1)
  else not(out.some(e => isBeginCheck(e)))
pure def sometimesRunning(s: AgentService): bool = s.phase == Running
```

### A child is spawned only after the stale child is reaped, a key is held and every check passed

A child an earlier launch journaled is killed before any spawn. A check
refuses with the cause it found and spawns nothing: payload digests differ
from the inventory (`Payload`), the launch hook (run once per launch,
returning only non-secret variables) or the configuration refused
(`Config`), the state directory cannot be prepared (`Storage`), no key is
held (`Credential`), anything else (`Runtime`). A failed spawn is
`Failed(Agent)`. The child gets the held key and the state directory of the
key's account (for example `filesDir/agent/<account digest>`).

```quint
pure def childOwned(c: Child): bool = match c { | Owned(_) => true | _ => false }
pure def keyVersion(k: KeyView): int = match k { | Key(x) => x.version | NoKey => 0 }
pure def keyAccount(k: KeyView): C::Account = match k { | Key(x) => x.account | NoKey => C::noAccount }
pure def childPhase(p: ServicePhase): bool = p == Starting({ step: Spawned }) or p == Running or isStopping(p)
pure def canReapStale(s: AgentService): bool = s.child != NoChild and not(childOwned(s.child))
pure def reapStale(s: AgentService): AgentService = { ...s, child: NoChild }
pure def canRefuse(s: AgentService, cause: FailureCause): bool = s.phase == Starting({ step: Checking }) and s.child == NoChild
  and (cause == Payload or cause == Config or cause == Storage or cause == Runtime or (cause == Credential and s.key == NoKey))
pure def refuse(s: AgentService, cause: FailureCause): AgentService = enter(Failed({ cause: cause }), s)
pure def canSpawn(s: AgentService, ok: bool): bool = s.phase == Starting({ step: Checking }) and s.child == NoChild and s.key != NoKey
pure def spawn(s: AgentService, ok: bool): AgentService =
  if (ok) { ...s, phase: Starting({ step: Spawned }), child: Owned({ ownedEpoch: s.epoch }), delivered: keyVersion(s.key), launched: keyAccount(s.key) }
  else enter(Failed({ cause: Agent }), s)
pure def childOfThisLaunch(s: AgentService): bool = { val c = s.child
  match c { | Owned(o) => o.ownedEpoch == s.epoch and s.epoch >= 1 | Stale(x) => x.staleEpoch >= 1 and x.staleEpoch <= s.epoch | NoChild => true } }
pure def alwaysChildOnlyWhileLaunched(s: AgentService): bool =
  (childOwned(s.child) iff childPhase(s.phase)) and childOfThisLaunch(s) and s.epoch >= 0 and s.readyEpoch >= 0 and s.readyEpoch <= s.epoch
pure def sometimesPayloadRefused(s: AgentService): bool = s.phase == Failed({ cause: Payload })
pure def sometimesStaleChildLeft(s: AgentService): bool = s.phase == Starting({ step: Checking }) and s.child != NoChild
```

### The agent runs only once it answers ready for this launch, and a launch that never does fails as Agent

Readiness is `H::classify` of the health answer for this epoch. After
60 s the shell kills the child, which stays journaled until it is reaped.
An exit before readiness is `Config` or `Storage` when `L::exitClass` says
so and `Agent` otherwise, and is never retried.

```quint
pure val readinessTimeoutMs = 60000
pure def readyReply(epoch: int): H::ProbeReply = H::Answered({ status: 200, body: H::Parsed({ ready: true, runtime: "ok", agentState: "running", epoch: epoch }) })
pure val replyValues = Set(readyReply(1), readyReply(2), readyReply(3), readyReply(4), readyReply(5), readyReply(6), H::Answered({ status: 503, body: H::Unparsed }))
pure def canObserveReady(s: AgentService, reply: H::ProbeReply): bool = s.phase == Starting({ step: Spawned }) and H::classify(reply, s.epoch) == H::Ok
pure def observeReady(s: AgentService, reply: H::ProbeReply): ServiceStep = {
  val v = keyVersion(s.key)
  emit(if (v > s.delivered) List(PushCredential({ pushEpoch: s.epoch, version: v })) else List(),
    { ...s, phase: Running, readyEpoch: s.epoch, delivered: v, watch: H::freshWatch })
}
pure def canReadinessTimedOut(s: AgentService): bool = s.phase == Starting({ step: Spawned })
pure def readinessTimedOut(s: AgentService): ServiceStep = {
  val failed = enter(Failed({ cause: Agent }), s)
  emit(List(KillChild), { ...failed, child: Stale({ staleEpoch: s.epoch }) })
}
pure val codeValues = Set(0, 1, 70, 74, 77, 78, 137)
pure def startupCause(code: int): FailureCause =
  if (L::exitClass(code) == L::BootFailed({ cause: L::Config })) Config
  else if (L::exitClass(code) == L::BootFailed({ cause: L::Storage })) Storage else Agent
pure def alwaysRunningWasReadyThisLaunch(s: AgentService): bool =
  (s.phase == Running implies s.readyEpoch == s.epoch) and (isStarting(s.phase) implies s.readyEpoch < s.epoch)
    and (s.phase == Stopping({ onExit: ToRestart }) implies s.readyEpoch == s.epoch)
pure def sometimesStorageFailedAtStart(s: AgentService): bool = s.phase == Failed({ cause: Storage }) and s.readyEpoch < s.epoch
pure def sometimesTimedOut(s: AgentService): bool = s.phase == Failed({ cause: Agent }) and s.child != NoChild
pure val weight_spawn = 50
pure val weight_observeReady = 90
pure val fair_observeReady = "weak"
pure val fair_readinessTimedOut = "weak"
pure def leadsToReadinessWaitSettles(s: AgentService, later: AgentService): bool =
  s.phase == Starting({ step: Spawned }) implies not(later.phase == Starting({ step: Spawned }) and later.epoch == s.epoch)
```

### A stop before the spawn spawns nothing, and a stop of a live child waits for its exit

A later start or stop only changes what follows the exit. A stop of a
failed service clears the failure.

```quint
pure def canStop(s: AgentService): bool = s.phase != Stopped
pure def stop(s: AgentService): ServiceStep =
  if (isStopping(s.phase)) emit(List(), { ...s, phase: Stopping({ onExit: ToStopped }) })
  else if (childPhase(s.phase)) emit(List(KillChild), enter(Stopping({ onExit: ToStopped }), s))
  else emit(List(), enter(Stopped, s))
pure def canObserveExit(s: AgentService, code: int): bool = childOwned(s.child)
pure def afterExit(onExit: AfterExit, s: AgentService): ServiceStep =
  if (onExit == ToStopped) emit(List(), enter(Stopped, s)) else if (onExit == ToStart) launch(0, 0, s)
  else if (onExit == ToRestart) restartOrFail(s.attempt, s) else emit(List(), enter(Failed({ cause: Credential }), s))
pure def observeExit(s: AgentService, code: int): ServiceStep = {
  val gone = { ...s, child: NoChild }
  val p = s.phase
  match p {
    | Starting(_) => emit(List(), enter(Failed({ cause: startupCause(code) }), gone))
    | Running => restartOrFail(s.attempt, gone)
    | Stopping(x) => afterExit(x.onExit, gone)
    | _ => emit(List(), s)
  }
}
pure def isKill(e: ServiceEffect): bool = e == KillChild
pure def stepKillOnlyALiveChild(before: AgentService, via: str, after: AgentService, out: List[ServiceEffect]): bool =
  out.some(e => isKill(e)) implies (childOwned(before.child) and not(before.phase == Running and after.phase == Running))
pure def sometimesStopping(s: AgentService): bool = s.phase == Stopping({ onExit: ToStopped })
pure val weight_observeExit = 16
```

### The service restarted by Android keeps the epoch, the key and the hold, and leaves its old child to be reaped

The journal keeps the epoch and the child's pid, the hold is durable and
the key is read back from the credential; the service comes back
`Stopped` and the old child is stale until reaped.

```quint
pure def processRestarted(s: AgentService): AgentService = {
  val back = enter(Stopped, s)
  val c = s.child
  { ...back, watch: H::freshWatch, child: match c { | Owned(o) => Stale({ staleEpoch: o.ownedEpoch }) | _ => s.child } }
}
pure def stepRestartKeepsDurableFacts(before: AgentService, via: str, after: AgentService): bool =
  via == "processRestarted" implies (after.epoch == before.epoch and after.key == before.key and after.hold == before.hold and after.delivered == before.delivered)
pure val weight_processRestarted = 1
```

### The status names a failure exactly when the service failed, and the notification is up in every state but Stopped

The bridge reports `{available, state, failure, error, epoch,
requestBodyLimit}`: `Starting` is `starting`, `Stopping` is `stopped`, an
app with no agent service is `unavailable`, and `requestBodyLimit` comes
from the agent's status. The notification uses the consumer's channel and
words, with a stop action when the consumer asks for one.

```quint
type AgentStatus = { bridgeState: str, failure: str, epoch: int, notice: bool }
pure def causeName(c: FailureCause): str = match c {
  | Payload => "payload" | Storage => "storage" | Config => "config" | Credential => "credential" | Agent => "agent" | Crashed => "crashed" | Runtime => "runtime" }
pure def statusOf(s: AgentService): AgentStatus = {
  val p = s.phase
  match p {
    | Stopped => { bridgeState: "stopped", failure: "", epoch: s.epoch, notice: false }
    | Starting(_) => { bridgeState: "starting", failure: "", epoch: s.epoch, notice: true }
    | Running => { bridgeState: "running", failure: "", epoch: s.epoch, notice: true }
    | Stopping(_) => { bridgeState: "stopped", failure: "", epoch: s.epoch, notice: true }
    | Failed(f) => { bridgeState: "failed", failure: causeName(f.cause), epoch: s.epoch, notice: true }
  }
}
pure def alwaysStatusTellsTheTruth(s: AgentService): bool = ((statusOf(s).failure != "") iff isFailed(s.phase)) and (statusOf(s).notice iff s.phase != Stopped)
  and (statusOf(s).bridgeState == "running" implies (s.readyEpoch == s.epoch and childOwned(s.child)))
```

## Story: Restart a crashed or unhealthy agent within a budget

> As a device owner, I want an agent that crashes or stops answering
> restarted after a growing pause, and given up on after five restarts in
> a row, so that it comes back by itself without draining my battery.

### Any exit after readiness is a crash, restarted after the health delay while fewer than five restarts were made

The agent never exits on its own once ready, so any code is a crash. The
sixth crash in a row is `Failed(Crashed)`, which an explicit start clears.

```quint
pure def restartOrFail(attempt: int, s: AgentService): ServiceStep =
  if (attempt < H::restartBudget) launch(attempt + 1, H::restartDelay(attempt), s)
  else emit(List(), enter(Failed({ cause: Crashed }), s))
pure def alwaysCrashedOnlyAfterTheBudget(s: AgentService): bool = s.attempt >= 0 and s.attempt <= H::restartBudget
  and (s.phase == Failed({ cause: Crashed }) implies (s.attempt == H::restartBudget and s.readyEpoch == s.epoch))
pure def sometimesRestartedAfterCrash(s: AgentService): bool = s.phase == Running and s.attempt >= 1
pure def sometimesCrashed(s: AgentService): bool = s.phase == Failed({ cause: Crashed })
```

### An unhealthy verdict kills the child and counts as a crash

Each health observation of the running launch is folded into the watch;
after a `Restart` verdict the child's exit is a crash under the same
budget.

```quint
pure def canObserveHealth(s: AgentService, observed: H::Observation): bool = s.phase == Running and H::verdict(s.watch, observed, s.epoch) == H::KeepRunning
pure def observeHealth(s: AgentService, observed: H::Observation): AgentService = { ...s, watch: H::afterObservation(s.watch, observed, s.epoch) }
pure def canRestartUnhealthy(s: AgentService, observed: H::Observation): bool = s.phase == Running and H::verdict(s.watch, observed, s.epoch) == H::Restart
pure def restartUnhealthy(s: AgentService, observed: H::Observation): ServiceStep = {
  val killing = enter(Stopping({ onExit: ToRestart }), s)
  emit(List(KillChild), { ...killing, watch: H::freshWatch })
}
pure val observedValues = Set(
  H::Probed({ reply: H::Answered({ status: 503, body: H::Unparsed }) }),
  H::Probed({ reply: H::Unanswered({ childAlive: true, socketAccepts: false }) }),
  H::ConnectChecked({ refused: true, child: H::Journaled({ childEpoch: 1, alive: false }) }),
  H::ConnectChecked({ refused: false, child: H::NoJournal }))
pure val weight_observeHealth = 4
pure def sometimesKilledAsUnhealthy(s: AgentService): bool = s.phase == Stopping({ onExit: ToRestart })
```

### Five minutes of running renew the restart budget

The shell sends `stableRun` after `H::stableRunMs` in `Running`.

```quint
pure def canStableRun(s: AgentService): bool = s.phase == Running and s.attempt > 0
pure def stableRun(s: AgentService): AgentService = { ...s, attempt: 0 }
pure def stepBudgetRenewedOnlyByStartOrStableRun(before: AgentService, via: str, after: AgentService): bool =
  (after.attempt < before.attempt) implies (after.attempt == 0 and (via == "stableRun" or after.epoch == before.epoch + 1))
```

## Story: Start the agent when I sign in and stop it when I sign out

> As a device owner, I want my agent to run only while I am signed in, on
> my own account's records, so that nobody else's agent or records run on
> my phone.

### Sign-out or an expired key fails the agent as Credential, and a key that arrives then starts it

The credential's `SignedOutNotice` and `ExpiredNotice` withdraw the key;
a live child is killed first, and a stopped service stays stopped. The
next `Announce` starts the agent without using the budget, unless an
update holds it.

```quint
pure val versionValues = Set(1, 2, 3)
pure val accountValues = Set({ userId: "u1", organizationId: "o1" }, { userId: "u2", organizationId: "o1" })
pure def accountNamed(a: C::Account): bool = a.userId != "" and a.organizationId != ""
pure def canCredentialArrived(s: AgentService, version: int, account: C::Account): bool = s.key == NoKey and version > s.newestVersion and accountNamed(account)
pure def credentialArrived(s: AgentService, version: int, account: C::Account): ServiceStep = {
  val keyed = { ...s, key: Key({ version: version, account: account }), newestVersion: version }
  if (s.phase == Failed({ cause: Credential })) (if (s.hold == NotHeld) launch(0, 0, keyed) else emit(List(), enter(Stopped, keyed)))
  else if (s.phase == Stopping({ onExit: ToCredentialFailure })) emit(List(), { ...keyed, phase: Stopping({ onExit: ToStart }) })
  else emit(List(), keyed)
}
pure def canCredentialWithdrawn(s: AgentService): bool = s.key != NoKey
pure def credentialWithdrawn(s: AgentService): ServiceStep = {
  val keyless = { ...s, key: NoKey }
  if (childPhase(s.phase) and not(isStopping(s.phase))) emit(List(KillChild), enter(Stopping({ onExit: ToCredentialFailure }), keyless))
  else if (isStopping(s.phase)) emit(List(), { ...keyless, phase: if (s.phase == Stopping({ onExit: ToStopped })) s.phase else Stopping({ onExit: ToCredentialFailure }) })
  else if (s.phase == Stopped) emit(List(), keyless)
  else emit(List(), enter(Failed({ cause: Credential }), keyless))
}
pure def alwaysCredentialFailureHoldsNoKey(s: AgentService): bool =
  (s.phase == Failed({ cause: Credential }) or s.phase == Stopping({ onExit: ToCredentialFailure })) implies s.key == NoKey
pure def alwaysLaunchCarriesTheNewestKey(s: AgentService): bool = s.delivered >= 0 and s.delivered <= s.newestVersion
  and (s.key != NoKey implies keyVersion(s.key) == s.newestVersion)
  and (childPhase(s.phase) and not(isStopping(s.phase)) implies (s.key != NoKey and keyAccount(s.key) == s.launched and s.delivered <= keyVersion(s.key)))
  and (s.phase == Running implies s.delivered == keyVersion(s.key))
pure def sometimesWaitingForSignIn(s: AgentService): bool = s.phase == Failed({ cause: Credential }) and s.newestVersion >= 1
pure def sometimesStartedBySignIn(s: AgentService): bool = s.phase == Running and s.newestVersion >= 2 and s.attempt == 0 and s.epoch >= 2
pure val weight_credentialArrived = 4
```

### Another account's key restarts the agent on that account's directory

The agent refuses a store opened under another account, so a live child
is killed and a new launch follows its exit; this costs no restart
budget.

```quint
pure def canAccountChanged(s: AgentService, version: int, account: C::Account): bool =
  s.key != NoKey and keyAccount(s.key) != account and accountNamed(account) and version > s.newestVersion
pure def accountChanged(s: AgentService, version: int, account: C::Account): ServiceStep = {
  val keyed = { ...s, key: Key({ version: version, account: account }), newestVersion: version }
  if (childPhase(s.phase) and not(isStopping(s.phase))) emit(List(KillChild), enter(Stopping({ onExit: ToStart }), keyed))
  else if (s.phase == Stopping({ onExit: ToRestart })) emit(List(), { ...keyed, phase: Stopping({ onExit: ToStart }) })
  else emit(List(), keyed)
}
pure def sometimesRestartingForAnotherAccount(s: AgentService): bool = s.phase == Stopping({ onExit: ToStart }) and keyAccount(s.key) != s.launched
```

## Story: Hand a new device key of the same account to the running agent

> As a device owner who signs in again on the same account, I want my
> running agent to take the new key without a restart, so that nothing I
> asked of it is cut off.

### A newer key of the same account is pushed to a running agent and never changes the phase

A launch not yet ready gets the newest key when it becomes ready, or in
its launch frame. The delivered version never goes back.

```quint
pure def canCredentialReplaced(s: AgentService, version: int): bool = s.key != NoKey and version > s.newestVersion
pure def credentialReplaced(s: AgentService, version: int): ServiceStep = {
  val keyed = { ...s, key: Key({ version: version, account: keyAccount(s.key) }), newestVersion: version }
  if (s.phase == Running) emit(List(PushCredential({ pushEpoch: s.epoch, version: version })), { ...keyed, delivered: version })
  else emit(List(), keyed)
}
pure def isPush(e: ServiceEffect): bool = match e { | PushCredential(_) => true | _ => false }
pure def stepNewKeyNeverRestarts(before: AgentService, via: str, after: AgentService, out: List[ServiceEffect]): bool =
  (via == "credentialReplaced" implies (after.phase == before.phase and after.epoch == before.epoch))
    and (out.some(e => isPush(e)) implies (after.phase == Running and out == List(PushCredential({ pushEpoch: after.epoch, version: after.delivered }))))
    and after.delivered >= before.delivered
pure def sometimesKeyPushedWithoutRestart(s: AgentService): bool = s.phase == Running and s.epoch == 1 and s.delivered >= 2
```

## Story: Recover my agent's records after a storage failure

> As a device owner whose agent cannot open its records, I want to review
> what is kept and move it aside myself, so that my records are never
> deleted and my agent can start again.

### Only the exact review token of this failure moves the data aside, and then the agent may start

A review needs `Failed(Storage)`, no child left and a focused foreground
screen; its token is bound to the epoch and replaces any earlier one, and
any change of phase drops it. Archiving moves the account's state
directory aside, never deletes it, and leaves the service `Stopped`.

```quint
pure def canReviewRecovery(s: AgentService, focused: bool): bool = focused and s.phase == Failed({ cause: Storage }) and s.child == NoChild
pure def reviewRecovery(s: AgentService, focused: bool): AgentService =
  { ...s, review: Reviewed({ token: s.tokens + 1, reviewEpoch: s.epoch }), tokens: s.tokens + 1 }
pure def canArchiveRecovery(s: AgentService, token: int): bool =
  s.phase == Failed({ cause: Storage }) and s.review == Reviewed({ token: token, reviewEpoch: s.epoch })
pure def archiveRecovery(s: AgentService, token: int): ServiceStep = emit(List(ArchiveData), enter(Stopped, s))
pure val tokenValues = Set(1, 2)
pure def alwaysReviewBelongsToThisFailure(s: AgentService): bool = s.tokens >= 0 and (s.review == NoReview
  or (s.review == Reviewed({ token: s.tokens, reviewEpoch: s.epoch }) and s.phase == Failed({ cause: Storage }) and s.child == NoChild))
pure def stepDataMovedAsideOnlyByItsReview(before: AgentService, via: str, after: AgentService, out: List[ServiceEffect]): bool =
  out.includes(ArchiveData) implies (before.review == Reviewed({ token: before.tokens, reviewEpoch: before.epoch }) and after.phase == Stopped)
pure def sometimesRecoveryReviewed(s: AgentService): bool = s.review != NoReview
pure val weight_reviewRecovery = 3
pure val weight_archiveRecovery = 3
```

## Story: Hold the agent for an app update

> As a device owner installing an app update, I want the agent kept
> stopped from the install until the new app is in place or the attempt
> ended, so that no agent runs on half-replaced code.

### A hold is taken only with no child, blocks every start and is released only for its target or an ended attempt

The install journal (`appUpdate/install.md`) takes the hold after the
agent stopped. A release counts only when the installed code and digest
equal the target, or the attempt is proven ended (baseline installed, no
session pending). The hold survives a restart of the service.

```quint
type UpdateOutcome = Installed({ artifact: int }) | AttemptEnded
pure def canHoldForUpdate(s: AgentService, target: int): bool =
  s.hold == NotHeld and target >= 1 and s.child == NoChild and (s.phase == Stopped or isFailed(s.phase))
pure def holdForUpdate(s: AgentService, target: int): AgentService = { ...s, hold: HeldFor({ target: target }) }
pure def canReleaseUpdate(s: AgentService, result: UpdateOutcome): bool = { val h = s.hold
  match h { | HeldFor(x) => result == Installed({ artifact: x.target }) or result == AttemptEnded | NotHeld => false } }
pure def releaseUpdate(s: AgentService, result: UpdateOutcome): AgentService = { ...s, hold: NotHeld }
pure val targetValues = Set(1, 2)
pure val resultValues = Set(Installed({ artifact: 1 }), Installed({ artifact: 2 }), AttemptEnded)
pure def alwaysHeldMeansNoAgent(s: AgentService): bool = s.hold != NotHeld implies (s.child == NoChild and (s.phase == Stopped or isFailed(s.phase)))
pure def stepHoldEndsOnlyByRelease(before: AgentService, via: str, after: AgentService): bool =
  (before.hold != NotHeld and after.hold != before.hold) implies via == "releaseUpdate"
pure def sometimesHeldForUpdate(s: AgentService): bool = s.hold != NotHeld and s.key != NoKey
pure val weight_holdForUpdate = 2
```

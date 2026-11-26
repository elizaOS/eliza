# Agent service lifecycle

The Android foreground service that runs the one agent Node child. Each
start is a launch with a new epoch: the service checks the payload, reaps a
child an earlier launch left behind, runs the consumer's launch hook,
spawns the agent with the launch frame of `spec/agent/host/launch.md`, and
serves once the agent answers ready for that epoch. It restarts a crashed,
unhealthy or never-ready agent after the delay of [health](./health.md),
however often that happens, follows the
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

No start is taken while an update holds the agent or its records need
recovery after a storage failure. The shell runs the
check (`BeginCheck`) after the delay it names; an explicit start (also on
boot or package replacement) resets the restart delay.
Before it publishes a check, the shell saves and syncs that launch's
epoch. A failed save reports `Runtime` and publishes no check.

```quint
import health as H from "./health"
import launch as L from "../../agent/host/launch"
import credential as C from "../signIn/credential"
type StartStep = Checking | Spawned
type FailureCause = Payload | Storage | Config | Credential | Agent | Runtime
type AfterExit = ToStopped | ToStart | ToRestart | ToCredentialFailure
type ServicePhase = Stopped | Starting({ step: StartStep }) | Running | Stopping({ onExit: AfterExit }) | Failed({ cause: FailureCause })
type Child = NoChild | Owned({ ownedEpoch: int }) | Stale({ staleEpoch: int })
type KeyView = NoKey | Key({ version: int, account: C::Account })
type Review = NoReview | Reviewed({ token: int, reviewEpoch: int }) | Archiving({ token: int, reviewEpoch: int })
type UpdateHold = NotHeld | HeldFor({ target: int }) | UnconfirmedHold({ pendingTarget: int })
type ServiceEffect = BeginCheck({ epoch: int, delayMs: int }) | KillChild | PushCredential({ pushEpoch: int, version: int }) | ArchiveData({ token: int, archiveEpoch: int })
type AgentService = { phase: ServicePhase, epoch: int, attempt: int, child: Child, readyEpoch: int, key: KeyView, newestVersion: int,
  delivered: int, launched: C::Account, watch: H::HealthWatch, review: Review, tokens: int, hold: UpdateHold, epochUnconfirmed: bool }
type ServiceStep = { state: AgentService, out: List[ServiceEffect] }
pure val initial: AgentService = { phase: Stopped, epoch: 0, attempt: 0, child: NoChild, readyEpoch: 0, key: NoKey, newestVersion: 0,
  delivered: 0, launched: C::noAccount, watch: H::freshWatch, review: NoReview, tokens: 0, hold: NotHeld, epochUnconfirmed: false }
pure def isFailed(p: ServicePhase): bool = match p { | Failed(_) => true | _ => false }
pure def isStopping(p: ServicePhase): bool = match p { | Stopping(_) => true | _ => false }
pure def isStarting(p: ServicePhase): bool = match p { | Starting(_) => true | _ => false }
pure def storageFailed(s: AgentService): bool = s.phase == Failed({ cause: Storage })
pure def enter(p: ServicePhase, s: AgentService): AgentService = { ...s, phase: p, review: NoReview }
pure def emit(out: List[ServiceEffect], s: AgentService): ServiceStep = { state: s, out: out }
pure def launch(attempt: int, delayMs: int, s: AgentService): ServiceStep = {
  val entered = enter(Starting({ step: Checking }), s)
  emit(List(BeginCheck({ epoch: s.epoch + 1, delayMs: delayMs })), { ...entered, epoch: s.epoch + 1, attempt: attempt, watch: H::freshWatch, epochUnconfirmed: false })
}
pure def canStart(s: AgentService): bool = s.hold == NotHeld and not(storageFailed(s)) and (s.phase == Stopped or isFailed(s.phase) or isStopping(s.phase))
pure def start(s: AgentService): ServiceStep =
  if (isStopping(s.phase)) emit(List(), { ...s, phase: Stopping({ onExit: ToStart }) }) else launch(0, 0, s)
pure def isBeginCheck(e: ServiceEffect): bool = match e { | BeginCheck(_) => true | _ => false }
type LaunchRequest = StartRequested | ExitObserved({ code: int }) | CredentialObserved({ version: int, account: C::Account })
pure def launchRequestAllowed(s: AgentService, request: LaunchRequest): bool = match request {
  | StartRequested => canStart(s)
  | ExitObserved(x) => canObserveExit(s, x.code)
  | CredentialObserved(x) => canCredentialArrived(s, x.version, x.account)
}
pure def requestedLaunch(request: LaunchRequest, s: AgentService): ServiceStep = match request {
  | StartRequested => start(s)
  | ExitObserved(x) => observeExit(s, x.code)
  | CredentialObserved(x) => credentialArrived(s, x.version, x.account)
}
pure def canLaunchEpochWriteFailed(s: AgentService, request: LaunchRequest, syncUnconfirmed: bool): bool =
  launchRequestAllowed(s, request) and requestedLaunch(request, s).out.some(e => isBeginCheck(e))
pure def launchEpochWriteFailed(s: AgentService, request: LaunchRequest, syncUnconfirmed: bool): AgentService = {
  val failed = enter(Failed({ cause: Runtime }), requestedLaunch(request, s).state)
  { ...failed, epoch: s.epoch, attempt: s.attempt, watch: s.watch, epochUnconfirmed: s.epochUnconfirmed or syncUnconfirmed }
}
pure val requestValues = Set(StartRequested, ExitObserved({ code: 1 }), CredentialObserved({ version: 3, account: { userId: "u1", organizationId: "o1" } }))
pure val syncUnconfirmedValues = Set(false, true)
pure def stepFailedEpochWriteNeverStarts(before: AgentService, via: str, after: AgentService, out: List[ServiceEffect]): bool =
  (via == "launchEpochWriteFailed") implies (before.epoch == after.epoch and after.phase == Failed({ cause: Runtime }) and out == List())
pure def stepEachLaunchIsOneNewEpoch(before: AgentService, via: str, after: AgentService, out: List[ServiceEffect]): bool =
  if (via == "processRestartedWithReservedEpoch")
    before.epochUnconfirmed and not(after.epochUnconfirmed) and after.epoch == before.epoch + 1 and after.phase == Stopped and out == List()
  else if (after.epoch != before.epoch)
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

### The agent runs only once it answers ready for this launch, and a launch that never does is restarted after the health delay

Readiness is `H::classify` of the health answer for this epoch. A cold
start can take minutes, as the first start after an update does, so the
shell waits 480 s before it kills the child; the child's exit then begins
the next launch after `H::restartDelay`, as a crash does. An exit before
readiness fails the service as `Config` or `Storage` when `L::exitClass`
says so; any other exit before readiness is restarted after the same
delay. Only an explicit start or a stable run resets that delay, and a
stop asked while the child is being killed still stops the service.

```quint
pure val readinessTimeoutMs = 480000
pure def readyReply(epoch: int): H::ProbeReply = H::Answered({ status: 200, body: H::Parsed({ ready: true, runtime: "ok", agentState: "running", epoch: epoch }) })
pure val replyValues = Set(readyReply(1), readyReply(2), readyReply(3), readyReply(4), readyReply(5), readyReply(6), H::Answered({ status: 503, body: H::Unparsed }))
pure def canObserveReady(s: AgentService, reply: H::ProbeReply): bool = s.phase == Starting({ step: Spawned }) and H::classify(reply, s.epoch) == H::Ok
pure def observeReady(s: AgentService, reply: H::ProbeReply): ServiceStep = {
  val v = keyVersion(s.key)
  emit(if (v > s.delivered) List(PushCredential({ pushEpoch: s.epoch, version: v })) else List(),
    { ...s, phase: Running, readyEpoch: s.epoch, delivered: v, watch: H::freshWatch })
}
pure def canReadinessTimedOut(s: AgentService): bool = s.phase == Starting({ step: Spawned })
pure def readinessTimedOut(s: AgentService): ServiceStep = emit(List(KillChild), enter(Stopping({ onExit: ToRestart }), s))
pure val codeValues = Set(0, 1, 70, 74, 77, 78, 137)
pure def startupCause(code: int): FailureCause =
  if (L::exitClass(code) == L::BootFailed({ cause: L::Config })) Config
  else if (L::exitClass(code) == L::BootFailed({ cause: L::Storage })) Storage else Agent
pure def alwaysRunningWasReadyThisLaunch(s: AgentService): bool =
  (s.phase == Running implies s.readyEpoch == s.epoch) and (isStarting(s.phase) implies s.readyEpoch < s.epoch)
pure def sometimesStorageFailedAtStart(s: AgentService): bool = s.phase == Failed({ cause: Storage }) and s.readyEpoch < s.epoch
pure def sometimesKilledAsNeverReady(s: AgentService): bool = s.phase == Stopping({ onExit: ToRestart }) and s.readyEpoch < s.epoch
pure val eval_witness_sometimesKilledAsNeverReady = (
  ("credentialArrived", 1, { userId: "u1", organizationId: "o1" }), "start", ("spawn", true), "readinessTimedOut"
)
pure def sometimesRestartedBeforeEverReady(s: AgentService): bool =
  s.phase == Starting({ step: Checking }) and s.attempt >= 2 and s.readyEpoch == 0
pure val eval_witness_sometimesRestartedBeforeEverReady = (
  ("credentialArrived", 1, { userId: "u1", organizationId: "o1" }), "start",
  ("spawn", true), "readinessTimedOut", ("observeExit", 137),
  ("spawn", true), ("observeExit", 70)
)
pure val weight_spawn = 100
pure val weight_observeReady = 100
pure val fair_observeReady = "weak"
pure val fair_readinessTimedOut = "weak"
pure def leadsToReadinessWaitSettles(s: AgentService, later: AgentService): bool =
  s.phase == Starting({ step: Spawned }) implies not(later.phase == Starting({ step: Spawned }) and later.epoch == s.epoch)
```

### A stop before the spawn spawns nothing, and a stop of a live child waits for its exit

A later start or stop only changes what follows the exit. A stop of a
failed service clears the failure except when its records need recovery.

```quint
pure def canStop(s: AgentService): bool = s.phase != Stopped and not(storageFailed(s))
pure def stop(s: AgentService): ServiceStep =
  if (isStopping(s.phase)) emit(List(), { ...s, phase: Stopping({ onExit: ToStopped }) })
  else if (childPhase(s.phase)) emit(List(KillChild), enter(Stopping({ onExit: ToStopped }), s))
  else emit(List(), enter(Stopped, s))
pure def canObserveExit(s: AgentService, code: int): bool = childOwned(s.child)
pure def afterExit(onExit: AfterExit, s: AgentService): ServiceStep =
  if (onExit == ToStopped) emit(List(), enter(Stopped, s)) else if (onExit == ToStart) launch(0, 0, s)
  else if (onExit == ToRestart) restartAfterCrash(s.attempt, s) else emit(List(), enter(Failed({ cause: Credential }), s))
pure def observeExit(s: AgentService, code: int): ServiceStep = {
  val gone = { ...s, child: NoChild }
  val p = s.phase
  match p {
    | Starting(_) => (if (startupCause(code) == Agent) restartAfterCrash(s.attempt, gone)
      else emit(List(), enter(Failed({ cause: startupCause(code) }), gone)))
    | Running => restartAfterCrash(s.attempt, gone)
    | Stopping(x) => afterExit(x.onExit, gone)
    | _ => emit(List(), s)
  }
}
pure def isKill(e: ServiceEffect): bool = e == KillChild
pure def stepKillOnlyALiveChild(before: AgentService, via: str, after: AgentService, out: List[ServiceEffect]): bool =
  out.some(e => isKill(e)) implies (childOwned(before.child) and not(before.phase == Running and after.phase == Running))
pure def sometimesStopping(s: AgentService): bool = s.phase == Stopping({ onExit: ToStopped })
pure val weight_observeExit = 10
```

### The service restarted by Android keeps the epoch, the key and the hold, and leaves its old child to be reaped

The journal keeps the newest reserved epoch separately from the epoch and
pid of its child so a recovery package can still read the child record.
The service uses the higher epoch from the two records. Only the child
record can identify a child to reap. The hold is durable and the key is
read back from the credential. The service comes back `Stopped` at the
journal's synced epoch. Any old child is stale until reaped. If the last
write renamed its record but could not confirm the directory sync,
restart can recover that reservation only by reading and syncing the
journal. It publishes no check for that recovered epoch.

```quint
pure def processRestarted(s: AgentService): AgentService = {
  val back = enter(Stopped, s)
  val c = s.child
  { ...back, watch: H::freshWatch, epochUnconfirmed: false, child: match c { | Owned(o) => Stale({ staleEpoch: o.ownedEpoch }) | _ => s.child } }
}
pure def canProcessRestartedWithReservedEpoch(s: AgentService): bool = s.epochUnconfirmed
pure def processRestartedWithReservedEpoch(s: AgentService): AgentService = { ...processRestarted(s), epoch: s.epoch + 1 }
pure def stepRestartKeepsDurableFacts(before: AgentService, via: str, after: AgentService): bool =
  (via == "processRestarted" or via == "processRestartedWithReservedEpoch") implies
    (after.epoch == before.epoch + (if (via == "processRestartedWithReservedEpoch") 1 else 0)
      and after.key == before.key and after.hold == before.hold and after.delivered == before.delivered)
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
  | Payload => "payload" | Storage => "storage" | Config => "config" | Credential => "credential" | Agent => "agent" | Runtime => "runtime" }
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

## Story: See a failed agent even when I silence its status

> As a device owner, I want a failed agent to tell me on an alerts channel of
> its own, so that I can silence the routine starting, running and stopping
> notice without missing a failure.

### A failed agent's notice is on the alerts channel with the failure words, and a starting, running or stopping agent's on the status channel

The service keeps one notice for the agent and moves it between two
channels as the phase changes, with the host file's status or failure words
(`./config.md`). A planned stop, and the stop before a credential failure,
stay on the status channel; only the failure itself alerts. A stopped agent
shows no notice.

```quint
type NoticeChannel = NoNotice | StatusChannel | AlertsChannel
pure def noticeChannel(s: AgentService): NoticeChannel = {
  val p = s.phase
  match p { | Stopped => NoNotice | Failed(_) => AlertsChannel | _ => StatusChannel }
}
pure def alwaysOnlyAFailureAlerts(s: AgentService): bool =
  ((noticeChannel(s) == AlertsChannel) iff isFailed(s.phase)) and ((noticeChannel(s) != NoNotice) iff statusOf(s).notice)
pure def sometimesAFailedAgentAlerts(s: AgentService): bool = noticeChannel(s) == AlertsChannel
pure def sometimesAStopIsOnTheStatusChannel(s: AgentService): bool = isStopping(s.phase) and noticeChannel(s) == StatusChannel
```

## Story: Restart a crashed or unhealthy agent until it stays up

> As a device owner, I want an agent that crashes or stops answering
> restarted after a growing pause, however often it crashes, so that it
> comes back by itself without draining my battery.

### Any exit after readiness is a crash, and every crash is restarted after the health delay

The agent never exits on its own once ready, so any code is a crash. The
delay grows with the crashes since the last explicit start or stable run
and stops growing at 60 s; no number of crashes leaves the agent failed.

```quint
pure def restartAfterCrash(attempt: int, s: AgentService): ServiceStep = launch(attempt + 1, H::restartDelay(attempt), s)
pure def alwaysCrashCountIsNotNegative(s: AgentService): bool = s.attempt >= 0
pure def sometimesRestartedAfterCrash(s: AgentService): bool = s.phase == Running and s.attempt >= 1
pure def sometimesRestartedAfterSixCrashesInARow(s: AgentService): bool = s.phase == Starting({ step: Checking }) and s.attempt == 6
pure val eval_witness_sometimesRestartedAfterSixCrashesInARow = (
  ("credentialArrived", 1, { userId: "u1", organizationId: "o1" }),
  "start",
  ("spawn", true), ("observeReady", readyReply(1)), ("observeExit", 1),
  ("spawn", true), ("observeReady", readyReply(2)), ("observeExit", 1),
  ("spawn", true), ("observeReady", readyReply(3)), ("observeExit", 1),
  ("spawn", true), ("observeReady", readyReply(4)), ("observeExit", 1),
  ("spawn", true), ("observeReady", readyReply(5)), ("observeExit", 1),
  ("spawn", true), ("observeReady", readyReply(6)), ("observeExit", 1)
)
```

### An unhealthy verdict kills the child and counts as a crash

Each health observation of the running launch is folded into the watch;
after a `Restart` verdict the child's exit is a crash, restarted after the
same delay.

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
pure def sometimesKilledAsUnhealthy(s: AgentService): bool = s.phase == Stopping({ onExit: ToRestart }) and s.readyEpoch == s.epoch
```

### Five minutes of running reset the restart delay

The shell sends `stableRun` after `H::stableRunMs` in `Running`.

```quint
pure def canStableRun(s: AgentService): bool = s.phase == Running and s.attempt > 0
pure def stableRun(s: AgentService): AgentService = { ...s, attempt: 0 }
pure def stepRestartDelayResetOnlyByStartOrStableRun(before: AgentService, via: str, after: AgentService): bool =
  (after.attempt < before.attempt) implies (after.attempt == 0 and (via == "stableRun" or after.epoch == before.epoch + 1))
```

## Story: Start the agent when I sign in and stop it when I sign out

> As a device owner, I want my agent to run only while I am signed in, on
> my own account's records, so that nobody else's agent or records run on
> my phone.

### Sign-out or an expired key fails the agent as Credential, and a key that arrives then starts it

The credential's `SignedOutNotice` and `ExpiredNotice` withdraw the key;
a live child is killed first, and a stopped service stays stopped. The
next `Announce` starts the agent with no restart delay, unless an
update holds it. A pending check keeps its epoch when its first key
arrives. If the key selects the account, the shell lets a queued stop or
hold run, then reads the current key before opening that account's storage.

```quint
pure val versionValues = Set(1, 2, 3)
pure val accountValues = Set({ userId: "u1", organizationId: "o1" }, { userId: "u2", organizationId: "o1" })
pure def accountNamed(a: C::Account): bool = a.userId != "" and a.organizationId != ""
pure def canCredentialArrived(s: AgentService, version: int, account: C::Account): bool = s.key == NoKey and version > s.newestVersion and accountNamed(account)
pure def credentialArrived(s: AgentService, version: int, account: C::Account): ServiceStep = {
  val keyed = { ...s, key: Key({ version: version, account: account }), newestVersion: version }
  if (s.phase == Failed({ cause: Credential })) (if (s.hold == NotHeld) launch(0, 0, keyed) else emit(List(), enter(Stopped, keyed)))
  else if (s.phase == Stopping({ onExit: ToCredentialFailure })) emit(List(), { ...keyed, phase: Stopping({ onExit: ToStart }) })
  else if (storageFailed(s)) emit(List(), { ...keyed, review: NoReview })
  else emit(List(), keyed)
}
pure def stepFirstKeyKeepsTheCheckingEpoch(before: AgentService, via: str, after: AgentService, out: List[ServiceEffect]): bool =
  (via == "credentialArrived" and before.key == NoKey and before.phase == Starting({ step: Checking })) implies
    (after.phase == before.phase and after.epoch == before.epoch and after.attempt == before.attempt
      and after.child == before.child and after.key != NoKey and out == List())
pure def canCredentialWithdrawn(s: AgentService): bool = s.key != NoKey
pure def credentialWithdrawn(s: AgentService): ServiceStep = {
  val keyless = { ...s, key: NoKey }
  if (childPhase(s.phase) and not(isStopping(s.phase))) emit(List(KillChild), enter(Stopping({ onExit: ToCredentialFailure }), keyless))
  else if (isStopping(s.phase)) emit(List(), { ...keyless, phase: if (s.phase == Stopping({ onExit: ToStopped })) s.phase else Stopping({ onExit: ToCredentialFailure }) })
  else if (s.phase == Stopped or storageFailed(s)) emit(List(), keyless)
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
pure val weight_credentialArrived = 18
```

### Another account's key restarts the agent on that account's directory

The agent refuses a store opened under another account, so a live child
is killed and a new launch follows its exit; this is not counted as a
crash.

```quint
pure def canAccountChanged(s: AgentService, version: int, account: C::Account): bool =
  s.key != NoKey and keyAccount(s.key) != account and accountNamed(account) and version > s.newestVersion
pure def accountChanged(s: AgentService, version: int, account: C::Account): ServiceStep = {
  val keyed = { ...s, key: Key({ version: version, account: account }), newestVersion: version }
  if (childPhase(s.phase) and not(isStopping(s.phase))) emit(List(KillChild), enter(Stopping({ onExit: ToStart }), keyed))
  else if (s.phase == Stopping({ onExit: ToRestart })) emit(List(), { ...keyed, phase: Stopping({ onExit: ToStart }) })
  else if (storageFailed(s)) emit(List(), enter(Stopped, keyed))
  else emit(List(), keyed)
}
pure def sometimesRestartingForAnotherAccount(s: AgentService): bool = s.phase == Stopping({ onExit: ToStart }) and keyAccount(s.key) != s.launched
```

### A replaced mail broker restarts a starting or running agent, and leaves a stopping agent's exit to decide what follows

When the consumer registers another mail broker while a launch holds the
old one ([config](./config.md)), a starting or running child is killed and
a new launch follows its exit, so that launch is handed the new broker;
this is not counted as a crash. A stopping child is left alone: a stop, a
start, a restart or a credential failure pending on its exit still
decides what follows, and any launch after it is handed the new broker.

```quint
pure def canBrokerReplaced(s: AgentService): bool = childPhase(s.phase) and not(isStopping(s.phase))
pure def brokerReplaced(s: AgentService): ServiceStep = emit(List(KillChild), enter(Stopping({ onExit: ToStart }), s))
pure def stepBrokerReplacementRestartsOnlyALiveLaunch(before: AgentService, via: str, after: AgentService, out: List[ServiceEffect]): bool =
  via == "brokerReplaced" implies
    (childPhase(before.phase) and not(isStopping(before.phase)) and out == List(KillChild)
      and after == enter(Stopping({ onExit: ToStart }), before))
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
directory aside and preserves its files. While the move is in progress, the
service stays `Failed(Storage)` and refuses another review, start, or stop.
For this account and service run, only a successful result for that token
clears the failure. If the move or directory sync fails, the service
consumes the review and keeps the failure so the owner can review and try
again. Selecting another account or signing in after a withdrawal drops
the old review.

If the rename succeeds, the shell keeps the exact moved directory for this
account until both parent directories sync. A new review reports the
records in that move. Its retry syncs those directories and skips the
rename. The shell refuses to open the account's state for a launch until
that receipt settles.

```quint
pure def isArchiving(r: Review): bool = match r { | Archiving(_) => true | _ => false }
pure def canReviewRecovery(s: AgentService, focused: bool): bool =
  focused and storageFailed(s) and s.child == NoChild and not(isArchiving(s.review))
pure def reviewRecovery(s: AgentService, focused: bool): AgentService =
  { ...s, review: Reviewed({ token: s.tokens + 1, reviewEpoch: s.epoch }), tokens: s.tokens + 1 }
pure def canArchiveRecovery(s: AgentService, token: int): bool =
  storageFailed(s) and s.review == Reviewed({ token: token, reviewEpoch: s.epoch })
pure def archiveRecovery(s: AgentService, token: int): ServiceStep =
  emit(List(ArchiveData({ token: token, archiveEpoch: s.epoch })), { ...s, review: Archiving({ token: token, reviewEpoch: s.epoch }) })
pure def canArchiveFinished(s: AgentService, token: int, archiveSucceeded: bool): bool =
  storageFailed(s) and s.review == Archiving({ token: token, reviewEpoch: s.epoch })
pure def archiveFinished(s: AgentService, token: int, archiveSucceeded: bool): AgentService =
  if (archiveSucceeded) enter(Stopped, s) else { ...s, review: NoReview }
pure val tokenValues = Set(1, 2)
pure def alwaysReviewBelongsToThisFailure(s: AgentService): bool = s.tokens >= 0 and (s.review == NoReview
  or ((s.review == Reviewed({ token: s.tokens, reviewEpoch: s.epoch }) or s.review == Archiving({ token: s.tokens, reviewEpoch: s.epoch }))
    and storageFailed(s) and s.child == NoChild))
pure def stepArchiveRequiresItsReview(before: AgentService, via: str, after: AgentService, out: List[ServiceEffect]): bool =
  via == "archiveRecovery" implies (before.review == Reviewed({ token: before.tokens, reviewEpoch: before.epoch })
    and after.review == Archiving({ token: before.tokens, reviewEpoch: before.epoch }) and storageFailed(after)
    and out == List(ArchiveData({ token: before.tokens, archiveEpoch: before.epoch })))
pure def stepStorageFailureRemainsFenced(before: AgentService, via: str, after: AgentService): bool =
  (storageFailed(before) and not(storageFailed(after))) implies (via == "processRestarted" or via == "processRestartedWithReservedEpoch" or via == "accountChanged"
    or (via == "archiveFinished" and isArchiving(before.review) and after.phase == Stopped and after.review == NoReview))
pure def sometimesRecoveryReviewed(s: AgentService): bool = s.review == Reviewed({ token: s.tokens, reviewEpoch: s.epoch })
pure def sometimesArchiveInFlight(s: AgentService): bool = isArchiving(s.review)
pure val weight_reviewRecovery = 3
pure val weight_archiveRecovery = 3
```

## Story: Hold the agent for an app update

> As a device owner installing an app update, I want the agent kept
> stopped from the install until the new app is in place or the attempt
> ended, so that no agent runs on half-replaced code.

### A hold is taken only with no child, blocks every start and is released only for its target or an ended attempt

The install journal (`appUpdate/install.md`) takes the hold after the
agent stopped. If a launch is checking and no child is journaled, the hold
request cancels that check before saving the grant. Any recorded child
blocks the grant until its journal entry is cleared. Before saving the
grant, the shell syncs the latest epoch into the childless journal so the
installed package can allocate above it with the original record format.
A release counts only
when the installed code and digest equal the target, or the attempt is
proven ended (baseline installed, no session pending). A failed grant write
opens the launch gate only after the shell confirms no grant is saved.
If it cannot confirm absence, it keeps the target fenced. The updater sees
a grant only after the shell confirms the saved record. The shell clears
and syncs the saved hold before opening the launch gate. On restart, it
resolves a visible release or unconfirmed grant only from a synced record
or confirmed absence.

```quint
type UpdateOutcome = Installed({ artifact: int }) | AttemptEnded
pure def canHoldForUpdate(s: AgentService, target: int): bool =
  s.hold == NotHeld and target >= 1 and s.child == NoChild
    and (s.phase == Stopped or isFailed(s.phase) or s.phase == Starting({ step: Checking }))
pure def stopCheckingForHold(s: AgentService): AgentService =
  if (s.phase == Starting({ step: Checking })) stop(s).state else s
pure def holdForUpdate(s: AgentService, target: int): AgentService = {
  val stopped = stopCheckingForHold(s)
  { ...stopped, hold: HeldFor({ target: target }) }
}
pure def canHoldWriteFailed(s: AgentService, target: int, absenceConfirmed: bool): bool = canHoldForUpdate(s, target)
pure def holdWriteFailed(s: AgentService, target: int, absenceConfirmed: bool): AgentService = {
  val stopped = stopCheckingForHold(s)
  if (absenceConfirmed) stopped else { ...stopped, hold: UnconfirmedHold({ pendingTarget: target }) }
}
pure def holdTarget(hold: UpdateHold): int = match hold {
  | NotHeld => 0
  | HeldFor(saved) => saved.target
  | UnconfirmedHold(unknown) => unknown.pendingTarget
}
pure def unconfirmed(hold: UpdateHold): bool = match hold { | UnconfirmedHold(_) => true | _ => false }
pure def canObserveHoldGrant(s: AgentService, grantSaved: bool): bool = s.phase == Stopped and unconfirmed(s.hold)
pure def observeHoldGrant(s: AgentService, grantSaved: bool): AgentService =
  { ...s, hold: if (grantSaved) HeldFor({ target: holdTarget(s.hold) }) else NotHeld }
pure def canReleaseUpdate(s: AgentService, result: UpdateOutcome): bool = { val h = s.hold
  h != NotHeld and (result == Installed({ artifact: holdTarget(h) }) or result == AttemptEnded) }
pure def releaseUpdate(s: AgentService, result: UpdateOutcome): AgentService = { ...s, hold: NotHeld }
pure def canReleaseUpdateFailed(s: AgentService, result: UpdateOutcome): bool = canReleaseUpdate(s, result)
pure def releaseUpdateFailed(s: AgentService, result: UpdateOutcome): AgentService = s
pure val targetValues = Set(1, 2)
pure val absenceConfirmedValues = Set(true, false)
pure val grantSavedValues = Set(true, false)
pure val resultValues = Set(Installed({ artifact: 1 }), Installed({ artifact: 2 }), AttemptEnded)
pure def alwaysHeldMeansNoAgent(s: AgentService): bool =
  s.hold != NotHeld implies (holdTarget(s.hold) >= 1 and s.child == NoChild and (s.phase == Stopped or isFailed(s.phase)))
pure def stepHoldChangesOnlyByReleaseOrReadback(before: AgentService, via: str, after: AgentService): bool =
  (before.hold != NotHeld and after.hold != before.hold) implies
    (via == "releaseUpdate" or (via == "observeHoldGrant" and unconfirmed(before.hold)
      and (after.hold == NotHeld or holdTarget(before.hold) == holdTarget(after.hold))))
pure def stepHoldCancelsOnlyChecking(before: AgentService, via: str, after: AgentService, out: List[ServiceEffect]): bool =
  (via == "holdForUpdate" or via == "holdWriteFailed") implies
    (out == List() and { ...after, hold: before.hold } == stopCheckingForHold(before))
pure def stepFailedReleaseKeepsState(before: AgentService, via: str, after: AgentService): bool =
  via == "releaseUpdateFailed" implies after == before
pure def sometimesHeldForUpdate(s: AgentService): bool = s.hold != NotHeld and not(unconfirmed(s.hold)) and s.key != NoKey
pure val weight_holdForUpdate = 2
```

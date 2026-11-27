# Agent process

One Node process runs one agent for one owner on the device. It boots from a
[launch](./launch.md), answers health and status, stops on a signal and exits
with a code from the launch's exit table. Boot runs the phases `ReadLaunch`,
`OpenStore`, `Migrate`, `LoadPlugins`, `InitializeRuntime`, `BindTransport`
and `Ready`, each only from the one before. Runtime initialization and stop
are core's [runtime lifecycle](../../core/runtime.md), which this machine
refines: `beginInitialization`, `completeInitialization`, `requestStop`,
`finishStop` and `closeAdapter` are core's transitions with core's guards, and
every other transition leaves the core runtime as it was. What boot acquires
is given back through [resources](./resources.md). The account state that
status reports is the [model binding](../models/binding.md)'s. Plugin loading,
the socket and loopback listeners and the store live in the shell
(`host/process.vibe`, `host/status.vibe`); this spec decides the phases, what
is held, what is reported and the exit code. The agent never asks its host for
a restart: there is no in-process restart and no restart code. Sources: the
develop boot pipeline (`runtime/boot-pipeline.ts`), process lifecycle
(`runtime/process-lifecycle.ts`) and health routes (`api/health-routes.ts`),
and the pinned embedded host's start and readiness probe.

## Story: Boot from a launch and serve only when ready

> As the host that starts my agent, I want it to boot through fixed phases
> and serve only once every phase is done, so that no request reaches a
> half-built agent.

### Boot moves through its phases in order, each only from the one before

A failed phase keeps the phase it failed in and names one cause; no later
phase runs. `LoadPlugins` fails as a configuration error when the load list
names a plugin the bundle lacks or the action allowlist does not match what
the plugins register; opening or migrating the store fails as a storage
error (locked, blocked migration, corrupt or another account's store).

```quint
import runtime as R from "../../core/runtime"
import resources as RS from "./resources"
import launch as L from "./launch"
type BootPhase = ReadLaunch | OpenStore | Migrate | LoadPlugins | InitializeRuntime | BindTransport | Ready
type BootResult = NoFailure | FailedWith({ cause: L::BootFailure })
type ProcessExit = StillRunning | ExitedWith({ code: int })
type AgentProcess = { phase: BootPhase, failure: BootResult, epoch: int, backend: L::Backend, plugins: List[str],
  stopRequests: int, runtime: R::Runtime, resources: RS::Resources, outcome: ProcessExit }
pure val initial: AgentProcess = { phase: ReadLaunch, failure: NoFailure, epoch: 0, backend: L::NoBackend, plugins: List(),
  stopRequests: 0, runtime: R::initial, resources: RS::initial, outcome: StillRunning }
pure def phaseOrder(b: BootPhase): int = match b {
  | ReadLaunch => 0 | OpenStore => 1 | Migrate => 2 | LoadPlugins => 3 | InitializeRuntime => 4 | BindTransport => 5 | Ready => 6
}
pure def booting(s: AgentProcess): bool = s.failure == NoFailure and s.runtime.stopPhase == R::Open
pure def failedWith(cause: L::BootFailure, s: AgentProcess): AgentProcess = { ...s, failure: FailedWith({ cause: cause }) }
pure def canOpenStore(s: AgentProcess, ok: bool): bool = booting(s) and s.phase == OpenStore
pure def openStore(s: AgentProcess, ok: bool): AgentProcess =
  if (ok) { ...s, phase: Migrate, resources: RS::acquire(s.resources, "store") } else failedWith(L::Storage, s)
pure def canMigrate(s: AgentProcess, ok: bool): bool = booting(s) and s.phase == Migrate
pure def migrate(s: AgentProcess, ok: bool): AgentProcess = if (ok) { ...s, phase: LoadPlugins } else failedWith(L::Storage, s)
pure def canLoadPlugins(s: AgentProcess, ok: bool): bool = booting(s) and s.phase == LoadPlugins
pure def loadPlugins(s: AgentProcess, ok: bool): AgentProcess = if (ok) { ...s, phase: InitializeRuntime } else failedWith(L::Config, s)
pure def canBindTransport(s: AgentProcess, ok: bool): bool = booting(s) and s.phase == BindTransport
pure def bindTransport(s: AgentProcess, ok: bool): AgentProcess =
  if (ok) { ...s, phase: Ready, resources: RS::acquire(s.resources, "transport") } else failedWith(L::Agent, s)
pure def stepBootAdvancesOnePhaseAtATime(before: AgentProcess, after: AgentProcess): bool =
  phaseOrder(after.phase) == phaseOrder(before.phase) or phaseOrder(after.phase) == phaseOrder(before.phase) + 1
pure def stepFailureIsFinal(before: AgentProcess, after: AgentProcess): bool =
  before.failure != NoFailure implies (after.failure == before.failure and after.phase == before.phase)
pure def sometimesReady(s: AgentProcess): bool = s.phase == Ready and booting(s)
pure def sometimesStorageFailed(s: AgentProcess): bool = s.failure == FailedWith({ cause: L::Storage })
pure val weight_readLaunch = 4
pure val weight_openStore = 4
pure val weight_migrate = 4
pure val weight_loadPlugins = 4
pure val weight_bindTransport = 4
```

### A refused launch fails before the store opens, as a configuration or credential error

The launch's own verdict decides: a refused document or frame is a
configuration error, and a cloud or own-key launch without a credential in
the frame is a credential error. An admitted launch fixes the epoch the
health answer echoes, the backend and the plugin load list.

```quint
pure def canReadLaunch(s: AgentProcess, doc: L::LaunchDocument, f: L::LaunchFrame): bool = booting(s) and s.phase == ReadLaunch
pure def refusalCause(v: L::LaunchVerdict): L::BootFailure = match v { | LaunchRefused(r) => r.cause | _ => L::Config }
pure def readLaunch(s: AgentProcess, doc: L::LaunchDocument, f: L::LaunchFrame): AgentProcess = {
  val verdict = L::launchVerdict(doc, f)
  if (verdict == L::LaunchAdmitted) { ...s, phase: OpenStore, epoch: f.epoch, backend: doc.backend, plugins: doc.policy.pluginsLoad }
  else failedWith(refusalCause(verdict), s)
}
pure def alwaysLaunchRefusalHoldsNothing(s: AgentProcess): bool =
  (s.failure == FailedWith({ cause: L::Credential }) implies s.phase == ReadLaunch)
    and (s.phase == ReadLaunch implies (s.resources.held.length() == 0 and s.epoch == 0))
    and (s.phase != ReadLaunch implies s.epoch >= 1)
pure def sometimesCredentialRefused(s: AgentProcess): bool = s.failure == FailedWith({ cause: L::Credential })
pure def sometimesConfigRefused(s: AgentProcess): bool = s.failure == FailedWith({ cause: L::Config }) and s.phase == ReadLaunch
```

### Runtime initialization is core's, and admission is open exactly while the transport is bound or binding and no stop began

`InitializeRuntime` runs core's initialization. A failed one is an agent
error (exit 70, the name the os supervisor uses). Core opens admission only on
success and closes it for good on stop.

```quint
pure def canBeginInitialization(s: AgentProcess): bool = booting(s) and s.phase == InitializeRuntime and R::canBeginInitialization(s.runtime)
pure def beginInitialization(s: AgentProcess): AgentProcess =
  { ...s, runtime: R::beginInitialization(s.runtime), resources: RS::acquire(s.resources, "runtime") }
pure def canCompleteInitialization(s: AgentProcess, ok: bool): bool = R::canCompleteInitialization(s.runtime, ok)
pure def completeInitialization(s: AgentProcess, ok: bool): AgentProcess = {
  val started = { ...s, runtime: R::completeInitialization(s.runtime, ok) }
  if (not(ok)) failedWith(L::Agent, started)
  else if (s.runtime.stopPhase != R::Open) { ...started, resources: RS::acquire(s.resources, "plugins") }
  else { ...started, phase: BindTransport, resources: RS::acquire(s.resources, "plugins") }
}
pure def refinesR(s: AgentProcess): R::Runtime = s.runtime
pure def admitting(s: AgentProcess): bool = (s.phase == BindTransport or s.phase == Ready) and s.runtime.stopPhase == R::Open
pure def alwaysAdmissionFollowsBoot(s: AgentProcess): bool = s.runtime.admissionOpen == admitting(s)
  and (phaseOrder(s.phase) <= 3 implies s.runtime.initPhase == R::Cold) and (phaseOrder(s.phase) >= 5 implies s.runtime.initPhase == R::Ready)
  and (s.runtime.initPhase == R::Initializing implies (s.phase == InitializeRuntime and s.failure == NoFailure))
  and (s.runtime.initPhase == R::InitFailed implies s.failure == FailedWith({ cause: L::Agent }))
pure def sometimesInitializationFailed(s: AgentProcess): bool = s.failure == FailedWith({ cause: L::Agent }) and s.phase == InitializeRuntime
```

### A cloud launch becomes ready with no plugin loaded

A cloud backend needs only its base URL, model names and credential: no
plugin, native module or managed-Google host is a precondition of
`LoadPlugins` or `Ready`.

```quint
pure def isCloudBackend(b: L::Backend): bool = match b { | CloudBackend(_) => true | _ => false }
pure def sometimesCloudReadyWithoutPlugins(s: AgentProcess): bool = s.phase == Ready and booting(s) and isCloudBackend(s.backend) and s.plugins.length() == 0
```

### What boot acquired is held in boot order: store, runtime, plugins, transport

The store opens first and the transport binds last, so a stop releases the
transport first and the store last.

```quint
pure def heldIf(c: bool, resource: str): List[str] = if (c) List(resource) else List()
pure def bootHeld(s: AgentProcess): List[str] =
  heldIf(phaseOrder(s.phase) >= 2, "store").concat(heldIf(s.runtime.initPhase != R::Cold, "runtime"))
    .concat(heldIf(s.runtime.initPhase == R::Ready, "plugins")).concat(heldIf(s.phase == Ready, "transport"))
pure def alwaysHeldFollowsBoot(s: AgentProcess): bool = s.resources.held == bootHeld(s)
```

## Story: Tell the host whether the agent can answer

> As the host that supervises my agent, I want one cheap answer that says
> whether this launch's agent is serving, so that I tell a booting agent, a
> stale child and a working one apart without a model call.

### Health is 200 only when boot is done and no stop began, and it echoes this launch's epoch

`GET /api/health` (public, read-only, no provider call) answers 200
`{ready: true, runtime: "ok", agentState: "running", epoch}` when healthy,
else 503 `{ready: false, phase}`, where `phase` is the boot phase or
`stopping`. The epoch is the launch frame's, which is not secret.

```quint
type HealthReply = HealthReady({ epoch: int }) | HealthUnavailable({ phase: str })
pure def healthy(s: AgentProcess): bool = s.phase == Ready and booting(s)
pure def phaseName(b: BootPhase): str = match b {
  | ReadLaunch => "readLaunch" | OpenStore => "openStore" | Migrate => "migrate" | LoadPlugins => "loadPlugins"
  | InitializeRuntime => "initializeRuntime" | BindTransport => "bindTransport" | Ready => "ready"
}
pure def healthReply(s: AgentProcess): HealthReply =
  if (healthy(s)) HealthReady({ epoch: s.epoch }) else HealthUnavailable({ phase: if (booting(s)) phaseName(s.phase) else "stopping" })
pure def healthStatus(r: HealthReply): int = match r { | HealthReady(_) => 200 | HealthUnavailable(_) => 503 }
pure def alwaysHealthyMeansServing(s: AgentProcess): bool = healthy(s) implies
  (s.runtime.admissionOpen and s.epoch >= 1 and s.resources.held == List("store", "runtime", "plugins", "transport"))
```

### Status says running only when health says ready, and the agent can respond only with a text backend and an unblocked account

`GET /api/status` (Root) answers `{state, canRespond, blocked,
lastCloudFailure?, serverInstanceId, backend, embeddings, requestBodyLimit}`:
`state` is `starting`, `running` or `stopping`, read from core's lifecycle;
`blocked` and `lastCloudFailure` are the binding's. `GET /api/agents` lists
exactly the one agent, `running` exactly when status says so.

```quint
import binding as B from "../models/binding"
type AgentRunState = Starting | Running | Stopping
pure def agentStateOf(s: AgentProcess): AgentRunState =
  if (s.runtime.stopPhase != R::Open or s.failure != NoFailure) Stopping else if (s.runtime.admissionOpen and s.phase == Ready) Running else Starting
pure def alwaysRunningIffHealthy(s: AgentProcess): bool = (agentStateOf(s) == Running) iff healthy(s)
pure def mayRespond(running: bool, backend: L::Backend, st: B::AccountState, t: int): bool =
  running and B::servedByBackend(backend, B::TextLarge) and not(B::blocked(st, t))
pure val backendValues = B::backendValues
pure val stValues = B::stValues
pure val tValues = B::tValues
pure def lawNoTextBackendNeverResponds(running: bool, st: B::AccountState, t: int): bool = not(mayRespond(running, L::NoBackend, st, t))
pure def lawBlockedAccountNeverResponds(running: bool, backend: L::Backend, st: B::AccountState, t: int): bool =
  B::blocked(st, t) implies not(mayRespond(running, backend, st, t))
```

## Story: Stop on a signal and exit with an honest code

> As the host that supervises my agent, I want a signal to stop it at once
> and its exit code to say whether boot or release failed, so that I restart
> only what can work.

### The first signal stops the runtime at once, and a repeated signal joins that stop

The first SIGTERM or SIGINT, or a boot failure, requests core's stop: core
aborts admitted turns with no drain window. A later signal changes nothing
but the count (core's stop attempt is joined, never restarted), and no
transition returns a stopping process to a boot phase.

```quint
pure def canRequestStop(s: AgentProcess, fast: bool): bool = fast and s.outcome == StillRunning
pure def requestStop(s: AgentProcess, fast: bool): AgentProcess =
  if (R::canRequestStop(s.runtime, fast)) { ...s, stopRequests: s.stopRequests + 1, runtime: R::requestStop(s.runtime, fast) }
  else { ...s, stopRequests: s.stopRequests + 1 }
pure def stepRepeatedSignalJoinsTheStop(before: AgentProcess, via: str, after: AgentProcess): bool =
  (via == "requestStop" and before.stopRequests >= 1) implies after == { ...before, stopRequests: before.stopRequests + 1 }
pure def stepNoReboot(before: AgentProcess, after: AgentProcess): bool = not(booting(before)) implies after.phase == before.phase
pure def alwaysStopFollowsRequests(s: AgentProcess): bool = s.stopRequests >= 0 and ((s.stopRequests == 0) iff (s.runtime.stopPhase == R::Open))
pure def sometimesSignalledTwice(s: AgentProcess): bool = s.stopRequests >= 2 and s.outcome == StillRunning
pure def sometimesStoppedDuringBoot(s: AgentProcess): bool = s.runtime.stopPhase != R::Open and s.failure == NoFailure and s.phase != Ready
```

### Stop releases everything boot acquired, newest first, and the store last as core's adapter close

Once core has stopped (after any initialization in progress settles), the
held resources are released through `RS`; a failed release is recorded and
the rest still run. The store's release is core's `closeAdapter`.

```quint
pure def canFinishStop(s: AgentProcess): bool = R::canFinishStop(s.runtime) and s.runtime.initPhase != R::Initializing
pure def finishStop(s: AgentProcess): AgentProcess = { ...s, runtime: R::finishStop(s.runtime), resources: RS::close(s.resources) }
pure def canReleaseNext(s: AgentProcess, ok: bool): bool = RS::canReleaseNext(s.resources) and s.resources.pending != List("store")
pure def releaseNext(s: AgentProcess, ok: bool): AgentProcess = { ...s, resources: RS::releaseNext(s.resources, ok) }
pure def canCloseAdapter(s: AgentProcess, ok: bool): bool = s.resources.pending == List("store") and RS::canReleaseNext(s.resources) and R::canCloseAdapter(s.runtime)
pure def closeAdapter(s: AgentProcess, ok: bool): AgentProcess = { ...s, runtime: R::closeAdapter(s.runtime), resources: RS::releaseNext(s.resources, ok) }
pure def alwaysReleaseFollowsCoreStop(s: AgentProcess): bool =
  ((s.resources.phase == RS::Open) iff (s.runtime.stopPhase == R::Open or s.runtime.stopPhase == R::Stopping))
    and ((s.runtime.stopPhase == R::Closed) iff s.resources.released.includes("store"))
    and (s.resources.phase != RS::Open implies s.runtime.initPhase != R::Initializing)
    and RS::alwaysReleasedNewestFirst(s.resources)
pure def sometimesAdapterClosed(s: AgentProcess): bool = s.runtime.adapterClosed and s.resources.phase == RS::Closed
```

### The exit code is the boot failure's code, else 0 after a clean release and 1 after a failed one

The process exits only after every release ran. Every code it exits with is
in the launch's exit table, so the supervisor never reads an exit of this
process as a crash. `exitClass` is the launch's table, offered here for the
os agent service.

```quint
pure def exitClass(code: int): L::ExitClass = L::exitClass(code)
pure def exitCodeFor(s: AgentProcess): int = {
  val failure = s.failure
  match failure { | FailedWith(x) => L::exitCode(x.cause) | NoFailure => if (RS::closedCleanly(s.resources)) 0 else 1 }
}
pure def canExitProcess(s: AgentProcess): bool = s.outcome == StillRunning and s.resources.phase == RS::Closed
pure def exitProcess(s: AgentProcess): AgentProcess = { ...s, outcome: ExitedWith({ code: exitCodeFor(s) }) }
pure def exitedCode(e: ProcessExit): int = match e { | ExitedWith(x) => x.code | StillRunning => -1 }
pure def alwaysExitCodeHonest(s: AgentProcess): bool = s.outcome != StillRunning implies
  (s.resources.phase == RS::Closed and exitedCode(s.outcome) == exitCodeFor(s) and exitClass(exitedCode(s.outcome)) != L::Crash)
pure def sometimesExitedClean(s: AgentProcess): bool = s.outcome == ExitedWith({ code: 0 }) and s.epoch >= 1 and s.runtime.adapterClosed
pure def sometimesExitedAfterReleaseFailure(s: AgentProcess): bool = s.outcome == ExitedWith({ code: 1 })
pure def sometimesExitedAsStorageFailure(s: AgentProcess): bool = s.outcome == ExitedWith({ code: 74 })
pure def sometimesExitedAsCredentialFailure(s: AgentProcess): bool = s.outcome == ExitedWith({ code: 77 })
```

### A requested stop ends in an exit

Initialization, core's stop, each release and the exit are the process's own
steps, so a stop under way always finishes.

```quint
pure val fair_completeInitialization = "weak"
pure val fair_finishStop = "weak"
pure val fair_releaseNext = "weak"
pure val fair_closeAdapter = "weak"
pure val fair_exitProcess = "weak"
pure val weight_beginInitialization = 4
pure val weight_completeInitialization = 4
pure val weight_finishStop = 4
pure val weight_releaseNext = 4
pure val weight_closeAdapter = 4
pure val weight_exitProcess = 4
pure def leadsToExit(s: AgentProcess, later: AgentProcess): bool = s.runtime.stopPhase != R::Open implies later.outcome != StillRunning
```

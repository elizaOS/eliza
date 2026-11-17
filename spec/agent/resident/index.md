# Resident agent

A device runs its agent as a resident process that outlives the app's
screens, one per install identity. Its
[installation identity](./installIdentity.md) is created once and reused;
its [lifecycle](./lifecycle.md) adopts a running resident instead of
launching a duplicate, fences each request to the live launch and retires
the exact owner before a credential change; [startup](./startup.md)
launches the agent and gateway under one owned scope; the
[watchdog](./watchdog.md) never treats a slow agent as an absent one;
[Cloud admission](./cloudAdmission.md) decides whether the resident may use
Cloud inference and [provider rebind](./providerRebind.md) rechecks it after
blocking work; the [Android host](./host.md) keeps custody of the runtime and
its [provider credential](./credential.md). The packaged inventory is
[os bundle inventory](../../os/build/bundleInventory.md). An on-device
resident runs under a [runtime profile](../plugins/profile.md): the device
profile keeps embeddings and the agent's speech on the device, and the
cloud-only profile carries no local model; both think only through the
owner's cloud account. This page owns the startup phases the host reports
while all of that happens.

## Story: Report where the agent is in its startup

> As a device owner, the app tells me whether the agent is starting,
> waiting for me to finish onboarding, running, degraded, stopping or
> failed, and that status follows what the host actually did.

### The host moves only along the startup graph

The API binds first, then the host either waits for onboarding or starts
the runtime. A started runtime becomes ready, starts its features, or
reports degraded; a ready or degraded agent can restart its runtime. Any
phase can begin stopping, and stopping ends in failed, from which the
runtime can start again. Every other move is refused.

```quint
type StartupPhase = ApiBinding | ApiBound | AwaitingOnboarding | RuntimeStarting | RuntimeReady | FeaturesStarting | StartupReady | StartupDegraded | StartupStopping | StartupFailed
type AgentState = AgentNotStarted | AgentStarting | AgentRunning | AgentStopped | AgentError
type AppStartup = { phase: StartupPhase, agent: AgentState, attempt: int, previous: StartupPhase }
pure def allowedMove(origin: StartupPhase, target: StartupPhase): bool =
  if (origin == ApiBinding) target == ApiBound or target == StartupFailed or target == StartupStopping
  else if (origin == ApiBound) target == AwaitingOnboarding or target == RuntimeStarting or target == StartupFailed or target == StartupStopping
  else if (origin == AwaitingOnboarding) target == RuntimeStarting or target == StartupFailed or target == StartupStopping
  else if (origin == RuntimeStarting) target == RuntimeReady or target == FeaturesStarting or target == StartupReady or target == StartupDegraded or target == StartupFailed or target == StartupStopping
  else if (origin == RuntimeReady) target == FeaturesStarting or target == StartupReady or target == StartupDegraded or target == RuntimeStarting or target == StartupStopping
  else if (origin == FeaturesStarting) target == StartupReady or target == StartupDegraded or target == RuntimeStarting or target == StartupStopping
  else if (origin == StartupReady) target == RuntimeStarting or target == StartupDegraded or target == StartupStopping
  else if (origin == StartupDegraded) target == RuntimeStarting or target == StartupReady or target == StartupStopping
  else if (origin == StartupStopping) target == StartupFailed
  else target == RuntimeStarting or target == StartupStopping
pure def agentStateOf(phase: StartupPhase): AgentState =
  if (phase == AwaitingOnboarding) AgentNotStarted
  else if (phase == StartupFailed) AgentError
  else if (phase == StartupStopping) AgentStopped
  else if (phase == RuntimeReady or phase == FeaturesStarting or phase == StartupReady or phase == StartupDegraded) AgentRunning
  else AgentStarting
pure val initial: AppStartup = { phase: ApiBinding, agent: AgentStarting, attempt: 0, previous: ApiBinding }
pure def canMovePhase(s: AppStartup, target: StartupPhase): bool = target != s.phase and allowedMove(s.phase, target)
pure def movePhase(s: AppStartup, target: StartupPhase): AppStartup =
  { phase: target, agent: agentStateOf(target), attempt: s.attempt + (if (target == RuntimeStarting) 1 else 0), previous: s.phase }
pure def stepStartupFollowsGraph(before: AppStartup, after: AppStartup): bool = after.phase == before.phase or allowedMove(before.phase, after.phase)
pure def sometimesAgentReady(s: AppStartup): bool = s.phase == StartupReady and s.attempt == 1
pure def sometimesRecoveredFromDegraded(s: AppStartup): bool = s.phase == StartupReady and s.previous == StartupDegraded
pure def sometimesRestartedAfterFailure(s: AppStartup): bool = s.phase == RuntimeStarting and s.previous == StartupFailed
```

### The reported agent state follows the phase, and each runtime start is counted

The agent state the host reports is a function of the phase: not started
while awaiting onboarding, running once the runtime is ready, stopped while
stopping, error when failed, and starting otherwise. Every entry into
runtime starting counts one more start attempt.

```quint
pure def alwaysAgentStateFollowsPhase(s: AppStartup): bool = s.agent == agentStateOf(s.phase) and s.attempt >= 0
pure def stepStartAttemptsCounted(before: AppStartup, after: AppStartup): bool =
  after.attempt == before.attempt + (if (after.phase == RuntimeStarting and before.phase != RuntimeStarting) 1 else 0)
pure def sometimesSecondStartAttempt(s: AppStartup): bool = s.attempt > 1
```

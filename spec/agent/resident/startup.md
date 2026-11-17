# Resident child startup and retirement

A launch of the [resident](./lifecycle.md) starts the agent and its gateway
together under one owned scope; a failure of either stops both. The scope
reaches serving only through authenticated readiness of both children,
which is the health the resident lifecycle waits for. Retiring the scope
fences its requests at once, while only an observed process exit proves
that a child stopped.

## Story: Start the agent and gateway under a single owned runtime scope

> As a device owner, my agent and its gateway start together, and a
> failure of either stops both.

### The selected profile controls when the scope publishes and probes

The parallel profile publishes the agent token, the gateway token and the
credential binding before it spawns the agent, and opens the broker before
the gateway starts; both readiness probes follow both spawns. The
sequential profile starts the agent and waits for its readiness before it
publishes the same three values, then opens the broker and starts the
gateway. Either way the binding is published before the gateway starts,
and the scope serves only after authenticated readiness of both children.

```quint
type StartupProfile = ParallelPair | SequentialPair
type LaunchPhase = Unselected | Publishing | AgentNext | BrokerNext | GatewayNext | AgentProbe | GatewayProbe | Admitting | Serving | Retiring | ScopeClosed | CleanupFailed
type Child = AgentChild | GatewayChild
type ScopeLaunch = { profile: StartupProfile, phase: LaunchPhase, publications: int, agentStarted: bool, gatewayStarted: bool, brokerOpen: bool, agentLive: bool, gatewayLive: bool, agentReady: bool, gatewayReady: bool, killRequested: bool }
pure val initial: ScopeLaunch = { profile: ParallelPair, phase: Unselected, publications: 0, agentStarted: false, gatewayStarted: false, brokerOpen: false, agentLive: false, gatewayLive: false, agentReady: false, gatewayReady: false, killRequested: false }
pure def canSelectProfile(s: ScopeLaunch): bool = s.phase == Unselected
pure def selectProfile(s: ScopeLaunch, profile: StartupProfile): ScopeLaunch =
  { ...s, profile: profile, phase: if (profile == ParallelPair) Publishing else AgentNext }
pure def canPublishNext(s: ScopeLaunch): bool = s.phase == Publishing and s.publications < 3
pure def publishNext(s: ScopeLaunch): ScopeLaunch = { ...s, publications: s.publications + 1, phase: if (s.publications != 2) Publishing else if (s.profile == ParallelPair) AgentNext else BrokerNext }
pure def canSpawnAgent(s: ScopeLaunch): bool = s.phase == AgentNext and (s.profile == SequentialPair or s.publications == 3)
pure def spawnAgent(s: ScopeLaunch): ScopeLaunch = { ...s, agentStarted: true, agentLive: true, phase: if (s.profile == ParallelPair) BrokerNext else AgentProbe }
pure def canOpenBroker(s: ScopeLaunch): bool = s.phase == BrokerNext and s.agentStarted and s.publications == 3
pure def openBroker(s: ScopeLaunch): ScopeLaunch = { ...s, brokerOpen: true, phase: GatewayNext }
pure def canSpawnGateway(s: ScopeLaunch): bool = s.phase == GatewayNext and s.agentStarted and s.brokerOpen and s.publications == 3 and (s.profile == ParallelPair or s.agentReady)
pure def spawnGateway(s: ScopeLaunch): ScopeLaunch = { ...s, gatewayStarted: true, gatewayLive: true, phase: if (s.profile == ParallelPair) AgentProbe else GatewayProbe }
pure def canObserveAgent(s: ScopeLaunch, authenticated: bool): bool = s.phase == AgentProbe and s.agentLive and (s.profile == SequentialPair or s.gatewayLive) and authenticated
pure def observeAgent(s: ScopeLaunch, authenticated: bool): ScopeLaunch = { ...s, agentReady: true, phase: if (s.profile == ParallelPair) GatewayProbe else Publishing }
pure def canObserveGateway(s: ScopeLaunch, authenticated: bool): bool = s.phase == GatewayProbe and s.agentReady and s.agentLive and s.gatewayLive and authenticated
pure def observeGateway(s: ScopeLaunch, authenticated: bool): ScopeLaunch = { ...s, gatewayReady: true, phase: Admitting }
pure def canAdmitScope(s: ScopeLaunch): bool = s.phase == Admitting and s.agentReady and s.gatewayReady and s.agentLive and s.gatewayLive
pure def admitScope(s: ScopeLaunch): ScopeLaunch = { ...s, phase: Serving }
pure def alwaysPublicationCount(s: ScopeLaunch): bool = s.publications >= 0 and s.publications <= 3 and ((s.gatewayStarted or (s.profile == ParallelPair and s.agentStarted)) implies s.publications == 3)
pure def alwaysChildrenBelongToScope(s: ScopeLaunch): bool =
  (s.agentLive implies s.agentStarted) and (s.gatewayLive implies s.gatewayStarted) and (s.gatewayStarted implies s.agentStarted)
pure def alwaysReadinessFollowsChildren(s: ScopeLaunch): bool =
  (s.agentReady implies s.agentStarted and (s.profile == SequentialPair or s.gatewayStarted)) and
  (s.gatewayReady implies s.agentReady) and (s.phase == Serving implies s.agentReady and s.gatewayReady)
pure def alwaysUnselectedOwnsNothing(s: ScopeLaunch): bool =
  s.phase == Unselected implies s.publications == 0 and not(s.agentStarted) and not(s.gatewayStarted) and not(s.agentReady) and not(s.gatewayReady)
pure def stepSequentialGatewayFollowsAgentReady(before: ScopeLaunch, via: str, after: ScopeLaunch): bool =
  via == "spawnGateway" and after.profile == SequentialPair implies before.agentReady
pure def sometimesParallelPairServes(s: ScopeLaunch): bool = s.phase == Serving and s.profile == ParallelPair
pure def sometimesSequentialPairServes(s: ScopeLaunch): bool = s.phase == Serving and s.profile == SequentialPair
```

### Scope retirement and physical process exit are separate receipts

Retirement fences the scope at once. A close attempt may fail and leave
the broker or a child running; an acknowledged close releases the broker
and asks for the children to be destroyed. Only an observed process exit
establishes that a child stopped. Restarting and the next launch's epoch
belong to the [resident lifecycle](./lifecycle.md).

```quint
pure def activeScope(s: ScopeLaunch): bool = s.phase != Retiring and s.phase != ScopeClosed and s.phase != CleanupFailed
pure def canRetireScope(s: ScopeLaunch): bool = activeScope(s)
pure def retireScope(s: ScopeLaunch): ScopeLaunch = { ...s, phase: Retiring }
pure def canObserveExit(s: ScopeLaunch, child: Child): bool =
  (s.phase != Unselected and (activeScope(s) or s.killRequested)) and (if (child == AgentChild) s.agentLive else s.gatewayLive)
pure def observeExit(s: ScopeLaunch, child: Child): ScopeLaunch =
  if (child == AgentChild) { ...s, agentLive: false } else { ...s, gatewayLive: false }
pure def canObserveCrash(s: ScopeLaunch): bool =
  activeScope(s) and ((s.agentStarted and not(s.agentLive)) or (s.gatewayStarted and not(s.gatewayLive)))
pure def observeCrash(s: ScopeLaunch): ScopeLaunch = { ...s, phase: Retiring }
pure def canFinishCleanup(s: ScopeLaunch): bool = s.phase == Retiring
pure def finishCleanup(s: ScopeLaunch, cleanupSucceeded: bool): ScopeLaunch =
  if (cleanupSucceeded) { ...s, phase: ScopeClosed, killRequested: true, brokerOpen: false }
  else { ...s, phase: CleanupFailed, killRequested: true }
pure def alwaysClosedFencesBroker(s: ScopeLaunch): bool = s.phase == ScopeClosed implies s.killRequested and not(s.brokerOpen)
pure def stepRetirementCannotReopen(before: ScopeLaunch, after: ScopeLaunch): bool = not(activeScope(before)) implies not(activeScope(after))
pure def stepCleanupDoesNotInventExit(before: ScopeLaunch, via: str, after: ScopeLaunch): bool =
  via == "finishCleanup" implies after.agentLive == before.agentLive and after.gatewayLive == before.gatewayLive
pure def sometimesUnobservedTermination(s: ScopeLaunch): bool = s.phase == ScopeClosed and s.agentLive
pure def sometimesCleanupFailed(s: ScopeLaunch): bool = s.phase == CleanupFailed
```

## Story: Start the agent before a provider is chosen

> As a new device owner, my agent starts even before I chose a model
> provider, and every message I send then tells me that no provider is set
> instead of failing in some other way or using a provider I never chose.

### An empty provider slot launches the agent unbound, and each turn answers that no provider is set

A launch with an empty provider slot is admitted under the unbound provider
generation and serves screens as a bound launch does. While it is unbound,
each turn ends with the no-provider answer and reaches no model. A turn of
a bound launch is answered by its provider, or fails as that provider
failed. A slot that cannot be read refuses the launch.

```quint
type ProviderSlot = EmptySlot | BoundSlot | UnreadableSlot
type TurnAnswer = NoProviderAnswer | ProviderAnswer | ProviderFailure | LaunchRefused
pure def launchAdmitted(slot: ProviderSlot): bool = slot != UnreadableSlot
pure def turnAnswer(slot: ProviderSlot, providerSucceeded: bool): TurnAnswer =
  if (slot == UnreadableSlot) LaunchRefused
  else if (slot == EmptySlot) NoProviderAnswer
  else if (providerSucceeded) ProviderAnswer else ProviderFailure
pure def lawEmptySlotLaunchesAndAnswersNoProvider(providerSucceeded: bool): bool =
  launchAdmitted(EmptySlot) and turnAnswer(EmptySlot, providerSucceeded) == NoProviderAnswer
pure def lawOnlyABoundSlotReachesAModel(slot: ProviderSlot, providerSucceeded: bool): bool =
  (turnAnswer(slot, providerSucceeded) == ProviderAnswer or turnAnswer(slot, providerSucceeded) == ProviderFailure) implies slot == BoundSlot
```

# Hosted agent lifecycle

A hosted agent runs on one agent server at a time. The server starts its
runtime, publishes a route to it, stops and deletes it on request, and
drains every agent before it shuts down within one deadline. One hosted
agent, its route and its server's shutdown are the state machine. The
operator's route cleanup, status publication and container health probes
are boundaries stated as laws. Network delivery and provider health are
outside the model: each remote call may succeed, fail or stall.

## Story: Start, stop and delete a hosted agent

> As an organization running an agent in the cloud, I want it started,
> stopped and deleted in order, so that a request never reaches a runtime
> that is gone and no capacity is freed while a runtime may still be live.

### A runtime is live exactly while the agent is between construction and stop

```quint
type AgentPhase = AgentAbsent | AgentStarting | AgentInitializing | AgentPublishing | AgentRunning | AgentStopping | AgentStopped
type PendingMutation = NoMutation | StopRequested | DeleteRequested
type ShutdownStage = NotShuttingDown | DrainStage | CleanupStage | QuitStage | ShutdownDone
type HostedAgent = { phase: AgentPhase, runtimeLive: bool, pending: PendingMutation, draining: bool, routeOwner: int, localEntry: bool, retiring: bool, stage: ShutdownStage, stageWaiting: bool, clock: int, failed: bool, quitCompleted: bool, disconnected: bool }
pure val initial: HostedAgent = { phase: AgentAbsent, runtimeLive: false, pending: NoMutation, draining: false, routeOwner: 0, localEntry: false, retiring: false, stage: NotShuttingDown, stageWaiting: false, clock: 0, failed: false, quitCompleted: false, disconnected: false }
pure def runtimePhase(phase: AgentPhase): bool = phase == AgentInitializing or phase == AgentPublishing or phase == AgentRunning or phase == AgentStopping
pure def alwaysRuntimeLiveMatchesPhase(a: HostedAgent): bool = a.runtimeLive == runtimePhase(a.phase)
```

### A new agent starts only while its server is not draining

The server reserves the agent, constructs its runtime, initializes it and
publishes its route. A drain that begins during startup sends the agent to
stopping instead of running. A startup that fails stops the runtime and
deletes the agent.

```quint
pure def canStart(a: HostedAgent): bool = a.phase == AgentAbsent and not(a.draining)
pure def start(a: HostedAgent): HostedAgent = { ...a, phase: AgentStarting }
pure def canConstruct(a: HostedAgent): bool = a.phase == AgentStarting
pure def construct(a: HostedAgent): HostedAgent = { ...a, phase: AgentInitializing, runtimeLive: true }
pure def canInitialized(a: HostedAgent): bool = a.phase == AgentInitializing
pure def initialized(a: HostedAgent): HostedAgent = { ...a, phase: if (a.draining) AgentStopping else AgentPublishing }
pure def canPublished(a: HostedAgent): bool = a.phase == AgentPublishing
pure def published(a: HostedAgent): HostedAgent = { ...a, phase: if (a.draining) AgentStopping else AgentRunning, routeOwner: 1, localEntry: true }
pure def canStartupFailed(a: HostedAgent): bool = a.phase == AgentInitializing or a.phase == AgentPublishing
pure def startupFailed(a: HostedAgent): HostedAgent = { ...a, phase: AgentStopping, pending: DeleteRequested }
pure def sometimesAgentRuns(a: HostedAgent): bool = a.phase == AgentRunning and a.routeOwner == 1
```

### A stop or delete waits for initialization and keeps capacity until the runtime stops

A stop or delete request made while initialization owns the reservation is
refused. A delete outranks a stop. A failed stop keeps the runtime and its
reservation so a retry can clean it up; only an acknowledged stop ends the
runtime, and a delete removes the agent only after its route is retired.

```quint
pure def mutable(phase: AgentPhase): bool = phase == AgentPublishing or phase == AgentRunning or phase == AgentStopping or phase == AgentStopped
pure def canRequestDelete(a: HostedAgent): bool = mutable(a.phase)
pure def requestDelete(a: HostedAgent): HostedAgent = { ...a, pending: DeleteRequested }
pure def canRequestStop(a: HostedAgent): bool = mutable(a.phase) and a.pending != DeleteRequested
pure def requestStop(a: HostedAgent): HostedAgent = { ...a, pending: StopRequested }
pure def canBeginStop(a: HostedAgent): bool = a.phase == AgentRunning and (a.pending != NoMutation or a.draining)
pure def beginStop(a: HostedAgent): HostedAgent = { ...a, phase: AgentStopping }
pure def canStopped(a: HostedAgent): bool = a.phase == AgentStopping
pure def stopped(a: HostedAgent): HostedAgent = { ...a, phase: AgentStopped, runtimeLive: false }
pure def canDeleted(a: HostedAgent): bool = a.phase == AgentStopped and a.pending == DeleteRequested and not(a.localEntry)
pure def deleted(a: HostedAgent): HostedAgent = { ...a, phase: AgentAbsent, pending: NoMutation }
pure def stepCapacityFreedOnlyAfterStop(before: HostedAgent, after: HostedAgent): bool =
  (before.runtimeLive and not(after.runtimeLive)) implies (before.phase == AgentStopping and after.phase == AgentStopped)

```

## Story: Route requests only to the server that holds the agent

> As a caller of a hosted agent, I want my request routed to the server that
> holds its runtime, and never to a server that has let it go.

### A server releases its local entry only after its route is removed

A server publishes its own route when the agent starts. Retiring a stopped
agent first removes the route; only the acknowledged removal releases the
local entry, and a failed removal keeps both for a retry. Another server may
take the route only after the release.

```quint
pure def canRetireRoute(a: HostedAgent): bool = a.phase == AgentStopped and a.localEntry and not(a.retiring)
pure def retireRoute(a: HostedAgent): HostedAgent = { ...a, retiring: true }
pure def canRouteRemoved(a: HostedAgent): bool = a.retiring
pure def routeRemoved(a: HostedAgent): HostedAgent = { ...a, routeOwner: if (a.routeOwner == 1) 0 else a.routeOwner, localEntry: false, retiring: false }
pure def canRemovalFailed(a: HostedAgent): bool = a.retiring
pure def removalFailed(a: HostedAgent): HostedAgent = { ...a, retiring: false }
pure def canReassignRoute(a: HostedAgent): bool = not(a.localEntry) and a.routeOwner != 2 and (a.phase == AgentAbsent or a.phase == AgentStopped)
pure def reassignRoute(a: HostedAgent): HostedAgent = { ...a, routeOwner: 2 }
pure def alwaysOwnRouteHasLocalEntry(a: HostedAgent): bool = a.routeOwner == 1 implies a.localEntry
pure def alwaysRetirementOnlyForAStoppedAgent(a: HostedAgent): bool = a.retiring implies a.localEntry and a.phase == AgentStopped
pure def sometimesStoppedAgentRouteTakenOver(a: HostedAgent): bool = a.phase == AgentStopped and a.routeOwner == 2
```

### Route cleanup deletes only the route the cleaner owns

The operator removes a server's route with a compare-and-delete: a route
another server has taken since survives the cleanup.

```quint
pure def routeAfterCleanup(routeOwner: int, cleanupOwner: int): int = if (routeOwner == cleanupOwner) 0 else routeOwner
pure def lawCleanupKeepsAnotherServersRoute(routeOwner: int, cleanupOwner: int): bool =
  routeOwner != cleanupOwner implies routeAfterCleanup(routeOwner, cleanupOwner) == routeOwner
```

### A published status is cached only after both destinations acknowledge it

The operator writes an observed agent status to the routing store and then
to the deployment record. Its cache of the last published status changes
only when both writes are acknowledged; a failed write leaves no cache
entry, so the same observation is retried.

```quint
type StatusWrite = { routingAcknowledged: bool, recordAcknowledged: bool }
pure def statusCacheAfter(statusWrite: StatusWrite, desired: int): int = if (statusWrite.routingAcknowledged and statusWrite.recordAcknowledged) desired else 0
pure def lawCachedStatusWasWrittenTwice(statusWrite: StatusWrite, desired: int): bool =
  (desired > 0 and statusCacheAfter(statusWrite, desired) == desired) implies (statusWrite.routingAcknowledged and statusWrite.recordAcknowledged)
pure val statusWriteValues = Set({ routingAcknowledged: true, recordAcknowledged: true }, { routingAcknowledged: true, recordAcknowledged: false }, { routingAcknowledged: false, recordAcknowledged: false })
pure val desiredValues = Set(1, 2)
```

### A health probe writes only to the deployment it sampled

A container probe samples the row, awaits the remote health check and
writes its result only if the row is still deploying the same revision,
placement and incarnation. A newer deployment, a recreated row or a
deletion that happened while the probe was out keeps the row as it is.

```quint
type ContainerSample = { deploying: bool, revision: int, placement: int, incarnation: int }
pure def probeMayWrite(sample: ContainerSample, row: ContainerSample): bool =
  row.deploying and sample.deploying and row.revision == sample.revision and row.placement == sample.placement and row.incarnation == sample.incarnation
pure def lawProbeNeverWritesANewerDeployment(sample: ContainerSample, row: ContainerSample): bool =
  (row.revision != sample.revision or row.incarnation != sample.incarnation or not(row.deploying)) implies not(probeMayWrite(sample, row))
pure val sampleValues = Set({ deploying: true, revision: 0, placement: 0, incarnation: 0 }, { deploying: true, revision: 1, placement: 1, incarnation: 0 })
pure val rowValues = Set({ deploying: true, revision: 0, placement: 0, incarnation: 0 }, { deploying: true, revision: 1, placement: 1, incarnation: 0 }, { deploying: false, revision: 1, placement: 0, incarnation: 0 }, { deploying: true, revision: 0, placement: 0, incarnation: 1 })
```

## Story: Shut a server down within one deadline

> As an operator, I want a server to drain its agents, clean up its routes
> and close its transport within one deadline, and to say whether it did so
> cleanly.

### Shutdown drains, cleans up and quits, or disconnects at the deadline

Shutdown sets the server draining, so no new agent starts, and runs three
stages in order against one deadline of two clock ticks. The drain stage
completes only once the agent's runtime has stopped. Each stage may
acknowledge, fail or stall; a stage starts only before the deadline. At the
deadline an unfinished shutdown disconnects and counts as failed. A clean
finish means the transport quit.

```quint
pure val shutdownDeadline = 2
pure def nextStage(stage: ShutdownStage): ShutdownStage = if (stage == DrainStage) CleanupStage else if (stage == CleanupStage) QuitStage else ShutdownDone
pure def shuttingDown(stage: ShutdownStage): bool = stage == DrainStage or stage == CleanupStage or stage == QuitStage
pure def canBeginShutdown(a: HostedAgent): bool = a.stage == NotShuttingDown
pure def beginShutdown(a: HostedAgent): HostedAgent = { ...a, draining: true, stage: DrainStage }
pure def canBeginStage(a: HostedAgent): bool = shuttingDown(a.stage) and not(a.stageWaiting) and a.clock < shutdownDeadline
pure def beginStage(a: HostedAgent): HostedAgent = { ...a, stageWaiting: true }
pure def canAcknowledgeStage(a: HostedAgent): bool =
  a.stageWaiting and a.clock < shutdownDeadline and (a.stage != DrainStage or (not(a.runtimeLive) and (a.phase == AgentAbsent or a.phase == AgentStopped)))
pure def acknowledgeStage(a: HostedAgent): HostedAgent = { ...a, stage: nextStage(a.stage), stageWaiting: false, quitCompleted: a.quitCompleted or a.stage == QuitStage }
pure def canRejectStage(a: HostedAgent): bool = a.stageWaiting and a.clock < shutdownDeadline
pure def rejectStage(a: HostedAgent): HostedAgent = { ...a, stage: nextStage(a.stage), stageWaiting: false, failed: true, disconnected: a.disconnected or a.stage == QuitStage }
pure def canTickClock(a: HostedAgent): bool = shuttingDown(a.stage) and a.clock < shutdownDeadline
pure def tickClock(a: HostedAgent): HostedAgent = { ...a, clock: a.clock + 1 }
pure def canTimeoutShutdown(a: HostedAgent): bool = shuttingDown(a.stage) and a.clock >= shutdownDeadline
pure def timeoutShutdown(a: HostedAgent): HostedAgent = { ...a, stage: ShutdownDone, stageWaiting: false, failed: true, disconnected: true }
pure def alwaysFinishedShutdownQuitOrDisconnected(a: HostedAgent): bool = a.stage == ShutdownDone implies (a.quitCompleted or a.disconnected)
pure def alwaysDisconnectIsAFailure(a: HostedAgent): bool = a.disconnected implies a.failed
pure def alwaysCleanShutdownQuit(a: HostedAgent): bool = (a.stage == ShutdownDone and not(a.failed)) implies a.quitCompleted
pure def alwaysShutdownWithinDeadline(a: HostedAgent): bool = a.clock >= 0 and a.clock <= shutdownDeadline and (a.stage != NotShuttingDown or a.clock == 0)
pure def alwaysShutdownDrains(a: HostedAgent): bool = a.stage != NotShuttingDown implies a.draining
pure def alwaysWaitingOnlyWhileShuttingDown(a: HostedAgent): bool = a.stageWaiting implies shuttingDown(a.stage)
pure def sometimesCleanShutdown(a: HostedAgent): bool = a.stage == ShutdownDone and not(a.failed)
pure def sometimesShutdownTimesOut(a: HostedAgent): bool = a.stage == ShutdownDone and a.disconnected and a.clock == shutdownDeadline
pure val fair_tickClock = "weak"
pure val fair_timeoutShutdown = "weak"
pure def leadsToShutdownEnds(a: HostedAgent, later: HostedAgent): bool = a.stage != NotShuttingDown implies later.stage == ShutdownDone
```

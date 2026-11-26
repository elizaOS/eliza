# Session admission, capacity, and disk budgets

This specification governs ACP session concurrency caps, priority-FIFO admission queues with aging, workspace disk-budget backpressure, and short-lived subscription attendance capabilities.

## Story: Admit coding agent sessions within concurrency and disk limits

> As an owner, I want concurrent coding sessions bounded by capacity and disk limits, queued fairly by priority and age when busy, and prevented from exceeding subscription attendance limits. Spending across a create's lanes is bounded by the wave budget in [Lanes, waves and routing](./lanesAndRouting.md).

### Active workers and queued admissions stay within configured bounds

Worker slots never exceed `maxWorkers` and the admission queue never exceeds `maxQueue`. When all worker slots are occupied, new requests enter the queue until capacity frees and promotes the next waiter. Releasing an active worker frees a slot immediately or promotes one queued task.

```quint
type SessionSlotStatus = SlotRunning | SlotReady | SlotBusy | SlotBlocked | SlotAuthenticating | SlotToolRunning | SlotCompleted | SlotStopped | SlotErrored | SlotCancelled
type PriorityLevel = PriorityLow | PriorityNormal | PriorityHigh | PriorityUrgent
type AdmissionPool = {
  activeWorkers: int,
  maxWorkers: int,
  queuedCount: int,
  maxQueue: int,
  admittedTotal: int,
  releasedTotal: int,
  diskBlocked: bool
}
pure val initial: AdmissionPool = {
  activeWorkers: 0,
  maxWorkers: 2,
  queuedCount: 0,
  maxQueue: 4,
  admittedTotal: 0,
  releasedTotal: 0,
  diskBlocked: false
}
pure def isTerminalSessionSlot(st: SessionSlotStatus): bool =
  st == SlotCompleted or st == SlotStopped or st == SlotErrored or st == SlotCancelled
pure def isPromptableSessionSlot(st: SessionSlotStatus): bool =
  st == SlotRunning or st == SlotReady or st == SlotBusy or st == SlotBlocked or st == SlotToolRunning
pure def priorityBandValue(p: PriorityLevel): int = match p {
  | PriorityUrgent => 3
  | PriorityHigh => 2
  | PriorityNormal => 1
  | PriorityLow => 0
}
pure def effectivePriorityBand(p: PriorityLevel, waitedSteps: int, agingInterval: int): int =
  if (agingInterval <= 0 or waitedSteps <= 0) priorityBandValue(p)
  else priorityBandValue(p) + (waitedSteps / agingInterval)
pure def canSpawnWorker(pool: AdmissionPool): bool =
  not(pool.diskBlocked) and pool.activeWorkers < pool.maxWorkers
pure def spawnWorker(pool: AdmissionPool): AdmissionPool =
  { ...pool, activeWorkers: pool.activeWorkers + 1, admittedTotal: pool.admittedTotal + 1 }
pure def canEnqueueWorker(pool: AdmissionPool): bool =
  not(pool.diskBlocked) and pool.activeWorkers >= pool.maxWorkers and pool.queuedCount < pool.maxQueue
pure def enqueueWorker(pool: AdmissionPool): AdmissionPool =
  { ...pool, queuedCount: pool.queuedCount + 1 }
pure def canReleaseWorker(pool: AdmissionPool): bool =
  pool.activeWorkers > 0
pure def releaseWorker(pool: AdmissionPool): AdmissionPool =
  if (pool.queuedCount > 0 and not(pool.diskBlocked))
    { ...pool, queuedCount: pool.queuedCount - 1, admittedTotal: pool.admittedTotal + 1, releasedTotal: pool.releasedTotal + 1 }
  else
    { ...pool, activeWorkers: pool.activeWorkers - 1, releasedTotal: pool.releasedTotal + 1 }
pure def canCancelQueued(pool: AdmissionPool): bool =
  pool.queuedCount > 0
pure def cancelQueued(pool: AdmissionPool): AdmissionPool =
  { ...pool, queuedCount: pool.queuedCount - 1 }
pure def setDiskBackpressure(pool: AdmissionPool, blocked: bool): AdmissionPool =
  { ...pool, diskBlocked: blocked }
pure def alwaysCapacityRespected(pool: AdmissionPool): bool =
  pool.activeWorkers >= 0 and pool.activeWorkers <= pool.maxWorkers and pool.maxWorkers == 2 and pool.queuedCount >= 0 and pool.queuedCount <= pool.maxQueue and pool.maxQueue == 4
pure def alwaysConservationOfWorkers(pool: AdmissionPool): bool =
  pool.admittedTotal >= pool.releasedTotal and pool.activeWorkers == pool.admittedTotal - pool.releasedTotal
pure def lawTerminalSessionNeverPromptable(st: SessionSlotStatus): bool =
  isTerminalSessionSlot(st) implies not(isPromptableSessionSlot(st))
pure def sometimesPoolFullAndQueued(pool: AdmissionPool): bool =
  pool.activeWorkers == pool.maxWorkers and pool.queuedCount > 0
pure def sometimesDiskBackpressure(pool: AdmissionPool): bool =
  pool.diskBlocked
```


### A turn completes only when the agent itself ends it

A session runs a real ACP agent process: the shell sends initialize and session/new, then one session/prompt per turn, and collects the agent's message chunks until the agent answers the prompt. Only the stop reason `end_turn` completes the turn's work; `max_tokens`, `max_turn_requests`, `refusal` and `cancelled` stop the turn without completing it. A prompt the agent never answers, because its process could not start, exited or wrote something other than JSON-RPC, errors the session and frees its worker slot. An agent's permission request is answered from the session's approval preset: `autonomous` and `permissive` allow once, every other preset rejects once.

```quint
type TurnEnd = EndTurn | MaxTokens | MaxTurnRequests | Refusal | CancelledTurn | AgentGone
type TurnOutcome = TurnCompleted | TurnStopped | TurnErrored
pure def turnOutcome(end: TurnEnd): TurnOutcome = match end {
  | EndTurn => TurnCompleted
  | AgentGone => TurnErrored
  | MaxTokens => TurnStopped
  | MaxTurnRequests => TurnStopped
  | Refusal => TurnStopped
  | CancelledTurn => TurnStopped
}
pure def lawOnlyEndTurnCompletes(end: TurnEnd): bool = (turnOutcome(end) == TurnCompleted) iff (end == EndTurn)
pure def lawVanishedAgentErrors(end: TurnEnd): bool = (end == AgentGone) implies turnOutcome(end) == TurnErrored
```
### Disk budget and subscription attendance fail closed

Workspace provisioning is admitted only when projected usage stays within the disk cap and free space remains at or above the minimum threshold. Subscription-only adapters require an unexpired user-attended authorization window matching the fixed TTL.

```quint
type BudgetVerdict = BudgetAllowed | BudgetDenied
pure def evaluateDiskBudget(usedBytes: int, capBytes: int, freeBytes: int, minFreeBytes: int): BudgetVerdict =
  if (capBytes <= 0 or minFreeBytes < 0 or usedBytes > capBytes or freeBytes < minFreeBytes) BudgetDenied
  else BudgetAllowed
pure def isAttendanceAuthValid(issuedAt: int, expiresAt: int, nowAt: int, expectedTtl: int): bool =
  expectedTtl > 0 and expiresAt - issuedAt == expectedTtl and nowAt >= issuedAt and nowAt < expiresAt
pure def lawLowDiskAlwaysDenied(usedBytes: int, capBytes: int, freeBytes: int, minFreeBytes: int): bool =
  (freeBytes < minFreeBytes) implies evaluateDiskBudget(usedBytes, capBytes, freeBytes, minFreeBytes) == BudgetDenied
pure def lawExpiredAttendanceRejected(issuedAt: int, expiresAt: int, nowAt: int, expectedTtl: int): bool =
  (nowAt >= expiresAt) implies not(isAttendanceAuthValid(issuedAt, expiresAt, nowAt, expectedTtl))
```

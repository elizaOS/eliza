# Session admission, capacity, and spend budgets

This specification governs ACP session concurrency caps, priority-FIFO admission queues with aging, workspace disk-budget backpressure, per-session spend authorization, and short-lived subscription attendance capabilities.

## Story: Admit coding agent sessions within concurrency, disk, and spend limits

> As an owner, I want concurrent coding sessions bounded by capacity and disk limits, queued fairly by priority and age when busy, and prevented from exceeding spend or subscription attendance limits.

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

### Disk budget, spend allowance, and subscription attendance fail closed

Workspace provisioning is admitted only when projected usage stays within the disk cap and free space remains at or above the minimum threshold. Spend actions that exceed the session spend cap always fail closed (`SpendDenyCap`), even if user-approved, while high-risk actions within the cap require explicit user approval (`SpendRequireApproval`) before admission. Subscription-only adapters require an unexpired user-attended authorization window matching the fixed TTL.

```quint
type BudgetVerdict = BudgetAllowed | BudgetDenied
type SpendVerdict = SpendAllow | SpendRequireApproval | SpendDenyCap
pure def evaluateDiskBudget(usedBytes: int, capBytes: int, freeBytes: int, minFreeBytes: int): BudgetVerdict =
  if (capBytes <= 0 or minFreeBytes < 0 or usedBytes > capBytes or freeBytes < minFreeBytes) BudgetDenied
  else BudgetAllowed
pure def evaluateSpendAllowance(spentCents: int, estimatedCents: int, capCents: int, highRisk: bool, userApproved: bool): SpendVerdict =
  if (estimatedCents < 0 or spentCents < 0 or capCents < 0) SpendDenyCap
  else if (spentCents + estimatedCents > capCents) SpendDenyCap
  else if (highRisk and not(userApproved)) SpendRequireApproval
  else SpendAllow
pure def isAttendanceAuthValid(issuedAt: int, expiresAt: int, nowAt: int, expectedTtl: int): bool =
  expectedTtl > 0 and expiresAt - issuedAt == expectedTtl and nowAt >= issuedAt and nowAt < expiresAt
pure def lawLowDiskAlwaysDenied(usedBytes: int, capBytes: int, freeBytes: int, minFreeBytes: int): bool =
  (freeBytes < minFreeBytes) implies evaluateDiskBudget(usedBytes, capBytes, freeBytes, minFreeBytes) == BudgetDenied
pure def lawOverSpendCapAlwaysDenied(spentCents: int, estimatedCents: int, capCents: int, highRisk: bool, userApproved: bool): bool =
  (spentCents >= 0 and estimatedCents >= 0 and capCents >= 0 and spentCents + estimatedCents > capCents) implies
    evaluateSpendAllowance(spentCents, estimatedCents, capCents, highRisk, userApproved) == SpendDenyCap
pure def lawExpiredAttendanceRejected(issuedAt: int, expiresAt: int, nowAt: int, expectedTtl: int): bool =
  (nowAt >= expiresAt) implies not(isAttendanceAuthValid(issuedAt, expiresAt, nowAt, expectedTtl))
```

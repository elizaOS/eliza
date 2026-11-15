# Runtime operations

A runtime operation is a reload, a model swap or another change the host
applies to its running runtime. Operations go through one start lane: the
request is recorded durably before it runs, the cheapest available strategy
tier at or above the one requested executes it, and a health check decides
success. Records found on disk at startup belong to the process
incarnation that wrote them. Runtime-management proposals are files that
two consumers may race to claim; the claim is checked again after the
atomic rename. The research baseline is
`packages/agent/src/runtime/operations/{manager,repository,classifier,health}.ts`,
`api/runtime-proposals.ts` and the `runtime-operations`,
`runtime-operation-tiers`, `runtime-operation-recovery` and `api-proposals`
models. Tiers 0, 1 and 2 are hot, warm and cold.

## Story: Apply a runtime operation once

> As the owner, when I ask my host to reload or change its runtime, one
> operation runs at a time, it never falls back to a cheaper strategy than
> it needs, and it succeeds only when the runtime is healthy afterwards.

### One operation runs at a time, and its request is recorded before it runs

```quint
type OpStatus = OpIdle | Selecting | OpRunning | Checking | OpSucceeded | OpFailed
type OpFailure = NoFailure | TierUnavailable | StrategyFailed | HealthFailed | Reclaimed
type OpOwner = NoOwner | ThisProcess | EarlierIncarnation | DeadLocalProcess | RemoteExecutor | UnversionedRecord
type ProposalFile = NoProposal | LiveProposal | ClaimedProposal | ConsumedProposal
type Operations = { status: OpStatus, key: int, recorded: bool, strategies: Set[int], requested: int, cursor: int, selected: int, applied: bool, healthy: bool, failure: OpFailure, owner: OpOwner, stale: bool, proposal: ProposalFile, proposalExpired: bool, proposalMatches: bool, checkedBy: Set[int], claimedBy: int, granted: Set[int] }
pure val initial: Operations = { status: OpIdle, key: -1, recorded: false, strategies: Set(0, 1, 2), requested: -1, cursor: -1, selected: -1, applied: false, healthy: false, failure: NoFailure, owner: NoOwner, stale: false, proposal: NoProposal, proposalExpired: false, proposalMatches: true, checkedBy: Set(), claimedBy: 0, granted: Set() }
pure val keyValues = Set(0, 1)
pure val tierValues = Set(0, 1, 2)
pure def canSubmit(o: Operations, key: int, tier: int): bool = o.status == OpIdle and key >= 0 and tier >= 0 and tier <= 2
pure def submit(o: Operations, key: int, tier: int): Operations =
  { ...o, status: Selecting, key: key, recorded: true, requested: tier, cursor: tier, selected: -1, applied: false, healthy: false, failure: NoFailure, owner: ThisProcess, stale: false }
pure def alwaysOperationIsRecorded(o: Operations): bool = o.status != OpIdle implies o.recorded and o.owner != NoOwner
```

### The cheapest available tier at or above the requested one runs the operation

A cold request never falls back to a hot strategy. When no tier at or
above the request is available, the operation fails without running.

```quint
pure val strategiesValues = Set(Set(0, 1, 2), Set(0, 2), Set(0), Set(1), Set(2))
pure def canConfigureStrategies(o: Operations, strategies: Set[int]): bool = o.status == OpIdle
pure def configureStrategies(o: Operations, strategies: Set[int]): Operations = { ...o, strategies: strategies }
pure def canSelectTier(o: Operations): bool = o.status == Selecting and o.strategies.contains(o.cursor)
pure def selectTier(o: Operations): Operations = { ...o, selected: o.cursor, status: OpRunning }
pure def canUpgradeTier(o: Operations): bool = o.status == Selecting and not(o.strategies.contains(o.cursor)) and o.cursor < 2
pure def upgradeTier(o: Operations): Operations = { ...o, cursor: o.cursor + 1 }
pure def canTierUnavailable(o: Operations): bool = o.status == Selecting and not(o.strategies.contains(o.cursor)) and o.cursor == 2
pure def tierUnavailable(o: Operations): Operations = { ...o, status: OpFailed, failure: TierUnavailable }
pure def alwaysSelectedTierIsCheapestAvailable(o: Operations): bool =
  (o.selected >= 0 implies o.selected >= o.requested and o.strategies.contains(o.selected) and o.strategies.forall(t => t < o.requested or t >= o.selected)) and
  (o.failure == TierUnavailable implies o.strategies.forall(t => t < o.requested)) and
  (o.status == Selecting implies o.cursor >= o.requested and o.cursor <= 2 and o.strategies.forall(t => t < o.requested or t >= o.cursor))
pure def sometimesWarmUpgradedToCold(o: Operations): bool = o.requested == 1 and o.selected == 2
pure def sometimesNoTierAvailable(o: Operations): bool = o.failure == TierUnavailable
```

### An operation succeeds only when the strategy applied and the health check passed

```quint
pure def canApplyStrategy(o: Operations): bool = o.status == OpRunning
pure def applyStrategy(o: Operations): Operations = { ...o, status: Checking, applied: true }
pure def canFailStrategy(o: Operations): bool = o.status == OpRunning
pure def failStrategy(o: Operations): Operations = { ...o, status: OpFailed, failure: StrategyFailed }
pure def canPassHealth(o: Operations): bool = o.status == Checking
pure def passHealth(o: Operations): Operations = { ...o, status: OpSucceeded, healthy: true }
pure def canFailHealth(o: Operations): bool = o.status == Checking
pure def failHealth(o: Operations): Operations = { ...o, status: OpFailed, failure: HealthFailed }
pure def alwaysSuccessIsHealthy(o: Operations): bool =
  (o.status == OpSucceeded implies o.applied and o.healthy) and (o.healthy implies o.applied) and (o.failure == HealthFailed implies o.applied and not(o.healthy))
pure def sometimesSucceeded(o: Operations): bool = o.status == OpSucceeded
pure def sometimesAppliedButUnhealthy(o: Operations): bool = o.failure == HealthFailed
```

### Only a terminal record is pruned, which frees the lane

```quint
pure def canPrune(o: Operations): bool = o.status == OpSucceeded or o.status == OpFailed
pure def prune(o: Operations): Operations = { ...o, status: OpIdle, key: -1, recorded: false, requested: -1, cursor: -1, selected: -1, applied: false, healthy: false, failure: NoFailure, owner: NoOwner, stale: false }
pure def stepPruneOnlyTerminal(before: Operations, via: str, after: Operations): bool =
  via == "prune" implies (before.status == OpSucceeded or before.status == OpFailed)
```

## Story: Recover operations after a restart

> As the owner, after my host restarts it finishes or fails what an earlier
> process left running, but it never takes over an operation that the
> current process or a remote executor still owns.

### A running record is reclaimed only from an earlier incarnation, a dead local process or a stale unversioned record

```quint
pure val ownerValues = Set(ThisProcess, EarlierIncarnation, DeadLocalProcess, RemoteExecutor, UnversionedRecord)
pure def reclaimable(owner: OpOwner, stale: bool): bool =
  owner == EarlierIncarnation or owner == DeadLocalProcess or (owner == UnversionedRecord and stale)
pure def canHydrate(o: Operations, owner: OpOwner): bool = o.status == OpIdle and owner != NoOwner
pure def hydrate(o: Operations, owner: OpOwner): Operations =
  { ...o, status: OpRunning, owner: owner, recorded: true, key: 0, requested: 0, cursor: 0, selected: if (o.strategies.contains(0)) 0 else -1, applied: false, healthy: false, failure: NoFailure, stale: false }
pure def canAge(o: Operations): bool = o.status == OpRunning and not(o.stale)
pure def age(o: Operations): Operations = { ...o, stale: true }
pure def canReclaim(o: Operations): bool = o.status == OpRunning and reclaimable(o.owner, o.stale)
pure def reclaim(o: Operations): Operations = { ...o, status: OpFailed, failure: Reclaimed }
pure def alwaysReclaimedOnlyWhenReclaimable(o: Operations): bool = o.failure == Reclaimed implies reclaimable(o.owner, o.stale)
pure def sometimesEarlierIncarnationReclaimed(o: Operations): bool = o.failure == Reclaimed and o.owner == EarlierIncarnation
pure def sometimesSlowCurrentOperationKept(o: Operations): bool = o.owner == ThisProcess and o.stale and o.status == OpRunning
```

### A restart turns this process's running operation into an earlier incarnation's

```quint
pure def canRestartProcess(o: Operations): bool = o.owner == ThisProcess and o.status == OpRunning
pure def restartProcess(o: Operations): Operations = { ...o, owner: EarlierIncarnation }
pure def stepOwnerChangesOnlyByRestartOrNewRecord(before: Operations, via: str, after: Operations): bool =
  (before.owner != after.owner) implies (via == "restartProcess" or via == "submit" or via == "hydrate" or via == "prune")
```

## Story: Claim a runtime-management proposal

> As the owner, when two consumers race for the same proposal, at most one
> is granted it, and never after it expired or stopped matching.

### At most one consumer is granted a proposal, and only after the claimed file is consumed

```quint
pure val consumerValues = Set(1, 2)
pure def canCreateProposal(o: Operations): bool = o.proposal == NoProposal
pure def createProposal(o: Operations): Operations = { ...o, proposal: LiveProposal }
pure def canExpireProposal(o: Operations): bool = o.proposal != NoProposal and not(o.proposalExpired)
pure def expireProposal(o: Operations): Operations = { ...o, proposalExpired: true }
pure def canMismatchProposal(o: Operations): bool = o.proposal != NoProposal and o.proposalMatches
pure def mismatchProposal(o: Operations): Operations = { ...o, proposalMatches: false }
pure def canCheckProposal(o: Operations, consumer: int): bool = o.proposal == LiveProposal and not(o.proposalExpired) and o.proposalMatches and consumer > 0
pure def checkProposal(o: Operations, consumer: int): Operations = { ...o, checkedBy: o.checkedBy.union(Set(consumer)) }
pure def canClaimProposal(o: Operations, consumer: int): bool = o.proposal == LiveProposal and o.checkedBy.contains(consumer)
pure def claimProposal(o: Operations, consumer: int): Operations = { ...o, proposal: ClaimedProposal, claimedBy: consumer }
pure def alwaysAtMostOneGrant(o: Operations): bool =
  o.granted.size() <= 1 and (o.granted.size() > 0 implies o.proposal == ConsumedProposal and o.granted.contains(o.claimedBy))
```

### A claim is granted only if the proposal still matches and has not expired after the rename

```quint
pure def canValidateClaim(o: Operations): bool = o.proposal == ClaimedProposal
pure def validateClaim(o: Operations): Operations =
  { ...o, proposal: ConsumedProposal, granted: if (o.proposalMatches and not(o.proposalExpired)) o.granted.union(Set(o.claimedBy)) else o.granted }
pure def canDiscardExpired(o: Operations): bool = o.proposal == LiveProposal and o.proposalExpired
pure def discardExpired(o: Operations): Operations = { ...o, proposal: ConsumedProposal }
pure def stepGrantNeedsValidProposal(before: Operations, after: Operations): bool =
  after.granted.size() > before.granted.size() implies before.proposalMatches and not(before.proposalExpired)
pure def sometimesGranted(o: Operations): bool = o.granted.size() == 1
pure def sometimesExpiredAfterCheckNotGranted(o: Operations): bool = o.proposal == ConsumedProposal and o.granted.size() == 0 and o.checkedBy.size() > 0
```

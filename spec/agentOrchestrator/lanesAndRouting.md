# Coding backend routing, Pi-agent isolation, multi-lane waves, and context compaction

This specification defines deterministic coding-backend selection, Pi-agent credential isolation, multi-lane parallel DAG readiness and wave supervision, and context-window compaction bounds.

## Story: Route coding tasks to authorized adapters, coordinate parallel lanes safely, and compact context within budget

> As an owner, I want coding tasks routed deterministically to allowed adapters including Pi Agent and Cerebras, parallel lanes guarded against file-scope collisions and budget overruns, and context compaction guaranteed to keep prompts within token limits.

### Backend routing follows strict precedence while honoring operator allow-lists

Explicit user selection, character policy, environment policy, pinned adapter, and planner guess are evaluated in precedence order. Whenever an operator `allow` lock-list is configured, no candidate outside the allow-list can ever be selected.

```quint
type BackendId = BackendNone | BackendElizaOs | BackendPiAgent | BackendClaude | BackendCodex | BackendKimi | BackendGrok
pure def allowedBackend(candidate: BackendId, allowConfigured: bool, allowSet: Set[BackendId]): BackendId =
  if (candidate == BackendNone) BackendNone
  else if (allowConfigured and not(allowSet.contains(candidate))) BackendNone
  else candidate
pure def resolveBackendPrecedence(
  explicitChoice: BackendId,
  policyTag: BackendId,
  policyDefault: BackendId,
  pinned: BackendId,
  plannerGuess: BackendId,
  allowConfigured: bool,
  allowSet: Set[BackendId]
): BackendId = {
  val e = allowedBackend(explicitChoice, allowConfigured, allowSet)
  val t = allowedBackend(policyTag, allowConfigured, allowSet)
  val d = allowedBackend(policyDefault, allowConfigured, allowSet)
  val p = allowedBackend(pinned, allowConfigured, allowSet)
  val g = allowedBackend(plannerGuess, allowConfigured, allowSet)
  if (e != BackendNone) e
  else if (t != BackendNone) t
  else if (d != BackendNone) d
  else if (p != BackendNone) p
  else g
}
pure def lawAllowListNeverEscaped(
  explicitChoice: BackendId,
  policyTag: BackendId,
  policyDefault: BackendId,
  pinned: BackendId,
  plannerGuess: BackendId,
  allowSet: Set[BackendId]
): bool = {
  val chosen = resolveBackendPrecedence(explicitChoice, policyTag, policyDefault, pinned, plannerGuess, true, allowSet)
  chosen == BackendNone or allowSet.contains(chosen)
}
pure def lawExplicitWinsWhenAllowed(
  explicitChoice: BackendId,
  policyTag: BackendId,
  policyDefault: BackendId,
  pinned: BackendId,
  plannerGuess: BackendId
): bool =
  (explicitChoice != BackendNone) implies
    resolveBackendPrecedence(explicitChoice, policyTag, policyDefault, pinned, plannerGuess, false, Set()) == explicitChoice
pure val allowSetValues = Set(Set(), Set(BackendPiAgent), Set(BackendElizaOs, BackendPiAgent, BackendClaude))
```

### Multi-lane wave execution prevents scope collisions and enforces concurrency and budget caps

A wave tracks active lanes, completed lanes, spent budget, and budget ceiling. A lane is ready only when all its dependencies are satisfied and its file scope does not collide with another active lane. A launched lane counts as satisfied only once its agent ended its turn itself; a lane that was queued, refused or cut off stays active for scope checks, and the lanes waiting on it are reported as not launched. Launching a lane requires available concurrency headroom and remaining budget; every lane a create launches goes through the wave supervisor, whose budget is the owner's `budgetCents` when given and otherwise the plan's estimated cost, and a lane that would exceed it is reported as refused, not launched.

```quint
type LaneReadyState = LaneReady | LaneWaitingDeps | LaneScopeCollision | LaneDoneState
type WaveState = {
  activeLanes: int,
  maxParallel: int,
  completedLanes: int,
  totalLanes: int,
  spentCents: int,
  budgetCapCents: int
}
pure val initial: WaveState = {
  activeLanes: 0,
  maxParallel: 3,
  completedLanes: 0,
  totalLanes: 4,
  spentCents: 0,
  budgetCapCents: 10
}
pure def evaluateLaneReadiness(done: bool, depsSatisfied: bool, scopeOverlaps: bool): LaneReadyState =
  if (done) LaneDoneState
  else if (not(depsSatisfied)) LaneWaitingDeps
  else if (scopeOverlaps) LaneScopeCollision
  else LaneReady
pure def canLaunchLane(w: WaveState, laneCost: int): bool =
  laneCost >= 0 and w.activeLanes < w.maxParallel and w.activeLanes + w.completedLanes < w.totalLanes and w.spentCents + laneCost <= w.budgetCapCents
pure def launchLane(w: WaveState, laneCost: int): WaveState =
  { ...w, activeLanes: w.activeLanes + 1, spentCents: w.spentCents + laneCost }
pure def canCompleteLane(w: WaveState): bool =
  w.activeLanes > 0
pure def completeLane(w: WaveState): WaveState =
  { ...w, activeLanes: w.activeLanes - 1, completedLanes: w.completedLanes + 1 }
pure def canApproveBudget(w: WaveState, extraCents: int): bool =
  extraCents > 0 and w.budgetCapCents + extraCents <= 20
pure def approveBudget(w: WaveState, extraCents: int): WaveState =
  { ...w, budgetCapCents: w.budgetCapCents + extraCents }
pure def alwaysWaveBoundsHold(w: WaveState): bool =
  w.activeLanes >= 0 and w.activeLanes <= w.maxParallel and w.maxParallel == 3 and w.completedLanes >= 0 and w.activeLanes + w.completedLanes <= w.totalLanes and w.totalLanes == 4 and w.spentCents >= 0 and w.spentCents <= w.budgetCapCents and w.budgetCapCents <= 20
pure def lawOverlappingScopeNeverReady(depsSatisfied: bool): bool =
  evaluateLaneReadiness(false, depsSatisfied, true) != LaneReady
pure def sometimesParallelLanesRunning(w: WaveState): bool =
  w.activeLanes >= 2
pure def sometimesWaveCompleted(w: WaveState): bool =
  w.completedLanes == w.totalLanes
pure val laneCostValues = Set(0, 1, 2, 3)
pure val extraCentsValues = Set(1, 2, 5)
```

### Output truncation and shift-handoff compaction keep context within token budgets

Bounded truncation caps emitted lines and bytes while preserving a reference handle to the spilled artifact. Context compaction triggers when prompt tokens exceed the usable budget (80% of the context window, reserving 20% for completion) and reduces historical turns into a fixed-size shift-handoff digest plus retained active tail.

```quint
pure def usableTokenBudget(windowTokens: int): int =
  if (windowTokens <= 0) 0 else (windowTokens * 4) / 5
pure def needsCompaction(currentTokens: int, windowTokens: int): bool =
  currentTokens > usableTokenBudget(windowTokens)
pure def boundedOutputBytes(rawBytes: int, maxBytes: int): int =
  if (rawBytes <= 0 or maxBytes <= 0) 0
  else if (rawBytes <= maxBytes) rawBytes
  else maxBytes
pure def lawBoundedOutputNeverExceedsCap(rawBytes: int, maxBytes: int): bool =
  maxBytes >= 0 implies boundedOutputBytes(rawBytes, maxBytes) <= maxBytes
pure def lawUsableBudgetLeavesReserve(windowTokens: int): bool =
  windowTokens >= 0 implies usableTokenBudget(windowTokens) <= windowTokens
```

# Pinned client feature publication

`AlphaPhone/scripts/prepare-client-features.ts` copies Git objects from the
locked Eliza revision, after `upstream-native-source.ts` authenticates the
source. The advertised inventory includes Eliza Git SHA-256s and prepared
SHA-256s. Projection 14 rewrites selected imports and creates two consumer
re-export maps. [The source inventory](../alphaBaseline.json) records the
actual prepared files and both hashes. This machine follows Alpha's
`specs/quint/services/ClientFeaturePublication.qnt` and its source's two
rename operations and winner readback. One execution of the machine
represents two concurrent preparation calls and one destination slot.

## Story: Publish an authenticated client projection during concurrent builds

### Each contender authenticates its own private candidate before publication

The check-only caller reads and validates the complete stamp and exact
inventory, including stable directory identity, without replacing the
active tree. Build preparation refuses an unrecognized or linked
publication. After validating its staged candidate, each preparing caller
may retire the prior directory once and attempt publication once. A
contended caller can read peer results, never repeat retirement or
publication. A later prepared caller may still retire a peer's winner.
This is why accepted source refers to the publication or readback instant.

```quint
type Tree = { identity: int, projection: int, kind: TreeKind }
type TreeKind = MissingTree | Authenticated | Unrecognized | LinkedTree
pure val authenticatedTreeKind: TreeKind = Authenticated
pure val noTree: Tree = { identity: 0, projection: 0, kind: MissingTree }
type CheckInput = { stable: bool, stampMatches: bool, bytesMatch: bool }
type PublicationVerdict = NoVerdict | Published | Reused | Refused | RequiresPreparation | TimedOut | IoFailed | CleanupError
pure def checkProjection(visible: Tree, desired: int, check: CheckInput): PublicationVerdict =
  if (check.stable and (visible.kind == Unrecognized or visible.kind == LinkedTree)) Refused
  else if (check.stable and visible.kind == Authenticated and visible.projection == desired and check.stampMatches and check.bytesMatch) Reused
  else RequiresPreparation
pure val visibleValues = Set(noTree, { identity: 1, projection: 14, kind: Authenticated }, { identity: 2, projection: 13, kind: Authenticated }, { identity: 3, projection: 0, kind: Unrecognized }, { identity: 4, projection: 0, kind: LinkedTree })
pure val checkValues = Set({ stable: true, stampMatches: true, bytesMatch: true }, { stable: false, stampMatches: true, bytesMatch: true }, { stable: true, stampMatches: false, bytesMatch: true }, { stable: true, stampMatches: true, bytesMatch: false })
pure def lawReuseRequiresStableExactBytes(visible: Tree, desired: int, check: CheckInput): bool =
  checkProjection(visible, desired, check) == Reused implies check.stable and visible.kind == Authenticated and visible.projection == desired and check.stampMatches and check.bytesMatch

type WorkerPhase = Idle | Staged | Retired | Readback | CleanAside | CleanStage | Finished | Failed
pure val noVerdict: PublicationVerdict = NoVerdict
pure val stagedPhase: WorkerPhase = Staged
pure val retiredPhase: WorkerPhase = Retired
pure val readbackPhase: WorkerPhase = Readback
pure val cleanAsidePhase: WorkerPhase = CleanAside
pure val cleanStagePhase: WorkerPhase = CleanStage
pure val finishedPhase: WorkerPhase = Finished
pure val failedPhase: WorkerPhase = Failed
type BuildWorker = { phase: WorkerPhase, desired: int, candidate: bool, aside: Tree, didRetire: bool, didPublish: bool, accepted: int, elapsed: int, verdict: PublicationVerdict }
type BuildSide = FirstWorker | SecondWorker
type Publication = { visible: Tree, first: BuildWorker, second: BuildWorker, serial: int }
pure val idleWorker: BuildWorker = { phase: Idle, desired: 0, candidate: false, aside: noTree, didRetire: false, didPublish: false, accepted: 0, elapsed: 0, verdict: noVerdict }
pure val initial: Publication = { visible: noTree, first: idleWorker, second: idleWorker, serial: 0 }
pure def worker(s: Publication, side: BuildSide): BuildWorker = if (side == FirstWorker) s.first else s.second
pure def withWorker(side: BuildSide, value: BuildWorker, s: Publication): Publication =
  if (side == FirstWorker) { ...s, first: value } else { ...s, second: value }
pure def canPrepare(s: Publication, side: BuildSide, desired: int): bool = worker(s, side).phase == Idle and desired > 0
pure def prepare(s: Publication, side: BuildSide, desired: int, authenticatedSource: bool, check: CheckInput): Publication = {
  val result = checkProjection(s.visible, desired, check)
  val refused = not(authenticatedSource) or result == Refused
  val usable = not(refused) and result == Reused
  val newPhase = if (refused or usable) finishedPhase else stagedPhase
  val verdict = if (refused) Refused else if (usable) Reused else noVerdict
  withWorker(side, { ...idleWorker, phase: newPhase, desired: desired, candidate: not(refused or usable), accepted: if (usable) desired else 0, verdict: verdict }, s)
}
pure def canRetire(s: Publication, side: BuildSide): bool = worker(s, side).phase == Staged
pure def retire(s: Publication, side: BuildSide): Publication = {
  val prior = worker(s, side)
  withWorker(side, { ...prior, phase: retiredPhase, aside: s.visible, didRetire: true }, { ...s, visible: noTree })
}
pure def canPublish(s: Publication, side: BuildSide): bool = worker(s, side).phase == Retired
pure def publish(s: Publication, side: BuildSide): Publication = {
  val prior = worker(s, side)
  val won = s.visible.kind == MissingTree
  val installed: Tree = { identity: s.serial + 1, projection: prior.desired, kind: authenticatedTreeKind }
  val verdict = if (won) Published else noVerdict
  withWorker(side, { ...prior, phase: if (won) cleanAsidePhase else readbackPhase, candidate: not(won), didPublish: true, accepted: if (won) prior.desired else 0, verdict: verdict },
    { ...s, visible: if (won) installed else s.visible, serial: if (won) s.serial + 1 else s.serial })
}
pure val desiredValues = Set(13, 14)
pure def alwaysPositivePublishedIdentity(s: Publication): bool = s.serial >= 0 and (s.visible.kind == Authenticated implies s.visible.identity > 0 and s.visible.identity <= s.serial and s.visible.projection > 0)
pure def alwaysPublicationFollowsRetirement(s: Publication): bool = (s.first.didPublish implies s.first.didRetire) and (s.second.didPublish implies s.second.didRetire)
pure def alwaysEligibleWorkersOwnCandidate(s: Publication): bool =
  (s.first.phase == Staged or s.first.phase == Retired or s.first.phase == Readback implies s.first.candidate and s.first.desired > 0) and
  (s.second.phase == Staged or s.second.phase == Retired or s.second.phase == Readback implies s.second.candidate and s.second.desired > 0)
pure def alwaysStagedHasNotRetired(s: Publication): bool =
  ((s.first.phase == Idle or s.first.phase == Staged) implies not(s.first.didRetire)) and ((s.second.phase == Idle or s.second.phase == Staged) implies not(s.second.didRetire))
pure def alwaysRetiredHasNotPublished(s: Publication): bool =
  (s.first.phase == Retired implies s.first.didRetire and not(s.first.didPublish)) and
  (s.second.phase == Retired implies s.second.didRetire and not(s.second.didPublish))
pure def sometimesPublishes(s: Publication): bool = s.first.verdict == Published or s.second.verdict == Published
```

### A caller owns no successful receipt while trying to publish or read back

Discovered by the proof: a fabricated staged worker could otherwise
carry a successful receipt into an I/O failure. Preparing, retiring and
waiting for a winner are all unsettled and have no accepted projection.

```quint
pure def unsettledHasNoAcceptance(w: BuildWorker): bool =
  (w.phase == Staged or w.phase == Retired or w.phase == Readback) implies w.accepted == 0
pure def alwaysUnsettledHasNoAcceptance(s: Publication): bool =
  unsettledHasNoAcceptance(s.first) and unsettledHasNoAcceptance(s.second)
```

### A collision loser reads back the exact winner and only cleans its own directories

Readback requires the current stable directory's requested projection,
verified source stamp and full file hashes. A vanished or different winner
keeps the caller waiting until the deadline. An unrecognized stable tree or
I/O failure yields an explicit failure. Cleanup first removes the owned
aside, then removes the owned private stage. A cleanup error can leave an
owned sidecar. Neither cleanup nor readback can modify the public slot.

```quint
pure def canObserveWinner(s: Publication, side: BuildSide): bool = worker(s, side).phase == Readback
pure def observeWinner(s: Publication, side: BuildSide, check: CheckInput): Publication = {
  val prior = worker(s, side)
  val answer = checkProjection(s.visible, prior.desired, check)
  if (answer == RequiresPreparation) s
  else withWorker(side, { ...prior, phase: cleanAsidePhase, verdict: answer, accepted: if (answer == Reused) prior.desired else 0 }, s)
}
pure def canWaitForWinner(s: Publication, side: BuildSide, milliseconds: int): bool = worker(s, side).phase == Readback and milliseconds >= 0
pure def waitForWinner(s: Publication, side: BuildSide, milliseconds: int): Publication = {
  val prior = worker(s, side)
  if (milliseconds >= 30000 - prior.elapsed)
    withWorker(side, { ...prior, phase: cleanAsidePhase, elapsed: 30000, verdict: TimedOut }, s)
  else withWorker(side, { ...prior, elapsed: prior.elapsed + milliseconds }, s)
}
pure val millisecondsValues = Set(0, 25, 29975, 30000)
pure def canIoError(s: Publication, side: BuildSide): bool = {
  val phase = worker(s, side).phase
  phase == Staged or phase == Retired or phase == Readback
}
pure def ioError(s: Publication, side: BuildSide): Publication = withWorker(side, { ...worker(s, side), phase: cleanAsidePhase, verdict: IoFailed }, s)
pure def canRemoveAside(s: Publication, side: BuildSide): bool = worker(s, side).phase == CleanAside
pure def removeAside(s: Publication, side: BuildSide, success: bool): Publication = {
  val prior = worker(s, side)
  val after = if (success) { ...prior, phase: cleanStagePhase, aside: noTree } else { ...prior, phase: failedPhase, accepted: 0, verdict: CleanupError }
  withWorker(side, after, s)
}
pure def canRemoveStage(s: Publication, side: BuildSide): bool = worker(s, side).phase == CleanStage
pure def removeStage(s: Publication, side: BuildSide, success: bool): Publication = {
  val prior = worker(s, side)
  val after = if (success) { ...prior, phase: finishedPhase, candidate: false } else { ...prior, phase: failedPhase, accepted: 0, verdict: CleanupError }
  withWorker(side, after, s)
}
pure def ownsNoAside(w: BuildWorker): bool = (w.phase == CleanStage or w.phase == Finished) implies w.aside == noTree
pure def exactAcceptance(w: BuildWorker): bool = w.accepted == 0 or (w.accepted == w.desired and (w.verdict == Published or w.verdict == Reused))
pure def alwaysExactAcceptance(s: Publication): bool = exactAcceptance(s.first) and exactAcceptance(s.second)
pure def alwaysCleanStageOwnsNoAside(s: Publication): bool = ownsNoAside(s.first) and ownsNoAside(s.second)
pure def alwaysFinishedOwnsNoCandidate(s: Publication): bool = (s.first.phase == Finished implies not(s.first.candidate)) and (s.second.phase == Finished implies not(s.second.candidate))
pure def alwaysWaitingTimeBound(s: Publication): bool = s.first.elapsed >= 0 and s.first.elapsed <= 30000 and s.second.elapsed >= 0 and s.second.elapsed <= 30000
pure def stepOnlyRenamesChangePublicTree(before: Publication, via: str, after: Publication): bool =
  via == "retire" or via == "publish" or after.visible == before.visible
pure def stepRenamesNeverBecomeAvailableAgain(before: Publication, after: Publication): bool =
  (before.first.didRetire implies after.first.didRetire) and (before.second.didRetire implies after.second.didRetire) and
  (before.first.didPublish implies after.first.didPublish) and (before.second.didPublish implies after.second.didPublish)
pure def sometimesContention(s: Publication): bool = s.first.phase == Readback or s.second.phase == Readback
pure def sometimesContendedReuse(s: Publication): bool = (s.first.didPublish and s.first.verdict == Reused) or (s.second.didPublish and s.second.verdict == Reused)
pure def sometimesCleanupError(s: Publication): bool = s.first.phase == Failed or s.second.phase == Failed
```

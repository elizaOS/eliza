# Completion verification, evidence gates, and fast-eval routing

This specification defines pure verification rules for acceptance-criteria refinement, sentence-end file path mining, claimed-file ledger verification, completion residuals, pre-PR diff review gates, and multi-model fast-eval routing (including Cerebras).

## Story: Verify subagent deliverables against concrete evidence and route fast evaluations cleanly

> As an owner, I want completion gates to reject unverified file claims, dirty residuals, and leaked secrets, preserve paths mentioned at the end of sentences, and route bounded verification checks to fast low-latency evaluators.

### Sentence-end punctuation keeps named files while longer names are never truncated

Mining file paths from a completion summary or stdout trims trailing sentence punctuation without truncating a longer filename that shares a prefix with an existing file.

```quint
type PathFollower = FollowEnd | FollowSpace | FollowNewline | FollowCloseParen | FollowCloseQuote | FollowNameChars
pure def sentencePathMatchesFile(follower: PathFollower): bool =
  follower != FollowNameChars
pure def lawSentencePunctuationPreservesFile(follower: PathFollower): bool =
  (follower != FollowNameChars) implies sentencePathMatchesFile(follower)
pure def lawLongerFileNameNotMatched(follower: PathFollower): bool =
  (follower == FollowNameChars) implies not(sentencePathMatchesFile(follower))
```

### Claimed edits, completion residuals, and diff secrets enforce fail-closed verification

Every claimed file modification must be backed by the session's observed write ledger or filesystem verification. Unresolved completion residuals block completion when the gate is enabled, and any secret-leak finding, critical diff finding, or oversized diff (`overSizeLimit`) blocks PR submission. Refined acceptance criteria drop invented unnamed-file checks and maintain a floor of at least three concrete criteria.

```quint
type GateOutcome = GatePass | GateBlock
pure def verifyClaimedWrite(claimedCount: int, verifiedCount: int): GateOutcome =
  if (claimedCount < 0 or verifiedCount < 0 or verifiedCount < claimedCount) GateBlock else GatePass
pure def evaluateResidualsGate(uncommittedCount: int, failedChecksCount: int, gateEnabled: bool): GateOutcome =
  if (not(gateEnabled)) GatePass
  else if (uncommittedCount > 0 or failedChecksCount > 0) GateBlock
  else GatePass
pure def evaluateDiffReviewGate(secretFindings: int, criticalFindings: int, overSizeLimit: bool): GateOutcome =
  if (secretFindings > 0 or criticalFindings > 0 or overSizeLimit) GateBlock else GatePass
pure def refinedCriteriaCount(keptTemplate: int, goalChecks: int, fallbackFloor: int): int =
  if (keptTemplate + goalChecks >= fallbackFloor) keptTemplate + goalChecks else fallbackFloor
pure def lawUnverifiedClaimedFileBlocked(claimedCount: int, verifiedCount: int): bool =
  (claimedCount > verifiedCount) implies verifyClaimedWrite(claimedCount, verifiedCount) == GateBlock
pure def lawDiffSecretAlwaysBlocks(secretFindings: int, criticalFindings: int, overSizeLimit: bool): bool =
  (secretFindings > 0) implies evaluateDiffReviewGate(secretFindings, criticalFindings, overSizeLimit) == GateBlock
pure def lawRefinedCriteriaMeetsFloor(keptTemplate: int, goalChecks: int): bool =
  refinedCriteriaCount(keptTemplate, goalChecks, 3) >= 3
```

### Bounded verification and classification tasks route to fast low-latency evaluators

Fast code verification, diff scoring, stall detection, and compact summarization route to the fast-eval lane (Cerebras when configured, else `TEXT_SMALL`), while complex multi-file planning and architecture route to the frontier planner (`TEXT_LARGE`).

```quint
type EvalTaskKind = EvalDiffCheck | EvalAcceptanceJudge | EvalStallClassify | EvalDigestSummary | EvalArchitecturePlan | EvalComplexDebug
type EvalModelLane = LaneCerebrasFast | LaneTextSmall | LaneTextLarge
pure def selectEvalModelLane(kind: EvalTaskKind, cerebrasAvailable: bool): EvalModelLane = match kind {
  | EvalArchitecturePlan => LaneTextLarge
  | EvalComplexDebug => LaneTextLarge
  | EvalDiffCheck => if (cerebrasAvailable) LaneCerebrasFast else LaneTextSmall
  | EvalAcceptanceJudge => if (cerebrasAvailable) LaneCerebrasFast else LaneTextSmall
  | EvalStallClassify => if (cerebrasAvailable) LaneCerebrasFast else LaneTextSmall
  | EvalDigestSummary => if (cerebrasAvailable) LaneCerebrasFast else LaneTextSmall
}
pure def lawFastEvalUsesCerebrasWhenAvailable(kind: EvalTaskKind): bool =
  (kind == EvalDiffCheck or kind == EvalAcceptanceJudge or kind == EvalStallClassify or kind == EvalDigestSummary) implies
    selectEvalModelLane(kind, true) == LaneCerebrasFast
pure def lawArchitectureAlwaysUsesLargePlanner(cerebrasAvailable: bool): bool =
  selectEvalModelLane(EvalArchitecturePlan, cerebrasAvailable) == LaneTextLarge
```

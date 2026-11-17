# Npm replacement contract

The target is the existing `@elizaos/core` npm package. The export map,
conditions, exact public declarations, data assets and observed consumer
imports are pinned in `baseline/core-public-surface.json` and
`baseline/core-consumers.json`. Release evidence belongs to one immutable
candidate containing both specification and implementation inputs.

## Story: Install the replacement through existing npm entry points

> As a package consumer, I want to install a packed ESM package whose
> declarations, exports and runtime behavior satisfy the recorded
> compatibility contract, so that upgrading needs no change to my imports.

The public facade adapts Effect to the established Promise interfaces. Type-only and browser-safe entry points retain their supported dependency closures. The Node runtime root retains its host-independent boundary.

### Every release check names the candidate it actually examined

Generation, proof, packed consumer compilation, packed import loading and
runtime conformance are separate evidence kinds. The implementation phase
must actually run those operations through normal entry points. This model
specifies freshness and aggregation of their results. A candidate carries
its attempt ID, source revision and immutable packed artifact digest. A
check records the three values it actually examined. Both passing and
failing results must match the selected candidate in all three values. A
matching failed check revokes release readiness. The checks run through the
actual package entry points after implementation.

```quint
type CheckKind = Generation | SafetyProof | PackedTypes | PackedImports | RuntimeConformance
type ReleaseCandidate = { attemptId: str, revision: str, artifactDigest: str }
type CandidateSelection = NoCandidate | SelectedCandidate(ReleaseCandidate)
type Release = { candidate: CandidateSelection, evidence: Set[CheckKind], ready: bool, revoked: bool, selectedAttempts: Set[str] }
pure val requiredChecks = Set(Generation, SafetyProof, PackedTypes, PackedImports, RuntimeConformance)
pure val candidateValues = Set(
  { attemptId: "first-attempt", revision: "revision-a", artifactDigest: "digest-a" },
  { attemptId: "second-attempt", revision: "revision-a", artifactDigest: "digest-a" },
  { attemptId: "first-attempt", revision: "revision-b", artifactDigest: "digest-a" },
  { attemptId: "first-attempt", revision: "revision-a", artifactDigest: "digest-b" },
  { attemptId: "first-attempt", revision: "", artifactDigest: "digest-a" }
)
pure val weight_recordPassingCheck = 5
pure val weight_markReady = 5
pure val initial: Release = { candidate: NoCandidate, evidence: Set(), ready: false, revoked: false, selectedAttempts: Set() }
pure def selectionOf(candidate: ReleaseCandidate): CandidateSelection =
  SelectedCandidate({ attemptId: candidate.attemptId, revision: candidate.revision, artifactDigest: candidate.artifactDigest })
pure def hasCandidate(r: Release): bool = {
  val selection = r.candidate
  match selection { | NoCandidate => false | SelectedCandidate(_) => true }
}
pure def canRecordPassingCheck(r: Release, candidate: ReleaseCandidate, check: CheckKind): bool =
  r.candidate == selectionOf(candidate) and not(r.ready)
pure def recordPassingCheck(r: Release, candidate: ReleaseCandidate, check: CheckKind): Release =
  { ...r, evidence: r.evidence.union(Set(check)) }
pure def canRecordFailingCheck(r: Release, candidate: ReleaseCandidate, check: CheckKind): bool =
  r.candidate == selectionOf(candidate)
pure def recordFailingCheck(r: Release, candidate: ReleaseCandidate, check: CheckKind): Release =
  { ...r, evidence: r.evidence.exclude(Set(check)), ready: false, revoked: r.ready or r.revoked }
pure def canMarkReady(r: Release): bool = hasCandidate(r) and requiredChecks.subseteq(r.evidence)
pure def markReady(r: Release): Release = { ...r, ready: true }
pure def alwaysReadyHasFreshCompleteEvidence(r: Release): bool =
  r.ready implies (hasCandidate(r) and requiredChecks.subseteq(r.evidence))
pure def alwaysEvidenceIsForAKnownCandidate(r: Release): bool = r.evidence.size() > 0 implies hasCandidate(r)
pure def sometimesReplacementIsReady(r: Release): bool = r.ready
pure def stepFailureRevokesReadiness(before: Release, via: str, after: Release): bool =
  via == "recordFailingCheck" implies not(after.ready)
pure def sometimesFailedCheckRevokesReadiness(r: Release): bool = r.revoked and not(r.ready)
pure def lawOtherCandidateCannotRecord(r: Release, candidate: ReleaseCandidate, check: CheckKind): bool =
  r.candidate != selectionOf(candidate) implies
    not(canRecordPassingCheck(r, candidate, check)) and not(canRecordFailingCheck(r, candidate, check))
```

### Each release selection reserves a fresh attempt ID

Selection requires a nonempty attempt ID, revision and artifact digest.
Retried builds of the same revision or artifact use a new attempt ID.
Reusing an attempt ID with a different revision or digest is refused.
Selection clears the previous attempt's evidence, readiness and revocation.

```quint
pure def canSelectCandidate(r: Release, candidate: ReleaseCandidate): bool =
  candidate.attemptId != "" and candidate.revision != "" and candidate.artifactDigest != "" and
    not(r.selectedAttempts.contains(candidate.attemptId))
pure def selectCandidate(r: Release, candidate: ReleaseCandidate): Release = {
  candidate: selectionOf(candidate), evidence: Set(), ready: false, revoked: false,
  selectedAttempts: r.selectedAttempts.union(Set(candidate.attemptId))
}
pure def alwaysCandidateWasSelected(r: Release): bool = {
  val selection = r.candidate
  match selection {
    | NoCandidate => true
    | SelectedCandidate(c) => c.attemptId != "" and c.revision != "" and c.artifactDigest != "" and
        r.selectedAttempts.contains(c.attemptId)
  }
}
pure def stepChangedCandidateDropsPriorResults(before: Release, via: str, after: Release): bool =
  via == "selectCandidate" implies (after.evidence.size() == 0 and not(after.ready) and not(after.revoked))
pure def stepUsedAttemptIdsStayReserved(before: Release, after: Release): bool =
  before.selectedAttempts.subseteq(after.selectedAttempts)
pure def lawUsedAttemptCannotBeSelected(r: Release, candidate: ReleaseCandidate): bool =
  r.selectedAttempts.contains(candidate.attemptId) implies not(canSelectCandidate(r, candidate))
```

# Npm replacement contract

The target is the existing `@elizaos/core` npm package. The export map,
conditions, exact public declarations, data assets and observed consumer
imports are pinned in `baseline/core-public-surface.json` and
`baseline/core-consumers.json`. Release evidence belongs to one immutable
candidate containing both specification and implementation inputs.

## Story: Install the replacement through existing npm entry points

As a package consumer, I install a packed ESM package whose declarations,
exports and runtime behavior satisfy the recorded compatibility contract.
The public facade adapts Effect to the established Promise interfaces.
Type-only and browser-safe entry points retain their supported dependency
closures. The Node runtime root retains its host-independent boundary.

### Every release check names the candidate it actually examined

Generation, proof, packed consumer compilation, packed import loading and
runtime conformance are separate evidence kinds. The implementation phase
must actually run those operations through normal entry points. This model
specifies freshness and aggregation of their results. A candidate identifies
one release attempt, including its immutable artifact digest. Retrying the
same artifact uses a fresh attempt identity. Asynchronous results from a
previous attempt cannot satisfy the current one. A failed check for the
current attempt revokes release readiness. The checks run through the
actual package entry points after implementation.

```quint
type CheckKind = Generation | SafetyProof | PackedTypes | PackedImports | RuntimeConformance
type Release = { candidate: str, evidence: Set[CheckKind], ready: bool, revoked: bool, selected: Set[str] }
pure val requiredChecks = Set(Generation, SafetyProof, PackedTypes, PackedImports, RuntimeConformance)
pure val candidateValues = Set("first-attempt", "second-attempt")
pure val weight_recordPassingCheck = 5
pure val weight_markReady = 5
pure val initial: Release = { candidate: "", evidence: Set(), ready: false, revoked: false, selected: Set() }
pure def canSelectCandidate(r: Release, candidate: str): bool = candidate != "" and not(r.selected.contains(candidate))
pure def selectCandidate(r: Release, candidate: str): Release = { candidate: candidate, evidence: Set(), ready: false, revoked: false, selected: r.selected.union(Set(candidate)) }
pure def canRecordPassingCheck(r: Release, candidate: str, check: CheckKind): bool = r.candidate != "" and candidate == r.candidate and not(r.ready)
pure def recordPassingCheck(r: Release, candidate: str, check: CheckKind): Release = { ...r, evidence: r.evidence.union(Set(check)) }
pure def canRecordFailingCheck(r: Release, candidate: str, check: CheckKind): bool = r.candidate != "" and candidate == r.candidate
pure def recordFailingCheck(r: Release, candidate: str, check: CheckKind): Release = { ...r, evidence: r.evidence.exclude(Set(check)), ready: false, revoked: r.ready or r.revoked }
pure def canMarkReady(r: Release): bool = r.candidate != "" and requiredChecks.subseteq(r.evidence)
pure def markReady(r: Release): Release = { ...r, ready: true }
pure def alwaysReadyHasFreshCompleteEvidence(r: Release): bool = r.ready implies (r.candidate != "" and requiredChecks.subseteq(r.evidence))
pure def alwaysEvidenceIsForAKnownCandidate(r: Release): bool = r.evidence.size() > 0 implies r.candidate != ""
pure def alwaysCandidateWasSelected(r: Release): bool = r.candidate != "" implies r.selected.contains(r.candidate)
pure def stepChangedCandidateDropsPriorResults(before: Release, via: str, after: Release): bool = via == "selectCandidate" implies (after.evidence.size() == 0 and not(after.ready))
pure def sometimesReplacementIsReady(r: Release): bool = r.ready
pure def stepFailureRevokesReadiness(before: Release, via: str, after: Release): bool =
  via == "recordFailingCheck" implies not(after.ready)
pure def sometimesFailedCheckRevokesReadiness(r: Release): bool = r.revoked and not(r.ready)
pure def lawOldCandidateCannotRecord(r: Release, candidate: str, check: CheckKind): bool =
  candidate != r.candidate implies not(canRecordPassingCheck(r, candidate, check)) and not(canRecordFailingCheck(r, candidate, check))
```

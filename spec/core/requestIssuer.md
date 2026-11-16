# Request operation issuer and restriction

Issuer capabilities in the process-global WeakMaps of `actions/task-extraction-context.ts`. A runtime and message object pair mints one opaque issuer; re-entering that pair returns the original issuer and cannot reset an invalid or tainted latch, and JSON copies can neither mint nor recover one. The host adapter supplies the object references.

## Story: Bind mutation interpretation to the original request

> As the execution boundary, I want a request classification that stays tied
> to its original actor, content and live host guard, so that a copied
> request cannot reuse it.

### Only a matching live original can create or use its issuer

Current authority requires the active object pair, original agent/message/room/entity identity, original request hash and a true current callback. A committed source also requires both current-source and retained-source hashes to equal the committed source hash. Hash and callback observations are external adapter inputs. Replacing a provider view does not replace this original source.

```quint
import requestCompletions as C from "./requestCompletions"
type InterpretationStatus = ExplicitInterpretation | UnavailableInterpretation | ContradictoryInterpretation
type Interpretation = { status: InterpretationStatus, operations: Set[C::Operation] }
type RequestIssuer = { issued: bool, live: bool, requestHash: str, currentRequestHash: str, committed: bool, tainted: bool, classification: C::RequestClass, interpretation: Interpretation, sourceHash: str, currentSourceHash: str, revision: int }
pure val emptyInterpretation: Interpretation = { status: UnavailableInterpretation, operations: Set() }
pure val initial: RequestIssuer = { issued: false, live: false, requestHash: "", currentRequestHash: "", committed: false, tainted: false, classification: C::UnresolvedClass, interpretation: emptyInterpretation, sourceHash: "", currentSourceHash: "", revision: 0 }
pure def validIssuer(s: RequestIssuer): bool = s.issued and s.live and s.requestHash == s.currentRequestHash and (not(s.committed) or s.sourceHash == s.currentSourceHash)
pure def canBeginIssuer(s: RequestIssuer, identityValid: bool, live: bool): bool = identityValid and live and (not(s.issued) or validIssuer(s))
pure def beginIssuer(s: RequestIssuer, identityValid: bool, live: bool, requestHash: str): RequestIssuer = if (s.issued) s else { ...s, issued: true, live: true, requestHash: requestHash, currentRequestHash: requestHash }
pure def observeCurrent(s: RequestIssuer, live: bool, currentRequestHash: str, currentSourceHash: str): RequestIssuer = { ...s, live: live, currentRequestHash: currentRequestHash, currentSourceHash: currentSourceHash }
pure def consistentInterpretation(classification: C::RequestClass, interpretation: Interpretation): bool = interpretation.status != ContradictoryInterpretation and (interpretation.status != ExplicitInterpretation or (if (classification == C::ReadOnlyClass) not(interpretation.operations.exists(operation => C::mutation(operation))) else if (classification == C::MutationClass) interpretation.operations.exists(operation => C::mutation(operation)) else interpretation.operations.size() == 0))
pure def normalizedInterpretation(classification: C::RequestClass, interpretation: Interpretation): Interpretation = if (consistentInterpretation(classification, interpretation)) interpretation else { status: ContradictoryInterpretation, operations: Set() }
pure def normalizedClassification(classification: C::RequestClass, interpretation: Interpretation): C::RequestClass = if (consistentInterpretation(classification, interpretation)) classification else C::UnresolvedClass
```

### A contradictory repeated commit permanently taints the issuer

The first valid commit records source and normalized interpretation and increments revision. The same commit is idempotent. A changed classification, source or interpretation marks the issuer tainted, resets classification to unresolved, records contradictory interpretation and increments revision. Later commits cannot restore its prior authority. A malformed interpretation normalizes to contradiction before committing.

```quint
pure def sameInterpretation(left: Interpretation, right: Interpretation): bool = left.status == right.status and left.operations.subseteq(right.operations) and right.operations.subseteq(left.operations)
pure def canCommitRestriction(s: RequestIssuer, sourceHash: str, observedSourceHash: str): bool = validIssuer(s) and sourceHash == observedSourceHash
pure def commitRestriction(s: RequestIssuer, classification: C::RequestClass, interpretation: Interpretation, sourceHash: str, observedSourceHash: str): RequestIssuer = {
  val normalized = normalizedInterpretation(classification, interpretation)
  val classified = normalizedClassification(classification, interpretation)
  if (not(s.committed)) { ...s, committed: true, classification: classified, interpretation: normalized, sourceHash: sourceHash, currentSourceHash: sourceHash, revision: s.revision + 1 }
  else if (not(s.tainted) and s.classification == classified and sameInterpretation(s.interpretation, normalized) and s.sourceHash == sourceHash) s
  else { ...s, tainted: true, classification: C::UnresolvedClass, interpretation: { status: ContradictoryInterpretation, operations: Set() }, revision: s.revision + 1 }
}
pure def restriction(s: RequestIssuer): C::RequestClass = if (validIssuer(s) and s.committed and not(s.tainted)) s.classification else C::UnresolvedClass
pure def alwaysIssuerRevision(s: RequestIssuer): bool = s.revision >= 0 and (s.committed implies s.issued and s.revision > 0)
pure def alwaysTaintedIssuerUnresolved(s: RequestIssuer): bool = s.tainted implies s.committed and s.classification == C::UnresolvedClass
pure def stepTaintCannotClear(before: RequestIssuer, after: RequestIssuer): bool = before.tainted implies after.tainted
pure def stepReentryCannotReset(before: RequestIssuer, via: str, after: RequestIssuer): bool = via == "beginIssuer" and before.issued implies before.issued == after.issued and before.live == after.live and before.requestHash == after.requestHash and before.currentRequestHash == after.currentRequestHash and before.committed == after.committed and before.tainted == after.tainted and before.classification == after.classification and sameInterpretation(before.interpretation, after.interpretation) and before.sourceHash == after.sourceHash and before.currentSourceHash == after.currentSourceHash and before.revision == after.revision
pure def sometimesMutationRestricted(s: RequestIssuer): bool = restriction(s) == C::MutationClass
pure def sometimesContradictionLatched(s: RequestIssuer): bool = s.tainted
pure val interpretationValues = Set({ status: UnavailableInterpretation, operations: Set() }, { status: ContradictoryInterpretation, operations: Set() }, { status: ExplicitInterpretation, operations: Set(C::GetOperation, C::ListOperation) }, { status: ExplicitInterpretation, operations: Set(C::UpdateOperation) }, { status: ExplicitInterpretation, operations: Set(C::CreateOperation, C::DeleteOperation) })
```

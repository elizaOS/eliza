# Request attempts and completion evidence

Source `actions/task-extraction-context.ts` binds opaque attempt tokens, denial identities and result-object fingerprints to an existing request issuer. These process-local associations support completion accounting. They never add permission to execute a mutation. The model follows one issuer and any number of attempts and result objects.

## Story: Keep mutation completion tied to the exact issued attempt

As the planner, I want a denied step removed only when a current same-request success proves its exact operation completed.

### Resolving a second different mutation invalidates an attempt

Read-only get/list checks leave mutation resolution unchanged. A mutation check resolves one operation, and a later different mutation latches conflict. A current attempt requires an unchanged issuer revision, original binding and live issuer. Without a current committed mutation classification, mutation checks deny with a process-local denial token. All decisions carry `addsAuthority: false`.

```quint
type Operation = NoOperation | GetOperation | ListOperation | CreateOperation | UpdateOperation | PatchOperation | DeleteOperation
type RequestClass = ReadOnlyClass | MutationClass | UnresolvedClass
type CompletionStatus = CurrentCompletion | StaleCompletion | ChangedCompletion
type Attempt = { id: str, revision: int, resolved: Operation, registered: Operation, conflicted: bool, invalidated: CompletionStatus }
type Completion = { id: str, attempt: str, fingerprint: str, projectionHash: str, changed: bool, hasFact: bool, projected: bool, status: CompletionStatus }
type Denial = { id: str, attempt: str, operation: Operation, classification: RequestClass, projectedResult: bool }
type RequestCompletions = { revision: int, live: bool, classification: RequestClass, attempts: List[Attempt], results: List[Completion], denials: List[Denial], lastAllowed: bool }
pure val emptyAttempt: Attempt = { id: "", revision: 0, resolved: NoOperation, registered: NoOperation, conflicted: false, invalidated: CurrentCompletion }
pure val emptyCompletion: Completion = { id: "", attempt: "", fingerprint: "", projectionHash: "", changed: false, hasFact: false, projected: false, status: StaleCompletion }
pure val emptyDenial: Denial = { id: "", attempt: "", operation: NoOperation, classification: UnresolvedClass, projectedResult: false }
pure val initial: RequestCompletions = { revision: 0, live: false, classification: UnresolvedClass, attempts: List(), results: List(), denials: List(), lastAllowed: false }
pure val revisionValues = Set(1, 2)
pure val idValues = Set("attempt1", "attempt2")
pure val attemptIdValues = idValues
pure val resultIdValues = Set("result1", "result2")
pure val sourceIdValues = Set("result1")
pure val targetIdValues = Set("result2")
pure val fingerprintValues = Set("fingerprint1", "fingerprint2")
pure val sourceFingerprintValues = fingerprintValues
pure val targetFingerprintValues = fingerprintValues
pure val projectionHashValues = Set("projection1", "projection2")
pure val operationValues = Set(NoOperation, GetOperation, ListOperation, CreateOperation, UpdateOperation, PatchOperation, DeleteOperation)
pure val registeredValues = operationValues
pure val denialIdValues = Set("", "denial1", "denial2")
pure val sourceDenialValues = Set("denial1", "denial2")
pure val errorIdValues = Set("error1", "error2")
pure val targetResultValues = resultIdValues
pure val expectedAttemptValues = idValues
pure def attemptAt(s: RequestCompletions, id: str): Attempt = s.attempts.select(attempt => attempt.id == id).nthOr(0, emptyAttempt)
pure def resultAt(s: RequestCompletions, id: str): Completion = s.results.select(result => result.id == id).nthOr(0, emptyCompletion)
pure def denialAt(s: RequestCompletions, id: str): Denial = s.denials.select(denial => denial.id == id).nthOr(0, emptyDenial)
pure def currentAttempt(s: RequestCompletions, id: str): bool = id != "" and s.live and attemptAt(s, id).id == id and attemptAt(s, id).revision == s.revision and not(attemptAt(s, id).conflicted)
pure def mutation(operation: Operation): bool = operation != NoOperation and operation != GetOperation and operation != ListOperation
pure def canObserveAuthority(s: RequestCompletions, revision: int): bool = revision >= 0
pure def observeAuthority(s: RequestCompletions, revision: int, live: bool, classification: RequestClass): RequestCompletions = { ...s, revision: revision, live: live, classification: classification }
pure def canBeginAttempt(s: RequestCompletions, id: str): bool = s.live and s.revision > 0 and id != "" and not(s.attempts.some(attempt => attempt.id == id))
pure def beginAttempt(s: RequestCompletions, id: str): RequestCompletions = { ...s, attempts: s.attempts.append({ ...emptyAttempt, id: id, revision: s.revision }) }
pure def canCheckOperation(s: RequestCompletions, operation: Operation): bool = operation != NoOperation
pure def checkOperation(s: RequestCompletions, id: str, operation: Operation, registered: Operation, denialId: str): RequestCompletions = {
  val old = attemptAt(s, id)
  val currentNow = currentAttempt(s, id)
  val conflict = currentNow and mutation(operation) and old.resolved != NoOperation and old.resolved != operation
  val allowed = not(mutation(operation)) or (currentNow and not(conflict) and s.classification == MutationClass)
  val updated = if (not(currentNow) or not(mutation(operation))) old else { ...old, resolved: if (old.resolved == NoOperation) operation else old.resolved, registered: if (old.registered == NoOperation) registered else old.registered, conflicted: old.conflicted or conflict }
  { ...s, attempts: s.attempts.listMap(attempt => if (attempt.id == id) updated else attempt), lastAllowed: allowed, denials: if (currentNow and not(conflict) and not(allowed) and denialId != "") s.denials.select(denial => denial.id != denialId).append({ id: denialId, attempt: id, operation: operation, classification: s.classification, projectedResult: false }) else s.denials }
}
pure def alwaysAttemptAndResultIdentityUnique(s: RequestCompletions): bool = s.attempts.every(attempt => s.attempts.select(other => other.id == attempt.id).length() == 1) and s.results.every(result => s.results.select(other => other.id == result.id).length() == 1)
pure def sometimesConflictingOperation(s: RequestCompletions): bool = s.attempts.some(attempt => attempt.conflicted)
pure def sometimesDeniedMutation(s: RequestCompletions): bool = s.denials.length() > 0
```

### Result fingerprints and invalidation persist across projection

A result may bind once to its current resolved attempt. Rebinding the same object is accepted only for the same attempt and fingerprint; a changed fingerprint permanently marks the association changed. Projection requires an owned source completion fact and a fresh target object under the same issuer. An unequal normalized projection retains a changed historical fact that blocks completion. Copying a fact into a projection requires matching fingerprints, normalized projection and owner. Once observed as stale or changed, completion cannot become current again.

```quint
pure def canBindResult(s: RequestCompletions, resultId: str, attemptId: str): bool = resultId != "" and currentAttempt(s, attemptId) and attemptAt(s, attemptId).resolved != NoOperation
pure def bindResult(s: RequestCompletions, resultId: str, attemptId: str, fingerprint: str, projectionHash: str, currentRegistration: bool, canonicalDispatch: bool): RequestCompletions = {
  val existing = resultAt(s, resultId)
  val hasFact = s.classification == MutationClass and mutation(attemptAt(s, attemptId).resolved) and mutation(attemptAt(s, attemptId).registered) and currentRegistration and canonicalDispatch
  if (existing.id != "") { ...s, results: s.results.listMap(result => if (result.id == resultId) { ...result, changed: result.changed or result.fingerprint != fingerprint } else result) }
  else { ...s, results: s.results.append({ id: resultId, attempt: attemptId, fingerprint: fingerprint, projectionHash: projectionHash, changed: false, hasFact: hasFact, projected: false, status: CurrentCompletion }) }
}
pure def canProjectResult(s: RequestCompletions, sourceId: str, targetId: str, ownerMatches: bool): bool = resultAt(s, sourceId).hasFact and targetId != "" and resultAt(s, targetId).id == "" and ownerMatches
pure def projectResult(s: RequestCompletions, sourceId: str, targetId: str, fingerprint: str, projectionHash: str, ownerMatches: bool, sourceFingerprint: str): RequestCompletions = {
  val original = resultAt(s, sourceId)
  val changed = original.changed or sourceFingerprint != original.fingerprint or projectionHash != original.projectionHash
  { ...s, results: s.results.listMap(result => if (result.id == sourceId) { ...result, changed: result.changed or sourceFingerprint != result.fingerprint } else result).append({ ...original, id: targetId, fingerprint: fingerprint, projectionHash: projectionHash, changed: changed, hasFact: changed, projected: true }) }
}
pure def canCopyCompletion(s: RequestCompletions, sourceId: str, targetId: str, sourceFingerprint: str, targetFingerprint: str): bool = resultAt(s, sourceId).hasFact and resultAt(s, targetId).projected and resultAt(s, sourceId).attempt == resultAt(s, targetId).attempt and not(resultAt(s, sourceId).changed) and not(resultAt(s, targetId).changed) and resultAt(s, sourceId).fingerprint == sourceFingerprint and resultAt(s, targetId).fingerprint == targetFingerprint and resultAt(s, sourceId).projectionHash == resultAt(s, targetId).projectionHash
pure def copyCompletion(s: RequestCompletions, sourceId: str, targetId: str, sourceFingerprint: str, targetFingerprint: str): RequestCompletions = { ...s, results: s.results.listMap(result => if (result.id == targetId) { ...result, hasFact: true } else result) }
pure def canInspectCompletion(s: RequestCompletions, resultId: str, ownerMatches: bool): bool = resultAt(s, resultId).hasFact and ownerMatches
pure def inspectCompletion(s: RequestCompletions, resultId: str, ownerMatches: bool, fingerprint: str, registrationCurrent: bool): RequestCompletions = {
  val original = resultAt(s, resultId)
  val attempt = attemptAt(s, original.attempt)
  val changed = original.changed or original.fingerprint != fingerprint or attempt.invalidated == ChangedCompletion
  val stale = not(currentAttempt(s, original.attempt)) or not(registrationCurrent) or attempt.invalidated == StaleCompletion
  val status = if (changed) ChangedCompletion else if (stale) StaleCompletion else CurrentCompletion
  { ...s, results: s.results.listMap(result => if (result.id == resultId) { ...result, status: status, changed: changed } else result), attempts: s.attempts.listMap(entry => if (entry.id == original.attempt and status != CurrentCompletion) { ...entry, invalidated: status } else entry) }
}
pure def alwaysCompletionOwnsAttempt(s: RequestCompletions): bool = s.results.every(result => s.attempts.some(attempt => attempt.id == result.attempt))
pure def stepChangedAssociationStaysChanged(before: RequestCompletions, after: RequestCompletions): bool = before.results.every(result => not(result.changed) or resultAt(after, result.id).changed)
pure def sometimesChangedCompletionBlocked(s: RequestCompletions): bool = s.results.some(result => result.status == ChangedCompletion)
pure def sometimesStaleCompletionBlocked(s: RequestCompletions): bool = s.results.some(result => result.status == StaleCompletion)
```

### Denial projection needs the exact attempt and an unexecuted zero-effect failure

Decision/error denial proofs can transfer only to an already attempt-owned result. A result denial source must itself still have the exact failure shape. Unknown or reconciliation-required outcomes, applied effects, missing false-executed evidence or another attempt reject transfer. A same-operation successful completion matches a denied requested mutation only with current issuer revision, registered family and canonical child identity, no contradictory status, and an applied or replayed-noop receipt naming the exact note resource.

```quint
pure def canWrapDenialError(s: RequestCompletions, sourceDenial: str, errorId: str): bool = denialAt(s, sourceDenial).id != "" and currentAttempt(s, denialAt(s, sourceDenial).attempt) and errorId != "" and denialAt(s, errorId).id == ""
pure def wrapDenialError(s: RequestCompletions, sourceDenial: str, errorId: str): RequestCompletions = { ...s, denials: s.denials.append({ ...denialAt(s, sourceDenial), id: errorId, projectedResult: false }) }
pure def canTransferDenial(s: RequestCompletions, sourceDenial: str, targetResult: str, expectedAttempt: str, targetNotStarted: bool, sourceNotStarted: bool): bool = denialAt(s, sourceDenial).id != "" and denialAt(s, sourceDenial).attempt == expectedAttempt and currentAttempt(s, expectedAttempt) and attemptAt(s, expectedAttempt).resolved == denialAt(s, sourceDenial).operation and s.classification == denialAt(s, sourceDenial).classification and resultAt(s, targetResult).attempt == expectedAttempt and targetNotStarted and (not(denialAt(s, sourceDenial).projectedResult) or sourceNotStarted)
pure def transferDenial(s: RequestCompletions, sourceDenial: str, targetResult: str, expectedAttempt: str, targetNotStarted: bool, sourceNotStarted: bool): RequestCompletions = { ...s, denials: s.denials.select(denial => denial.id != targetResult).append({ ...denialAt(s, sourceDenial), id: targetResult, projectedResult: true }) }
pure def matchingMutationCompletion(sameIssuer: bool, sameRevision: bool, sameFamily: bool, sameChild: bool, sameOperation: bool, bothCurrent: bool, success: bool, noContradiction: bool, receiptMatches: bool): bool = sameIssuer and sameRevision and sameFamily and sameChild and sameOperation and bothCurrent and success and noContradiction and receiptMatches
pure def lawOtherOperationNeverCompletes(sameIssuer: bool, sameRevision: bool, sameFamily: bool, sameChild: bool, bothCurrent: bool, success: bool, noContradiction: bool, receiptMatches: bool): bool = not(matchingMutationCompletion(sameIssuer, sameRevision, sameFamily, sameChild, false, bothCurrent, success, noContradiction, receiptMatches))
```

# Model selection and cancellation

Model invocation retains the ordered registration list and complete request identity. Sources include [model-dispatch.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/model-dispatch.ts), [model-policy.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/model-policy.ts), [ModelProviderFailover.qnt](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/quint/ModelProviderFailover.qnt) and [TurnCancellation.qnt](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/quint/TurnCancellation.qnt). The host supplies the registered providers in priority and registration order.

## Story: Dispatch a complete admitted request

As a caller I receive a result from the selected capability with original provider evidence.

### Admission checks the complete request without changing its source bytes

The request retains the exact source IDs, texts, authors, mandatory evidence, tool definitions and schemas in a structural envelope, alongside the provider serialization. The provider serializer must encode that complete envelope at its external adapter boundary. A budget rejection leaves both representations intact.

```quint
type DispatchPhase = Unconfigured | Configured | Admitted | Invoking | Answered | DispatchFailed | Cancelled
type Outcome = Answer | RefusedConnection | RetryEnvelope | BadRequest | FundingDenied | ProcessingDenied | ProviderAbort | CallerAbort | ExhaustedBudget
type Registration = { id: int, provider: int }
type Attempt = { registration: Registration, resultKind: Outcome }
pure val missingAttempt: Attempt = {registration: {id: -1, provider: -1}, resultKind: Answer}
type RequestEvidence = { sourceIds: List[str], sourceTexts: List[str], sourceAuthors: List[str], mandatory: List[str], tools: List[str], schemas: List[str] }
pure val emptyRequestEvidence: RequestEvidence = {sourceIds: List(), sourceTexts: List(), sourceAuthors: List(), mandatory: List(), tools: List(), schemas: List()}
type Dispatch = { evidence: RequestEvidence, phase: DispatchPhase, sourceBytes: str, admittedBytes: str, capability: bool, withinBudget: bool, pinned: bool, speech: bool, remaining: List[Registration], attempts: List[Attempt], exhausted: Set[int], emitted: bool, answerRegistration: int, sameTurn: bool, ownSignal: bool, rootAborted: bool, ownAborted: bool, providerAborted: bool }
pure val initial: Dispatch = { evidence: emptyRequestEvidence, phase: Unconfigured, sourceBytes: "", admittedBytes: "", capability: false, withinBudget: false, pinned: false, speech: false, remaining: List(), attempts: List(), exhausted: Set(), emitted: false, answerRegistration: -1, sameTurn: false, ownSignal: false, rootAborted: false, ownAborted: false, providerAborted: false }
pure val evidenceValues = Set(emptyRequestEvidence, {sourceIds: List("request"), sourceTexts: List("complete user request"), sourceAuthors: List("user"), mandatory: List("standing rule"), tools: List("READ"), schemas: List("READ schema")})
pure val tokenValues = Set("complete serialized request a", "complete serialized request b")
pure val registrationsValues = Set(List({id: 1, provider: 1}), List({id: 1, provider: 1}, {id: 2, provider: 1}, {id: 3, provider: 2}))
pure def aborted(s: Dispatch): bool = (s.sameTurn and s.rootAborted) or (s.ownSignal and s.ownAborted) or s.providerAborted
pure def canConfigure(s: Dispatch, token: str, registrations: List[Registration], available: bool, budget: bool, pinned: bool, speech: bool, sameTurn: bool, ownSignal: bool, evidence: RequestEvidence): bool = evidence.sourceIds.length() == evidence.sourceTexts.length() and evidence.sourceIds.length() == evidence.sourceAuthors.length() and s.phase == Unconfigured and token != "" and registrations.every(r => r.id >= 0 and r.provider >= 0 and registrations.select(x => x.id == r.id).length() == 1)
pure def configure(s: Dispatch, token: str, registrations: List[Registration], available: bool, budget: bool, pinned: bool, speech: bool, sameTurn: bool, ownSignal: bool, evidence: RequestEvidence): Dispatch = { ...s, evidence: evidence, phase: Configured, sourceBytes: token, remaining: registrations, capability: available, withinBudget: budget, pinned: pinned, speech: speech, sameTurn: sameTurn, ownSignal: ownSignal }
pure def canAdmitRequest(s: Dispatch): bool = s.phase == Configured and s.capability and s.withinBudget and s.remaining.length() > 0 and not(aborted(s))
pure def admitRequest(s: Dispatch): Dispatch = { ...s, phase: Admitted, admittedBytes: s.sourceBytes }
pure def canRejectRequest(s: Dispatch): bool = s.phase == Configured and not(aborted(s)) and (not(s.capability) or not(s.withinBudget) or s.remaining.length() == 0)
pure def rejectRequest(s: Dispatch): Dispatch = { ...s, phase: DispatchFailed }
pure def canInvokeModel(s: Dispatch): bool = s.phase == Admitted and s.remaining.length() > 0 and not(aborted(s))
pure def invokeModel(s: Dispatch): Dispatch = { ...s, phase: Invoking }
pure def alwaysAdmittedRequestComplete(s: Dispatch): bool = (s.phase == Admitted or s.phase == Invoking or s.phase == Answered) implies (s.capability and s.withinBudget and s.admittedBytes == s.sourceBytes)
pure def stepSourceBytesPreserved(before: Dispatch, after: Dispatch): bool = before.phase != Unconfigured implies after.sourceBytes == before.sourceBytes and after.evidence == before.evidence
pure def sometimesOverflowRejectedBeforeProvider(s: Dispatch): bool = s.phase == DispatchFailed and not(s.withinBudget) and s.attempts.length() == 0
```

### Eligible text failures advance only to registrations with remaining budget

Funding, policy, request errors, speech and cancellation terminate dispatch. Exhausted provider identities remove all of that provider's remaining registrations.

Discovered by the proof. Configuration has no prior attempts. Every active
registration has a distinct identity and has yet to be attempted. This makes
the replacement provider chain disjoint from the attempt history.

```quint
pure def uniqueRegistrations(registrations: List[Registration]): bool = registrations.every(r => registrations.select(other => other.id == r.id).length() == 1)
pure def tryRegistration(registrations: List[Registration], exhausted: Set[int]): List[Registration] = registrations.removeAt(0).select(r => not(exhausted.contains(r.provider)))
pure def retryable(resultKind: Outcome): bool = resultKind == RefusedConnection or resultKind == RetryEnvelope or resultKind == ExhaustedBudget
pure def canObserveOutcome(s: Dispatch, resultKind: Outcome): bool = s.phase == Invoking and s.remaining.length() > 0 and not(aborted(s))
pure def observeOutcome(s: Dispatch, resultKind: Outcome): Dispatch = {
  val registration = s.remaining.nthOr(0, {id: -1, provider: -1})
  val exhausted = if (resultKind == ExhaustedBudget) s.exhausted.union(Set(registration.provider)) else s.exhausted
  val following = tryRegistration(s.remaining, exhausted)
  val retry = retryable(resultKind) and not(s.speech) and not(s.pinned) and not(s.emitted) and following.length() > 0
  { ...s, attempts: s.attempts.append({ registration: registration, resultKind: resultKind }), exhausted: exhausted,
    remaining: if (retry) following else s.remaining,
    providerAborted: resultKind == ProviderAbort or resultKind == CallerAbort,
    phase: if (resultKind == Answer) Answered else if (resultKind == ProviderAbort or resultKind == CallerAbort) Cancelled else if (retry) Admitted else DispatchFailed,
    answerRegistration: if (resultKind == Answer) registration.id else -1 }
}
pure def canEmitToken(s: Dispatch): bool = s.phase == Invoking and not(aborted(s))
pure def emitToken(s: Dispatch): Dispatch = { ...s, emitted: true }
pure def alwaysExhaustedProvidersSkipped(s: Dispatch): bool = (s.phase == Configured or s.phase == Admitted or s.phase == Invoking) implies s.remaining.every(r => not(s.exhausted.contains(r.provider)))
pure def alwaysConfiguredHasNoAttempts(s: Dispatch): bool = (s.phase == Unconfigured or s.phase == Configured) implies s.attempts.length() == 0 and s.exhausted.size() == 0
pure def alwaysRemainingRegistrationsFresh(s: Dispatch): bool = (s.phase == Configured or s.phase == Admitted or s.phase == Invoking) implies (uniqueRegistrations(s.remaining) and s.remaining.every(r => not(s.attempts.some(a => a.registration.id == r.id))))
pure def alwaysRegistrationAttemptedOnce(s: Dispatch): bool = s.attempts.every(a => s.attempts.select(b => a.registration.id == b.registration.id).length() == 1)
pure def alwaysTerminalOutcomeEndsChain(s: Dispatch): bool = s.phase == Admitted and s.attempts.length() > 0 implies retryable(s.attempts.nthOr(s.attempts.length() - 1, missingAttempt).resultKind) and not(s.pinned) and not(s.speech) and not(s.emitted)
pure def alwaysAnswerNamesProvider(s: Dispatch): bool = s.phase == Answered implies (s.attempts.length() > 0 and s.attempts.nthOr(s.attempts.length() - 1, missingAttempt).resultKind == Answer and s.answerRegistration == s.attempts.nthOr(s.attempts.length() - 1, missingAttempt).registration.id)
pure def sometimesConnectionFailureFallsBack(s: Dispatch): bool = s.phase == Admitted and s.attempts.length() == 1 and s.attempts.nthOr(0, missingAttempt).resultKind == RefusedConnection
pure def sometimesProviderBudgetSkipsSibling(s: Dispatch): bool = s.phase == Admitted and s.exhausted.contains(1) and s.remaining.nthOr(0, {id: -1, provider: -1}).provider == 2
pure def sometimesPinnedProviderFailureIsTerminal(s: Dispatch): bool = s.phase == DispatchFailed and s.pinned and s.attempts.length() > 0 and s.attempts.nthOr(0, missingAttempt).resultKind == RefusedConnection
pure def sometimesVisibleOutputPreventsRetry(s: Dispatch): bool = s.phase == DispatchFailed and s.emitted and s.attempts.length() > 0
```

### Cancellation follows turn identity and blocks fallback

Root cancellation crosses same-turn scopes. A distinct turn inherits only its own supplied signal.

```quint
pure def canAbortRoot(s: Dispatch): bool = not(s.rootAborted)
pure def abortRoot(s: Dispatch): Dispatch = { ...s, rootAborted: true }
pure def canAbortOwn(s: Dispatch): bool = s.ownSignal and not(s.ownAborted)
pure def abortOwn(s: Dispatch): Dispatch = { ...s, ownAborted: true }
pure def canCancelDispatch(s: Dispatch): bool = aborted(s) and (s.phase == Configured or s.phase == Admitted or s.phase == Invoking)
pure def cancelDispatch(s: Dispatch): Dispatch = { ...s, phase: Cancelled }
pure def stepNoRetryAfterCancellation(before: Dispatch, after: Dispatch): bool = before.phase != Unconfigured and aborted(before) implies after.remaining == before.remaining
pure def sometimesOwnSignalCancelsOtherTurn(s: Dispatch): bool = not(s.sameTurn) and s.ownSignal and s.ownAborted and s.phase == Cancelled
pure def sometimesOtherTurnIgnoresRootAbort(s: Dispatch): bool = not(s.sameTurn) and s.rootAborted and s.phase == Invoking and not(aborted(s))
pure def sometimesProviderAbortEndsChain(s: Dispatch): bool = s.providerAborted and s.phase == Cancelled and s.attempts.length() == 1
```

### An aborted active dispatch eventually settles as cancelled

The cancellation observer eventually runs after an authoritative same-turn or provider abort.

Discovered by simulation: dispatch checks the signal before its policy and
request admission checks. A configured request with an observed abort settles
as cancelled even if admission would otherwise reject it.

```quint
pure val fair_cancelDispatch = "weak"
pure def leadsToCancelledDispatch(s: Dispatch, later: Dispatch): bool = aborted(s) and (s.phase == Configured or s.phase == Admitted or s.phase == Invoking) implies later.phase == Cancelled
```

### Every admitted model request has an enabled terminal or provider step

Unconfigured, answered, failed and cancelled requests are quiescent. Configuration admits or rejects explicitly, and admitted or invoking requests can advance or observe cancellation.

```quint
pure def dispatchQuiescent(s: Dispatch): bool = s.phase == Unconfigured or s.phase == Answered or s.phase == DispatchFailed or s.phase == Cancelled
pure def dispatchProgressEnabled(s: Dispatch): bool = canAdmitRequest(s) or canRejectRequest(s) or canInvokeModel(s) or canObserveOutcome(s, Answer) or canCancelDispatch(s)
pure def alwaysDispatchDeadlockFree(s: Dispatch): bool = dispatchQuiescent(s) or dispatchProgressEnabled(s)
pure def alwaysActiveDispatchHasRegistration(s: Dispatch): bool = s.phase == Admitted or s.phase == Invoking implies s.remaining.length() > 0
```

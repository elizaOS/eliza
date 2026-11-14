# Provider-prepared request guards

Each guard captures the complete serialized request and tokenizer result. Rechecking bytes and token counts precedes every transport attempt and optional host allowance reservation. Sources include [prepared-model-request.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/prepared-model-request.ts) and [streaming-context.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/streaming-context.ts).

## Story: Bind every transport retry to the admitted request

As a provider I serialize a request once and prove that retries preserve its model-visible bytes and token count.

### A request guard captures its exact admitted serialization

Creation receives one correlated request and budget record. Simulation exercises exact admission and rejection, estimate-only admission, malformed exact authority and issued turn contexts; all well-typed records remain eligible for the same guards. Graph and raw-wire serializers are mutually exclusive. Exact count authority requires a tokenizer and explicit context and output limits. Provider estimates remain diagnostic. With no tokenizer, the diagnostic count equals the UTF-8 length derived from the complete UTF-16 sequence.

```quint
import modelAttemptLeases as L from "./modelAttemptLeases"
import unicode as U from "./unicode"
type CountSource = ProviderTokenizer | TokenizerEstimate | Utf8UpperBound
type GuardPhase = GuardReady | GuardRejected
type RequestGuardInput = {provider: str, model: str, route: str, codeUnits: List[int], inputCount: int, countSource: CountSource, threshold: int, exactAuthority: bool, outputTokens: int, leaseId: int, messageId: str}
type RequestObservation = {codeUnits: List[int], inputCount: int, countSource: CountSource}
type PreparedGuard = {id: int, phase: GuardPhase, provider: str, model: str, route: str, codeUnits: List[int], inputCount: int, countSource: CountSource, threshold: int, exactAuthority: bool, outputTokens: int, leaseId: int, messageId: str, attempts: int, errorCode: str}
type PreparedRequests = {guards: List[PreparedGuard], leases: L::ModelLeases}
pure val initial: PreparedRequests = {guards: List(), leases: L::initial}
pure val guardIdValues = Set(1, 2, 3)
pure val leaseIdValues = Set(0, 1, 2)
pure val messageIdValues = Set("turn-a", "turn-b")
pure val providerTokenizer: CountSource = ProviderTokenizer
pure val tokenizerEstimate: CountSource = TokenizerEstimate
pure val utf8UpperBound: CountSource = Utf8UpperBound
pure val admittedCodeUnits = List(65, 55357, 56832)
pure val changedCodeUnits = List(66, 55357, 56832)
pure val requestInputValues = Set(
  {provider: "alpha", model: "small", route: "text", codeUnits: admittedCodeUnits, inputCount: 1, countSource: providerTokenizer, threshold: 10, exactAuthority: true, outputTokens: 1, leaseId: 0, messageId: "turn-a"},
  {provider: "alpha", model: "small", route: "text", codeUnits: admittedCodeUnits, inputCount: 1, countSource: providerTokenizer, threshold: 10, exactAuthority: true, outputTokens: 1, leaseId: 1, messageId: "turn-a"},
  {provider: "alpha", model: "small", route: "text", codeUnits: admittedCodeUnits, inputCount: 1, countSource: providerTokenizer, threshold: 10, exactAuthority: true, outputTokens: 1, leaseId: 2, messageId: "turn-b"},
  {provider: "alpha", model: "small", route: "text", codeUnits: admittedCodeUnits, inputCount: 10, countSource: providerTokenizer, threshold: 10, exactAuthority: true, outputTokens: 1, leaseId: 0, messageId: "turn-a"},
  {provider: "beta", model: "large", route: "text", codeUnits: admittedCodeUnits, inputCount: 20, countSource: tokenizerEstimate, threshold: 10, exactAuthority: false, outputTokens: 10, leaseId: 0, messageId: "turn-b"},
  {provider: "beta", model: "large", route: "missing", codeUnits: changedCodeUnits, inputCount: 5, countSource: utf8UpperBound, threshold: 100, exactAuthority: false, outputTokens: 10, leaseId: 0, messageId: "turn-b"},
  {provider: "alpha", model: "small", route: "text", codeUnits: admittedCodeUnits, inputCount: 1, countSource: tokenizerEstimate, threshold: 10, exactAuthority: true, outputTokens: 1, leaseId: 0, messageId: "turn-a"})
pure val observedValues = Set(
  {codeUnits: admittedCodeUnits, inputCount: 1, countSource: providerTokenizer},
  {codeUnits: changedCodeUnits, inputCount: 1, countSource: providerTokenizer},
  {codeUnits: admittedCodeUnits, inputCount: 10, countSource: providerTokenizer},
  {codeUnits: admittedCodeUnits, inputCount: 1, countSource: tokenizerEstimate},
  {codeUnits: admittedCodeUnits, inputCount: 20, countSource: tokenizerEstimate},
  {codeUnits: changedCodeUnits, inputCount: 5, countSource: utf8UpperBound})
pure val allowanceInputValues = L::allowanceInputValues
pure val noGuard: PreparedGuard = {id: 0, phase: GuardRejected, provider: "", model: "", route: "", codeUnits: List(), inputCount: 0, countSource: Utf8UpperBound, threshold: 0, exactAuthority: false, outputTokens: 0, leaseId: 0, messageId: "", attempts: 0, errorCode: "missing"}
pure def alwaysGuardIdsUnique(s: PreparedRequests): bool = s.guards.every(g => g.id > 0 and s.guards.select(other => other.id == g.id).length() == 1)
pure def preparedGuard(s: PreparedRequests, guardId: int): PreparedGuard = s.guards.select(g => g.id == guardId).nthOr(0, noGuard)
pure def canCreateRequestGuard(s: PreparedRequests, guardId: int, requestInput: RequestGuardInput): bool =
  guardId > 0 and requestInput.provider != "" and requestInput.model != "" and U::validCodeUnits(requestInput.codeUnits) and requestInput.inputCount >= 0 and (requestInput.countSource == Utf8UpperBound implies requestInput.inputCount == U::utf8Length(requestInput.codeUnits)) and requestInput.threshold > 0 and requestInput.outputTokens > 0 and not(s.guards.some(g => g.id == guardId)) and (not(requestInput.exactAuthority) or requestInput.countSource == providerTokenizer) and (requestInput.leaseId == 0 or L::leaseContextValid(s.leases, requestInput.leaseId, requestInput.messageId))
pure def buildRequestGuard(guardId: int, requestInput: RequestGuardInput): PreparedGuard = {
  val overBudget = requestInput.exactAuthority and requestInput.inputCount >= requestInput.threshold
  {id: guardId, phase: if (overBudget) GuardRejected else GuardReady, provider: requestInput.provider, model: requestInput.model, route: requestInput.route, codeUnits: requestInput.codeUnits, inputCount: requestInput.inputCount, countSource: requestInput.countSource, threshold: requestInput.threshold, exactAuthority: requestInput.exactAuthority, outputTokens: requestInput.outputTokens, leaseId: requestInput.leaseId, messageId: requestInput.messageId, attempts: 0, errorCode: if (overBudget) "MODEL_INPUT_OVER_BUDGET" else ""}
}
pure def createRequestGuard(s: PreparedRequests, guardId: int, requestInput: RequestGuardInput): PreparedRequests = { ...s, guards: s.guards.append(buildRequestGuard(guardId, requestInput)) }
pure def alwaysExactBudgetAdmission(s: PreparedRequests): bool = s.guards.every(g => g.phase == GuardReady and g.exactAuthority implies g.inputCount < g.threshold)
pure def alwaysGuardAttemptsNonnegative(s: PreparedRequests): bool = s.guards.every(g => g.attempts >= 0)
pure def sometimesEstimateAboveThresholdAdmitted(s: PreparedRequests): bool = s.guards.some(g => not(g.exactAuthority) and g.inputCount >= g.threshold and g.phase == GuardReady)
```

### Every dispatched attempt rechecks bytes counts and lease authority

The allowance computes its input charge bound from the actual serialized code units. A standalone unchanged check consumes no transport attempt. A failed check reports a typed error without debiting the lease or incrementing the attempt count. The guard remains usable if a later check observes the original bytes and count again.

The aggregate also selects an existing eligible guard and submits its captured
bytes and count through the same dispatch guard. This models a normal unchanged
retry without requiring a sampled caller to guess values already held by the
provider; explicit changed-byte and changed-count operations remain available.

Discovered by the proof. The composition retains the complete allowance and
lease invariant. The unchanged retry uses the same dispatch guard as the
identity-specific entry point. Each guard ID uniquely identifies its retained request and latest diagnostic.

```quint
pure def requestUnchanged(g: PreparedGuard, observed: RequestObservation): bool = g.codeUnits == observed.codeUnits and g.inputCount == observed.inputCount and g.countSource == observed.countSource
pure def capturedObservation(g: PreparedGuard): RequestObservation = {codeUnits: g.codeUnits, inputCount: g.inputCount, countSource: g.countSource}
pure def canCheckUnchanged(s: PreparedRequests, guardId: int, observed: RequestObservation): bool = preparedGuard(s, guardId).phase == GuardReady and preparedGuard(s, guardId).id != 0
pure def checkUnchanged(s: PreparedRequests, guardId: int, observed: RequestObservation): PreparedRequests = { ...s, guards: s.guards.listMap(g => if (g.id != guardId) g else { ...g, errorCode: if (requestUnchanged(g, observed)) "" else if (g.codeUnits != observed.codeUnits) "MODEL_PREPARED_REQUEST_MUTATED" else "MODEL_PREPARED_REQUEST_TOKEN_COUNT_DRIFT" }) }
pure def preparedReservation(g: PreparedGuard, observed: RequestObservation, currentTurn: bool): L::AttemptReservationInput = {messageId: g.messageId, provider: g.provider, model: g.model, route: g.route, codeUnits: observed.codeUnits, outputTokens: g.outputTokens, currentTurn: currentTurn}
pure def canDispatchPrepared(s: PreparedRequests, guardId: int, observed: RequestObservation, currentTurn: bool): bool = {
  val g = preparedGuard(s, guardId)
  g.id != 0 and g.phase == GuardReady and requestUnchanged(g, observed) and (g.leaseId == 0 or L::canReserveAttempt(s.leases, g.leaseId, preparedReservation(g, observed, currentTurn)))
}
pure def dispatchPrepared(s: PreparedRequests, guardId: int, observed: RequestObservation, currentTurn: bool): PreparedRequests = {
  val g = preparedGuard(s, guardId)
  { ...s, guards: s.guards.listMap(old => if (old.id == guardId) { ...old, attempts: old.attempts + 1, errorCode: "" } else old), leases: if (g.leaseId == 0) s.leases else L::reserveAttempt(s.leases, g.leaseId, preparedReservation(g, observed, currentTurn)) }
}
pure def currentDispatchCandidate(s: PreparedRequests, currentTurn: bool): PreparedGuard = s.guards.select(g => canDispatchPrepared(s, g.id, capturedObservation(g), currentTurn)).nthOr(0, noGuard)
pure def canDispatchUnchanged(s: PreparedRequests, currentTurn: bool): bool = {
  val g = currentDispatchCandidate(s, currentTurn)
  g.id != 0 and canDispatchPrepared(s, g.id, capturedObservation(g), currentTurn)
}
pure def dispatchUnchanged(s: PreparedRequests, currentTurn: bool): PreparedRequests = {
  val g = currentDispatchCandidate(s, currentTurn)
  dispatchPrepared(s, g.id, capturedObservation(g), currentTurn)
}
pure def stepGuardBytesStayFixed(before: PreparedRequests, after: PreparedRequests): bool = before.guards.every(g => after.guards.some(other => other.id == g.id and other.codeUnits == g.codeUnits and other.inputCount == g.inputCount and other.countSource == g.countSource))
pure def stepUnchangedCheckDoesNotCount(before: PreparedRequests, via: str, after: PreparedRequests): bool = via == "checkUnchanged" implies before.guards.every(g => after.guards.some(other => other.id == g.id and other.attempts == g.attempts))
pure def alwaysPreparedLeasesStayNonnegative(s: PreparedRequests): bool = L::alwaysAllowancesNonnegative(s.leases) and L::alwaysLeaseHasAllowance(s.leases) and L::alwaysLeasesUnique(s.leases) and L::alwaysAllowanceIdsUnique(s.leases)
pure def sometimesMutatedRequestRejected(s: PreparedRequests): bool = s.guards.some(g => g.errorCode == "MODEL_PREPARED_REQUEST_MUTATED" and g.attempts == 0)
pure def alwaysRecheckKeepsAdmittedGuard(s: PreparedRequests): bool = s.guards.every(g => g.errorCode == "MODEL_PREPARED_REQUEST_MUTATED" or g.errorCode == "MODEL_PREPARED_REQUEST_TOKEN_COUNT_DRIFT" implies g.phase == GuardReady)
pure def sometimesPreparedAttemptDispatched(s: PreparedRequests): bool = s.guards.some(g => g.attempts > 0)
```

### Prepared requests use the same issued allowance and turn lease

The guard's optional lease is created and closed through the host allowance model. Observing an expired allowance clock or closing its turn makes later prepared attempts fail admission without changing the stored request. A later wall-clock rewind can restore time eligibility for an unclosed allowance; it cannot undo explicit allowance or turn closure.

```quint
pure def canCreateAllowance(s: PreparedRequests, allowanceId: int, allowanceInput: L::AllowanceInput): bool = L::canCreateAllowance(s.leases, allowanceId, allowanceInput)
pure def createAllowance(s: PreparedRequests, allowanceId: int, allowanceInput: L::AllowanceInput): PreparedRequests = { ...s, leases: L::createAllowance(s.leases, allowanceId, allowanceInput) }
pure def canOpenTurnLease(s: PreparedRequests, allowanceId: int, leaseId: int, messageId: str): bool = L::canOpenTurnLease(s.leases, allowanceId, leaseId, messageId)
pure def openTurnLease(s: PreparedRequests, allowanceId: int, leaseId: int, messageId: str): PreparedRequests = { ...s, leases: L::openTurnLease(s.leases, allowanceId, leaseId, messageId) }
pure def canCloseTurnLease(s: PreparedRequests, leaseId: int): bool = L::canCloseTurnLease(s.leases, leaseId)
pure def closeTurnLease(s: PreparedRequests, leaseId: int): PreparedRequests = { ...s, leases: L::closeTurnLease(s.leases, leaseId) }
pure def canCloseAllowance(s: PreparedRequests, allowanceId: int): bool = L::canCloseAllowance(s.leases, allowanceId)
pure def closeAllowance(s: PreparedRequests, allowanceId: int): PreparedRequests = { ...s, leases: L::closeAllowance(s.leases, allowanceId) }
pure def setAllowanceClock(s: PreparedRequests, now: int): PreparedRequests = { ...s, leases: L::setAllowanceClock(s.leases, now) }
pure val nowValues = L::nowValues
pure def sometimesLeasedTransportReserved(s: PreparedRequests): bool = s.guards.some(g => g.leaseId > 0 and g.attempts > 0) and s.leases.reservations.length() > 0
```

# Provider-prepared request guards

Each guard captures the complete serialized request and tokenizer result. Rechecking bytes and token counts precedes every transport attempt and optional host allowance reservation. Sources include [prepared-model-request.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/prepared-model-request.ts) and [streaming-context.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/streaming-context.ts).

## Story: Bind every transport retry to the admitted request

As a provider I serialize a request once and prove that retries preserve its model-visible bytes and token count.

### A request guard captures its exact admitted serialization

Graph and raw-wire serializers are mutually exclusive. Exact count authority requires a tokenizer and explicit context and output limits; estimates remain diagnostic.

```quint
import modelAttemptLeases as L from "./modelAttemptLeases"
type CountSource = ProviderTokenizer | TokenizerEstimate | Utf8UpperBound
type GuardPhase = GuardReady | GuardRejected
type PreparedGuard = {id: int, phase: GuardPhase, provider: str, model: str, route: str, bytes: str, inputCount: int, countSource: CountSource, threshold: int, exactAuthority: bool, outputTokens: int, leaseId: int, messageId: str, attempts: int, errorCode: str}
type PreparedRequests = {guards: List[PreparedGuard], leases: L::ModelLeases}
pure val initial: PreparedRequests = {guards: List(), leases: L::initial}
pure val guardIdValues = Set(1, 2, 3)
pure val leaseIdValues = Set(0, 1, 2)
pure val messageIdValues = Set("turn-a", "turn-b")
pure val providerValues = Set("alpha", "beta")
pure val modelValues = Set("small", "large")
pure val routeValues = Set("text", "missing")
pure val bytesValues = Set("complete request", "changed request")
pure val inputCountValues = Set(1, 10, 20)
pure val thresholdValues = Set(10, 100)
pure val outputTokensValues = Set(1, 10)
pure val actualCountValues = Set(1, 10, 20)
pure val actualBytesValues = Set("complete request", "changed request")
pure val byteCountValues = Set(1, 10)
pure val noGuard: PreparedGuard = {id: 0, phase: GuardRejected, provider: "", model: "", route: "", bytes: "", inputCount: 0, countSource: Utf8UpperBound, threshold: 0, exactAuthority: false, outputTokens: 0, leaseId: 0, messageId: "", attempts: 0, errorCode: "missing"}
pure def preparedGuard(s: PreparedRequests, guardId: int): PreparedGuard = s.guards.select(g => g.id == guardId).nthOr(0, noGuard)
pure def canCreateRequestGuard(s: PreparedRequests, guardId: int, provider: str, model: str, route: str, bytes: str, inputCount: int, countSource: CountSource, threshold: int, exactAuthority: bool, outputTokens: int, leaseId: int, messageId: str): bool = guardId > 0 and provider != "" and model != "" and inputCount >= 0 and threshold > 0 and outputTokens > 0 and not(s.guards.some(g => g.id == guardId)) and (not(exactAuthority) or countSource == ProviderTokenizer) and (leaseId == 0 or L::leaseContextValid(s.leases, leaseId, messageId))
pure def createRequestGuard(s: PreparedRequests, guardId: int, provider: str, model: str, route: str, bytes: str, inputCount: int, countSource: CountSource, threshold: int, exactAuthority: bool, outputTokens: int, leaseId: int, messageId: str): PreparedRequests = { ...s, guards: s.guards.append({id: guardId, phase: if (exactAuthority and inputCount >= threshold) GuardRejected else GuardReady, provider: provider, model: model, route: route, bytes: bytes, inputCount: inputCount, countSource: countSource, threshold: threshold, exactAuthority: exactAuthority, outputTokens: outputTokens, leaseId: leaseId, messageId: messageId, attempts: 0, errorCode: if (exactAuthority and inputCount >= threshold) "MODEL_INPUT_OVER_BUDGET" else ""}) }
pure def alwaysExactBudgetAdmission(s: PreparedRequests): bool = s.guards.every(g => g.phase == GuardReady and g.exactAuthority implies g.inputCount < g.threshold)
pure def alwaysGuardAttemptsNonnegative(s: PreparedRequests): bool = s.guards.every(g => g.attempts >= 0)
pure def sometimesEstimateAboveThresholdAdmitted(s: PreparedRequests): bool = s.guards.some(g => not(g.exactAuthority) and g.inputCount >= g.threshold and g.phase == GuardReady)
```

### Every dispatched attempt rechecks bytes counts and lease authority

A standalone unchanged check consumes no transport attempt. A failed check reports a typed error without debiting the lease or incrementing the attempt count. The guard remains usable if a later check observes the original bytes and count again.

The aggregate also selects an existing eligible guard and submits its captured
bytes and count through the same dispatch guard. This models a normal unchanged
retry without requiring a sampled caller to guess values already held by the
provider; explicit changed-byte and changed-count operations remain available.

```quint
pure def requestUnchanged(g: PreparedGuard, actualBytes: str, actualCount: int, countSource: CountSource): bool = g.bytes == actualBytes and g.inputCount == actualCount and g.countSource == countSource
pure def canCheckUnchanged(s: PreparedRequests, guardId: int, actualBytes: str, actualCount: int, countSource: CountSource): bool = preparedGuard(s, guardId).phase == GuardReady and preparedGuard(s, guardId).id != 0
pure def checkUnchanged(s: PreparedRequests, guardId: int, actualBytes: str, actualCount: int, countSource: CountSource): PreparedRequests = { ...s, guards: s.guards.listMap(g => if (g.id != guardId) g else { ...g, errorCode: if (requestUnchanged(g, actualBytes, actualCount, countSource)) "" else if (g.bytes != actualBytes) "MODEL_PREPARED_REQUEST_MUTATED" else "MODEL_PREPARED_REQUEST_TOKEN_COUNT_DRIFT" }) }
pure def canDispatchPrepared(s: PreparedRequests, guardId: int, actualBytes: str, actualCount: int, countSource: CountSource, byteCount: int, currentTurn: bool): bool = {
  val g = preparedGuard(s, guardId)
  g.id != 0 and g.phase == GuardReady and requestUnchanged(g, actualBytes, actualCount, countSource) and (g.leaseId == 0 or L::canReserveAttempt(s.leases, g.leaseId, g.messageId, g.provider, g.model, g.route, byteCount, actualBytes, g.outputTokens, currentTurn))
}
pure def dispatchPrepared(s: PreparedRequests, guardId: int, actualBytes: str, actualCount: int, countSource: CountSource, byteCount: int, currentTurn: bool): PreparedRequests = {
  val g = preparedGuard(s, guardId)
  { ...s, guards: s.guards.listMap(old => if (old.id == guardId) { ...old, attempts: old.attempts + 1, errorCode: "" } else old), leases: if (g.leaseId == 0) s.leases else L::reserveAttempt(s.leases, g.leaseId, g.messageId, g.provider, g.model, g.route, byteCount, actualBytes, g.outputTokens, currentTurn) }
}
pure def currentDispatchCandidate(s: PreparedRequests, byteCount: int, currentTurn: bool): PreparedGuard = s.guards.select(g => canDispatchPrepared(s, g.id, g.bytes, g.inputCount, g.countSource, byteCount, currentTurn)).nthOr(0, noGuard)
pure def canDispatchUnchanged(s: PreparedRequests, byteCount: int, currentTurn: bool): bool = currentDispatchCandidate(s, byteCount, currentTurn).id != 0
pure def dispatchUnchanged(s: PreparedRequests, byteCount: int, currentTurn: bool): PreparedRequests = {
  val g = currentDispatchCandidate(s, byteCount, currentTurn)
  dispatchPrepared(s, g.id, g.bytes, g.inputCount, g.countSource, byteCount, currentTurn)
}
pure def stepGuardBytesStayFixed(before: PreparedRequests, after: PreparedRequests): bool = before.guards.every(g => after.guards.some(other => other.id == g.id and other.bytes == g.bytes and other.inputCount == g.inputCount and other.countSource == g.countSource))
pure def stepUnchangedCheckDoesNotCount(before: PreparedRequests, via: str, after: PreparedRequests): bool = via == "checkUnchanged" implies before.guards.every(g => after.guards.some(other => other.id == g.id and other.attempts == g.attempts))
pure def alwaysPreparedLeasesStayNonnegative(s: PreparedRequests): bool = L::alwaysAllowancesNonnegative(s.leases)
pure def sometimesMutatedRequestRejected(s: PreparedRequests): bool = s.guards.some(g => g.errorCode == "MODEL_PREPARED_REQUEST_MUTATED" and g.attempts == 0)
pure def alwaysRecheckKeepsAdmittedGuard(s: PreparedRequests): bool = s.guards.every(g => g.errorCode == "MODEL_PREPARED_REQUEST_MUTATED" or g.errorCode == "MODEL_PREPARED_REQUEST_TOKEN_COUNT_DRIFT" implies g.phase == GuardReady)
pure def sometimesPreparedAttemptDispatched(s: PreparedRequests): bool = s.guards.some(g => g.attempts > 0)
```

### Prepared requests use the same issued allowance and turn lease

The guard's optional lease is created and closed through the host allowance model. Observing an expired allowance clock or closing its turn makes later prepared attempts fail admission without changing the stored request. A later wall-clock rewind can restore time eligibility for an unclosed allowance; it cannot undo explicit allowance or turn closure.

```quint
pure def canCreateAllowance(s: PreparedRequests, allowanceId: int, budget: int, maxAttempts: int, maxOutput: int, expiresAt: int, tariffs: List[L::Tariff]): bool = L::canCreateAllowance(s.leases, allowanceId, budget, maxAttempts, maxOutput, expiresAt, tariffs)
pure def createAllowance(s: PreparedRequests, allowanceId: int, budget: int, maxAttempts: int, maxOutput: int, expiresAt: int, tariffs: List[L::Tariff]): PreparedRequests = { ...s, leases: L::createAllowance(s.leases, allowanceId, budget, maxAttempts, maxOutput, expiresAt, tariffs) }
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

# Provider-prepared request guards

Each guard captures the complete serialized request and tokenizer result. Rechecking bytes and token counts precedes every transport attempt and optional host allowance reservation. Sources include [prepared-model-request.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/prepared-model-request.ts) and [streaming-context.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/streaming-context.ts).

## Story: Bind every transport retry to the admitted request

As a provider I serialize a request once and prove that retries preserve its model-visible bytes and token count.

### A request guard captures its exact admitted serialization

The guard derives its retained body and count from one preparation observation. The provider adapter reports the completed validation walk for a projection or the exact raw-wire serialization. The guard is created only when preparation succeeds and the budget and lease context permit it.

```quint
import modelAttemptLeases as L from "./modelAttemptLeases"
import preparedRequestSerialization as S from "./preparedRequestSerialization"
import unicode as U from "./unicode"
type CountSource = ProviderTokenizer | TokenizerEstimate | Utf8UpperBound
type GuardPhase = GuardReady | GuardRejected
type LimitObservation = {supplied: bool, positiveFinite: bool, roundedDown: int, safeInteger: bool}
type PreparationLimits = {contextWindow: LimitObservation, outputReserve: LimitObservation}
type TokenObservation = NoTokenizer | ExactTokenizerMissing | TokenizerFailed | TokenizerCount({body: List[int], roundedUp: int, exact: bool})
type PreparationObservation = {walk: S::Validation, serializer: S::SerializerChoice, serialized: S::SerializedObservation, tokens: TokenObservation}
type RequestPreparation = Prepared({request: RequestObservation}) | InvalidPreparationBudget | SerializationFailed | PreparationHostFailure({stage: S::SerializationHostStage}) | TokenizationFailed
type RequestGuardInput = {provider: str, model: str, route: str, preparation: PreparationObservation, limits: PreparationLimits, leaseId: int, messageId: str}
type RequestObservation = {codeUnits: List[int], inputCount: int, countSource: CountSource}
type PreparedGuard = {id: int, phase: GuardPhase, provider: str, model: str, route: str, codeUnits: List[int], inputCount: int, countSource: CountSource, threshold: int, exactAuthority: bool, contextTokens: int, outputTokens: int, reservationTokens: int, leaseId: int, messageId: str, attempts: int, errorCode: str}
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
pure val absentLimit: LimitObservation = {supplied: false, positiveFinite: false, roundedDown: 0, safeInteger: false}
pure val badLimit: LimitObservation = { ...absentLimit, supplied: true }
pure def integerLimit(value: int): LimitObservation = {supplied: true, positiveFinite: value > 0, roundedDown: value, safeInteger: value > 0 and value <= 9007199254740991}
pure val exactLimits: PreparationLimits = {contextWindow: integerLimit(11), outputReserve: integerLimit(1)}
pure val diagnosticLimits: PreparationLimits = {contextWindow: integerLimit(20), outputReserve: integerLimit(10)}
pure val defaultLimits: PreparationLimits = {contextWindow: absentLimit, outputReserve: absentLimit}
pure val fractionalLimit: LimitObservation = {supplied: true, positiveFinite: true, roundedDown: 1, safeInteger: false}
pure val outputReserveValues = Set(absentLimit, badLimit, integerLimit(1), fractionalLimit)
pure val limitValues = outputReserveValues
pure val limitsValues = Set(exactLimits, diagnosticLimits, defaultLimits, {contextWindow: integerLimit(11), outputReserve: fractionalLimit})
pure def wirePreparation(body: List[int], count: int, source: CountSource): PreparationObservation =
  {walk: S::initial, serializer: S::serializerChoice(false, true), serialized: S::SerializedText({codeUnits: body}), tokens: if (source == Utf8UpperBound) NoTokenizer else TokenizerCount({body: body, roundedUp: count, exact: source == ProviderTokenizer})}
pure val projectionPreparation: PreparationObservation =
  { ...wirePreparation(admittedCodeUnits, 1, ProviderTokenizer), serializer: S::serializerChoice(true, false) }
pure val requestInputValues = Set(
  {provider: "alpha", model: "small", route: "text", preparation: projectionPreparation, limits: exactLimits, leaseId: 0, messageId: "turn-a"},
  {provider: "alpha", model: "small", route: "text", preparation: wirePreparation(admittedCodeUnits, 1, providerTokenizer), limits: exactLimits, leaseId: 1, messageId: "turn-a"},
  {provider: "alpha", model: "small", route: "text", preparation: wirePreparation(admittedCodeUnits, 1, providerTokenizer), limits: exactLimits, leaseId: 2, messageId: "turn-b"},
  {provider: "alpha", model: "small", route: "text", preparation: wirePreparation(admittedCodeUnits, 10, providerTokenizer), limits: exactLimits, leaseId: 0, messageId: "turn-a"},
  {provider: "beta", model: "large", route: "text", preparation: wirePreparation(admittedCodeUnits, 20, tokenizerEstimate), limits: diagnosticLimits, leaseId: 0, messageId: "turn-b"},
  {provider: "beta", model: "large", route: "missing", preparation: wirePreparation(changedCodeUnits, 5, utf8UpperBound), limits: defaultLimits, leaseId: 0, messageId: "turn-b"},
  {provider: "alpha", model: "small", route: "text", preparation: wirePreparation(admittedCodeUnits, 20, providerTokenizer), limits: {contextWindow: integerLimit(11), outputReserve: absentLimit}, leaseId: 0, messageId: "turn-a"},
  {provider: "alpha", model: "small", route: "text", preparation: wirePreparation(admittedCodeUnits, 1, tokenizerEstimate), limits: {contextWindow: badLimit, outputReserve: integerLimit(1)}, leaseId: 0, messageId: "turn-a"},
  {provider: "p1", model: "small", route: "text", preparation: { ...projectionPreparation, tokens: ExactTokenizerMissing }, limits: exactLimits, leaseId: 0, messageId: "turn-a"},
  {provider: "p1", model: "small", route: "text", preparation: { ...projectionPreparation, walk: { ...S::initial, ancestors: List(1) } }, limits: exactLimits, leaseId: 0, messageId: "turn-a"},
  {provider: "p1", model: "small", route: "text", preparation: { ...projectionPreparation, tokens: TokenizerCount({body: changedCodeUnits, roundedUp: 1, exact: true}) }, limits: exactLimits, leaseId: 0, messageId: "turn-a"})
pure val observedValues = Set(
  {codeUnits: admittedCodeUnits, inputCount: 1, countSource: providerTokenizer},
  {codeUnits: changedCodeUnits, inputCount: 1, countSource: providerTokenizer},
  {codeUnits: admittedCodeUnits, inputCount: 10, countSource: providerTokenizer},
  {codeUnits: admittedCodeUnits, inputCount: 1, countSource: tokenizerEstimate},
  {codeUnits: admittedCodeUnits, inputCount: 20, countSource: tokenizerEstimate},
  {codeUnits: changedCodeUnits, inputCount: 5, countSource: utf8UpperBound})
pure val allowanceInputValues = L::allowanceInputValues
pure val noGuard: PreparedGuard = {id: 0, phase: GuardRejected, provider: "", model: "", route: "", codeUnits: List(), inputCount: 0, countSource: Utf8UpperBound, threshold: 0, exactAuthority: false, contextTokens: 0, outputTokens: 0, reservationTokens: 0, leaseId: 0, messageId: "", attempts: 0, errorCode: "missing"}
pure def alwaysGuardIdsUnique(s: PreparedRequests): bool = s.guards.every(g => g.id > 0 and s.guards.select(other => other.id == g.id).length() == 1)
pure def preparedGuard(s: PreparedRequests, guardId: int): PreparedGuard = s.guards.select(g => g.id == guardId).nthOr(0, noGuard)
pure def canCreateRequestGuard(s: PreparedRequests, guardId: int, requestInput: RequestGuardInput): bool =
  guardId > 0 and requestInput.provider != "" and requestInput.model != "" and preparationSucceeded(requestInput.preparation) and validPreparationLimits(requestInput.limits) and not(s.guards.some(g => g.id == guardId)) and (requestInput.leaseId == 0 or L::leaseContextValid(s.leases, requestInput.leaseId, requestInput.messageId))
pure def buildCountedRequestGuard(guardId: int, requestInput: RequestGuardInput, request: RequestObservation): PreparedGuard = {
  val limits = requestInput.limits
  val contextTokens = preparedContext(limits)
  val outputTokens = preparedReserve(limits)
  val threshold = atLeastOne(contextTokens - outputTokens)
  val exactAuthority = hasRejectionAuthority(request.countSource, limits)
  val overBudget = exactAuthority and request.inputCount >= threshold
  {id: guardId, phase: if (overBudget) GuardRejected else GuardReady, provider: requestInput.provider, model: requestInput.model, route: requestInput.route, codeUnits: request.codeUnits, inputCount: request.inputCount, countSource: request.countSource, threshold: threshold, exactAuthority: exactAuthority, contextTokens: contextTokens, outputTokens: outputTokens, reservationTokens: qualifiedReservationTokens(limits.outputReserve), leaseId: requestInput.leaseId, messageId: requestInput.messageId, attempts: 0, errorCode: if (overBudget) "MODEL_INPUT_OVER_BUDGET" else ""}
}
pure def buildRequestGuard(guardId: int, requestInput: RequestGuardInput): PreparedGuard = {
  val preparation = prepareObservation(requestInput.preparation)
  match preparation {
    | Prepared(prepared) => buildCountedRequestGuard(guardId, requestInput, prepared.request)
    | _ => noGuard
  }
}
pure def createRequestGuard(s: PreparedRequests, guardId: int, requestInput: RequestGuardInput): PreparedRequests = { ...s, guards: s.guards.append(buildRequestGuard(guardId, requestInput)) }
pure def alwaysExactBudgetAdmission(s: PreparedRequests): bool = s.guards.every(g => g.phase == GuardReady and g.exactAuthority implies g.inputCount < g.threshold)
pure def alwaysGuardAttemptsNonnegative(s: PreparedRequests): bool = s.guards.every(g => g.attempts >= 0)
pure def sometimesEstimateAboveThresholdAdmitted(s: PreparedRequests): bool = s.guards.some(g => not(g.exactAuthority) and g.inputCount >= g.threshold and g.phase == GuardReady)
```

### Preparation checks serializer and tokenizer configuration before calling either serializer

The adapter checks the trimmed provider and model IDs before it classifies
serializer and tokenizer configuration. Missing or conflicting serializers
report `MODEL_PREPARED_REQUEST_SERIALIZATION_FAILED`. With one serializer,
requesting exact token counting without a tokenizer reports
`MODEL_PREPARED_REQUEST_INVALID_BUDGET`. Either configuration error leaves
no guard and runs neither serializer nor tokenizer.

```quint
type PreparationPreflight = ReadyToSerialize | InvalidSerializerSelection | MissingRequiredTokenizer
pure def preparationPreflight(serializer: S::SerializerChoice, missingExactTokenizer: bool): PreparationPreflight =
  if (not(S::hasExactlyOneSerializer(serializer))) InvalidSerializerSelection
  else if (missingExactTokenizer) MissingRequiredTokenizer
  else ReadyToSerialize
pure def isMissingExactTokenizer(tokens: TokenObservation): bool =
  match tokens {
    | ExactTokenizerMissing => true
    | _ => false
  }
pure def lawPreparationPreflightRejectsInvalidConfiguration(preparation: PreparationObservation): bool =
  if (not(S::hasExactlyOneSerializer(preparation.serializer)))
    preparationError(prepareObservation(preparation)) == "MODEL_PREPARED_REQUEST_SERIALIZATION_FAILED"
  else if (isMissingExactTokenizer(preparation.tokens))
    preparationError(prepareObservation(preparation)) == "MODEL_PREPARED_REQUEST_INVALID_BUDGET"
  else true
pure def lawMissingRequiredTokenizerCannotCreateGuard(s: PreparedRequests, guardId: int, requestInput: RequestGuardInput): bool =
  isMissingExactTokenizer(requestInput.preparation.tokens) implies not(canCreateRequestGuard(s, guardId, requestInput))
```

### Only the admitted body can supply its input token count

After configuration passes, an invalid or unfinished serialization fails
before tokenization. A failed
tokenizer or a count for a different serialized body leaves no guard. The
adapter reports a thrown tokenizer or an invalid numeric count as tokenization
failure, and rounds a successful finite nonnegative count upward. The guard
reports `MODEL_PREPARED_REQUEST_SERIALIZATION_FAILED` or
`MODEL_PREPARED_REQUEST_TOKENIZATION_FAILED` for typed preparation failures.
For a host failure the adapter propagates the original thrown value from the
reported stage. Both forms of serialization failure leave no guard. When
neither a tokenizer nor exact counting is configured, the diagnostic count
is the UTF-8 length of the admitted UTF-16 sequence. An estimate remains
diagnostic. The adapter supplies the exact serialized body to the count
callback and establishes how the count describes the selected provider's input.

The AOSP fused loader tokenizes the final prompt once in the loaded context.
It copies the native result into an owned token vector and reports that
vector's length to the guard. Each stream attempt, including the one-time
cache fallback, uses the same context and prefill vector. The guard separately
checks the serialized projection before dispatch. The adapter must establish
that the counted vector is the one submitted to native prefill. Device
conformance must exercise tokenization and prefill on the loaded model and
native library. [Pinned AOSP source](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/plugins/plugin-native-inference/src/aosp-local-inference-bootstrap.ts#L3075-L3176)

```quint
pure val preparationValues = Set(
  projectionPreparation,
  wirePreparation(changedCodeUnits, 0, Utf8UpperBound),
  { ...projectionPreparation, tokens: ExactTokenizerMissing },
  { ...projectionPreparation, serializer: S::ConflictingSerializers, tokens: ExactTokenizerMissing },
  { ...projectionPreparation, walk: { ...S::initial, ancestors: List(1) } },
  { ...projectionPreparation, serialized: S::SerializationThrew },
  { ...projectionPreparation, walk: { ...S::initial, ancestors: List(1) }, serialized: S::SerializerHostThrew({stage: S::ValidationReflection}) },
  { ...projectionPreparation, serialized: S::SerializerHostThrew({stage: S::InitialProjectionFreeze}) },
  { ...wirePreparation(changedCodeUnits, 0, Utf8UpperBound), serialized: S::SerializerHostThrew({stage: S::WireCallback}) },
  { ...projectionPreparation, tokens: TokenizerFailed },
  { ...projectionPreparation, tokens: TokenizerCount({body: changedCodeUnits, roundedUp: 1, exact: true}) })
pure def prepareSerializedObservation(preparation: PreparationObservation): RequestPreparation = {
  val serialization = S::finishSerialization(preparation.walk, preparation.serializer, preparation.serialized)
  val tokens = preparation.tokens
  match serialization {
    | AdmittedBody(body) =>
      match tokens {
        | NoTokenizer => Prepared({request: {codeUnits: body.codeUnits, inputCount: U::utf8Length(body.codeUnits), countSource: Utf8UpperBound}})
        | TokenizerCount(counted) =>
          if (counted.body == body.codeUnits and counted.roundedUp >= 0)
            Prepared({request: {codeUnits: body.codeUnits, inputCount: counted.roundedUp, countSource: if (counted.exact) ProviderTokenizer else TokenizerEstimate}})
          else TokenizationFailed
        | _ => TokenizationFailed
      }
    | HostSerializationFailure(failure) => PreparationHostFailure({stage: failure.stage})
    | _ => SerializationFailed
  }
}
pure def prepareObservation(preparation: PreparationObservation): RequestPreparation = {
  val preflight = preparationPreflight(preparation.serializer, isMissingExactTokenizer(preparation.tokens))
  match preflight {
    | InvalidSerializerSelection => SerializationFailed
    | MissingRequiredTokenizer => InvalidPreparationBudget
    | ReadyToSerialize => prepareSerializedObservation(preparation)
  }
}
pure def preparationSucceeded(preparation: PreparationObservation): bool = {
  val result = prepareObservation(preparation)
  match result {
    | Prepared(_) => true
    | _ => false
  }
}
pure def preparationError(result: RequestPreparation): str =
  match result {
    | InvalidPreparationBudget => "MODEL_PREPARED_REQUEST_INVALID_BUDGET"
    | SerializationFailed => "MODEL_PREPARED_REQUEST_SERIALIZATION_FAILED"
    | TokenizationFailed => "MODEL_PREPARED_REQUEST_TOKENIZATION_FAILED"
    | _ => ""
  }
pure def lawFailedSerializationPrecedesTokenizer(preparation: PreparationObservation): bool = {
  val admission = S::finishSerialization(preparation.walk, preparation.serializer, preparation.serialized)
  val result = prepareObservation(preparation)
  val preflight = preparationPreflight(preparation.serializer, isMissingExactTokenizer(preparation.tokens))
  if (preflight == InvalidSerializerSelection)
    preparationError(result) == "MODEL_PREPARED_REQUEST_SERIALIZATION_FAILED"
  else if (preflight == MissingRequiredTokenizer)
    preparationError(result) == "MODEL_PREPARED_REQUEST_INVALID_BUDGET"
  else match admission {
    | InvalidBody => match result {
      | SerializationFailed => true
      | _ => false
    }
    | HostSerializationFailure(failure) => match result {
      | PreparationHostFailure(reported) => reported.stage == failure.stage
      | _ => false
    }
    | _ => true
  }
}
pure def lawPreparationRetainsAdmittedBody(preparation: PreparationObservation): bool = {
  val result = prepareObservation(preparation)
  val admission = S::finishSerialization(preparation.walk, preparation.serializer, preparation.serialized)
  match result {
    | Prepared(ready) => S::admittedBodyEquals(admission, ready.request.codeUnits)
    | _ => true
  }
}
pure def lawCountMustDescribeTheAdmittedBody(preparation: PreparationObservation, body: List[int]): bool = {
  val edited = { ...preparation, tokens: TokenizerCount({body: body, roundedUp: 0, exact: true}) }
  val admission = S::finishSerialization(preparation.walk, preparation.serializer, preparation.serialized)
  S::hasAdmittedBody(admission) and not(S::admittedBodyEquals(admission, body)) implies
    preparationError(prepareObservation(edited)) == "MODEL_PREPARED_REQUEST_TOKENIZATION_FAILED"
}
```

### Rejection authority uses explicit limits and reservation uses the original output argument

Omitted context uses 128,000 tokens. Omitted output reserve is the smaller
of 10,000 and the context less one, with one as the floor. The dispatch
threshold is at least one. A provider tokenizer can reject at or above the
threshold only when both limits were explicitly supplied.

For AOSP text generation, the adapter explicitly reserves one output token
when the caller leaves the output cap omitted. The decoder can still use its
calculated remaining context. The preliminary AOSP budget calculation can
accept an exact fit. The prepared guard rejects that case under its strict
threshold when the supplied context and reserve equal the calculation inputs.
[Pinned AOSP budget calculation](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/plugins/plugin-native-inference/src/aosp-local-inference-bootstrap.ts#L552-L596)

The adapter identifies missing, invalid and positive finite numeric inputs.
A positive fraction is floored for the reported budget, including fractions
below one. A leased dispatch qualifies only with an explicitly supplied
positive safe-integer output cap. Defaulted and floored reporting values
cannot authorize the charge.

```quint
pure def validLimit(limit: LimitObservation): bool =
  not(limit.supplied) or (limit.positiveFinite and limit.roundedDown >= 0 and
    (limit.safeInteger implies limit.roundedDown > 0 and limit.roundedDown <= 9007199254740991))
pure def validPreparationLimits(limits: PreparationLimits): bool =
  validLimit(limits.contextWindow) and validLimit(limits.outputReserve)
pure def atLeastOne(value: int): int = if (value < 1) 1 else value
pure def preparedContext(limits: PreparationLimits): int =
  if (limits.contextWindow.supplied) limits.contextWindow.roundedDown else 128000
pure def preparedReserve(limits: PreparationLimits): int = {
  val available = atLeastOne(preparedContext(limits) - 1)
  if (limits.outputReserve.supplied) limits.outputReserve.roundedDown
  else if (available < 10000) available else 10000
}
pure def hasRejectionAuthority(countSource: CountSource, limits: PreparationLimits): bool =
  countSource == ProviderTokenizer and limits.contextWindow.supplied and limits.outputReserve.supplied
pure def qualifiedReservationTokens(outputReserve: LimitObservation): int =
  if (outputReserve.supplied and outputReserve.positiveFinite and outputReserve.safeInteger and
      outputReserve.roundedDown > 0 and outputReserve.roundedDown <= 9007199254740991)
    outputReserve.roundedDown
  else 0
pure def lawDefaultOutputCannotReserve(limits: PreparationLimits): bool =
  not(limits.outputReserve.supplied) implies qualifiedReservationTokens(limits.outputReserve) == 0
pure def lawFractionalOutputCannotReserve(outputReserve: LimitObservation): bool =
  not(outputReserve.safeInteger) implies qualifiedReservationTokens(outputReserve) == 0
pure def sometimesExactTokenizerWithoutAuthority(s: PreparedRequests): bool =
  s.guards.some(g => g.countSource == ProviderTokenizer and not(g.exactAuthority) and
    g.inputCount >= g.threshold and g.phase == GuardReady)
```

### Every dispatched attempt rechecks bytes counts and lease authority

The allowance computes its input charge bound from the actual serialized code
units and qualifies the original output argument. The captured request and
budget stay fixed. A standalone unchanged check consumes no transport attempt.
A changed body reports a typed error before token counting. A changed count
for the original body reports a separate typed error. The retry adapter
forwards serializer exceptions under the same source rules as preparation and
does not freeze the projection again. A failed check leaves the lease and
attempt count intact. The guard remains usable if a later check observes the
original bytes and count again.

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
pure def preparedReservation(g: PreparedGuard, observed: RequestObservation, currentTurn: bool): L::AttemptReservationInput = {messageId: g.messageId, provider: g.provider, model: g.model, route: g.route, codeUnits: observed.codeUnits, outputTokens: g.reservationTokens, currentTurn: currentTurn}
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
pure def stepGuardBytesStayFixed(before: PreparedRequests, after: PreparedRequests): bool = before.guards.every(g => after.guards.some(other => other.id == g.id and other.codeUnits == g.codeUnits and other.inputCount == g.inputCount and other.countSource == g.countSource and other.contextTokens == g.contextTokens and other.outputTokens == g.outputTokens and other.reservationTokens == g.reservationTokens and other.threshold == g.threshold and other.exactAuthority == g.exactAuthority))
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

# OpenAI-compatible embeddings

The endpoint adapter generates vectors for the runtime's single and batch
embedding handlers. The [kernel's embedding space](../core/embeddingSpace.md)
owns the representation used by vector storage.

## Story: Embed every input in the configured vector space

> As a runtime caller, I want one usable vector per input in exactly the
> input order. I want endpoint failure to stay visible.

### An endpoint attempt uses the configured representation and count

No implicit URL supplies an embedding. Auto-enable activates only when a
primary endpoint URL or primary API key is configured; fallback settings alone
never activate the plugin. A null single input identifies the configured width
without dispatch and fails when no primary endpoint URL is configured so an
unconfigured adapter never shadows another embedder. An empty batch returns
without inspecting provider configuration. Vector widths must be one of the
runtime's supported dimensions (`384`, `512`, `768`, `1024`, `1536`, `2048`,
`3072`, defaulting to `1536`) parsed as strict decimal integers. The shell
trims and normalizes text to well-formed Unicode, rejects empty or non-string
text, sends a single string for single-input requests and an array for batch
requests, and writes `dimensions` to the provider request only when
`EMBEDDING_DIMENSIONS` is explicitly configured.

```quint
type EmbeddingInput = ProbeWidth | EmbedOne | EmbedBatch
type EmbeddingAdmission = MissingEndpoint | InvalidEmbedding | NoInputs | ReturnWidth({ width: int }) | RequestVectors({ count: int, expectedWidth: int, sendWidth: bool })
pure def isValidVectorWidth(width: int): bool =
  width == 384 or width == 512 or width == 768 or width == 1024 or width == 1536 or width == 2048 or width == 3072
pure def autoEnableEmbedding(hasBaseUrl: bool, hasApiKey: bool): bool =
  hasBaseUrl or hasApiKey
pure def embeddingAdmission(inputKind: EmbeddingInput, inputCount: int, endpoint: str, width: int, explicitWidth: bool): EmbeddingAdmission =
  if (inputKind == EmbedBatch and inputCount == 0) NoInputs
  else if (not(isValidVectorWidth(width)) or inputCount < 0) InvalidEmbedding
  else if (endpoint == "") MissingEndpoint
  else if (inputKind == ProbeWidth) ReturnWidth({ width: width })
  else if (inputKind == EmbedOne and inputCount != 1) InvalidEmbedding
  else RequestVectors({ count: inputCount, expectedWidth: width, sendWidth: explicitWidth })
pure def lawEmptyBatchNeverDispatches(endpoint: str, width: int, explicitWidth: bool): bool =
  embeddingAdmission(EmbedBatch, 0, endpoint, width, explicitWidth) == NoInputs
pure def lawProbeRequiresEndpoint(width: int, explicitWidth: bool): bool =
  isValidVectorWidth(width) implies embeddingAdmission(ProbeWidth, 0, "", width, explicitWidth) == MissingEndpoint
pure def lawInvalidWidthRefuses(endpoint: str, width: int, explicitWidth: bool): bool =
  not(isValidVectorWidth(width)) implies (
    embeddingAdmission(EmbedOne, 1, endpoint, width, explicitWidth) == InvalidEmbedding and
    embeddingAdmission(ProbeWidth, 0, endpoint, width, explicitWidth) == InvalidEmbedding
  )
pure def lawAutoEnableRequiresPrimarySetting(hasBaseUrl: bool, hasApiKey: bool): bool =
  (not(hasBaseUrl) and not(hasApiKey)) implies not(autoEnableEmbedding(hasBaseUrl, hasApiKey))
```

### Vectors cover every index exactly once and share one width

The response uses provider indices to recover original order. Send only
finite numbers into the runtime's chosen representation. An absent, duplicate,
out-of-range, nonfinite, or wrong-width entry fails the attempt. The shell
decodes floating-point coordinates, buckets the rows by their provider index
in linear time, passes the ordered indices and observations to the model, and
emits a `MODEL_USED` telemetry event when provider token usage is reported
without allowing listener failures to reject a served embedding.

```quint
type VectorObservation = { inputIndex: int, vectorWidth: int, finiteCoordinates: bool }
pure def embeddingRowsMatch(rows: List[VectorObservation], inputCount: int, width: int): bool =
  inputCount > 0 and isValidVectorWidth(width) and rows.length() == inputCount and
    rows.foldl(0, (rowNumber, row) =>
      if (rowNumber >= 0 and row.inputIndex == rowNumber and row.vectorWidth == width and row.finiteCoordinates)
      rowNumber + 1 else -1) == inputCount
pure def lawWrongCountRefuses(rows: List[VectorObservation], inputCount: int, width: int): bool =
  rows.length() != inputCount implies not(embeddingRowsMatch(rows, inputCount, width))
pure def lawInvalidWidthRowRefuses(rows: List[VectorObservation], inputCount: int, width: int): bool =
  not(isValidVectorWidth(width)) implies not(embeddingRowsMatch(rows, inputCount, width))
pure def lawNonFiniteRowRefuses(rows: List[VectorObservation], inputCount: int, width: int): bool =
  rows.some(row => not(row.finiteCoordinates)) implies not(embeddingRowsMatch(rows, inputCount, width))
pure def lawWrongRowWidthRefuses(rows: List[VectorObservation], inputCount: int, width: int): bool =
  rows.some(row => row.vectorWidth != width) implies not(embeddingRowsMatch(rows, inputCount, width))
```

### A failed primary can use a configured fallback once

An attempt records which endpoint supplied its observations. A retryable
primary failure advances to the configured fallback once; a non-retryable
failure (such as a confidential-inference denial) exhausts the request without
redispatching to fallback. Cancellation ends the request, including
cancellation after failure and before fallback dispatch. The shell isolates
each request, binds its abort signal and timeout, preserves HTTP status,
headers, body, URL, and cause metadata on failures, and reports only fresh
results from the active endpoint.

```quint
type EmbeddingAttempt = PrimaryAttempt | FallbackAttempt
type EmbeddingPhase = Awaiting | EmbeddingSucceeded | EmbeddingExhausted | EmbeddingCancelled
type EmbeddingRun = { phase: EmbeddingPhase, attempt: EmbeddingAttempt, count: int, width: int, hasFallback: bool }
pure val initial: EmbeddingRun = { phase: Awaiting, attempt: PrimaryAttempt, count: 0, width: 0, hasFallback: false }
pure def canBeginEmbedding(s: EmbeddingRun, inputCount: int, width: int): bool =
  s.phase == Awaiting and s.count == 0 and inputCount > 0 and isValidVectorWidth(width)
pure def beginEmbedding(s: EmbeddingRun, inputCount: int, width: int, hasFallback: bool): EmbeddingRun =
  { ...s, count: inputCount, width: width, hasFallback: hasFallback }
pure def canFinishEmbedding(s: EmbeddingRun, attempt: EmbeddingAttempt, rows: List[VectorObservation]): bool =
  s.phase == Awaiting and s.attempt == attempt and embeddingRowsMatch(rows, s.count, s.width)
pure def finishEmbedding(s: EmbeddingRun, attempt: EmbeddingAttempt, rows: List[VectorObservation]): EmbeddingRun =
  { ...s, phase: EmbeddingSucceeded }
pure def canFailEmbedding(s: EmbeddingRun, attempt: EmbeddingAttempt): bool =
  s.phase == Awaiting and s.count > 0 and s.attempt == attempt
pure def failEmbedding(s: EmbeddingRun, attempt: EmbeddingAttempt, allowFallback: bool): EmbeddingRun =
  if (s.attempt == PrimaryAttempt and s.hasFallback and allowFallback) { ...s, attempt: FallbackAttempt }
  else { ...s, phase: EmbeddingExhausted }
pure def canCancelEmbedding(s: EmbeddingRun): bool = s.phase == Awaiting
pure def cancelEmbedding(s: EmbeddingRun): EmbeddingRun = { ...s, phase: EmbeddingCancelled }
pure def alwaysRunShapeValid(s: EmbeddingRun): bool =
  s.count >= 0 and
    (if (s.count == 0) (s.width == 0 and s.attempt == PrimaryAttempt and (s.phase == Awaiting or s.phase == EmbeddingCancelled))
     else isValidVectorWidth(s.width)) and
    (s.attempt == FallbackAttempt implies s.hasFallback)
pure def stepFallbackNeverReturnsToPrimary(before: EmbeddingRun, after: EmbeddingRun): bool =
  before.attempt == FallbackAttempt implies after.attempt == FallbackAttempt
pure def stepCancelledEmbeddingStaysCancelled(before: EmbeddingRun, after: EmbeddingRun): bool =
  before.phase == EmbeddingCancelled implies after == before
pure def stepTerminalPhaseStaysTerminal(before: EmbeddingRun, after: EmbeddingRun): bool =
  before.phase != Awaiting implies after == before
pure val widthValues = Set(-1, 0, 100, 384, 1536)
pure val rowsValues = Set(
  List(),
  List({ inputIndex: 0, vectorWidth: 384, finiteCoordinates: true }),
  List({ inputIndex: 1, vectorWidth: 384, finiteCoordinates: true }),
  List({ inputIndex: 0, vectorWidth: 384, finiteCoordinates: true }, { inputIndex: 0, vectorWidth: 384, finiteCoordinates: true }),
  List({ inputIndex: 0, vectorWidth: 384, finiteCoordinates: true }, { inputIndex: 1, vectorWidth: 384, finiteCoordinates: true }),
  List({ inputIndex: 0, vectorWidth: 384, finiteCoordinates: false }),
  List({ inputIndex: 0, vectorWidth: 512, finiteCoordinates: true }))
pure def sometimesPrimarySucceeds(s: EmbeddingRun): bool = s.attempt == PrimaryAttempt and s.phase == EmbeddingSucceeded
pure def sometimesFallbackSucceeds(s: EmbeddingRun): bool = s.attempt == FallbackAttempt and s.phase == EmbeddingSucceeded
pure def sometimesExhausted(s: EmbeddingRun): bool = s.phase == EmbeddingExhausted
pure def sometimesCancelledAfterFailure(s: EmbeddingRun): bool = s.attempt == FallbackAttempt and s.phase == EmbeddingCancelled
pure val eval_witness_sometimesPrimarySucceeds = (("beginEmbedding", 1, 384, false), ("finishEmbedding", PrimaryAttempt, List({ inputIndex: 0, vectorWidth: 384, finiteCoordinates: true })))
pure val eval_witness_sometimesFallbackSucceeds = (("beginEmbedding", 1, 384, true), ("failEmbedding", PrimaryAttempt, true), ("finishEmbedding", FallbackAttempt, List({ inputIndex: 0, vectorWidth: 384, finiteCoordinates: true })))
pure val eval_witness_sometimesCancelledAfterFailure = (("beginEmbedding", 1, 384, true), ("failEmbedding", PrimaryAttempt, true), "cancelEmbedding")
```

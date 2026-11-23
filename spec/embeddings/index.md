# OpenAI-compatible embeddings

The endpoint adapter generates vectors for the runtime's single and batch
embedding handlers. The [kernel's embedding space](../core/embeddingSpace.md)
owns the representation used by vector storage.

## Story: Embed every input in the configured vector space

> As a runtime caller, I want one usable vector per input in exactly the
> input order. I want endpoint failure to stay visible.

### An endpoint attempt uses the configured representation and count

No implicit URL supplies an embedding. A null single input identifies the
configured width without dispatch. An empty batch returns without inspecting
provider configuration. The shell validates widths against the runtime's
vector dimensions, trims and normalizes text to well-formed Unicode, rejects
empty text, and sends all remaining content. Only explicitly configured
dimensions are written to the provider request.

```quint
type EmbeddingInput = ProbeWidth | EmbedOne | EmbedBatch
type EmbeddingAdmission = MissingEndpoint | InvalidEmbedding | NoInputs | ReturnWidth({ width: int }) | RequestVectors({ count: int, expectedWidth: int, sendWidth: bool })
pure def embeddingAdmission(inputKind: EmbeddingInput, inputCount: int, endpoint: str, width: int, explicitWidth: bool): EmbeddingAdmission =
  if (inputKind == EmbedBatch and inputCount == 0) NoInputs
  else if (width <= 0 or inputCount < 0) InvalidEmbedding
  else if (endpoint == "") MissingEndpoint
  else if (inputKind == ProbeWidth) ReturnWidth({ width: width })
  else if (inputKind == EmbedOne and inputCount != 1) InvalidEmbedding
  else RequestVectors({ count: inputCount, expectedWidth: width, sendWidth: explicitWidth })
pure def lawEmptyBatchNeverDispatches(endpoint: str, width: int, explicitWidth: bool): bool =
  embeddingAdmission(EmbedBatch, 0, endpoint, width, explicitWidth) == NoInputs
```

### Vectors cover every index exactly once and share one width

The response uses provider indices to recover original order. Send only
finite numbers into the runtime's chosen representation. An absent, duplicate,
out-of-range, nonfinite, or wrong-width entry fails the attempt. The shell
decodes floating-point coordinates, sorts the rows by their provider index,
and passes the ordered indices and observations to the model.

```quint
type VectorObservation = { inputIndex: int, vectorWidth: int, finiteCoordinates: bool }
pure def embeddingRowsMatch(rows: List[VectorObservation], inputCount: int, width: int): bool =
  inputCount > 0 and width > 0 and rows.length() == inputCount and
    rows.foldl(0, (rowNumber, row) =>
      if (rowNumber >= 0 and row.inputIndex == rowNumber and row.vectorWidth == width and row.finiteCoordinates)
      rowNumber + 1 else -1) == inputCount
pure def lawWrongCountRefuses(rows: List[VectorObservation], inputCount: int, width: int): bool =
  rows.length() != inputCount implies not(embeddingRowsMatch(rows, inputCount, width))
```

### A failed primary can use a configured fallback once

An attempt records which endpoint supplied its observations. Cancellation
ends the request, including cancellation after failure and before fallback
dispatch. The shell isolates each request, binds its abort signal, and reports
only fresh results from the active endpoint.

```quint
type EmbeddingAttempt = PrimaryAttempt | FallbackAttempt
type EmbeddingPhase = Awaiting | EmbeddingSucceeded | EmbeddingExhausted | EmbeddingCancelled
type EmbeddingRun = { phase: EmbeddingPhase, attempt: EmbeddingAttempt, count: int, width: int, hasFallback: bool }
pure val initial: EmbeddingRun = { phase: Awaiting, attempt: PrimaryAttempt, count: 0, width: 0, hasFallback: false }
pure def canBeginEmbedding(s: EmbeddingRun, inputCount: int, width: int): bool =
  s.phase == Awaiting and s.count == 0 and inputCount > 0 and width > 0
pure def beginEmbedding(s: EmbeddingRun, inputCount: int, width: int, hasFallback: bool): EmbeddingRun =
  { ...s, count: inputCount, width: width, hasFallback: hasFallback }
pure def canFinishEmbedding(s: EmbeddingRun, attempt: EmbeddingAttempt, rows: List[VectorObservation]): bool =
  s.phase == Awaiting and s.attempt == attempt and embeddingRowsMatch(rows, s.count, s.width)
pure def finishEmbedding(s: EmbeddingRun, attempt: EmbeddingAttempt, rows: List[VectorObservation]): EmbeddingRun =
  { ...s, phase: EmbeddingSucceeded }
pure def canFailEmbedding(s: EmbeddingRun, attempt: EmbeddingAttempt): bool =
  s.phase == Awaiting and s.count > 0 and s.attempt == attempt
pure def failEmbedding(s: EmbeddingRun, attempt: EmbeddingAttempt): EmbeddingRun =
  if (s.attempt == PrimaryAttempt and s.hasFallback) { ...s, attempt: FallbackAttempt }
  else { ...s, phase: EmbeddingExhausted }
pure def canCancelEmbedding(s: EmbeddingRun): bool = s.phase == Awaiting
pure def cancelEmbedding(s: EmbeddingRun): EmbeddingRun = { ...s, phase: EmbeddingCancelled }
pure def stepFallbackNeverReturnsToPrimary(before: EmbeddingRun, after: EmbeddingRun): bool =
  before.attempt == FallbackAttempt implies after.attempt == FallbackAttempt
pure def stepCancelledEmbeddingStaysCancelled(before: EmbeddingRun, after: EmbeddingRun): bool =
  before.phase == EmbeddingCancelled implies after == before
pure val rowsValues = Set(
  List(),
  List({ inputIndex: 0, vectorWidth: 2, finiteCoordinates: true }),
  List({ inputIndex: 1, vectorWidth: 2, finiteCoordinates: true }),
  List({ inputIndex: 0, vectorWidth: 2, finiteCoordinates: true }, { inputIndex: 0, vectorWidth: 2, finiteCoordinates: true }),
  List({ inputIndex: 0, vectorWidth: 2, finiteCoordinates: true }, { inputIndex: 1, vectorWidth: 2, finiteCoordinates: true }),
  List({ inputIndex: 0, vectorWidth: 2, finiteCoordinates: false }))
pure def sometimesFallbackSucceeds(s: EmbeddingRun): bool = s.attempt == FallbackAttempt and s.phase == EmbeddingSucceeded
pure val eval_witness_sometimesFallbackSucceeds = (("beginEmbedding", 1, 2, true), ("failEmbedding", PrimaryAttempt), ("finishEmbedding", FallbackAttempt, List({ inputIndex: 0, vectorWidth: 2, finiteCoordinates: true })))
```

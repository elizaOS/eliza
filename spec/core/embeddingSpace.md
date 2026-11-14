# Embedding representation identity

The compatibility baseline is `elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`. Sources are `packages/core/src/runtime/embeddings.ts`, `embedding-vector-space.ts`, and `quint/EmbeddingDimension.qnt`. Equal dimensions do not establish equal encoder, pooling or normalization. Provider identity and vector-space metadata remain attached to numeric vectors and exact copies. A configured model label alone cannot identify output.

## Story: Keep stored vectors in their verified representation

As an agent, I initialize and pin the embedding provider only after its probe and adapter preparation succeed. A named representation cannot be silently relabeled. The storage boundary captures dimension and representation before awaiting and rechecks both before committing each vector.

### A probe prepares dimensions and representation before pinning

```quint
type ProbePhase = Idle | Probing | Resized | Spaced | Pinned
type Encoder = { provider: str, space: str, dimension: int }
type EmbeddingSpace = { phase: ProbePhase, candidate: Encoder, pin: Encoder, hasPin: bool, column: int, storeSpace: str, clearFailed: bool, admitted: bool, capturedColumn: int, capturedSpace: str, vector: Encoder, stored: List[Encoder], rejected: bool, initializationActive: bool, pendingProviders: List[Encoder], failedProviders: List[str], realFailure: bool, disabled: bool, transitionUnconfirmed: bool, skipWarned: bool }
pure val initial: EmbeddingSpace = { phase: Idle, candidate: { provider: "", space: "", dimension: 0 }, pin: { provider: "", space: "", dimension: 0 }, hasPin: false, column: 0, storeSpace: "", clearFailed: false, admitted: false, capturedColumn: 0, capturedSpace: "", vector: { provider: "", space: "", dimension: 0 }, stored: List(), rejected: false, initializationActive: false, pendingProviders: List(), failedProviders: List(), realFailure: false, disabled: false, transitionUnconfirmed: false, skipWarned: false }
pure val encoderValues = Set({ provider: "providerA", space: "encoderA", dimension: 384 }, { provider: "providerB", space: "encoderB", dimension: 384 }, { provider: "providerC", space: "", dimension: 768 })
pure def compatiblePin(s: EmbeddingSpace, encoder: Encoder): bool = not(s.hasPin) or (if (s.pin.space != "") encoder.space == s.pin.space and encoder.dimension == s.pin.dimension else encoder.space == "")
pure val providersValues = Set(List(), List({ provider: "providerA", space: "encoderA", dimension: 384 }), List({ provider: "providerA", space: "encoderA", dimension: 384 }, { provider: "providerC", space: "", dimension: 768 }))
pure def canStartInitialization(s: EmbeddingSpace, providers: List[Encoder]): bool = s.phase == Idle and not(s.initializationActive) and providers.every(encoder => encoder.provider != "" and encoder.dimension > 0)
pure def startInitialization(s: EmbeddingSpace, providers: List[Encoder]): EmbeddingSpace = { ...s, initializationActive: true, pendingProviders: providers.foldl(List(), (found, encoder) => if (found.some(previous => previous.provider == encoder.provider)) found else found.append(encoder)), failedProviders: List(), realFailure: false }
pure def canBeginProbe(s: EmbeddingSpace): bool = s.phase == Idle and s.initializationActive and s.pendingProviders.length() > 0
pure def beginProbe(s: EmbeddingSpace): EmbeddingSpace = { ...s, phase: Probing, candidate: s.pendingProviders.nthOr(0, { provider: "", space: "", dimension: 0 }), pendingProviders: s.pendingProviders.removeAt(0), rejected: false }
pure def canProbeFailed(s: EmbeddingSpace, benign: bool): bool = s.phase == Probing
pure def probeFailed(s: EmbeddingSpace, benign: bool): EmbeddingSpace = { ...s, phase: Idle, failedProviders: s.failedProviders.append(s.candidate.provider), realFailure: s.realFailure or not(benign) }
pure def canExhaustProviders(s: EmbeddingSpace): bool = s.phase == Idle and s.initializationActive and s.pendingProviders.length() == 0
pure def exhaustProviders(s: EmbeddingSpace): EmbeddingSpace = { ...s, initializationActive: false, disabled: s.disabled or s.realFailure, skipWarned: if (s.realFailure) false else s.skipWarned }
pure def canResize(s: EmbeddingSpace): bool = s.phase == Probing
pure def resize(s: EmbeddingSpace): EmbeddingSpace =
  if (compatiblePin(s, s.candidate) and (s.storeSpace == "" or s.column == s.candidate.dimension)) { ...s, column: s.candidate.dimension, phase: Resized, transitionUnconfirmed: s.transitionUnconfirmed or s.column != s.candidate.dimension or s.storeSpace != s.candidate.space }
  else { ...s, phase: Idle, rejected: true, initializationActive: false }
pure def canPrepareSpace(s: EmbeddingSpace): bool = s.phase == Resized
pure def prepareSpace(s: EmbeddingSpace): EmbeddingSpace =
  if (s.candidate.space == "" or s.storeSpace == "" or s.storeSpace == s.candidate.space) { ...s, storeSpace: if (s.candidate.space == "") s.storeSpace else s.candidate.space, phase: Spaced }
  else { ...s, phase: Idle, rejected: true, initializationActive: false }
pure def canPin(s: EmbeddingSpace): bool = s.phase == Spaced
pure def pin(s: EmbeddingSpace): EmbeddingSpace = { ...s, phase: Pinned, pin: s.candidate, hasPin: true, initializationActive: false, disabled: false, transitionUnconfirmed: false, skipWarned: false }
pure def canClearStale(s: EmbeddingSpace, succeeded: bool): bool = s.phase == Pinned
pure def clearStale(s: EmbeddingSpace, succeeded: bool): EmbeddingSpace = { ...s, phase: Idle, stored: if (succeeded) s.stored.select(vector => vector.dimension == s.column or vector.space != s.storeSpace) else s.stored, clearFailed: not(succeeded) }
pure def stepNamedPinDoesNotChange(before: EmbeddingSpace, after: EmbeddingSpace): bool = not(before.hasPin) or before.pin.space == "" or (after.pin.space == before.pin.space and after.pin.dimension == before.pin.dimension)
```

### The vector write rechecks captured representation after every await

An unmarked direct input is represented by an empty space and may enter only an unnamed store. Stale dimension or identity writes are rejected. A failed stale-vector clear remains an explicit diagnostic state.

```quint
pure def canAdmit(s: EmbeddingSpace, encoder: Encoder): bool = not(s.admitted) and not(s.disabled) and not(s.transitionUnconfirmed) and encoder.dimension > 0 and compatiblePin(s, encoder) and (not(s.hasPin) or encoder.provider == s.pin.provider)
pure def admit(s: EmbeddingSpace, encoder: Encoder): EmbeddingSpace = { ...s, admitted: true, capturedColumn: s.column, capturedSpace: s.storeSpace, vector: encoder }
pure def canWriteVector(s: EmbeddingSpace): bool = s.admitted
pure def writeVector(s: EmbeddingSpace): EmbeddingSpace =
  if (s.capturedColumn == s.column and s.capturedSpace == s.storeSpace and s.vector.dimension == s.column and s.vector.space == s.storeSpace) { ...s, admitted: false, stored: s.stored.append(s.vector) }
  else { ...s, admitted: false, rejected: true }
pure def vectorRelabelAllowed(originalSpace: str, requestedSpace: str, previouslyMarked: bool): bool = not(previouslyMarked) or originalSpace == requestedSpace
pure def lawMarkedVectorCannotChangeIdentity(originalSpace: str, requestedSpace: str): bool = vectorRelabelAllowed(originalSpace, requestedSpace, true) == (originalSpace == requestedSpace)
pure def alwaysPreparedCandidateMatchesPin(s: EmbeddingSpace): bool = (s.phase != Resized and s.phase != Spaced and s.phase != Pinned) or compatiblePin(s, s.candidate)
pure def alwaysPreparedColumnMatchesCandidate(s: EmbeddingSpace): bool = (s.phase != Resized and s.phase != Spaced and s.phase != Pinned) or s.column == s.candidate.dimension
pure def alwaysPinnedColumnMatches(s: EmbeddingSpace): bool = s.phase != Idle or s.transitionUnconfirmed or not(s.hasPin) or (s.pin.dimension == s.column and (s.pin.space == "" or s.pin.space == s.storeSpace))
pure def alwaysCurrentColumnHasMatchingDimensions(s: EmbeddingSpace): bool = s.phase != Idle or s.transitionUnconfirmed or s.clearFailed or s.stored.every(vector => vector.space != s.storeSpace or vector.dimension == s.column)
pure def alwaysStoredDimensionsPositive(s: EmbeddingSpace): bool = s.stored.every(vector => vector.dimension > 0)
pure def sometimesVectorStored(s: EmbeddingSpace): bool = s.stored.length() > 0
pure def sometimesRepresentationRejected(s: EmbeddingSpace): bool = s.rejected
```

### Failed initialization fences generation until a confirmed recovery

A real failure of every eligible provider disables new vector generation and retains every failure for diagnostics. An all-benign no-provider result preserves the existing flag. A failed storage transition remains fenced because the operation may already have committed. Existing memory persistence continues through the host's ordinary storage contract. The skip warning is emitted once per disabled period.

```quint
pure def canPreparationFailed(s: EmbeddingSpace): bool = s.phase == Probing or s.phase == Resized or s.phase == Spaced
pure def preparationFailed(s: EmbeddingSpace): EmbeddingSpace = { ...s, phase: Idle, initializationActive: false, transitionUnconfirmed: true }
pure def canObserveSkippedGeneration(s: EmbeddingSpace): bool = s.disabled or s.transitionUnconfirmed
pure def observeSkippedGeneration(s: EmbeddingSpace): EmbeddingSpace = { ...s, skipWarned: true }
pure def alwaysDisabledRefusesNewGeneration(s: EmbeddingSpace): bool = (s.disabled or s.transitionUnconfirmed) implies not(canAdmit(s, { provider: "providerA", space: "encoderA", dimension: 384 }))
pure def sometimesAllProvidersFail(s: EmbeddingSpace): bool = s.disabled and s.failedProviders.length() > 0 and not(s.initializationActive)
pure def sometimesTransitionRemainsFenced(s: EmbeddingSpace): bool = s.transitionUnconfirmed and s.phase == Idle
pure val fair_beginProbe = "weak"
pure val fair_resize = "weak"
pure val fair_prepareSpace = "weak"
pure val fair_pin = "weak"
pure val fair_clearStale = "weak"
pure val fair_exhaustProviders = "weak"
pure def leadsToInitializationSettles(s: EmbeddingSpace, later: EmbeddingSpace): bool = s.initializationActive implies not(later.initializationActive)
```

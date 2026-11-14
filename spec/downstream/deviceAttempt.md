# Renderer device action attempt identity

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` uses
`createDeviceActionExecution` from Eliza
`c518127a025ab173874af9c7d304f26b25213b0d` through the shared device
action coordinator. [Device action custody](./mobileDeviceExecution.md)
owns authority, the durable journal, and receipt delivery. This spec
owns the renderer guard's exact identity, failure order and phase.

## Story: Dispatch an exact renderer attempt once and settle its result

### Store only the validated scope, proposal and operation identity

The decoder takes an object and projects only `scope`, `proposalId` and
`operationId`. Scope is exactly 64 lowercase hexadecimal units. The
two IDs each contain 1 through 128 ASCII letters, digits, hyphens or
underscores. The result has a frozen, detached identity. Each later
argument passes the same decoder, and exact comparison uses all
three projected strings. Untrusted JavaScript object access and copying
are host duties. The pure model takes lexical observations of the
three read strings.

```quint
type AttemptIdentity = { scope: str, proposal: str, operation: str }
type IdentityShape = { objectRecord: bool, scopeUnits: int, scopeHex: bool,
  proposalUnits: int, proposalAscii: bool, operationUnits: int, operationAscii: bool }
pure def admittedIdentity(shape: IdentityShape): bool =
  shape.objectRecord and shape.scopeUnits == 64 and shape.scopeHex and
    shape.proposalUnits >= 1 and shape.proposalUnits <= 128 and shape.proposalAscii and
    shape.operationUnits >= 1 and shape.operationUnits <= 128 and shape.operationAscii
pure val validShape: IdentityShape = { objectRecord: true, scopeUnits: 64, scopeHex: true, proposalUnits: 8,
  proposalAscii: true, operationUnits: 9, operationAscii: true }
pure val shapeValues = Set(validShape, { ...validShape, scopeHex: false },
  { ...validShape, proposalAscii: false }, { ...validShape, operationUnits: 129 })
pure def lawScopeMustBeExactHexLength(shape: IdentityShape): bool =
  admittedIdentity(shape) implies shape.scopeUnits == 64 and shape.scopeHex
pure def lawBothIdentifiersMustFit(shape: IdentityShape): bool =
  admittedIdentity(shape) implies shape.proposalUnits > 0 and shape.proposalUnits <= 128 and
    shape.operationUnits > 0 and shape.operationUnits <= 128
```

### Dispatch checks retirement and ownership while settlement checks the retained dispatch

The guard starts prepared with the accepted identity. Dispatch tests a
candidate's shape, exact identity, cancellation, prepared phase and
retirement, then invokes the current caller assertion. The phase moves only
if all checks return. Cancellation propagates its original reason.
Retirement is sticky. The journal reservation and server claim are external
preconditions for the coordinator that calls this guard.

Settlement checks the candidate's shape, exact identity and dispatched
phase. It still succeeds after the caller retires or the signal aborts,
because it settles the same attempt. The observable `dispatched` flag stays
true in the settled phase. A fresh guard needs a distinct authoritative
admission. This model follows one constructed guard and assumes the
current caller assertion is synchronous and does not reenter that guard,
as with the pinned coordinator.

```quint
type RendererPhase = AttemptPrepared | AttemptDispatched | AttemptSettled
type AttemptRefusal = AttemptAllowed | InvalidIdentity | ChangedIdentity | SignalAbort | UnavailablePhase | StaleOwner | NoOpenDispatch
type RendererAttempt = { key: AttemptIdentity, phase: RendererPhase, retired: bool, aborted: bool, current: bool }
pure val firstIdentity: AttemptIdentity = { scope: "binding", proposal: "offer", operation: "operation" }
pure val initial: RendererAttempt = { key: firstIdentity, phase: AttemptPrepared, retired: false, aborted: false, current: true }
pure val candidateValues = Set(firstIdentity, { ...firstIdentity, scope: "elsewhere" }, { ...firstIdentity, operation: "different" })
pure def identityCheck(candidate: AttemptIdentity, valid: bool, expected: AttemptIdentity): AttemptRefusal =
  if (not(valid)) InvalidIdentity else if (candidate != expected) ChangedIdentity else AttemptAllowed
pure def dispatchCheck(attempt: RendererAttempt, candidate: AttemptIdentity, valid: bool): AttemptRefusal = {
  val binding = identityCheck(candidate, valid, attempt.key)
  if (binding != AttemptAllowed) binding
  else if (attempt.aborted) SignalAbort
  else if (attempt.retired or attempt.phase != AttemptPrepared) UnavailablePhase
  else if (not(attempt.current)) StaleOwner else AttemptAllowed
}
pure def settleCheck(attempt: RendererAttempt, candidate: AttemptIdentity, valid: bool): AttemptRefusal = {
  val binding = identityCheck(candidate, valid, attempt.key)
  if (binding != AttemptAllowed) binding
  else if (attempt.phase != AttemptDispatched) NoOpenDispatch else AttemptAllowed
}
pure def canDispatchAttempt(attempt: RendererAttempt, candidate: AttemptIdentity, valid: bool): bool =
  dispatchCheck(attempt, candidate, valid) == AttemptAllowed
pure def dispatchAttempt(attempt: RendererAttempt, candidate: AttemptIdentity, valid: bool): RendererAttempt =
  { ...attempt, phase: AttemptDispatched }
pure def canSettleAttempt(attempt: RendererAttempt, candidate: AttemptIdentity, valid: bool): bool =
  settleCheck(attempt, candidate, valid) == AttemptAllowed
pure def settleAttempt(attempt: RendererAttempt, candidate: AttemptIdentity, valid: bool): RendererAttempt =
  { ...attempt, phase: AttemptSettled }
pure def canAbortAttempt(attempt: RendererAttempt): bool = not(attempt.aborted)
pure def abortAttempt(attempt: RendererAttempt): RendererAttempt = { ...attempt, aborted: true }
pure def canRetireAttempt(attempt: RendererAttempt): bool = not(attempt.retired)
pure def retireAttempt(attempt: RendererAttempt): RendererAttempt = { ...attempt, retired: true }
pure def canMoveOwner(attempt: RendererAttempt): bool = attempt.current
pure def moveOwner(attempt: RendererAttempt): RendererAttempt = { ...attempt, current: false }
pure def wasDispatched(attempt: RendererAttempt): bool = attempt.phase != AttemptPrepared
pure def stepAttemptKeepsIdentity(before: RendererAttempt, after: RendererAttempt): bool = before.key == after.key
pure def stepRecordedDispatchPersists(before: RendererAttempt, after: RendererAttempt): bool =
  wasDispatched(before) implies wasDispatched(after)
pure def stepSettlementIsTerminal(before: RendererAttempt, after: RendererAttempt): bool =
  before.phase == AttemptSettled implies after.phase == AttemptSettled
pure def sometimesSettlesAfterAbort(attempt: RendererAttempt): bool = attempt.aborted and attempt.phase == AttemptSettled
pure def sometimesRetiresBeforeDispatch(attempt: RendererAttempt): bool = attempt.retired and attempt.phase == AttemptPrepared
pure def lawRetiredAttemptDoesNotDispatch(attempt: RendererAttempt, candidate: AttemptIdentity, valid: bool): bool =
  attempt.retired implies not(canDispatchAttempt(attempt, candidate, valid))
pure def lawSettlementNeedsExactDispatch(attempt: RendererAttempt, candidate: AttemptIdentity, valid: bool): bool =
  canSettleAttempt(attempt, candidate, valid) implies candidate == attempt.key and valid and attempt.phase == AttemptDispatched
```

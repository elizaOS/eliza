# Alpha device action claim and receipt custody

Alpha reuses the pinned Eliza
`plugins/plugin-assistant/src/services/device-actions/client-coordinator.ts`
in `apps/app/src/runtime/device-actions.ts`. That coordinator imports
`packages/contracts/src/device-action-execution.ts` for the
renderer-attempt fence. The public contract includes
`DeviceClientSession`, `DeviceContextEnvelope`,
`DeviceActionProposalCard`, `DeviceActionJournal`,
`DeviceExecutor`, `ForegroundReviewExecutor`, and
`DeviceOperationReceipt`. The proposal card displays a stored
proposal. Approval takes its ID and current context, and execution
uses the stored operation.

This model covers a single claim and its journaled effect. Other
proposals have separate identities. The local journal owns
scope/proposal/operation identity, operation hash and attempt ID.
The server owns execution grants. The host supplies evidence for
canonical decoding, exact owner, installation, enrollment,
session, origin, request key, and proposal digest. The native
executor's own operation admission is separate.

## Story: Approve a device operation on the screen that reviewed it

### An exact reservation and server claim must precede dispatch

Only the same live, nonsensitive and unexpired context can
approve. Claim and journal must retain the exact proposal and
operation. A prior reservation can be adopted only if its owner,
device and operation hash match and it has no attempt ID.
A reserved row whose operation differs, an applying row or a
terminal row blocks replay. The coordinator writes applying
with the granted attempt before it marks dispatch and invokes
the native port. Retirement before dispatch prevents it.
Prior entries and claim decisions arrive through the authoritative
store and server ports.

```quint
type DevicePhase = Unreviewed | Reviewed | JournalReserved | ServerClaimed | Applying | Dispatched | TerminalDevice | NeedsHistory
type ReserveEvidence = { newEntry: bool, exactMatch: bool, reservedWithoutAttempt: bool }
type DeviceAttempt = {
  phase: DevicePhase, operationId: int, attemptId: int, retired: bool, dispatched: bool,
  answer: DeviceAnswer, uploaded: bool
}
type DeviceAnswer = NoDeviceAnswer | DeviceSucceeded | DeviceRejected | DeviceUncertain
pure val noDeviceAnswer: DeviceAnswer = NoDeviceAnswer
pure val initial: DeviceAttempt = {
  phase: Unreviewed, operationId: 0, attemptId: 0, retired: false, dispatched: false,
  answer: noDeviceAnswer, uploaded: false
}
pure def canShowProposal(s: DeviceAttempt, proposalValid: bool): bool = s.phase == Unreviewed and proposalValid and not(s.retired)
pure def showProposal(s: DeviceAttempt, proposalValid: bool): DeviceAttempt = {...s, phase: Reviewed}
pure def canReserveAction(s: DeviceAttempt, operationId: int, exactCurrentScreen: bool, nonSensitive: bool, unexpired: bool): bool =
  s.phase == Reviewed and not(s.retired) and operationId > 0 and exactCurrentScreen and nonSensitive and unexpired
pure def reserveAction(s: DeviceAttempt, operationId: int, exactCurrentScreen: bool, nonSensitive: bool, unexpired: bool, receipt: ReserveEvidence): DeviceAttempt =
  if (receipt.exactMatch and (receipt.newEntry or receipt.reservedWithoutAttempt)) {...s, operationId: operationId, phase: JournalReserved}
  else {...s, phase: NeedsHistory}
pure val operationIdValues = Set(0, 1, 2)
pure val receiptValues = Set(
  {newEntry: true, exactMatch: true, reservedWithoutAttempt: true},
  {newEntry: false, exactMatch: true, reservedWithoutAttempt: true},
  {newEntry: false, exactMatch: false, reservedWithoutAttempt: true},
  {newEntry: false, exactMatch: true, reservedWithoutAttempt: false}
)
pure def canAcceptClaim(s: DeviceAttempt, attemptId: int, exactClaim: bool): bool =
  s.phase == JournalReserved and not(s.retired) and attemptId > 0 and exactClaim
pure def acceptClaim(s: DeviceAttempt, attemptId: int, exactClaim: bool): DeviceAttempt =
  {...s, phase: ServerClaimed, attemptId: attemptId}
pure val attemptIdValues = Set(0, 1, 2)
pure def canMarkApplying(s: DeviceAttempt): bool = s.phase == ServerClaimed and not(s.retired)
pure def markApplying(s: DeviceAttempt): DeviceAttempt = {...s, phase: Applying}
pure def canInvokeExecutor(s: DeviceAttempt, exactOperation: bool, currentContext: bool, unexpired: bool): bool =
  s.phase == Applying and not(s.retired) and exactOperation and currentContext and unexpired
pure def invokeExecutor(s: DeviceAttempt, exactOperation: bool, currentContext: bool, unexpired: bool): DeviceAttempt =
  {...s, phase: Dispatched, dispatched: true}
pure def canRetireProposal(s: DeviceAttempt): bool = not(s.retired)
pure def retireProposal(s: DeviceAttempt): DeviceAttempt = {...s, retired: true}
pure def alwaysDispatchOwnsClaim(s: DeviceAttempt): bool =
  (s.phase != Unreviewed and s.phase != Reviewed and s.phase != NeedsHistory implies s.operationId > 0) and
  (s.phase == ServerClaimed or s.phase == Applying or s.phase == Dispatched or s.phase == TerminalDevice implies s.attemptId > 0)
pure def alwaysDispatchPhaseMatches(s: DeviceAttempt): bool =
  (s.phase == Dispatched implies s.dispatched) and (s.dispatched implies s.phase == Dispatched or s.phase == TerminalDevice)
pure def stepOnlyApplyingCanDispatch(before: DeviceAttempt, after: DeviceAttempt): bool =
  not(before.dispatched) and after.dispatched implies before.phase == Applying and not(before.retired)
```

## Story: Preserve a device result when the renderer retires

### Durable settlement precedes upload and ambiguous work is never repeated

An executor's `DeviceActionNotStarted` refusal supplies evidence
of no effect. Other exceptions after dispatch are uncertain.
A successful response requires the operation's typed result where
that operation has one. A malformed typed response leaves the
applying entry available to history recovery. The journal records
a terminal result even after the renderer retires. An upload
failure leaves the local result as-is and offers explicit history
retry, which only uploads the exact terminal result.

```quint
pure def canRecordResult(s: DeviceAttempt, answer: DeviceAnswer, exactTypedResult: bool): bool =
  (s.phase == Dispatched or (s.phase == Applying and answer == DeviceRejected)) and
    answer != NoDeviceAnswer and (answer != DeviceSucceeded or exactTypedResult)
pure def recordResult(s: DeviceAttempt, answer: DeviceAnswer, exactTypedResult: bool): DeviceAttempt =
  {...s, phase: TerminalDevice, answer: answer}
pure def canUploadResult(s: DeviceAttempt, exactAttempt: bool): bool =
  s.phase == TerminalDevice and not(s.uploaded) and exactAttempt
pure def uploadResult(s: DeviceAttempt, exactAttempt: bool, serverAccepted: bool): DeviceAttempt =
  {...s, uploaded: serverAccepted}
pure def alwaysResultIsExplicit(s: DeviceAttempt): bool =
  (s.phase == TerminalDevice) == (s.answer != NoDeviceAnswer)
pure def alwaysSuccessWasDispatched(s: DeviceAttempt): bool = s.answer == DeviceSucceeded implies s.dispatched
pure def alwaysUploadMeansTerminal(s: DeviceAttempt): bool = s.uploaded implies s.phase == TerminalDevice
pure def stepTerminalDeviceAnswerStable(before: DeviceAttempt, after: DeviceAttempt): bool =
  before.phase == TerminalDevice implies before.answer == after.answer and before.operationId == after.operationId and
    before.attemptId == after.attemptId and after.phase == TerminalDevice
pure def sometimesRetiredEffectRetained(s: DeviceAttempt): bool =
  s.phase == TerminalDevice and s.dispatched and s.retired
pure def sometimesUnsyncedLocalResult(s: DeviceAttempt): bool =
  s.phase == TerminalDevice and s.answer == DeviceSucceeded and not(s.uploaded)
pure def sometimesExactResultUploaded(s: DeviceAttempt): bool = s.uploaded
```

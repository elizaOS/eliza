# Computer use approvals

## Story: Gate computer-use commands by approval mode and operator decisions

> As the owner, I can choose `full_control`, `smart_approve`, `approve_all`, or `off`. Commands follow the active approval policy, pending approvals are resolved once by id, and switching to `off` cancels every pending request immediately.

### Approval policy maps mode and command risk to an unambiguous verdict

`off` denies all commands; `full_control` auto-approves all commands; `smart_approve` auto-approves only read-only commands and queues mutating or destructive commands; `approve_all` queues every command. The scene context offered to vision prompts (open applications, the focused window and its title, process names) is an observation of the screen: it is given only while a screenshot would be auto-approved, and otherwise carries none of them, not even from a scene captured earlier.

```quint
type ApprovalMode = FullControl | SmartApprove | ApproveAll | Off
type CommandRisk = ReadOnly | Mutating | Destructive
type ApprovalVerdict = AutoApproved | NeedsApproval | AutoDenied

pure def evaluateApprovalPolicy(mode: ApprovalMode, risk: CommandRisk): ApprovalVerdict =
  match mode {
    | Off => AutoDenied
    | FullControl => AutoApproved
    | ApproveAll => NeedsApproval
    | SmartApprove => if (risk == ReadOnly) AutoApproved else NeedsApproval
  }

pure def lawOffAlwaysDenies(risk: CommandRisk): bool =
  evaluateApprovalPolicy(Off, risk) == AutoDenied

pure def lawFullControlAlwaysApproves(risk: CommandRisk): bool =
  evaluateApprovalPolicy(FullControl, risk) == AutoApproved

pure def lawSmartApproveOnlyAutoApprovesReadOnly(risk: CommandRisk): bool =
  (evaluateApprovalPolicy(SmartApprove, risk) == AutoApproved) iff (risk == ReadOnly)

pure def lawApproveAllNeverAutoApproves(risk: CommandRisk): bool =
  evaluateApprovalPolicy(ApproveAll, risk) == NeedsApproval
```

### The pending approval queue assigns monotonic ids and cancels pending items when disabled

Each queued request receives the next integer id. Resolving or cancelling removes that id permanently. Switching the mode to `Off` cancels all currently pending requests in one atomic step.

```quint
type ApprovalQueue = {
  mode: ApprovalMode,
  nextId: int,
  pendingIds: List[int],
  approvedCount: int,
  deniedCount: int,
  cancelledCount: int
}

pure val initial: ApprovalQueue = {
  mode: SmartApprove,
  nextId: 1,
  pendingIds: List(),
  approvedCount: 0,
  deniedCount: 0,
  cancelledCount: 0
}

pure def canSetMode(q: ApprovalQueue, nextMode: ApprovalMode): bool =
  q.mode != nextMode

pure def setMode(q: ApprovalQueue, nextMode: ApprovalMode): ApprovalQueue =
  if (nextMode == Off) {
    ...q,
    mode: Off,
    pendingIds: List(),
    cancelledCount: q.cancelledCount + q.pendingIds.length()
  } else {
    ...q,
    mode: nextMode
  }

pure def canEnqueueApproval(q: ApprovalQueue, risk: CommandRisk): bool =
  evaluateApprovalPolicy(q.mode, risk) == NeedsApproval

pure def enqueueApproval(q: ApprovalQueue, risk: CommandRisk): ApprovalQueue = {
  ...q,
  nextId: q.nextId + 1,
  pendingIds: q.pendingIds.append(q.nextId)
}

pure def canResolveApproval(q: ApprovalQueue, approvalId: int, approved: bool): bool =
  q.pendingIds.includes(approvalId)

pure def resolveApproval(q: ApprovalQueue, approvalId: int, approved: bool): ApprovalQueue = {
  ...q,
  pendingIds: q.pendingIds.select(id => id != approvalId),
  approvedCount: if (approved) q.approvedCount + 1 else q.approvedCount,
  deniedCount: if (approved) q.deniedCount else q.deniedCount + 1
}

pure def canCancelApproval(q: ApprovalQueue, approvalId: int): bool =
  q.pendingIds.includes(approvalId)

pure def cancelApproval(q: ApprovalQueue, approvalId: int): ApprovalQueue = {
  ...q,
  pendingIds: q.pendingIds.select(id => id != approvalId),
  cancelledCount: q.cancelledCount + 1
}

pure def canCancelAllApprovals(q: ApprovalQueue): bool =
  q.pendingIds.length() > 0

pure def cancelAllApprovals(q: ApprovalQueue): ApprovalQueue = {
  ...q,
  pendingIds: List(),
  cancelledCount: q.cancelledCount + q.pendingIds.length()
}
```

### Queue invariants preserve id monotonicity, uniqueness, total accounting, and fail-closed Off mode

Every pending id was previously issued and appears at most once in the pending queue (Discovered by the proof: without uniqueness of pending ids, removing one id could drop multiple entries and break total accounting). The total of pending plus resolved plus cancelled requests equals the total issued requests, and `Off` mode never holds pending approvals.

```quint
pure def alwaysApprovalCountsValid(q: ApprovalQueue): bool =
  q.nextId >= 1 and q.approvedCount >= 0 and q.deniedCount >= 0 and q.cancelledCount >= 0

pure def alwaysPendingIdsIssued(q: ApprovalQueue): bool =
  q.pendingIds.every(id => id >= 1 and id < q.nextId)

pure def alwaysPendingIdsUnique(q: ApprovalQueue): bool =
  q.pendingIds.every(id => q.pendingIds.select(x => x == id).length() == 1)

pure def alwaysOffModeHasNoPending(q: ApprovalQueue): bool =
  q.mode == Off implies q.pendingIds.length() == 0

pure def alwaysIssuedAccountingBalanced(q: ApprovalQueue): bool =
  q.pendingIds.length() + q.approvedCount + q.deniedCount + q.cancelledCount == q.nextId - 1

pure def stepNextIdMonotonic(before: ApprovalQueue, after: ApprovalQueue): bool =
  after.nextId >= before.nextId and
  after.approvedCount >= before.approvedCount and
  after.deniedCount >= before.deniedCount and
  after.cancelledCount >= before.cancelledCount

pure def sometimesApprovedRequest(q: ApprovalQueue): bool =
  q.approvedCount >= 1

pure def sometimesDeniedRequest(q: ApprovalQueue): bool =
  q.deniedCount >= 1

pure def sometimesOffCancelsPending(q: ApprovalQueue): bool =
  q.mode == Off and q.cancelledCount >= 1

pure val approvalIdValues = Set(0, 1, 2, 3, 4)
pure val eval_witness_sometimesApprovedRequest = (("enqueueApproval", Mutating), ("resolveApproval", 1, true))
pure val eval_witness_sometimesDeniedRequest = (("enqueueApproval", Destructive), ("resolveApproval", 1, false))
pure val eval_witness_sometimesOffCancelsPending = (("enqueueApproval", Mutating), ("setMode", Off))
```

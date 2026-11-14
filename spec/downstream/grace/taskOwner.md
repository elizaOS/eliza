# Task gateway owner fence

## Story: A delayed credential read cannot end another account's task

The pinned host gateway reads credentials asynchronously. It creates a sequence
and captures the owner epoch for each read. A read that would replace or clear
a live owner asks for confirmation first. An out-of-order read for the same
owner may still succeed, but never moves the settled sequence backwards.

### Apply the credential gate decision

`OwnerFence` and `GateRead` are the value contracts of
`packages/host/native-host/task-owner-fence.mjs` at Grace's pin. Empty account
models `null` or a gate failure. Explicit revocation retries cleanup even if
the fence is already closed. The result's revoke bit describes a cleanup
request. The gateway owns that work and its errors.

```quint
type OwnerFence = { epoch: int, owner: str, settledSequence: int, closed: bool }
type GateRead = { sequence: int, startedEpoch: int, account: str, confirming: bool }
type GateDecision = Superseded | Confirm | Accepted | SignedOut
type GateResult = { fence: OwnerFence, decision: GateDecision, revoke: bool }

pure val supersededDecision: GateDecision = Superseded
pure val confirmDecision: GateDecision = Confirm
pure val initialFence: OwnerFence = { epoch: 0, owner: "", settledSequence: 0, closed: false }
pure def staleRead(f: OwnerFence, read: GateRead): bool =
  f.closed or read.startedEpoch != f.epoch or
  (read.sequence < f.settledSequence and (read.account == "" or read.account != f.owner))
pure def gateRead(f: OwnerFence, read: GateRead): GateResult = {
  val revokes = f.owner != "" and read.account != f.owner
  val boundedSequence = if (read.sequence > f.settledSequence) read.sequence else f.settledSequence
  if (staleRead(f, read)) { fence: f, decision: supersededDecision, revoke: false }
  else if (revokes and not(read.confirming)) { fence: f, decision: confirmDecision, revoke: false }
  else if (read.account == "") {
    fence: { ...f, epoch: f.epoch + 1, owner: "", settledSequence: boundedSequence },
    decision: SignedOut, revoke: true
  }
  else {
    fence: { ...f, epoch: if (revokes) f.epoch + 1 else f.epoch, owner: read.account, settledSequence: boundedSequence },
    decision: Accepted, revoke: revokes
  }
}
pure def endFence(f: OwnerFence, closing: bool): GateResult = {
  fence: { ...f, epoch: f.epoch + 1, owner: "", closed: f.closed or closing },
  decision: SignedOut, revoke: true
}
pure def lawStaleReadHasNoEffect(f: OwnerFence, read: GateRead): bool =
  staleRead(f, read) implies gateRead(f, read) == { fence: f, decision: supersededDecision, revoke: false }
pure def lawReplacingOwnerNeedsConfirmation(f: OwnerFence, read: GateRead): bool =
  (not(staleRead(f, read)) and f.owner != "" and read.account != f.owner and not(read.confirming))
  implies gateRead(f, read) == { fence: f, decision: confirmDecision, revoke: false }
pure def lawOldReadCannotMoveSequenceBack(f: OwnerFence, read: GateRead): bool =
  gateRead(f, read).fence.settledSequence >= f.settledSequence
pure def lawARevokeClearsOwner(f: OwnerFence, closing: bool): bool =
  endFence(f, closing).fence.owner == "" and endFence(f, closing).fence.epoch == f.epoch + 1
pure def lawSwitchInvalidatesOldEpoch(f: OwnerFence, read: GateRead): bool =
  (f.owner != "" and gateRead(f, read).fence.owner != f.owner)
  implies gateRead(f, read).fence.epoch > f.epoch and gateRead(f, read).revoke
```

## Story: Return a task response only to the account that requested it

### Recheck owner and epoch at the response boundary

Related source evidence includes Grace's `TaskOwnerFence.tla`, its
`model-replay-task-owner-fence.test.mjs`, and pinned
`packages/host/native-host/task-runtime-gateway.mjs`. A committed response is
still subject to the owner fence. If a write already committed, the response
fence does not undo its effects. The task and effect ledgers govern
reconciliation and prevent dispatch replay.

```quint
type RequestFence = { owner: str, epoch: int }
pure def permitsReply(f: OwnerFence, request: RequestFence): bool =
  not(f.closed) and f.owner != "" and f.owner == request.owner and f.epoch == request.epoch
pure def lawClosedFenceRejectsReply(f: OwnerFence, request: RequestFence): bool =
  f.closed implies not(permitsReply(f, request))
pure def lawAnotherEpochRejectsReply(f: OwnerFence, request: RequestFence): bool =
  f.epoch != request.epoch implies not(permitsReply(f, request))
pure def lawAnotherOwnerRejectsReply(f: OwnerFence, request: RequestFence): bool =
  f.owner != request.owner implies not(permitsReply(f, request))
pure val fValues = Set(initialFence, { ...initialFence, owner: "ownerA", epoch: 1, settledSequence: 2 },
  { ...initialFence, closed: true, epoch: 2, settledSequence: 3 })
pure val readValues = Set(
  { sequence: 1, startedEpoch: 1, account: "ownerB", confirming: true },
  { sequence: 3, startedEpoch: 1, account: "ownerB", confirming: false },
  { sequence: 3, startedEpoch: 1, account: "ownerB", confirming: true },
  { sequence: 3, startedEpoch: 1, account: "", confirming: true },
  { sequence: 1, startedEpoch: 1, account: "ownerA", confirming: false },
  { sequence: 1, startedEpoch: 0, account: "ownerA", confirming: false })
pure val requestValues = Set({ owner: "ownerA", epoch: 1 }, { owner: "ownerB", epoch: 1 },
  { owner: "ownerA", epoch: 2 })
```

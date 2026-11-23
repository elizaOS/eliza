# Native action journal

The execution policy belongs to [the device-action client](../agent/deviceActions/execution.md). This contract covers the durable journal boundary and its scope-filtered reads.

## Story: Resume an approved operation after the device restarts

> As the owner, I want to recover the result of the exact operation I reviewed, so a retry cannot substitute another operation or dispatch it twice.

### A reservation binds the owner scope, proposal, operation and record digest

Each modeled entry is a single durable slot keyed by scope and proposal. The storage adapter only compares canonical, validated digest and identifier values. It returns an identical reservation on replay and refuses different evidence.

```quint
type Reservation = {
  ownerScope: str, proposalId: str, operationId: str, operationHash: str, recordDigest: str
}
type TerminalStatus = JournalSucceeded | JournalFailed | JournalUnknown | JournalCancelled
type Dispatch = { reserved: Reservation, attemptId: str }
type Receipt = { reserved: Reservation, terminal: TerminalStatus, summaryDigest: str, resultDigest: str }
type Entry = Vacant | Reserved(Reservation) | Applying(Dispatch) | Terminal(Receipt)
pure val initial: Entry = Vacant
pure def validReservation(held: Reservation): bool =
  held.ownerScope != "" and held.proposalId != "" and held.operationId != "" and
  held.operationHash != "" and held.recordDigest != ""
pure def sameReservation(entry: Entry, held: Reservation): bool = match entry {
  | Vacant => false
  | Reserved(saved) => { ownerScope: saved.ownerScope, proposalId: saved.proposalId, operationId: saved.operationId, operationHash: saved.operationHash, recordDigest: saved.recordDigest } == held
  | Applying(saved) => saved.reserved == held
  | Terminal(saved) => saved.reserved == held
}
pure def canReserve(entry: Entry, held: Reservation): bool =
  validReservation(held) and (entry == Vacant or sameReservation(entry, held))
pure def reserve(entry: Entry, held: Reservation): Entry =
  if (entry == Vacant) Reserved({ ownerScope: held.ownerScope, proposalId: held.proposalId, operationId: held.operationId, operationHash: held.operationHash, recordDigest: held.recordDigest }) else entry
pure def lawReservationReplayKeepsPhase(entry: Entry, held: Reservation): bool =
  sameReservation(entry, held) implies reserve(entry, held) == entry
```

### Only a reservation starts applying and a terminal receipt cannot change

A cancellation or recovery may finish a reserved entry, and the provider may finish an applying entry. Replaying the same receipt returns it. The shell commits the resulting entry before acknowledging and lists only redacted records in reservation order.

```quint
pure def canMarkApplying(entry: Entry, attemptId: str): bool =
  attemptId != "" and match entry { | Reserved(saved) => true | _ => false }
pure def markApplying(entry: Entry, attemptId: str): Entry = match entry {
  | Reserved(saved) => Applying({ reserved: { ownerScope: saved.ownerScope, proposalId: saved.proposalId, operationId: saved.operationId, operationHash: saved.operationHash, recordDigest: saved.recordDigest }, attemptId: attemptId })
  | _ => entry
}
pure def canFinish(entry: Entry, receipt: Receipt): bool = match entry {
  | Vacant => false
  | Reserved(saved) => { ownerScope: saved.ownerScope, proposalId: saved.proposalId, operationId: saved.operationId, operationHash: saved.operationHash, recordDigest: saved.recordDigest } == receipt.reserved and
      (receipt.terminal == JournalCancelled or receipt.terminal == JournalUnknown)
  | Applying(saved) => saved.reserved == receipt.reserved
  | Terminal(saved) => saved.reserved == receipt.reserved and saved.terminal == receipt.terminal and
      saved.summaryDigest == receipt.summaryDigest and saved.resultDigest == receipt.resultDigest
}
pure def finish(entry: Entry, receipt: Receipt): Entry =
  if (canFinish(entry, receipt)) Terminal({ reserved: receipt.reserved, terminal: receipt.terminal, summaryDigest: receipt.summaryDigest, resultDigest: receipt.resultDigest }) else entry
pure def stepTerminalReceiptStaysFinal(before: Entry, after: Entry): bool = match before {
  | Terminal(saved) => after == before
  | _ => true
}
pure def mayRead(entry: Entry, ownerScope: str, proposalId: str): bool = match entry {
  | Vacant => false
  | Reserved(saved) => saved.ownerScope == ownerScope and saved.proposalId == proposalId
  | Applying(saved) => saved.reserved.ownerScope == ownerScope and saved.reserved.proposalId == proposalId
  | Terminal(saved) => saved.reserved.ownerScope == ownerScope and saved.reserved.proposalId == proposalId
}
pure val heldValues = Set({ ownerScope: "owner", proposalId: "proposal", operationId: "op", operationHash: "hash", recordDigest: "record" })
pure val attemptIdValues = Set("attempt", "")
pure val receiptValues = Set({ reserved: { ownerScope: "owner", proposalId: "proposal", operationId: "op", operationHash: "hash", recordDigest: "record" }, terminal: JournalSucceeded, summaryDigest: "summary", resultDigest: "result" })
pure def sometimesJournalCommits(entry: Entry): bool = match entry { | Terminal(saved) => true | _ => false }
pure val entryValues = Set(Vacant,
  Reserved({ ownerScope: "owner", proposalId: "proposal", operationId: "op", operationHash: "hash", recordDigest: "record" }),
  Applying({ reserved: { ownerScope: "other-owner", proposalId: "proposal", operationId: "op", operationHash: "other-hash", recordDigest: "record" }, attemptId: "desktop" }))
```

# Native task evidence

The native host keeps an append-only store of task evidence
(`packages/agent/native-host/task-evidence-store.mjs`): what a task observed
and did, recorded per owner and storage epoch. Evidence records neither
authorize nor transition the task journal, which [tasks](../tasks/) own.

## Story: Keep a task's evidence exactly once, in order, for its owner

> As a device owner, each piece of evidence a task records is kept once,
> never lost to a rolled-back write and never written under a later owner's
> storage epoch.

### Evidence is appended in a transaction under the epoch that began it

An append stages one new record identity in a transaction under the current
epoch, and commits only while that epoch is unchanged; the epoch cannot
advance while a transaction is open. Committed evidence only grows, and the
log's length is the number of distinct records committed.

```quint
type EvidenceStore = { epoch: int, recorded: Set[int], length: int, transaction: bool, staged: int, captured: int, failed: bool, repeats: int }
pure val initial: EvidenceStore = { epoch: 0, recorded: Set(), length: 0, transaction: false, staged: 0, captured: -1, failed: false, repeats: 0 }
pure def canBeginEvidence(e: EvidenceStore, record: int): bool = not(e.transaction) and not(e.failed) and record > 0 and not(e.recorded.contains(record))
pure def beginEvidence(e: EvidenceStore, record: int): EvidenceStore = { ...e, transaction: true, staged: record, captured: e.epoch }
pure def canCommitEvidence(e: EvidenceStore): bool = e.transaction and e.captured == e.epoch
pure def commitEvidence(e: EvidenceStore): EvidenceStore =
  { ...e, transaction: false, recorded: e.recorded.union(Set(e.staged)), length: e.length + 1, staged: 0 }
pure def canAdvanceEpoch(e: EvidenceStore): bool = not(e.transaction)
pure def advanceEpoch(e: EvidenceStore): EvidenceStore = { ...e, epoch: e.epoch + 1 }
pure val recordValues = Set(0, 1, 2, 3)
pure def alwaysLogCountsDistinctRecords(e: EvidenceStore): bool =
  e.length == e.recorded.size() and (e.transaction implies (e.staged != 0 and e.captured == e.epoch and not(e.recorded.contains(e.staged))))
pure def stepEvidenceOnlyGrows(before: EvidenceStore, after: EvidenceStore): bool = before.recorded.subseteq(after.recorded) and after.length >= before.length
pure def sometimesEvidenceAcrossEpochs(e: EvidenceStore): bool = e.length > 1 and e.epoch > 0
```

### A repeated record changes nothing, and a rollback publishes nothing

Appending a record already committed is answered from the log without a new
entry. A rolled-back transaction leaves no record. If the rollback itself
fails, the connection is discarded and refuses further appends until it is
reopened.

```quint
pure def canRepeatEvidence(e: EvidenceStore, record: int): bool = e.recorded.contains(record)
pure def repeatEvidence(e: EvidenceStore, record: int): EvidenceStore = { ...e, repeats: e.repeats + 1 }
pure def canRollBackEvidence(e: EvidenceStore): bool = e.transaction
pure def rollBackEvidence(e: EvidenceStore, rollbackFailed: bool): EvidenceStore = { ...e, transaction: false, staged: 0, failed: rollbackFailed }
pure def canReopenEvidence(e: EvidenceStore): bool = e.failed
pure def reopenEvidence(e: EvidenceStore): EvidenceStore = { ...e, failed: false }
pure def stepRepeatAndRollbackAddNothing(before: EvidenceStore, via: str, after: EvidenceStore): bool =
  (via == "repeatEvidence" or via == "rollBackEvidence") implies (after.length == before.length and after.recorded.subseteq(before.recorded))
pure def alwaysDiscardedConnectionHoldsNoTransaction(e: EvidenceStore): bool = e.failed implies not(e.transaction)
pure def sometimesRepeatAnswered(e: EvidenceStore): bool = e.repeats > 0 and e.length == 1
pure def sometimesRollbackDiscardedConnection(e: EvidenceStore): bool = e.failed
```

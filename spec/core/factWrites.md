# Serialized fact evidence writes

The compatibility baseline is `elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`. Sources are `packages/core/src/runtime/fact-write-dedupe.ts`, `runtime/data-mutations.ts` and `quint/FactWriteDedupe.qnt`. This machine follows one natural fact key with multiple writer identities. Different keys have independent queues. Existing data must be read through its canonical deduplication key before this path updates it.

## Story: Merge every contribution once into its canonical fact

As an agent, I preserve all evidence when concurrent writes describe the same fact. Read, merge and insert-or-update execute under the key's serialization owner. A failed writer releases its lock and preserves earlier committed contributions.

### One writer owns the read and commit interval

```quint
type FactPhase = Idle | Reading | Writing
type FactWrites = { phase: FactPhase, owner: str, rowCount: int, stored: Set[str], snapshot: Set[str], receipts: Set[str] }
pure val initial: FactWrites = { phase: Idle, owner: "", rowCount: 0, stored: Set(), snapshot: Set(), receipts: Set() }
pure val writerValues = Set("writer1", "writer2", "writer3")
pure def canBegin(s: FactWrites, writer: str): bool = s.phase == Idle and writer != ""
pure def begin(s: FactWrites, writer: str): FactWrites = { ...s, phase: Reading, owner: writer }
pure def canReadExisting(s: FactWrites): bool = s.phase == Reading
pure def readExisting(s: FactWrites): FactWrites = { ...s, phase: Writing, snapshot: s.stored }
pure def canCommit(s: FactWrites): bool = s.phase == Writing and s.owner != ""
pure def commit(s: FactWrites): FactWrites = { ...s, phase: Idle, stored: s.snapshot.union(Set(s.owner)), receipts: s.receipts.union(Set(s.owner)), rowCount: 1, owner: "" }
pure def canWriteFailed(s: FactWrites): bool = s.phase != Idle
pure def writeFailed(s: FactWrites): FactWrites = { ...s, phase: Idle, owner: "" }
pure def alwaysWriteSnapshotMatchesStored(s: FactWrites): bool = s.phase != Writing or (s.snapshot.subseteq(s.stored) and s.stored.subseteq(s.snapshot))
pure def alwaysOneCanonicalRow(s: FactWrites): bool = s.rowCount >= 0 and s.rowCount <= 1
pure def alwaysCommittedEvidenceRemains(s: FactWrites): bool = s.receipts.subseteq(s.stored)
pure def alwaysOwnerCoversWrite(s: FactWrites): bool = (s.phase == Idle) == (s.owner == "")
pure def stepCommittedEvidenceNeverDisappears(before: FactWrites, after: FactWrites): bool = before.stored.subseteq(after.stored)
pure def sometimesMergedWriters(s: FactWrites): bool = s.receipts.contains("writer1") and s.receipts.contains("writer2")
pure val fair_readExisting = "weak"
pure val fair_commit = "weak"
pure def leadsToWriterReturns(s: FactWrites, later: FactWrites): bool = s.phase != Idle implies later.phase == Idle
```

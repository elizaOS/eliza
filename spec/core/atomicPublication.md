# Atomic JSON publication

This model migrates `quint/AtomicJsonPublication.qnt` and `utils/atomic-json.ts`. It describes one publication attempt. The shared serialization model orders same-process asynchronous calls. Independent processes can replace complete snapshots in either order.

## Story: Publish complete durable JSON with an honest receipt

As a store owner, I want readers to see a complete old or new file and callers to receive the publication outcome.

### The final path changes only after a complete temporary file is renamed

Create an exclusive sibling temporary file, write the complete body, rename it to publish, and remove remaining temporary data during cleanup. Failed cleanup preserves the write outcome. A process crash can leave temporary data or published data with an unknown caller outcome. A subsequent write remains possible after failure.

```quint
type PublicationPhase = Queued | Writing | Renaming | Cleanup | Settled | Crashed
type PublicationReceipt = PendingReceipt | SuccessReceipt | FailureReceipt | UnknownReceipt
type TemporaryContents = NoTemporary | PartialTemporary | CompleteTemporary
type Publication = { phase: PublicationPhase, temporary: TemporaryContents, published: bool, receipt: PublicationReceipt, writeSucceeded: bool }
pure val initial: Publication = { phase: Queued, temporary: NoTemporary, published: false, receipt: PendingReceipt, writeSucceeded: false }
pure def canCreate(p: Publication): bool = p.phase == Queued
pure def create(p: Publication, ok: bool): Publication = { ...p, phase: if (ok) Writing else Cleanup, temporary: if (ok) PartialTemporary else NoTemporary }
pure def canWrite(p: Publication): bool = p.phase == Writing
pure def write(p: Publication, ok: bool): Publication = { ...p, phase: if (ok) Renaming else Cleanup, temporary: if (ok) CompleteTemporary else PartialTemporary }
pure def canRename(p: Publication): bool = p.phase == Renaming and p.temporary == CompleteTemporary
pure def rename(p: Publication, ok: bool): Publication = { ...p, phase: Cleanup, published: ok, writeSucceeded: ok, temporary: if (ok) NoTemporary else CompleteTemporary }
pure def canCleanup(p: Publication): bool = p.phase == Cleanup
pure def cleanup(p: Publication, removed: bool): Publication = { ...p, phase: Settled, temporary: if (removed) NoTemporary else p.temporary, receipt: if (p.writeSucceeded) SuccessReceipt else FailureReceipt }
pure def canCrash(p: Publication): bool = p.phase == Writing or p.phase == Renaming or p.phase == Cleanup
pure def crash(p: Publication): Publication = { ...p, phase: Crashed, receipt: UnknownReceipt }
pure def alwaysSuccessMeansPublished(p: Publication): bool = (p.receipt == SuccessReceipt implies p.published) and (p.receipt == FailureReceipt implies not(p.published))
pure def alwaysUnknownMeansCrashed(p: Publication): bool = p.receipt == UnknownReceipt implies p.phase == Crashed
pure def alwaysPublicationMatchesWrite(p: Publication): bool = p.published == p.writeSucceeded
pure def stepPublicationSurvivesCleanup(before: Publication, after: Publication): bool = before.published implies after.published
pure def sometimesPublicationSucceeds(p: Publication): bool = p.receipt == SuccessReceipt
pure def sometimesPublicationFails(p: Publication): bool = p.receipt == FailureReceipt
pure def sometimesPublishedOutcomeUnknown(p: Publication): bool = p.phase == Crashed and p.published and p.receipt == UnknownReceipt
```

### Publication attempts settle when their pending I/O settles

The environment eventually completes each admitted create, write, rename and cleanup operation. A crash is already a terminal unknown receipt. This preserves the original conditional progress property.

```quint
pure val fair_create = "weak"
pure val fair_write = "weak"
pure val fair_rename = "weak"
pure val fair_cleanup = "weak"
pure def leadsToPublicationSettled(p: Publication, later: Publication): bool = later.phase == Settled or later.phase == Crashed
```

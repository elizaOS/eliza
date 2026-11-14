# Stream revision allocation

Source `utils/streaming.ts` allocates a process-local revision when an extractor is constructed or reset. All extractor instances share this sequence.

## Story: Distinguish a new stream attempt from prior chunks

As a chunk consumer, I want reset attempts to carry the allocator's new revision.

### Allocation increments and wraps the maximum safe integer to one

The initial allocator value is zero and every emitted revision is positive. Revisions wrap at the exact source maximum. Consumers therefore compare revisions within their active attempt and retain the source's bounded wrap behavior.

```quint
type StreamRevision = { revision: int }
pure val initial: StreamRevision = { revision: 0 }
pure def allocate(r: StreamRevision): StreamRevision = { revision: if (r.revision == 9007199254740991) 1 else r.revision + 1 }
pure def alwaysRevisionFitsSafeInteger(r: StreamRevision): bool = r.revision >= 0 and r.revision <= 9007199254740991
pure def stepAllocatedRevisionPositive(before: StreamRevision, after: StreamRevision): bool = after.revision > 0
pure def sometimesAllocated(r: StreamRevision): bool = r.revision > 0
```

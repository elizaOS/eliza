# Stream revision allocation

Source `utils/streaming.ts` allocates a process-local revision when an extractor is constructed or reset. All extractor instances share this sequence.

## Story: Distinguish a new stream attempt from prior chunks

> As a chunk consumer, I want each reset attempt to carry a new revision, so
> that I can discard chunks from an earlier attempt.

### Allocation increments and wraps the maximum safe integer to one

The initial allocator value is zero and every emitted revision is positive. Revisions wrap at the exact source maximum. Consumers therefore compare revisions within their active attempt and retain the source's bounded wrap behavior.

```quint
import numbers as Num from "./numbers"
type StreamRevision = { revision: int }
pure val initial: StreamRevision = { revision: 0 }
pure def allocate(r: StreamRevision): StreamRevision = { revision: if (r.revision == Num::maxSafeInteger) 1 else r.revision + 1 }
pure def alwaysRevisionFitsSafeInteger(r: StreamRevision): bool = r.revision >= 0 and r.revision <= Num::maxSafeInteger
pure def stepAllocatedRevisionPositive(before: StreamRevision, after: StreamRevision): bool = after.revision > 0
pure def sometimesAllocated(r: StreamRevision): bool = r.revision > 0
```

# Calendar

The calendar package reads, links and changes the owner's calendars. A
consumer's agent reads only what the owner reviewed, writes only the
exact event or series scope the owner chose, and keeps a resident
calendar in step with a linked provider calendar without overwriting an
independent edit. Provider access for managed accounts is the Cloud's
[managed Google](../cloud/services/google/connection.md) connection.

| Area | Specifications |
| --- | --- |
| Reading | [Reviewed reads](./reviewedReads.md), [availability](./availability.md), [read clock](./readClock.md), [occurrence grouping](./aggregateMerge.md) |
| Changing | [Event and series scope](./seriesScope.md), [mutation ledger](./mutationLedger.md) |
| Linked sync | [Sync control](./linkedSync.md), [reconciliation](./linkedReconcile.md), [sync settlement](./syncSettlement.md), [managed feed](./managedFeed.md) |

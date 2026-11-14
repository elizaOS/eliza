# Complete source-row collection

The compatibility baseline is `elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`. Sources are the memory source sweep path and `quint/MemorySourceSweep.qnt`. Ordinary memory lists can hide immutable source segments. A sweep must enumerate source rows separately, including orphan segments, before deciding which media is referenced or which rows a wipe removes.

## Story: Include hidden source rows in collection and wipes

As an operator, I preserve media referenced by source-only rows during collection and remove source rows during an explicit complete wipe. A partial ordinary-memory scan cannot authorize either operation.

### A sweep captures the complete ordinary and source-row input sets

```quint
type SourceRow = { id: str, mediaRef: str }
type SweepPhase = Empty | Ordinary | Sources | Classified | Wiped
type Sweep = { phase: SweepPhase, ordinaryRows: Set[str], sourceRows: List[SourceRow], collectedIds: Set[str], collectedMedia: Set[str], retainedIds: Set[str] }
pure val initial: Sweep = { phase: Empty, ordinaryRows: Set(), sourceRows: List(), collectedIds: Set(), collectedMedia: Set(), retainedIds: Set() }
pure val ordinaryRowsValues = Set(Set(), Set("memory1"))
pure val sourceRowsValues = Set(List(), List({ id: "source1", mediaRef: "media1" }, { id: "orphan", mediaRef: "media2" }))
pure def canLoad(s: Sweep, ordinaryRows: Set[str], sourceRows: List[SourceRow]): bool = s.phase == Empty
pure def load(s: Sweep, ordinaryRows: Set[str], sourceRows: List[SourceRow]): Sweep = { ...s, ordinaryRows: ordinaryRows, sourceRows: sourceRows, retainedIds: sourceRows.foldl(ordinaryRows, (ids, row) => ids.union(Set(row.id))), phase: Ordinary }
pure def canCollectOrdinary(s: Sweep): bool = s.phase == Ordinary
pure def collectOrdinary(s: Sweep): Sweep = { ...s, collectedIds: s.ordinaryRows, phase: Sources }
pure def canCollectSources(s: Sweep): bool = s.phase == Sources
pure def collectSources(s: Sweep): Sweep = { ...s, collectedIds: s.sourceRows.foldl(s.collectedIds, (ids, row) => ids.union(Set(row.id))), collectedMedia: s.sourceRows.foldl(Set(), (refs, row) => if (row.mediaRef == "") refs else refs.union(Set(row.mediaRef))), phase: Classified }
```

### Only complete source collection permits a wipe

The media reference set is retained after the wipe so media cleanup can apply its own retention policy with complete evidence. No source row is silently left behind.

```quint
pure def canWipe(s: Sweep): bool = s.phase == Classified
pure def wipe(s: Sweep): Sweep = { ...s, retainedIds: s.retainedIds.exclude(s.collectedIds), phase: Wiped }
pure def allInputIds(s: Sweep): Set[str] = s.sourceRows.foldl(s.ordinaryRows, (ids, row) => ids.union(Set(row.id)))
pure def alwaysRetainedRowsComeFromInput(s: Sweep): bool = s.retainedIds.subseteq(allInputIds(s))
pure def alwaysClassifiedIdsCoverInput(s: Sweep): bool = (s.phase == Classified or s.phase == Wiped) implies allInputIds(s).subseteq(s.collectedIds)
pure def alwaysSourceCollectionComplete(s: Sweep): bool = (s.phase == Classified or s.phase == Wiped) implies s.sourceRows.every(row => s.collectedIds.contains(row.id))
pure def alwaysSourceMediaRetained(s: Sweep): bool = (s.phase == Classified or s.phase == Wiped) implies s.sourceRows.every(row => row.mediaRef == "" or s.collectedMedia.contains(row.mediaRef))
pure def alwaysWipeRemovesEveryRow(s: Sweep): bool = s.phase == Wiped implies s.retainedIds.size() == 0
pure def sometimesOrphanSourceRemoved(s: Sweep): bool = s.phase == Wiped and s.collectedIds.contains("orphan")
pure val fair_collectOrdinary = "weak"
pure val fair_collectSources = "weak"
pure val fair_wipe = "weak"
pure def leadsToSweepFinishes(s: Sweep, later: Sweep): bool = s.phase != Empty implies later.phase == Wiped
```

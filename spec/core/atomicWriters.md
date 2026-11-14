# Independent atomic writers

This composes [atomic publication](./atomicPublication.md) for multiple writers targeting the same resolved final file. A writer owns its exclusive temporary file. A nonempty process key serializes that process's asynchronous writers in invocation order. An empty key denotes a synchronous or otherwise independent writer; it does not share a tail.

## Story: Publish whole snapshots despite interleaved processes

As a reader, I want the final file to contain a complete successfully renamed writer body while independent cleanup and crashes proceed.

### The latest successful rename owns the whole final snapshot

A failed rename leaves the previous snapshot. Cleanup and crashes affect the addressed writer's temporary state and receipt. They cannot change another writer or undo a published rename. Publication can outlive an unknown caller receipt. Same-process asynchronous writers cannot create their temporary files until earlier callbacks settle, including rejection. The independent crash case follows the legacy model; whole-process recovery of a shared async queue is an external restart boundary.

```quint
import atomicPublication as P from "./atomicPublication"
type Writer = { publication: P::Publication, body: str, processKey: str, ordinal: int }
type AtomicWriters = { ids: Set[str], orderedIds: List[str], writers: str -> Writer, winner: str, body: str, addressed: str }
pure val emptyWriter: Writer = { publication: P::initial, body: "", processKey: "", ordinal: -1 }
pure val initial: AtomicWriters = { ids: Set(), orderedIds: List(), writers: Map(), winner: "", body: "", addressed: "" }
pure def writerAt(a: AtomicWriters, id: str): Writer = if (a.ids.contains(id)) a.writers.getOr(id, emptyWriter) else emptyWriter
pure def settledWriter(w: Writer): bool = w.publication.phase == P::Settled or w.publication.phase == P::Crashed
pure def canRegisterWriter(a: AtomicWriters, id: str): bool = id != "" and not(a.ids.contains(id))
pure def registerWriter(a: AtomicWriters, id: str, body: str, processKey: str): AtomicWriters = { ...a, ids: a.ids.union(Set(id)), orderedIds: a.orderedIds.append(id), writers: a.writers.put(id, { publication: P::initial, body: body, processKey: processKey, ordinal: a.orderedIds.length() }), addressed: id }
pure def earlierWritersSettled(a: AtomicWriters, id: str): bool = {
  val w = writerAt(a, id)
  w.processKey == "" or a.ids.forall(priorId => writerAt(a, priorId).processKey != w.processKey or writerAt(a, priorId).ordinal >= w.ordinal or settledWriter(writerAt(a, priorId)))
}
pure def canCreateWriter(a: AtomicWriters, id: str): bool = a.ids.contains(id) and P::canCreate(writerAt(a, id).publication) and earlierWritersSettled(a, id)
pure def createWriter(a: AtomicWriters, id: str, ok: bool): AtomicWriters = { ...a, writers: a.writers.put(id, { ...writerAt(a, id), publication: P::create(writerAt(a, id).publication, ok) }), addressed: id }
pure def canWriteWriter(a: AtomicWriters, id: str): bool = a.ids.contains(id) and P::canWrite(writerAt(a, id).publication)
pure def writeWriter(a: AtomicWriters, id: str, ok: bool): AtomicWriters = { ...a, writers: a.writers.put(id, { ...writerAt(a, id), publication: P::write(writerAt(a, id).publication, ok) }), addressed: id }
pure def canRenameWriter(a: AtomicWriters, id: str): bool = a.ids.contains(id) and P::canRename(writerAt(a, id).publication)
pure def renameWriter(a: AtomicWriters, id: str, ok: bool): AtomicWriters = { ...a, writers: a.writers.put(id, { ...writerAt(a, id), publication: P::rename(writerAt(a, id).publication, ok) }), winner: if (ok) id else a.winner, body: if (ok) writerAt(a, id).body else a.body, addressed: id }
pure def canCleanupWriter(a: AtomicWriters, id: str): bool = a.ids.contains(id) and P::canCleanup(writerAt(a, id).publication)
pure def cleanupWriter(a: AtomicWriters, id: str, removed: bool): AtomicWriters = { ...a, writers: a.writers.put(id, { ...writerAt(a, id), publication: P::cleanup(writerAt(a, id).publication, removed) }), addressed: id }
pure def canCrashWriter(a: AtomicWriters, id: str): bool = a.ids.contains(id) and writerAt(a, id).processKey == "" and P::canCrash(writerAt(a, id).publication)
pure def crashWriter(a: AtomicWriters, id: str): AtomicWriters = { ...a, writers: a.writers.put(id, { ...writerAt(a, id), publication: P::crash(writerAt(a, id).publication) }), addressed: id }
pure def alwaysWriterReceipt(a: AtomicWriters): bool = a.ids.forall(id => P::alwaysSuccessMeansPublished(writerAt(a, id).publication) and P::alwaysUnknownMeansCrashed(writerAt(a, id).publication) and P::alwaysPublicationMatchesWrite(writerAt(a, id).publication))
pure def alwaysWinnerPublishedWholeBody(a: AtomicWriters): bool = a.winner == "" or (a.ids.contains(a.winner) and writerAt(a, a.winner).publication.published and a.body == writerAt(a, a.winner).body)
pure def stepOtherWritersStayUnchanged(before: AtomicWriters, after: AtomicWriters): bool = before.ids.forall(id => id == after.addressed or writerAt(before, id) == writerAt(after, id))
pure def stepSnapshotOnlyChangesByRename(before: AtomicWriters, after: AtomicWriters): bool = (before.winner != after.winner or before.body != after.body) implies after.winner != "" and writerAt(before, after.winner).publication.phase == P::Renaming and writerAt(after, after.winner).publication.published
pure def alwaysOrderedWritersOwnEarlierSettlements(a: AtomicWriters): bool = a.ids.forall(id => writerAt(a, id).publication.phase != P::Queued implies earlierWritersSettled(a, id))
pure def sometimesTwoWriters(a: AtomicWriters): bool = a.ids.size() > 1
pure def sometimesPublishedWriterCrashed(a: AtomicWriters): bool = a.winner != "" and writerAt(a, a.winner).publication.phase == P::Crashed
```

### Conditional progress settles every admitted writer, including queued successors

The oldest unfinished invocation leaves the queue when its create, write,
rename and cleanup operations settle. Fair progress selects that actual
identity from state; it does not assume any I/O success or block independent
writers from advancing in another order.

```quint
pure def nextWriterId(a: AtomicWriters): str = a.orderedIds.select(id => not(settledWriter(writerAt(a, id)))).nthOr(0, "")
pure def canAdvanceWriter(a: AtomicWriters): bool = {
  val id = nextWriterId(a)
  canCreateWriter(a, id) or canWriteWriter(a, id) or canRenameWriter(a, id) or canCleanupWriter(a, id)
}
pure def advanceWriter(a: AtomicWriters, ok: bool): AtomicWriters = {
  val id = nextWriterId(a)
  if (canCreateWriter(a, id)) createWriter(a, id, ok) else if (canWriteWriter(a, id)) writeWriter(a, id, ok) else if (canRenameWriter(a, id)) renameWriter(a, id, ok) else cleanupWriter(a, id, ok)
}
pure val processKeyValues = Set("", "process1")
pure val fair_advanceWriter = "weak"
pure def leadsToAdmittedWritersSettle(a: AtomicWriters, later: AtomicWriters): bool = a.ids.forall(id => settledWriter(writerAt(later, id)))
```

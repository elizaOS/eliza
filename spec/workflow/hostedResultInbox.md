# Device hosted digest inbox reconciliation

The device's native host keeps a hosted digest inbox. `syncInbox` and
`inboxHistory` resolve the active session for its hosted delivery. Foreground
sync and the background delivery worker share one application-lifetime inbox
coordinator. The coordinator has a single-flight lock and a shorter commit
gate; network calls never hold the commit gate. The two routes are the
workflow package's digest result and digest acknowledgement routes,
implemented by `digestResults` and `acknowledgeDigest` in its embedded
workflow service. [Hosted digest](./hostedDigest.md) owns common offers and
browser inbox state. [Result notices](../os/android/hostedResultNotices.md)
own OS delivery and taps. This specification owns native receipt
reconciliation and the checkpoint for sending an ACK. Its state represents
one exact owner/agent/origin scope with a captured session generation.
Effect ports report reads, writes, notice settlement, and the result of
provider I/O under that binding.

## Story: Keep a terminal digest result when the provisional cancellation returns again

> As the person, I want a digest that finished to stay finished when an earlier
> cancellation of it arrives again.

### Reconciliation preserves equivalent bytes and replaces only the matching cancellation

The decoder projects cursor, run, workflow, workflow version, template
version, scheduled time, source, status, started time, completed time,
output and error. Missing or non-string error becomes JSON null. A row
is at most 200,000 UTF-16 units as passed to the Java parser. Its cursor
must be an integral value between 1 and 9,007,199,254,740,991 inclusive.
Run, workflow, workflow version and template version use 1–128 characters,
starting with an ASCII alphanumeric and followed by ASCII alphanumerics,
underscores or hyphens. The three time fields parse as `Instant`, source
is an object, and output is required. Android consumes the projected status
as a string. Complete equality ignores JSON object key order, preserves
array order and compares numbers by value. Replay preserves the old raw
bytes even when a legacy raw row contains an extra field.

For a saved cancellation and a greater cursor with a different status,
require identical run, workflow, workflow version, template version,
scheduled time and structurally equal source. The terminal replaces the
stored row and arms notice processing for that run. The reverse delivery
keeps the terminal and ACKs the incoming page cursor. A second different
cancellation, an altered identity or any other divergent row fails the
page. The agent's server replaces only an exact durable cancelled execution
with a finished failed execution. It removes the old result and writes the
new result in the same transaction. The per-agent/owner advisory lock
orders sequence allocation with commit. For the mobile client the
source's non-cancelled status rule also governs other valid result strings.

```quint
type DigestStatus = DigestCancelled | DigestFailed | DigestOther
type DigestReconciliation = StoreNew | KeepEquivalent | KeepTerminal | ReplaceCancelled | RefuseConflict
type ReconciliationEvidence = { exists: bool, exactValue: bool, exactProvenance: bool, savedStatus: DigestStatus, incomingStatus: DigestStatus, savedCursor: int, incomingCursor: int }
pure def reconcileDigest(facts: ReconciliationEvidence): DigestReconciliation =
  if (not(facts.exists)) StoreNew
  else if (facts.exactValue) KeepEquivalent
  else if (not(facts.exactProvenance)) RefuseConflict
  else if (facts.savedStatus == DigestCancelled and facts.incomingStatus != DigestCancelled and facts.incomingCursor > facts.savedCursor) ReplaceCancelled
  else if (facts.incomingStatus == DigestCancelled and facts.savedStatus != DigestCancelled and facts.savedCursor > facts.incomingCursor) KeepTerminal
  else RefuseConflict
pure def serverReconciles(savedStatus: DigestStatus, incomingStatus: DigestStatus, bothFinished: bool, sameDurableSnapshot: bool): bool =
  savedStatus == DigestCancelled and incomingStatus == DigestFailed and bothFinished and sameDurableSnapshot
pure val cancellationReplacement: ReconciliationEvidence = { exists: true, exactValue: false, exactProvenance: true, savedStatus: DigestCancelled, incomingStatus: DigestFailed, savedCursor: 1, incomingCursor: 3 }
pure val factsValues = Set(cancellationReplacement, { ...cancellationReplacement, exactProvenance: false },
  { ...cancellationReplacement, incomingCursor: 1 }, { ...cancellationReplacement, exactValue: true },
  { ...cancellationReplacement, savedStatus: DigestFailed, incomingStatus: DigestCancelled, savedCursor: 3, incomingCursor: 1 })
pure def lawChangedProvenanceCannotReplace(facts: ReconciliationEvidence): bool =
  not(facts.exactProvenance) implies reconcileDigest(facts) != ReplaceCancelled and reconcileDigest(facts) != KeepTerminal
pure def lawNewerTerminalIsNeverOverwrittenByCancellation(facts: ReconciliationEvidence): bool =
  (facts.exists and not(facts.exactValue) and facts.savedStatus != DigestCancelled and facts.incomingStatus == DigestCancelled) implies
    reconcileDigest(facts) != ReplaceCancelled and reconcileDigest(facts) != StoreNew
```

## Story: Acknowledge a complete page after its native retention journal commits

> As the person, I want the device to tell the server it has a page of digests
> only after that page is safely stored.

### Parse the complete page before durable writes and bind its acknowledgement to its final incoming row

The sync reads `hosted-digests:v1:<scope>` and its per-run rows under the
current generation. The stored index has an exact client ID, an ordered
unique `ids` array and optional unique `pendingRemoval` and `pendingNotices`
arrays, at most 200 elements each at decoding. A missing index gets a new
UUID client. Missing, malformed or differently identified retained rows
fail history read. Before HTTP, recover the removal journal and retry
pending notices. A scope gets at most two GETs per invocation. An empty
page ends it, and more than 50 results or non-increasing cursors fail
before any result rows are written. The page scan validates each row
before work and records the final incoming run and cursor. Existing
browser snapshots are a different storage owner.

```quint
type DigestPageRow = { digestRun: str, cursor: int, wireValid: bool }
type DigestPageScan = { ordered: bool, count: int, lastRun: str, lastCursor: int }
pure val emptyDigestScan: DigestPageScan = { ordered: true, count: 0, lastRun: "", lastCursor: 0 }
pure def scanDigestRow(scan: DigestPageScan, row: DigestPageRow): DigestPageScan = {
  ordered: scan.ordered and row.wireValid and row.digestRun != "" and row.cursor > scan.lastCursor and row.cursor <= 9007199254740991,
  count: scan.count + 1, lastRun: row.digestRun, lastCursor: row.cursor
}
pure def scanDigestPage(entries: List[DigestPageRow]): DigestPageScan = entries.foldl(emptyDigestScan, scanDigestRow)
pure def usableDigestPage(scan: DigestPageScan): bool =
  scan.ordered and scan.count > 0 and scan.count <= 50 and scan.lastRun != "" and scan.lastCursor >= 1 and scan.lastCursor <= 9007199254740991
pure val firstDigestRow: DigestPageRow = { digestRun: "run-one", cursor: 1, wireValid: true }
pure val secondDigestRow: DigestPageRow = { digestRun: "run-two", cursor: 2, wireValid: true }
pure val entriesValues = Set(List(), List(firstDigestRow), List(firstDigestRow, secondDigestRow), List(secondDigestRow, firstDigestRow), List({ ...firstDigestRow, wireValid: false }))
pure val scanValues = Set(emptyDigestScan, scanDigestPage(List(firstDigestRow)), scanDigestPage(List(firstDigestRow, secondDigestRow)),
  { ...emptyDigestScan, count: 51, lastRun: "run-one", lastCursor: 51 })
pure def lawAdmittedPageHasBoundedTail(scan: DigestPageScan): bool = usableDigestPage(scan) implies
  scan.count <= 50 and scan.lastRun != "" and scan.lastCursor >= 1 and scan.lastCursor <= 9007199254740991
```

### Writes may leave unindexed bytes, and eviction journals precede deletion

Process the page rows in order. Missing rows write their projected JSON.
Equivalent and reverse-cancellation deliveries preserve prior bytes.
Replacement writes occur before the index write. A storage fault, changed
entry, or failed index write can leave a prefix of physical row writes,
including a replacement of a row already listed. No successful index or
ACK follows that fault in the current invocation. `observeRows` records
how many rows the port finished in source order. A compatibility
rejection leaves the remaining rows unprocessed. The pending notices,
retained IDs and pending removal are written together in one index write.
The planner consumes the complete existing index and the ordered row
decisions. It appends
new IDs once in incoming order, arms notice IDs for adds and replacements,
evicts the oldest from the head until at most 100 remain, intersects the
notice list with retained IDs, and journals every evicted ID. A retained
row already listed is not reinserted at the end. Even the page's final
incoming row can be evicted. Retention therefore accepts either durable
history membership or a durable journal for that exact row before ACK.
The observed index must match this plan on disk before dispatch.

```quint
type DigestPhase = ReadyToPoll | FetchingPage | WritingRows | WritingIndex | SettlingNotices | ReadyToAck | AwaitingAck | RecoveringRemoval | PollFinished | PollFailed
type NativeDigestInbox = { phase: DigestPhase, client: str, generation: int, retired: bool, pages: int, incoming: DigestPageScan,
  rowsFinished: int, indexed: bool, acceptedCursor: int, pendingRemoval: Set[str] }
pure val initial: NativeDigestInbox = { phase: ReadyToPoll, client: "", generation: 0, retired: false, pages: 0,
  incoming: emptyDigestScan, rowsFinished: 0, indexed: false, acceptedCursor: 0, pendingRemoval: Set() }
pure def canBeginDigestPoll(i: NativeDigestInbox, generation: int, client: str): bool =
  (i.phase == ReadyToPoll or i.phase == PollFailed or i.phase == PollFinished) and generation > 0 and generation >= i.generation and
    client != "" and (i.client == "" or i.client == client)
pure def beginDigestPoll(i: NativeDigestInbox, generation: int, client: str, recoveredAtStart: bool): NativeDigestInbox =
  if (recoveredAtStart) { ...i, phase: FetchingPage, client: client, generation: generation, retired: false, pages: 1,
    incoming: emptyDigestScan, rowsFinished: 0, indexed: false, pendingRemoval: Set() }
  else { ...i, phase: PollFailed }
pure val generationValues = Set(1, 2)
pure val clientValues = Set("digest-client", "other-client", "")
pure def canReceiveDigestPage(i: NativeDigestInbox): bool = i.phase == FetchingPage and not(i.retired)
pure def receiveDigestPage(i: NativeDigestInbox, entries: List[DigestPageRow], validEnvelope: bool): NativeDigestInbox = {
  val scan = scanDigestPage(entries)
  if (not(validEnvelope)) { ...i, phase: PollFailed }
  else if (scan.count == 0) { ...i, phase: PollFinished }
  else if (usableDigestPage(scan)) { ...i, phase: WritingRows, incoming: scan }
  else { ...i, phase: PollFailed }
}
pure def canObserveRows(i: NativeDigestInbox, durablePrefix: int): bool =
  i.phase == WritingRows and not(i.retired) and durablePrefix >= 0 and durablePrefix <= i.incoming.count
pure def observeRows(i: NativeDigestInbox, durablePrefix: int): NativeDigestInbox =
  { ...i, rowsFinished: durablePrefix, phase: if (durablePrefix == i.incoming.count) WritingIndex else PollFailed }
pure val durablePrefixValues = Set(0, 1, 2, 50)
type DigestIndex = { retained: List[str], noticeDue: List[str], removalDue: List[str] }
type SavedDigestRow = { digestRun: str, replaced: bool }
pure def appendDigestIdentity(ids: List[str], digestRun: str): List[str] = if (ids.includes(digestRun)) ids else ids.append(digestRun)
pure def noteSavedDigestRow(prior: DigestIndex, saved: SavedDigestRow): DigestIndex = {
  ...prior, retained: appendDigestIdentity(prior.retained, saved.digestRun),
  noticeDue: if (saved.replaced or not(prior.retained.includes(saved.digestRun))) appendDigestIdentity(prior.noticeDue, saved.digestRun) else prior.noticeDue
}
type DigestEviction = { excess: int, retainedAfter: List[str], journalAfter: List[str] }
pure def evictExcessDigestRow(walk: DigestEviction, digestRun: str): DigestEviction =
  if (walk.excess > 0) { ...walk, excess: walk.excess - 1, journalAfter: appendDigestIdentity(walk.journalAfter, digestRun) }
  else { ...walk, retainedAfter: walk.retainedAfter.append(digestRun) }
pure def planDigestIndex(prior: DigestIndex, savedRows: List[SavedDigestRow]): DigestIndex = {
  val merged = savedRows.foldl(prior, noteSavedDigestRow)
  val capped = merged.retained.foldl({ excess: merged.retained.length() - 100, retainedAfter: List(), journalAfter: merged.removalDue }, evictExcessDigestRow)
  { retained: capped.retainedAfter, removalDue: capped.journalAfter, noticeDue: merged.noticeDue.select(digestRun => capped.retainedAfter.includes(digestRun)) }
}
pure val initialDigestIndex: DigestIndex = { retained: List(), noticeDue: List(), removalDue: List() }
pure val priorValues = Set({ ...initialDigestIndex, retained: List("run-one") }, initialDigestIndex)
pure val savedRowsValues = Set(List(), List({ digestRun: "run-one", replaced: true }, { digestRun: "run-two", replaced: false }))
type IndexEvidence = { stored: bool, exactPlan: bool, retainedCount: int, tailRetained: bool, evictedRuns: Set[str] }
pure def exactIndexCommit(scan: DigestPageScan, indexCommit: IndexEvidence): bool = indexCommit.stored and indexCommit.exactPlan and
  indexCommit.retainedCount >= 1 and indexCommit.retainedCount <= 100 and
  indexCommit.tailRetained != indexCommit.evictedRuns.contains(scan.lastRun)
pure def canCommitDigestIndex(i: NativeDigestInbox): bool = i.phase == WritingIndex and not(i.retired)
pure def commitDigestIndex(i: NativeDigestInbox, indexCommit: IndexEvidence): NativeDigestInbox =
  if (exactIndexCommit(i.incoming, indexCommit)) { ...i, phase: SettlingNotices, indexed: true, pendingRemoval: indexCommit.evictedRuns }
  else { ...i, phase: PollFailed }
pure val indexCommitValues = Set({ stored: true, exactPlan: true, retainedCount: 2, tailRetained: true, evictedRuns: Set() },
  { stored: true, exactPlan: true, retainedCount: 100, tailRetained: false, evictedRuns: Set("run-one", "run-two") },
  { stored: false, exactPlan: false, retainedCount: 2, tailRetained: true, evictedRuns: Set() })
pure def lawIndexCommitIncludesExactTail(scan: DigestPageScan, indexCommit: IndexEvidence): bool =
  exactIndexCommit(scan, indexCommit) implies indexCommit.tailRetained or indexCommit.evictedRuns.contains(scan.lastRun)
```

### Notice retry and an uncertain ACK preserve the committed journal

Notice publish may throw. A current fence leaves its pending entry for
retry and proceeds. A successful publish clears one pending entry in the
index. A failure to write that clear aborts this sync before ACK even if
Android posted already. `noticesCanProceed` represents those completed
checks, including a permitted deferred notice. The ACK uses the exact
client ID of the committed index and the run and cursor of the final
incoming row. It never substitutes the newer locally stored cursor when
acknowledging a superseded cancellation. The provider accepts only an
existing row of that tenant, owner, run and cursor. It advances the exact
client's cursor to the maximum of old and accepted. A replacement can
remove an old result between GET and ACK, causing the old ACK to fail.
Native requires a successful response but does not parse or use the
returned `acknowledged` value or the GET's `acknowledged` field as a
local checkpoint. An ACK accepted by the provider may lose its reply.
A retired generation blocks late local writes and a new ACK. A request
already dispatched can retain its remote receipt even after retirement.
Following a successful reply, remove only journaled IDs no longer retained
and clear the journal with a durable index write. If a remove or that
write fails, retry from the persisted journal before another GET. An
interrupted attempt can leave some bodies absent while the journal still
lists them. Recovery removal is idempotent. Notice publication and payload
privacy remain separate from inbox acceptance.
Discovered by the proof: an unindexed page cannot inherit another page's
pending-removal journal. Recovery clears the persisted journal before a
new GET and any still-pending journal identifies an indexed page. Fetching
or writing rows starts a new page with no index receipt. Admitting the
completed page and entering its index write both preserve that fact.

```quint
pure def canSettleDigestNotices(i: NativeDigestInbox): bool = i.phase == SettlingNotices and not(i.retired)
pure def settleDigestNotices(i: NativeDigestInbox, noticesCanProceed: bool): NativeDigestInbox =
  { ...i, phase: if (noticesCanProceed) ReadyToAck else PollFailed }
pure def canDispatchDigestAck(i: NativeDigestInbox): bool = i.phase == ReadyToAck and not(i.retired)
pure def dispatchDigestAck(i: NativeDigestInbox): NativeDigestInbox = { ...i, phase: AwaitingAck }
pure def providerDigestCursor(previousCursor: int, receivedCursor: int, exactProviderRow: bool): int =
  if (exactProviderRow and receivedCursor >= 1 and receivedCursor <= 9007199254740991 and receivedCursor > previousCursor) receivedCursor else previousCursor
pure def canObserveDigestAck(i: NativeDigestInbox): bool = i.phase == AwaitingAck
pure def observeDigestAck(i: NativeDigestInbox, exactProviderRow: bool, responseSuccessful: bool): NativeDigestInbox =
  { ...i, acceptedCursor: providerDigestCursor(i.acceptedCursor, i.incoming.lastCursor, exactProviderRow),
    phase: if (not(i.retired) and exactProviderRow and responseSuccessful) RecoveringRemoval else PollFailed }
pure def canRecoverDigestJournal(i: NativeDigestInbox): bool = i.phase == RecoveringRemoval and not(i.retired)
pure def recoverDigestJournal(i: NativeDigestInbox, removedAndCleared: bool): NativeDigestInbox =
  if (not(removedAndCleared)) { ...i, phase: PollFailed }
  else if (i.pages == 2) { ...i, phase: PollFinished, pendingRemoval: Set() }
  else { ...i, phase: FetchingPage, pages: 2, incoming: emptyDigestScan, rowsFinished: 0, indexed: false, pendingRemoval: Set() }
pure def canRetireDigestPoll(i: NativeDigestInbox): bool = not(i.retired) and i.phase != ReadyToPoll and i.phase != PollFinished and i.phase != PollFailed
pure def retireDigestPoll(i: NativeDigestInbox): NativeDigestInbox =
  { ...i, retired: true, phase: if (i.phase == AwaitingAck) AwaitingAck else PollFailed }
pure def alwaysDigestReceiptHasDurablePage(i: NativeDigestInbox): bool =
  ((i.phase == SettlingNotices or i.phase == ReadyToAck or i.phase == AwaitingAck or i.phase == RecoveringRemoval) implies i.indexed) and
  (i.pendingRemoval.size() > 0 implies i.indexed) and
  (i.indexed implies i.rowsFinished == i.incoming.count and usableDigestPage(i.incoming) and i.client != "")
pure def alwaysDigestPollCoordinates(i: NativeDigestInbox): bool =
  i.pages >= 0 and i.pages <= 2 and i.acceptedCursor >= 0 and
  ((i.phase == FetchingPage or i.phase == WritingRows or i.phase == WritingIndex) implies i.client != "" and not(i.indexed)) and
  (i.phase == WritingIndex implies i.rowsFinished == i.incoming.count and usableDigestPage(i.incoming)) and
  (i.phase == WritingRows implies usableDigestPage(i.incoming))
pure def stepDigestAckUsesDurableTail(before: NativeDigestInbox, via: str, after: NativeDigestInbox): bool =
  via == "dispatchDigestAck" implies before.indexed and not(before.retired) and before.incoming.lastRun == after.incoming.lastRun and
    before.incoming.lastCursor == after.incoming.lastCursor and before.client == after.client
pure def stepDigestReceiptDoesNotGoBack(before: NativeDigestInbox, after: NativeDigestInbox): bool = before.acceptedCursor <= after.acceptedCursor
pure def stepClearRequiresRecovery(before: NativeDigestInbox, via: str, after: NativeDigestInbox): bool =
  (before.pendingRemoval.size() > 0 and after.pendingRemoval.size() == 0) implies via == "recoverDigestJournal" or via == "beginDigestPoll"
pure def sometimesDigestReceiptSurvivesLostReply(i: NativeDigestInbox): bool = i.phase == PollFailed and i.acceptedCursor > 0
pure def sometimesEvictionWaitsForAck(i: NativeDigestInbox): bool = i.phase == AwaitingAck and i.pendingRemoval.contains(i.incoming.lastRun)
pure def sometimesSecondDigestPage(i: NativeDigestInbox): bool = i.phase == FetchingPage and i.pages == 2
pure val weight_beginDigestPoll = 5
pure val weight_receiveDigestPage = 8
pure val weight_observeRows = 8
pure val weight_commitDigestIndex = 8
pure val weight_settleDigestNotices = 8
pure val weight_dispatchDigestAck = 8
pure val weight_observeDigestAck = 8
pure val weight_recoverDigestJournal = 8
```

Orchestration traces of partial writes, an ACK with a lost reply, stale
generations and journaled eviction, and cancellation replacement, rejection
of an altered identity and retained terminal results on reverse delivery,
are replayed by the consumer against a controlled delivery port. Installed
Android lifecycle and provider-backed acceptance are separate evidence.

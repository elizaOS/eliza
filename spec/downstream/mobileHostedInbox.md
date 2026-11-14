# Alpha Android hosted Brief inbox reconciliation

AlphaPhone `8d44dfe5` registers `AlphaHostedResultsPlugin.java` in
`MainActivity.java`. `syncInbox` and `inboxHistory` resolve the active
session in `HostedDelivery.java`. Foreground sync and `HostedDeliveryWorker`
share the application-lifetime `HostedInbox.java` under
`android/app/src/main/java/ai/alphacompute/alphaphone`. The coordinator has a
single-flight lock and a shorter commit gate; network calls never hold the
commit gate. The two routes come from Eliza `c518127a`'s
`plugins/plugin-workflow/src/routes/workflow-routes.ts`. Their implementation
is `digestResults` and `acknowledgeDigest` in
`services/embedded-workflow-service.ts`.
[Hosted digest](./hostedDigest.md) owns common offers and browser inbox state.
[Result notices](./mobileHostedResultNotices.md) own OS delivery and taps.
This specification owns native receipt reconciliation and the checkpoint
for sending an ACK. Its state represents one exact owner/agent/origin scope
with a captured session generation. Effect ports report reads, writes,
notice settlement, and the result of provider I/O under that binding.

## Story: Keep a terminal Brief result when the provisional cancellation returns again

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
page. The Eliza server replaces only an exact durable cancelled execution
with a finished failed execution. It removes the old result and writes the
new result in the same transaction. The per-agent/owner advisory lock
orders sequence allocation with commit. For the mobile client the
source's non-cancelled status rule also governs other valid result strings.

```quint
type BriefStatus = BriefCancelled | BriefFailed | BriefOther
type BriefReconciliation = StoreNew | KeepEquivalent | KeepTerminal | ReplaceCancelled | RefuseConflict
type ReconciliationEvidence = { exists: bool, exactValue: bool, exactProvenance: bool, savedStatus: BriefStatus, incomingStatus: BriefStatus, savedCursor: int, incomingCursor: int }
pure def reconcileBrief(facts: ReconciliationEvidence): BriefReconciliation =
  if (not(facts.exists)) StoreNew
  else if (facts.exactValue) KeepEquivalent
  else if (not(facts.exactProvenance)) RefuseConflict
  else if (facts.savedStatus == BriefCancelled and facts.incomingStatus != BriefCancelled and facts.incomingCursor > facts.savedCursor) ReplaceCancelled
  else if (facts.incomingStatus == BriefCancelled and facts.savedStatus != BriefCancelled and facts.savedCursor > facts.incomingCursor) KeepTerminal
  else RefuseConflict
pure def serverReconciles(savedStatus: BriefStatus, incomingStatus: BriefStatus, bothFinished: bool, sameDurableSnapshot: bool): bool =
  savedStatus == BriefCancelled and incomingStatus == BriefFailed and bothFinished and sameDurableSnapshot
pure val cancellationReplacement: ReconciliationEvidence = { exists: true, exactValue: false, exactProvenance: true, savedStatus: BriefCancelled, incomingStatus: BriefFailed, savedCursor: 1, incomingCursor: 3 }
pure val factsValues = Set(cancellationReplacement, { ...cancellationReplacement, exactProvenance: false },
  { ...cancellationReplacement, incomingCursor: 1 }, { ...cancellationReplacement, exactValue: true },
  { ...cancellationReplacement, savedStatus: BriefFailed, incomingStatus: BriefCancelled, savedCursor: 3, incomingCursor: 1 })
pure def lawChangedProvenanceCannotReplace(facts: ReconciliationEvidence): bool =
  not(facts.exactProvenance) implies reconcileBrief(facts) != ReplaceCancelled and reconcileBrief(facts) != KeepTerminal
pure def lawNewerTerminalIsNeverOverwrittenByCancellation(facts: ReconciliationEvidence): bool =
  (facts.exists and not(facts.exactValue) and facts.savedStatus != BriefCancelled and facts.incomingStatus == BriefCancelled) implies
    reconcileBrief(facts) != ReplaceCancelled and reconcileBrief(facts) != StoreNew
```

## Story: Acknowledge a complete page after its native retention journal commits

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
type BriefPageRow = { briefRun: str, cursor: int, wireValid: bool }
type BriefPageScan = { ordered: bool, count: int, lastRun: str, lastCursor: int }
pure val emptyBriefScan: BriefPageScan = { ordered: true, count: 0, lastRun: "", lastCursor: 0 }
pure def scanBriefRow(scan: BriefPageScan, row: BriefPageRow): BriefPageScan = {
  ordered: scan.ordered and row.wireValid and row.briefRun != "" and row.cursor > scan.lastCursor and row.cursor <= 9007199254740991,
  count: scan.count + 1, lastRun: row.briefRun, lastCursor: row.cursor
}
pure def scanBriefPage(entries: List[BriefPageRow]): BriefPageScan = entries.foldl(emptyBriefScan, scanBriefRow)
pure def usableBriefPage(scan: BriefPageScan): bool =
  scan.ordered and scan.count > 0 and scan.count <= 50 and scan.lastRun != "" and scan.lastCursor >= 1 and scan.lastCursor <= 9007199254740991
pure val firstBriefRow: BriefPageRow = { briefRun: "run-one", cursor: 1, wireValid: true }
pure val secondBriefRow: BriefPageRow = { briefRun: "run-two", cursor: 2, wireValid: true }
pure val entriesValues = Set(List(), List(firstBriefRow), List(firstBriefRow, secondBriefRow), List(secondBriefRow, firstBriefRow), List({ ...firstBriefRow, wireValid: false }))
pure val scanValues = Set(emptyBriefScan, scanBriefPage(List(firstBriefRow)), scanBriefPage(List(firstBriefRow, secondBriefRow)),
  { ...emptyBriefScan, count: 51, lastRun: "run-one", lastCursor: 51 })
pure def lawAdmittedPageHasBoundedTail(scan: BriefPageScan): bool = usableBriefPage(scan) implies
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
type BriefPhase = ReadyToPoll | FetchingPage | WritingRows | WritingIndex | SettlingNotices | ReadyToAck | AwaitingAck | RecoveringRemoval | PollFinished | PollFailed
type NativeBriefInbox = { phase: BriefPhase, client: str, generation: int, retired: bool, pages: int, incoming: BriefPageScan,
  rowsFinished: int, indexed: bool, acceptedCursor: int, pendingRemoval: Set[str] }
pure val initial: NativeBriefInbox = { phase: ReadyToPoll, client: "", generation: 0, retired: false, pages: 0,
  incoming: emptyBriefScan, rowsFinished: 0, indexed: false, acceptedCursor: 0, pendingRemoval: Set() }
pure def canBeginBriefPoll(i: NativeBriefInbox, generation: int, client: str): bool =
  (i.phase == ReadyToPoll or i.phase == PollFailed or i.phase == PollFinished) and generation > 0 and generation >= i.generation and
    client != "" and (i.client == "" or i.client == client)
pure def beginBriefPoll(i: NativeBriefInbox, generation: int, client: str, recoveredAtStart: bool): NativeBriefInbox =
  if (recoveredAtStart) { ...i, phase: FetchingPage, client: client, generation: generation, retired: false, pages: 1,
    incoming: emptyBriefScan, rowsFinished: 0, indexed: false, pendingRemoval: Set() }
  else { ...i, phase: PollFailed }
pure val generationValues = Set(1, 2)
pure val clientValues = Set("brief-client", "other-client", "")
pure def canReceiveBriefPage(i: NativeBriefInbox): bool = i.phase == FetchingPage and not(i.retired)
pure def receiveBriefPage(i: NativeBriefInbox, entries: List[BriefPageRow], validEnvelope: bool): NativeBriefInbox = {
  val scan = scanBriefPage(entries)
  if (not(validEnvelope)) { ...i, phase: PollFailed }
  else if (scan.count == 0) { ...i, phase: PollFinished }
  else if (usableBriefPage(scan)) { ...i, phase: WritingRows, incoming: scan }
  else { ...i, phase: PollFailed }
}
pure def canObserveRows(i: NativeBriefInbox, durablePrefix: int): bool =
  i.phase == WritingRows and not(i.retired) and durablePrefix >= 0 and durablePrefix <= i.incoming.count
pure def observeRows(i: NativeBriefInbox, durablePrefix: int): NativeBriefInbox =
  { ...i, rowsFinished: durablePrefix, phase: if (durablePrefix == i.incoming.count) WritingIndex else PollFailed }
pure val durablePrefixValues = Set(0, 1, 2, 50)
type BriefIndex = { retained: List[str], noticeDue: List[str], removalDue: List[str] }
type SavedBriefRow = { briefRun: str, replaced: bool }
pure def appendBriefIdentity(ids: List[str], briefRun: str): List[str] = if (ids.includes(briefRun)) ids else ids.append(briefRun)
pure def noteSavedBriefRow(prior: BriefIndex, saved: SavedBriefRow): BriefIndex = {
  ...prior, retained: appendBriefIdentity(prior.retained, saved.briefRun),
  noticeDue: if (saved.replaced or not(prior.retained.includes(saved.briefRun))) appendBriefIdentity(prior.noticeDue, saved.briefRun) else prior.noticeDue
}
type BriefEviction = { excess: int, retainedAfter: List[str], journalAfter: List[str] }
pure def evictExcessBriefRow(walk: BriefEviction, briefRun: str): BriefEviction =
  if (walk.excess > 0) { ...walk, excess: walk.excess - 1, journalAfter: appendBriefIdentity(walk.journalAfter, briefRun) }
  else { ...walk, retainedAfter: walk.retainedAfter.append(briefRun) }
pure def planBriefIndex(prior: BriefIndex, savedRows: List[SavedBriefRow]): BriefIndex = {
  val merged = savedRows.foldl(prior, noteSavedBriefRow)
  val capped = merged.retained.foldl({ excess: merged.retained.length() - 100, retainedAfter: List(), journalAfter: merged.removalDue }, evictExcessBriefRow)
  { retained: capped.retainedAfter, removalDue: capped.journalAfter, noticeDue: merged.noticeDue.select(briefRun => capped.retainedAfter.includes(briefRun)) }
}
pure val initialBriefIndex: BriefIndex = { retained: List(), noticeDue: List(), removalDue: List() }
pure val priorValues = Set({ ...initialBriefIndex, retained: List("run-one") }, initialBriefIndex)
pure val savedRowsValues = Set(List(), List({ briefRun: "run-one", replaced: true }, { briefRun: "run-two", replaced: false }))
type IndexEvidence = { stored: bool, exactPlan: bool, retainedCount: int, tailRetained: bool, evictedRuns: Set[str] }
pure def exactIndexCommit(scan: BriefPageScan, indexCommit: IndexEvidence): bool = indexCommit.stored and indexCommit.exactPlan and
  indexCommit.retainedCount >= 1 and indexCommit.retainedCount <= 100 and
  indexCommit.tailRetained != indexCommit.evictedRuns.contains(scan.lastRun)
pure def canCommitBriefIndex(i: NativeBriefInbox): bool = i.phase == WritingIndex and not(i.retired)
pure def commitBriefIndex(i: NativeBriefInbox, indexCommit: IndexEvidence): NativeBriefInbox =
  if (exactIndexCommit(i.incoming, indexCommit)) { ...i, phase: SettlingNotices, indexed: true, pendingRemoval: indexCommit.evictedRuns }
  else { ...i, phase: PollFailed }
pure val indexCommitValues = Set({ stored: true, exactPlan: true, retainedCount: 2, tailRetained: true, evictedRuns: Set() },
  { stored: true, exactPlan: true, retainedCount: 100, tailRetained: false, evictedRuns: Set("run-one", "run-two") },
  { stored: false, exactPlan: false, retainedCount: 2, tailRetained: true, evictedRuns: Set() })
pure def lawIndexCommitIncludesExactTail(scan: BriefPageScan, indexCommit: IndexEvidence): bool =
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
pure def canSettleBriefNotices(i: NativeBriefInbox): bool = i.phase == SettlingNotices and not(i.retired)
pure def settleBriefNotices(i: NativeBriefInbox, noticesCanProceed: bool): NativeBriefInbox =
  { ...i, phase: if (noticesCanProceed) ReadyToAck else PollFailed }
pure def canDispatchBriefAck(i: NativeBriefInbox): bool = i.phase == ReadyToAck and not(i.retired)
pure def dispatchBriefAck(i: NativeBriefInbox): NativeBriefInbox = { ...i, phase: AwaitingAck }
pure def providerBriefCursor(previousCursor: int, receivedCursor: int, exactProviderRow: bool): int =
  if (exactProviderRow and receivedCursor >= 1 and receivedCursor <= 9007199254740991 and receivedCursor > previousCursor) receivedCursor else previousCursor
pure def canObserveBriefAck(i: NativeBriefInbox): bool = i.phase == AwaitingAck
pure def observeBriefAck(i: NativeBriefInbox, exactProviderRow: bool, responseSuccessful: bool): NativeBriefInbox =
  { ...i, acceptedCursor: providerBriefCursor(i.acceptedCursor, i.incoming.lastCursor, exactProviderRow),
    phase: if (not(i.retired) and exactProviderRow and responseSuccessful) RecoveringRemoval else PollFailed }
pure def canRecoverBriefJournal(i: NativeBriefInbox): bool = i.phase == RecoveringRemoval and not(i.retired)
pure def recoverBriefJournal(i: NativeBriefInbox, removedAndCleared: bool): NativeBriefInbox =
  if (not(removedAndCleared)) { ...i, phase: PollFailed }
  else if (i.pages == 2) { ...i, phase: PollFinished, pendingRemoval: Set() }
  else { ...i, phase: FetchingPage, pages: 2, incoming: emptyBriefScan, rowsFinished: 0, indexed: false, pendingRemoval: Set() }
pure def canRetireBriefPoll(i: NativeBriefInbox): bool = not(i.retired) and i.phase != ReadyToPoll and i.phase != PollFinished and i.phase != PollFailed
pure def retireBriefPoll(i: NativeBriefInbox): NativeBriefInbox =
  { ...i, retired: true, phase: if (i.phase == AwaitingAck) AwaitingAck else PollFailed }
pure def alwaysBriefReceiptHasDurablePage(i: NativeBriefInbox): bool =
  ((i.phase == SettlingNotices or i.phase == ReadyToAck or i.phase == AwaitingAck or i.phase == RecoveringRemoval) implies i.indexed) and
  (i.pendingRemoval.size() > 0 implies i.indexed) and
  (i.indexed implies i.rowsFinished == i.incoming.count and usableBriefPage(i.incoming) and i.client != "")
pure def alwaysBriefPollCoordinates(i: NativeBriefInbox): bool =
  i.pages >= 0 and i.pages <= 2 and i.acceptedCursor >= 0 and
  ((i.phase == FetchingPage or i.phase == WritingRows or i.phase == WritingIndex) implies i.client != "" and not(i.indexed)) and
  (i.phase == WritingIndex implies i.rowsFinished == i.incoming.count and usableBriefPage(i.incoming)) and
  (i.phase == WritingRows implies usableBriefPage(i.incoming))
pure def stepBriefAckUsesDurableTail(before: NativeBriefInbox, via: str, after: NativeBriefInbox): bool =
  via == "dispatchBriefAck" implies before.indexed and not(before.retired) and before.incoming.lastRun == after.incoming.lastRun and
    before.incoming.lastCursor == after.incoming.lastCursor and before.client == after.client
pure def stepBriefReceiptDoesNotGoBack(before: NativeBriefInbox, after: NativeBriefInbox): bool = before.acceptedCursor <= after.acceptedCursor
pure def stepClearRequiresRecovery(before: NativeBriefInbox, via: str, after: NativeBriefInbox): bool =
  (before.pendingRemoval.size() > 0 and after.pendingRemoval.size() == 0) implies via == "recoverBriefJournal" or via == "beginBriefPoll"
pure def sometimesBriefReceiptSurvivesLostReply(i: NativeBriefInbox): bool = i.phase == PollFailed and i.acceptedCursor > 0
pure def sometimesEvictionWaitsForAck(i: NativeBriefInbox): bool = i.phase == AwaitingAck and i.pendingRemoval.contains(i.incoming.lastRun)
pure def sometimesSecondBriefPage(i: NativeBriefInbox): bool = i.phase == FetchingPage and i.pages == 2
pure val weight_beginBriefPoll = 5
pure val weight_receiveBriefPage = 8
pure val weight_observeRows = 8
pure val weight_commitBriefIndex = 8
pure val weight_settleBriefNotices = 8
pure val weight_dispatchBriefAck = 8
pure val weight_observeBriefAck = 8
pure val weight_recoverBriefJournal = 8
```

The pinned `test/quint-native-hosted-inbox.test.mjs` replays twelve JVM
orchestration traces against `specs/quint/native/NativeHostedInbox.qnt`,
including partial writes, an ACK with lost reply, stale generations and
journaled eviction. `test/resident-result-transport.test.mjs` exercises
cancellation replacement, rejection of altered identity, and retained
terminal results on reverse delivery. These are source fixtures with a
controlled delivery port. Installed Android lifecycle and provider-backed
acceptance are separate evidence.

# Hosted digests

A hosted digest is a scheduled workflow whose result the agent's host
delivers to the owner's devices. The [daily dossier](../assistant/scheduledDossiers.md)
owns when the daily digest fires; this spec owns the offer of a missed run
and delivery into each client's inbox. The server stays authoritative for
sources and results. [Result notices](../os/index.md)
own OS delivery and taps.

The linked OS contracts are being rebuilt. Their detailed models and execution
evidence remain pending.

## Story: Review a missed digest only while its source and result are current

> As the owner, I want to be offered a missed digest only while its source is
> still current and no newer result has replaced it.

### Source freshness and newer results determine whether a retry offer is visible

A revoked source is revoked even after its expiry. Other sources expire
at the expiry instant. A scheduled wakeup later than the
[schedule](./schedule.md)'s miss window is missed. A manual offer for a
missed scheduled run requires an active, enabled digest, a current device
source of the exact revision, and a valid derived mutation ID. A newer
result for the same digest or source, or a newer on-demand run, supersedes
it. An absent or mismatched source gives no offer.

```quint
import numbers as Num from "../core/numbers"
import schedule as S from "./schedule"
type SourceFreshness = SourceCurrent | SourceExpired | SourceRevoked
type DigestOffer = { scheduledAt: int, digestExists: bool, removed: bool, active: bool, enabled: bool, deviceSource: bool, revisionMatches: bool, sourcePresent: bool, revoked: bool, expiresAt: int, digestSourceCurrent: bool, newerResult: bool, validMutation: bool }
pure def sourceFreshness(revoked: bool, expiresAt: int, now: int): SourceFreshness = if (revoked) SourceRevoked else if (expiresAt <= now) SourceExpired else SourceCurrent
pure def offersMissedRun(offer: DigestOffer, now: int): bool = S::missedOccurrence(offer.scheduledAt, now) and offer.digestExists and not(offer.removed) and offer.active and offer.enabled and offer.deviceSource and offer.revisionMatches and offer.sourcePresent and sourceFreshness(offer.revoked, offer.expiresAt, now) == SourceCurrent and offer.digestSourceCurrent and not(offer.newerResult) and offer.validMutation
pure val currentOffer: DigestOffer = { scheduledAt: 0, digestExists: true, removed: false, active: true, enabled: true, deviceSource: true, revisionMatches: true, sourcePresent: true, revoked: false, expiresAt: 2000000, digestSourceCurrent: true, newerResult: false, validMutation: true }
pure val offerValues = Set(currentOffer, { ...currentOffer, newerResult: true }, { ...currentOffer, revoked: true })
pure val nowValues = Set(0, 1800001, 2000000)
pure def lawNoOfferWithoutCurrentSource(offer: DigestOffer, now: int): bool = offersMissedRun(offer, now) implies (offer.deviceSource and offer.revisionMatches and offer.sourcePresent and not(offer.revoked) and offer.expiresAt > now)
pure def lawLaterResultsSupersedeOffer(offer: DigestOffer, now: int): bool = offer.newerResult implies not(offersMissedRun(offer, now))
```

## Story: Keep a terminal digest result when the provisional cancellation returns again

> As the owner, I want a digest that finished to stay finished when an earlier
> cancellation of it arrives again.

### Reconciliation preserves equivalent bytes and replaces only the matching cancellation

A result row carries its cursor, run, workflow and template versions,
scheduled time, source, status, times, output and error. Equality ignores
JSON object key order, keeps array order and compares numbers by value;
replay keeps the bytes already stored. A saved cancellation is replaced by
a later row of a different status only when run, workflow, versions,
scheduled time and source are identical; the replacement arms its notice.
A cancellation arriving after the terminal row keeps the terminal and
acknowledges the incoming cursor. Any other divergent row fails the page.
The server replaces only an exact durable cancelled execution with a
finished failed one, removing the old result in the same transaction.

```quint
type DigestStatus = DigestCancelled | DigestFailed | DigestOther
type DigestReconciliation = StoreNew | KeepEquivalent | KeepTerminal | ReplaceCancelled | RefuseConflict
type ReconciliationEvidence = { exists: bool, exactValue: bool, exactProvenance: bool, savedStatus: DigestStatus, incomingStatus: DigestStatus, savedCursor: int, incomingCursor: int }
pure def reconcileDigest(evidence: ReconciliationEvidence): DigestReconciliation =
  if (not(evidence.exists)) StoreNew
  else if (evidence.exactValue) KeepEquivalent
  else if (not(evidence.exactProvenance)) RefuseConflict
  else if (evidence.savedStatus == DigestCancelled and evidence.incomingStatus != DigestCancelled and evidence.incomingCursor > evidence.savedCursor) ReplaceCancelled
  else if (evidence.incomingStatus == DigestCancelled and evidence.savedStatus != DigestCancelled and evidence.savedCursor > evidence.incomingCursor) KeepTerminal
  else RefuseConflict
pure def serverReconciles(savedStatus: DigestStatus, incomingStatus: DigestStatus, bothFinished: bool, sameDurableSnapshot: bool): bool =
  savedStatus == DigestCancelled and incomingStatus == DigestFailed and bothFinished and sameDurableSnapshot
pure val cancellationReplacement: ReconciliationEvidence = { exists: true, exactValue: false, exactProvenance: true, savedStatus: DigestCancelled, incomingStatus: DigestFailed, savedCursor: 1, incomingCursor: 3 }
pure val evidenceValues = Set(cancellationReplacement, { ...cancellationReplacement, exactProvenance: false },
  { ...cancellationReplacement, incomingCursor: 1 }, { ...cancellationReplacement, exactValue: true },
  { ...cancellationReplacement, savedStatus: DigestFailed, incomingStatus: DigestCancelled, savedCursor: 3, incomingCursor: 1 })
pure def lawChangedProvenanceCannotReplace(evidence: ReconciliationEvidence): bool =
  not(evidence.exactProvenance) implies reconcileDigest(evidence) != ReplaceCancelled and reconcileDigest(evidence) != KeepTerminal
pure def lawNewerTerminalIsNeverOverwrittenByCancellation(evidence: ReconciliationEvidence): bool =
  (evidence.exists and not(evidence.exactValue) and evidence.savedStatus != DigestCancelled and evidence.incomingStatus == DigestCancelled) implies
    reconcileDigest(evidence) != ReplaceCancelled and reconcileDigest(evidence) != StoreNew
```

## Story: Acknowledge a page of digests only after it is stored

> As the owner, I want every digest result kept on my device before the
> server is told that I have it.

### Parse the complete page before durable writes and bind its acknowledgement to its final incoming row

Every client keeps one inbox per owner, agent and origin scope, under a
captured session generation, and serializes its inbox work. The stored
index holds the client ID, the ordered retained result IDs, the pending
notices and the removal journal. A sync first recovers the removal journal
and retries pending notices, then reads at most two pages. An empty page
ends it; a page of more than 50 results or with non-increasing cursors
fails before any row is written. The scan records the final incoming run
and cursor.

```quint
type DigestPageRow = { digestRun: str, cursor: int, wireValid: bool }
type DigestPageScan = { ordered: bool, count: int, lastRun: str, lastCursor: int }
pure val emptyDigestScan: DigestPageScan = { ordered: true, count: 0, lastRun: "", lastCursor: 0 }
pure def scanDigestRow(scan: DigestPageScan, row: DigestPageRow): DigestPageScan = {
  ordered: scan.ordered and row.wireValid and row.digestRun != "" and row.cursor > scan.lastCursor and row.cursor <= Num::maxSafeInteger,
  count: scan.count + 1, lastRun: row.digestRun, lastCursor: row.cursor
}
pure def scanDigestPage(entries: List[DigestPageRow]): DigestPageScan = entries.foldl(emptyDigestScan, scanDigestRow)
pure def usableDigestPage(scan: DigestPageScan): bool =
  scan.ordered and scan.count > 0 and scan.count <= 50 and scan.lastRun != "" and scan.lastCursor >= 1 and scan.lastCursor <= Num::maxSafeInteger
pure val firstDigestRow: DigestPageRow = { digestRun: "run-one", cursor: 1, wireValid: true }
pure val secondDigestRow: DigestPageRow = { digestRun: "run-two", cursor: 2, wireValid: true }
pure val entriesValues = Set(List(), List(firstDigestRow), List(firstDigestRow, secondDigestRow), List(secondDigestRow, firstDigestRow), List({ ...firstDigestRow, wireValid: false }))
pure val scanValues = Set(emptyDigestScan, scanDigestPage(List(firstDigestRow)), scanDigestPage(List(firstDigestRow, secondDigestRow)),
  { ...emptyDigestScan, count: 51, lastRun: "run-one", lastCursor: 51 })
pure def lawAdmittedPageHasBoundedTail(scan: DigestPageScan): bool = usableDigestPage(scan) implies
  scan.count <= 50 and scan.lastRun != "" and scan.lastCursor >= 1 and scan.lastCursor <= Num::maxSafeInteger
```

### Writes may leave unindexed bytes, and eviction journals precede deletion

Rows are written in order, before the index. A storage fault can leave a
prefix of row writes, and then no index or acknowledgement follows in that
sync. The index write records the retained IDs, pending notices and
removal journal together: new IDs are appended once in incoming order,
notices are armed for additions and replacements, the oldest IDs beyond
100 are evicted and journaled, and only retained IDs keep a notice. Even
the page's final row can be evicted, so before acknowledgement that row is
either retained or journaled.

```quint
type DigestPhase = ReadyToPoll | FetchingPage | WritingRows | WritingIndex | SettlingNotices | ReadyToAck | AwaitingAck | RecoveringRemoval | PollFinished | PollFailed
type DigestInbox = { phase: DigestPhase, client: str, generation: int, retired: bool, pages: int, incoming: DigestPageScan,
  rowsFinished: int, indexed: bool, acceptedCursor: int, pendingRemoval: Set[str] }
pure val initial: DigestInbox = { phase: ReadyToPoll, client: "", generation: 0, retired: false, pages: 0,
  incoming: emptyDigestScan, rowsFinished: 0, indexed: false, acceptedCursor: 0, pendingRemoval: Set() }
pure def canBeginDigestPoll(i: DigestInbox, generation: int, client: str): bool =
  (i.phase == ReadyToPoll or i.phase == PollFailed or i.phase == PollFinished) and generation > 0 and generation >= i.generation and
    client != "" and (i.client == "" or i.client == client)
pure def beginDigestPoll(i: DigestInbox, generation: int, client: str, recoveredAtStart: bool): DigestInbox =
  if (recoveredAtStart) { ...i, phase: FetchingPage, client: client, generation: generation, retired: false, pages: 1,
    incoming: emptyDigestScan, rowsFinished: 0, indexed: false, pendingRemoval: Set() }
  else { ...i, phase: PollFailed }
pure val generationValues = Set(1, 2)
pure val clientValues = Set("digest-client", "other-client", "")
pure def canReceiveDigestPage(i: DigestInbox): bool = i.phase == FetchingPage and not(i.retired)
pure def receiveDigestPage(i: DigestInbox, entries: List[DigestPageRow], validEnvelope: bool): DigestInbox = {
  val scan = scanDigestPage(entries)
  if (not(validEnvelope)) { ...i, phase: PollFailed }
  else if (scan.count == 0) { ...i, phase: PollFinished }
  else if (usableDigestPage(scan)) { ...i, phase: WritingRows, incoming: scan }
  else { ...i, phase: PollFailed }
}
pure def canObserveRows(i: DigestInbox, durablePrefix: int): bool =
  i.phase == WritingRows and not(i.retired) and durablePrefix >= 0 and durablePrefix <= i.incoming.count
pure def observeRows(i: DigestInbox, durablePrefix: int): DigestInbox =
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
pure def canCommitDigestIndex(i: DigestInbox): bool = i.phase == WritingIndex and not(i.retired)
pure def commitDigestIndex(i: DigestInbox, indexCommit: IndexEvidence): DigestInbox =
  if (exactIndexCommit(i.incoming, indexCommit)) { ...i, phase: SettlingNotices, indexed: true, pendingRemoval: indexCommit.evictedRuns }
  else { ...i, phase: PollFailed }
pure val indexCommitValues = Set({ stored: true, exactPlan: true, retainedCount: 2, tailRetained: true, evictedRuns: Set() },
  { stored: true, exactPlan: true, retainedCount: 100, tailRetained: false, evictedRuns: Set("run-one", "run-two") },
  { stored: false, exactPlan: false, retainedCount: 2, tailRetained: true, evictedRuns: Set() })
pure def lawIndexCommitIncludesExactTail(scan: DigestPageScan, indexCommit: IndexEvidence): bool =
  exactIndexCommit(scan, indexCommit) implies indexCommit.tailRetained or indexCommit.evictedRuns.contains(scan.lastRun)
```

### Notice retry and an uncertain ACK preserve the committed journal

A failed notice stays pending for retry; a failure to record a delivered
notice aborts the sync before acknowledgement. The acknowledgement names
the committed index's client and the final incoming row's run and cursor,
never a newer locally stored cursor. The provider accepts only an existing
row of that tenant, owner, run and cursor and advances the client's cursor
monotonically. An accepted acknowledgement may lose its reply. A retired
generation blocks late local writes and a new acknowledgement, though a
request already sent may still be recorded remotely. After a successful
reply, only journaled IDs no longer retained are removed and the journal
is cleared by a durable index write; a failure retries from the persisted
journal before the next read, and removal is idempotent. A pending
removal journal always belongs to an indexed page.

```quint
pure def canSettleDigestNotices(i: DigestInbox): bool = i.phase == SettlingNotices and not(i.retired)
pure def settleDigestNotices(i: DigestInbox, noticesCanProceed: bool): DigestInbox =
  { ...i, phase: if (noticesCanProceed) ReadyToAck else PollFailed }
pure def canDispatchDigestAck(i: DigestInbox): bool = i.phase == ReadyToAck and not(i.retired)
pure def dispatchDigestAck(i: DigestInbox): DigestInbox = { ...i, phase: AwaitingAck }
pure def providerDigestCursor(previousCursor: int, receivedCursor: int, exactProviderRow: bool): int =
  if (exactProviderRow and receivedCursor >= 1 and receivedCursor <= Num::maxSafeInteger and receivedCursor > previousCursor) receivedCursor else previousCursor
pure def canObserveDigestAck(i: DigestInbox): bool = i.phase == AwaitingAck
pure def observeDigestAck(i: DigestInbox, exactProviderRow: bool, responseSuccessful: bool): DigestInbox =
  { ...i, acceptedCursor: providerDigestCursor(i.acceptedCursor, i.incoming.lastCursor, exactProviderRow),
    phase: if (not(i.retired) and exactProviderRow and responseSuccessful) RecoveringRemoval else PollFailed }
pure def canRecoverDigestJournal(i: DigestInbox): bool = i.phase == RecoveringRemoval and not(i.retired)
pure def recoverDigestJournal(i: DigestInbox, removedAndCleared: bool): DigestInbox =
  if (not(removedAndCleared)) { ...i, phase: PollFailed }
  else if (i.pages == 2) { ...i, phase: PollFinished, pendingRemoval: Set() }
  else { ...i, phase: FetchingPage, pages: 2, incoming: emptyDigestScan, rowsFinished: 0, indexed: false, pendingRemoval: Set() }
pure def canRetireDigestPoll(i: DigestInbox): bool = not(i.retired) and i.phase != ReadyToPoll and i.phase != PollFinished and i.phase != PollFailed
pure def retireDigestPoll(i: DigestInbox): DigestInbox =
  { ...i, retired: true, phase: if (i.phase == AwaitingAck) AwaitingAck else PollFailed }
pure def alwaysDigestReceiptHasDurablePage(i: DigestInbox): bool =
  ((i.phase == SettlingNotices or i.phase == ReadyToAck or i.phase == AwaitingAck or i.phase == RecoveringRemoval) implies i.indexed) and
  (i.pendingRemoval.size() > 0 implies i.indexed) and
  (i.indexed implies i.rowsFinished == i.incoming.count and usableDigestPage(i.incoming) and i.client != "")
pure def alwaysDigestPollCoordinates(i: DigestInbox): bool =
  i.pages >= 0 and i.pages <= 2 and i.acceptedCursor >= 0 and
  ((i.phase == FetchingPage or i.phase == WritingRows or i.phase == WritingIndex) implies i.client != "" and not(i.indexed)) and
  (i.phase == WritingIndex implies i.rowsFinished == i.incoming.count and usableDigestPage(i.incoming)) and
  (i.phase == WritingRows implies usableDigestPage(i.incoming))
pure def stepDigestAckUsesDurableTail(before: DigestInbox, via: str, after: DigestInbox): bool =
  via == "dispatchDigestAck" implies before.indexed and not(before.retired) and before.incoming.lastRun == after.incoming.lastRun and
    before.incoming.lastCursor == after.incoming.lastCursor and before.client == after.client
pure def stepDigestReceiptDoesNotGoBack(before: DigestInbox, after: DigestInbox): bool = before.acceptedCursor <= after.acceptedCursor
pure def stepClearRequiresRecovery(before: DigestInbox, via: str, after: DigestInbox): bool =
  (before.pendingRemoval.size() > 0 and after.pendingRemoval.size() == 0) implies via == "recoverDigestJournal" or via == "beginDigestPoll"
pure def sometimesDigestReceiptSurvivesLostReply(i: DigestInbox): bool = i.phase == PollFailed and i.acceptedCursor > 0
pure def sometimesEvictionWaitsForAck(i: DigestInbox): bool = i.phase == AwaitingAck and i.pendingRemoval.contains(i.incoming.lastRun)
pure def sometimesSecondDigestPage(i: DigestInbox): bool = i.phase == FetchingPage and i.pages == 2
pure val weight_beginDigestPoll = 5
pure val weight_receiveDigestPage = 8
pure val weight_observeRows = 8
pure val weight_commitDigestIndex = 8
pure val weight_settleDigestNotices = 8
pure val weight_dispatchDigestAck = 8
pure val weight_observeDigestAck = 8
pure val weight_recoverDigestJournal = 8
```

# Browser session restoration and clear

The consumer's renderer saves its browsing session through the shared
[storage codec](./storage.md) and owns the save queue, its backoff, Clear
and the merge of a late restore into the running view.
[Document custody](./documentCustody.md) owns native tab events and which
tab may contribute.

## Story: Restore saved public tabs without losing the tabs I already opened

> As the person, I want my saved public tabs restored beside the tabs I
> already opened, so that a slow restore never replaces or duplicates
> what I am using.

### A snapshot offers the codec at most eight known normal tabs

Snapshot production skips private tabs before asking for their addresses
and offers the codec up to eight normal tabs whose address is known, in
order; the codec then drops any that are invalid, so an invalid early
candidate can take one of the eight slots. A known address can come from
an unloaded restored page.

```quint
import storage as St from "./storage"
pure def appendSnapshotCandidate(rows: List[St::SavedTab], row: St::SavedTab): List[St::SavedTab] =
  if (rows.length() < St::maxSavedTabs and not(row.privateTab) and row.address.raw != "") rows.append(row) else rows
pure def snapshotSession(history: List[St::WebAddress], candidates: List[St::SavedTab], preferred: str): St::SavedSession =
  St::normalizeSession(St::RendererCodec, history, candidates.foldl(List(), (rows, row) => appendSnapshotCandidate(rows, row)), preferred)
pure val privateSavedTab: St::SavedTab = { ...St::publicTab, id: "private", privateTab: true }
pure val candidatesValues = Set(List(), List(St::publicTab), List(privateSavedTab, St::publicTab, St::publicTab))
pure val historyValues = Set(List(), List(St::publicAddress))
pure val preferredValues = Set("", "public", "private")
pure def lawSnapshotKeepsAtMostTheTabLimit(history: List[St::WebAddress], candidates: List[St::SavedTab], preferred: str): bool =
  snapshotSession(history, candidates, preferred).tabs.length() <= St::maxSavedTabs
```

### A late restore preserves the open list and appends only unused identities

A single blank tab with no registered native tab, metadata or editing is
pristine. On a pristine view with saved rows the saved rows replace it,
selecting the saved selection or the first saved row. Otherwise the open
list and selection stay, and unused saved IDs are appended in order up to
the tab limit, open private tabs included in that count. Existing history
comes first when saved history is merged, up to the history limit. A
restored tab loads lazily, navigates to its address when shown and never
resubmits a request.

```quint
type OpenTabs = { ids: List[str], selected: str }
pure def addUnusedId(ids: List[str], id: str): List[str] =
  if (ids.length() < St::maxSavedTabs and not(ids.includes(id))) ids.append(id) else ids
pure def restoreTabIds(openTabs: OpenTabs, record: St::SavedSession, pristine: bool): OpenTabs = {
  val savedIds = record.tabs.listMap(row => row.id)
  if (pristine and savedIds.length() > 0)
    { ids: savedIds, selected: if (record.selected != "") record.selected else savedIds.nthOr(0, "") }
  else { ...openTabs, ids: savedIds.foldl(openTabs.ids, (ids, id) => addUnusedId(ids, id)) }
}
pure def restoreHistory(visits: List[str], record: St::SavedSession): List[str] = {
  val first = visits.foldl(List(), (kept, url) => if (kept.length() < St::maxSavedHistory) kept.append(url) else kept)
  record.history.foldl(first, (kept, url) => St::keepVisit(St::RendererCodec, kept, url))
}
pure val visitsValues = Set(List(), List("https://example.test"))
pure val idsValues = Set(List(), List("public"), List("private"))
pure val openTabsValues = Set({ ids: List("new"), selected: "new" }, { ids: List("public", "private"), selected: "private" })
pure val recordValues = Set(St::normalizeSession(St::RendererCodec, List(), List(), ""), St::normalizeSession(St::RendererCodec, List(St::publicAddress), List(St::publicTab), "public"))
pure val idValues = Set("public", "private", "new")
pure def lawLateRestoreKeepsCurrent(openTabs: OpenTabs, record: St::SavedSession): bool =
  restoreTabIds(openTabs, record, false).selected == openTabs.selected
pure def lawDuplicateCannotUseCapacity(ids: List[str], id: str): bool =
  ids.includes(id) implies addUnusedId(ids, id) == ids
pure def lawFullViewCannotAppend(ids: List[str], id: str): bool =
  ids.length() >= St::maxSavedTabs implies addUnusedId(ids, id) == ids
```

## Story: Clear browsing data without resurrecting earlier snapshots

> As the person, I want Clear to remove my browsing data for good, so
> that no save or restore already in flight brings an earlier snapshot
> back.

### Restore and save use the current generation and serialize durable writes

Startup waits for one host read before enabling saves. A failed read
leaves the saved state untouched. An old read that completes after
Clear has started cannot restore tabs or visits. If that old read
arrives before successful hydration it can release the read latch so
startup can try again after Clear. Hydration primes the last submitted
snapshot and never immediately writes it back.

Each accepted save captures the immutable candidate identity and current
generation. Equal snapshots coalesce. The queue executes one at a time.
A failed write schedules a retry only when its candidate is still the
latest submitted snapshot and its generation is still current. Retry
starts at 2,000 ms, doubles up to 60,000 ms, and is specific to the failed
candidate. A different snapshot can save immediately. A successful
current write resets retry state. The first current failure in a streak
reports a warning. A snapshot is named by a positive number; zero is no
snapshot.

Clear starts only with a confirmed live action. It advances the generation,
pauses new saves, retires pending old writes, and drains the write already
issued before sending the native clear. The UI waits for publication of
the cleared view before unpausing. A failure leaves the current view and
permits saving it again. A successful clear establishes the new baseline
without another write.

```quint
type BrowserWrite = { epoch: int, snapshot: int }
type BrowserStorage = { epoch: int, readLatched: bool, readPending: bool, readEpoch: int,
  hydrated: bool, clearing: bool, clearIssued: bool, clearPublished: bool, queued: List[BrowserWrite], active: BrowserWrite,
  lastSubmitted: int, failedSnapshot: int, retryAt: int, retryDelay: int, warned: bool, durable: int }
pure val idleWrite: BrowserWrite = { epoch: 0, snapshot: 0 }
pure val initial: BrowserStorage = { epoch: 0, readLatched: false, readPending: false, readEpoch: 0,
  hydrated: false, clearing: false, clearIssued: false, clearPublished: false, queued: List(), active: idleWrite,
  lastSubmitted: 0, failedSnapshot: 0, retryAt: 0, retryDelay: 2000, warned: false, durable: 0 }
pure def canStartRestore(s: BrowserStorage): bool = not(s.readLatched or s.clearing)
pure def startRestore(s: BrowserStorage): BrowserStorage = { ...s, readLatched: true, readPending: true, readEpoch: s.epoch }
pure def canFinishRestore(s: BrowserStorage, snapshot: int): bool = s.readPending and snapshot > 0
pure def finishRestore(s: BrowserStorage, snapshot: int, readOk: bool): BrowserStorage =
  if (readOk and s.readEpoch == s.epoch) { ...s, readPending: false, hydrated: true, lastSubmitted: snapshot }
  else { ...s, readPending: false, readLatched: if (readOk and s.readEpoch != s.epoch and not(s.hydrated)) false else s.readLatched }
pure def canQueueSave(s: BrowserStorage, snapshot: int, now: int): bool =
  s.hydrated and not(s.clearing) and snapshot > 0 and snapshot != s.lastSubmitted and
  (snapshot != s.failedSnapshot or now >= s.retryAt)
pure def queueSave(s: BrowserStorage, snapshot: int, now: int): BrowserStorage =
  { ...s, lastSubmitted: snapshot, queued: s.queued.append({ epoch: s.epoch, snapshot: snapshot }) }
pure def canDispatchSave(s: BrowserStorage): bool =
  not(s.clearing) and s.active.snapshot == 0 and s.queued.length() > 0
pure def dispatchSave(s: BrowserStorage): BrowserStorage =
  { ...s, active: s.queued.nthOr(0,idleWrite), queued: s.queued.removeAt(0) }
pure def canFinishSave(s: BrowserStorage): bool = s.active.snapshot > 0
pure def nextRetry(delay: int): int = if (delay >= 30000) 60000 else delay * 2
pure def finishSave(s: BrowserStorage, writeOk: bool, now: int): BrowserStorage = {
  val write = s.active
  val ended = { ...s, active: idleWrite, durable: if (writeOk) write.snapshot else s.durable }
  if (write.epoch != s.epoch) ended
  else if (writeOk) { ...ended, failedSnapshot: 0, retryAt: 0, retryDelay: 2000, warned: false }
  else if (s.lastSubmitted == write.snapshot) { ...ended, lastSubmitted: 0, failedSnapshot: write.snapshot,
    retryAt: now + s.retryDelay, retryDelay: nextRetry(s.retryDelay), warned: true }
  else ended
}
pure def canAskClear(s: BrowserStorage, confirmed: bool): bool = confirmed and not(s.clearing)
pure def askClear(s: BrowserStorage, confirmed: bool): BrowserStorage =
  { ...s, clearing: true, clearPublished: false, epoch: s.epoch + 1, queued: List(), lastSubmitted: 0,
    failedSnapshot: 0, retryAt: 0, retryDelay: 2000, warned: false }
pure def canSendClear(s: BrowserStorage): bool = s.clearing and not(s.clearIssued) and s.active.snapshot == 0
pure def sendClear(s: BrowserStorage): BrowserStorage = { ...s, clearIssued: true }
pure def canFinishClear(s: BrowserStorage, clearedSnapshot: int): bool = s.clearIssued and clearedSnapshot > 0
pure def finishClear(s: BrowserStorage, clearedSnapshot: int, published: bool): BrowserStorage =
  if (published) { ...s, hydrated: true, clearing: false, clearIssued: false, clearPublished: true, durable: clearedSnapshot, lastSubmitted: clearedSnapshot }
  else { ...s, clearing: false, clearIssued: false }
pure val snapshotValues = Set(0, 1, 2)
pure val clearedSnapshotValues = Set(0, 3)
pure val nowValues = Set(0, 1999, 2000, 60000)
pure def alwaysQueuedWritesAreCurrent(s: BrowserStorage): bool =
  s.queued.every(write => write.epoch == s.epoch and write.snapshot > 0)
pure def alwaysClearDrainsWrites(s: BrowserStorage): bool =
  s.clearIssued implies s.clearing and s.active.snapshot == 0
pure def stepOldReadCannotPrime(before: BrowserStorage, via: str, after: BrowserStorage): bool =
  (via == "finishRestore" and before.readEpoch != before.epoch) implies
    after.lastSubmitted == before.lastSubmitted and after.hydrated == before.hydrated
pure def stepOldWriteCannotAddBackoff(before: BrowserStorage, via: str, after: BrowserStorage): bool =
  (via == "finishSave" and before.active.epoch != before.epoch) implies after.failedSnapshot == before.failedSnapshot
pure def stepPublishedClearFollowsDrain(before: BrowserStorage, via: str, after: BrowserStorage): bool =
  (after.clearPublished and not(before.clearPublished)) implies via == "finishClear" and before.clearIssued and before.active.snapshot == 0
pure def sometimesDrainingBeforeClear(s: BrowserStorage): bool = s.clearing and s.active.snapshot > 0 and not(s.clearIssued)
pure def sometimesPublishedClear(s: BrowserStorage): bool = s.clearPublished and s.hydrated and not(s.clearing)
pure def sometimesRetryingASnapshot(s: BrowserStorage): bool = s.failedSnapshot > 0 and s.retryDelay == 4000
```

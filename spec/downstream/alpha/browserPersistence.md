# Alpha browser session restoration and clear

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` calls the
shared `browsing-session.ts` and owns the save queue in
`apps/app/src/prototype/browser-adapter.ts`. The shared helper's Git blob
`b9faf9efcb13e938ddfd27f19d35b190cc5e4200` matches both downstream Eliza
pins. Alpha's original `BrowserSessionPersistence.qnt` models backoff,
clear, and hydration. [Live document custody](./browser.md) owns native
tab events and capture. This model owns the persisted list and write fence.

## Story: Restore saved public tabs without losing the tabs I already opened

### Saved rows keep order and exact safe addresses

The shared helper accepts raw HTTP or HTTPS URLs up to 4,096 UTF-16 units
with a parsed nonempty hostname and no credentials or literal ASCII
space, controls or DEL. Preserve raw spelling, so distinct accepted
spellings have distinct history identity. The host supplies URL parse
facts. Tab IDs are one through 80 ASCII alphanumeric, hyphen or underscore
units. History preserves the first admitted occurrence, with at most 100
URLs. The first valid row of each tab ID is kept, with at most eight tabs.
The title replaces ASCII control characters and DEL with spaces, takes the
first 200 UTF-16 units, and then trims. Preserve the selected ID only when
it remains in the admitted rows. Missing arrays are empty.

Snapshot production omits private tabs before asking for their addresses.
It collects up to eight normal tabs with known addresses before the
shared normalization pass. An invalid early candidate can therefore take
up one of those eight slots and then be discarded. Its known URL can come
from an unloaded restored page. Browser-only external pages can also
contribute through Alpha's browser tracking. Visit admission keeps
private navigation out of the supplied visit list.

```quint
type Address = { raw: str, units: int, http: bool, hostname: bool, credentials: bool, forbiddenUnit: bool }
type DecodedTab = { id: str, validId: bool, address: Address, title: str, privateTab: bool }
type SavedSession = { history: List[str], tabs: List[DecodedTab], selected: str }
pure def savedAddress(address: Address): bool =
  address.raw != "" and address.units > 0 and address.units <= 4096 and address.http and address.hostname and not(address.credentials or address.forbiddenUnit)
pure def appendHistory(visits: List[str], address: Address): List[str] =
  if (visits.length() < 100 and savedAddress(address) and not(visits.some(url => url == address.raw))) visits.append(address.raw) else visits
pure def idIn(rows: List[DecodedTab], id: str): bool = rows.some(row => row.id == id)
pure def appendSavedTab(rows: List[DecodedTab], row: DecodedTab): List[DecodedTab] =
  if (rows.length() < 8 and row.validId and savedAddress(row.address) and not(idIn(rows,row.id))) rows.append(row) else rows
pure def appendSnapshotCandidate(rows: List[DecodedTab], row: DecodedTab): List[DecodedTab] =
  if (rows.length() < 8 and not(row.privateTab) and row.address.raw != "") rows.append(row) else rows
pure def normalizeSession(history: List[Address], candidates: List[DecodedTab], preferred: str): SavedSession = {
  val rows = candidates.foldl(List(), appendSavedTab)
  { history: history.foldl(List(), appendHistory), tabs: rows, selected: if (idIn(rows, preferred)) preferred else "" }
}
pure def snapshotSession(history: List[Address], candidates: List[DecodedTab], preferred: str): SavedSession =
  normalizeSession(history, candidates.foldl(List(), appendSnapshotCandidate), preferred)
pure val exampleAddress: Address = { raw: "https://example.test", units: 20, http: true, hostname: true, credentials: false, forbiddenUnit: false }
pure val exampleTab: DecodedTab = { id: "public", validId: true, address: exampleAddress, title: "Public", privateTab: false }
pure val privateExampleTab: DecodedTab = { ...exampleTab, id: "private", privateTab: true }
pure val addressValues = Set(exampleAddress, { ...exampleAddress, credentials: true }, { ...exampleAddress, units: 4097 })
pure val historyValues = Set(List(), List(exampleAddress), List(exampleAddress, exampleAddress))
pure val candidatesValues = Set(List(), List(exampleTab), List(privateExampleTab, exampleTab, exampleTab))
pure val rowsValues = candidatesValues
pure val rowValues = Set(exampleTab, privateExampleTab)
pure val preferredValues = Set("", "public", "private")
pure def lawCredentialsNeverPersist(address: Address): bool = address.credentials implies not(savedAddress(address))
pure def lawPrivateRowIsNotASnapshotCandidate(rows: List[DecodedTab], row: DecodedTab): bool =
  row.privateTab implies appendSnapshotCandidate(rows, row) == rows
pure def lawSelectedRowSurvivesCodec(history: List[Address], candidates: List[DecodedTab], preferred: str): bool = {
  val record = normalizeSession(history, candidates, preferred)
  record.selected != "" implies idIn(record.tabs, record.selected)
}
```

### A late restore preserves the open list and appends only unused identities

Preexisting history takes priority when merging admitted saved history and
the result is capped at 100. A single blank tab with no registered native
tab or metadata and no editing is pristine. The pinned shared helper can
restore history only for a nonpristine shell. Alpha requests normalized
rows from it with the pristine flag, then chooses whether to replace
or append them based on the live view. On a pristine shell with saved
rows, use the saved selection or the first saved row. Otherwise retain the
open list and selection and append unused saved IDs in order up to the
total tab limit, including open private tabs in the capacity check.
An accepted restore installs lazy tabs and never resubmits a historical
request. When shown, a restored page navigates to the retained address.

```quint
type OpenTabs = { ids: List[str], selected: str }
pure def addUnusedId(ids: List[str], id: str): List[str] =
  if (ids.length() < 8 and not(ids.some(openId => openId == id))) ids.append(id) else ids
pure def addRestoredTab(ids: List[str], row: DecodedTab): List[str] = addUnusedId(ids, row.id)
pure def restoreTabIds(openTabs: OpenTabs, record: SavedSession, pristine: bool): OpenTabs =
  if (pristine and record.tabs.length() > 0) {
    ids: record.tabs.listMap(row => row.id),
    selected: if (record.selected != "") record.selected else record.tabs.nthOr(0, exampleTab).id
  }
  else { ...openTabs, ids: record.tabs.foldl(openTabs.ids, addRestoredTab) }
pure def addRestoredVisit(visits: List[str], url: str): List[str] =
  if (visits.length() < 100 and not(visits.some(known => known == url))) visits.append(url) else visits
pure def restoreHistory(visits: List[str], record: SavedSession): List[str] = {
  val first = visits.foldl(List(), (kept, url) => if (kept.length() < 100) kept.append(url) else kept)
  record.history.foldl(first, addRestoredVisit)
}
pure val visitsValues = Set(List(), List("https://example.test"))
pure val idsValues = Set(List(), List("public"), List("private"))
pure val openTabsValues = Set({ ids: List("new"), selected: "new" }, { ids: List("public","private"), selected: "private" })
pure val recordValues = Set(normalizeSession(List(), List(), ""), normalizeSession(List(exampleAddress), List(exampleTab), "public"))
pure val idValues = Set("public", "private", "new")
pure val urlValues = Set("https://example.test", "https://other.test")
pure def lawLateRestoreKeepsCurrent(openTabs: OpenTabs, record: SavedSession): bool =
  restoreTabIds(openTabs, record, false).selected == openTabs.selected
pure def lawDuplicateCannotUseCapacity(ids: List[str], id: str): bool =
  ids.some(openId => openId == id) implies addUnusedId(ids,id) == ids
pure def lawFullViewCannotAppend(ids: List[str], id: str): bool =
  ids.length() >= 8 implies addUnusedId(ids,id) == ids
```

## Story: Clear browsing data without resurrecting earlier snapshots

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
reports a warning. Absolute timer readings and JSON identity comparison
come from the host. Model integers represent equivalent nonempty encoded
snapshots, including the empty browsing session. Zero is absence of a
snapshot identity.

Clear starts only with a confirmed live action. It advances the generation,
pauses new saves, retires pending old writes, and drains the write already
issued before sending the native clear. The UI waits for publication of
the cleared view before unpausing. A failure leaves the current view and
permits saving it again. A successful clear establishes the new baseline
without another write. The closure and native receipt report proof of
durable clear and retained private tabs. Tab removal itself belongs to
the browser host, and does not share its authority with a save receipt.

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
pure val weight_startRestore = 5
pure val weight_finishRestore = 7
pure val weight_queueSave = 8
pure val weight_dispatchSave = 8
pure val weight_finishSave = 8
pure val weight_askClear = 4
pure val weight_sendClear = 6
pure val weight_finishClear = 6
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

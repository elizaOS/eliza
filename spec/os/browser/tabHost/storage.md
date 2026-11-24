# Browser tab host storage

The native tab host keeps the saved browsing session (normal tabs, history
and the selected tab) and the bookmarks of its persistent normal profile,
and clears that profile's browsing data. Private tabs never reach this
store. Every saved session, read or written by the native host or the
renderer, goes through the one codec below, and every address goes through
the web-address test of [the address spec](../address.md). The shell seals
each record under the host's key, commits it synchronously, turns control
characters in a title into spaces, and lets the renderer cut a title to
200 units; the native host keeps the whole title. A missing record reads as
empty; a session record that cannot be opened is refused and left as it is.
The tab document spec (`tabHost/document`) decides which tab may contribute.

## Story: Keep my normal tabs and history across restarts

> As a person browsing, I want my normal tabs and history saved as I left
> them, so that a restart loses nothing I chose to keep and never brings
> back a private tab or an address with my credentials.

### An address is saved only when it is a web address of at most 4,096 units, and bookmarked only over HTTPS

```quint
import address.* from "../address"
pure val savedAddressUnitsLimit = 4096
pure def savedAddress(address: WebAddress): bool = isWebAddress(address) and address.units <= savedAddressUnitsLimit
pure def bookmarkAddress(address: WebAddress): bool = savedAddress(address) and isSecureWebAddress(address)
pure def lawNoCredentialOrOtherSchemeIsSaved(address: WebAddress): bool =
  (address.userInfo or address.scheme == OtherScheme or address.units > savedAddressUnitsLimit) implies not(savedAddress(address))
```

### A saved session keeps the first valid row of each tab and address

A row needs a tab ID of 1 to 80 letters, digits, underscores or dashes,
which the shell reads as `validId`, and a saved address. A private or
invalid row is dropped before deduplication, so it reserves no ID. History keeps the first occurrence of each saved address, in order.
The native codec keeps every such row; the renderer codec keeps at most
eight tabs and 100 history entries. The selection survives only when its
tab does.

```quint
type SavedTab = { id: str, validId: bool, address: WebAddress, privateTab: bool }
type SavedSession = { history: List[WebAddress], tabs: List[SavedTab], selected: str }
type SessionCodec = NativeCodec | RendererCodec
pure val maxSavedTabs = 8
pure val maxSavedHistory = 100
pure val emptySession: SavedSession = { history: List(), tabs: List(), selected: "" }
pure def underCap(codec: SessionCodec, count: int, cap: int): bool = codec == NativeCodec or count < cap
pure def hasTab(tabs: List[SavedTab], id: str): bool = tabs.some(t => t.id == id)
pure def mayKeepTab(rows: List[SavedTab], row: SavedTab): bool =
  not(row.privateTab) and row.validId and savedAddress(row.address) and not(hasTab(rows, row.id))
pure def keepTab(codec: SessionCodec, rows: List[SavedTab], row: SavedTab): List[SavedTab] =
  if (underCap(codec, rows.length(), maxSavedTabs) and mayKeepTab(rows, row)) rows.append(row) else rows
pure def keepVisit(codec: SessionCodec, kept: List[WebAddress], address: WebAddress): List[WebAddress] =
  if (underCap(codec, kept.length(), maxSavedHistory) and savedAddress(address) and not(kept.some(v => v.href == address.href))) kept.append(address) else kept
pure def normalizeSession(codec: SessionCodec, record: SavedSession): SavedSession = {
  val kept = record.tabs.foldl(List(), (rows, row) => keepTab(codec, rows, row))
  { history: record.history.foldl(List(), (visits, a) => keepVisit(codec, visits, a)), tabs: kept,
    selected: if (hasTab(kept, record.selected)) record.selected else "" }
}
pure val unknownAddress: WebAddress = { href: "", units: 0, cleanText: true, scheme: OtherScheme, validHost: false, userInfo: false }
pure val publicRow: SavedTab = { id: "public", validId: true, address: secureAddress, privateTab: false }
pure val privateRow: SavedTab = { ...publicRow, id: "private", privateTab: true }
pure val rowValues = Set(publicRow, privateRow, { ...publicRow, address: { ...secureAddress, userInfo: true } }, { ...publicRow, validId: false })
pure val rowsValues = Set(List(), List(publicRow))
pure val recordValues = Set(emptySession,
  { history: List(secureAddress, secureAddress), tabs: List(privateRow, publicRow, publicRow), selected: "public" },
  { history: List(), tabs: List(privateRow), selected: "private" })
pure def lawOnlyAdmittedRowsAreKept(codec: SessionCodec, rows: List[SavedTab], row: SavedTab): bool =
  keepTab(codec, rows, row) != rows implies mayKeepTab(rows, row)
pure def lawNativeCodecHasNoCountCutoff(rows: List[SavedTab], row: SavedTab): bool =
  mayKeepTab(rows, row) implies keepTab(NativeCodec, rows, row) == rows.append(row)
pure def lawRendererCodecKeepsAtMostEightTabs(rows: List[SavedTab], row: SavedTab): bool =
  rows.length() <= maxSavedTabs implies keepTab(RendererCodec, rows, row).length() <= maxSavedTabs
pure def lawSelectionNamesAKeptTab(codec: SessionCodec, record: SavedSession): bool = {
  val canonical = normalizeSession(codec, record)
  canonical.selected != "" implies hasTab(canonical.tabs, canonical.selected)
}
```

### A visit time is kept only for a kept history address, as a positive whole number of milliseconds

A saved session may carry the time each history address was last visited,
so that the history can be shown by day. Either codec keeps a time only
for an address its history kept, the first one given for that address, and
only when it is a whole number of milliseconds from 1 to
9,007,199,254,740,991. A session with no kept time carries none, and a
restore offers the saved times of the history it merged.

```quint
type VisitTime = { visited: str, millis: int }
pure val maxVisitMillis = 9007199254740991
pure def mayKeepVisitTime(hrefs: List[str], keptTimes: List[VisitTime], stamp: VisitTime): bool =
  stamp.millis > 0 and stamp.millis <= maxVisitMillis and hrefs.includes(stamp.visited) and not(keptTimes.some(k => k.visited == stamp.visited))
pure def keepVisitTime(hrefs: List[str], keptTimes: List[VisitTime], stamp: VisitTime): List[VisitTime] =
  if (mayKeepVisitTime(hrefs, keptTimes, stamp)) keptTimes.append(stamp) else keptTimes
pure def retainedVisitTimes(hrefs: List[str], stamps: List[VisitTime]): List[VisitTime] =
  stamps.foldl(List(), (held, seen) => keepVisitTime(hrefs, held, seen))
pure val keptVisit: VisitTime = { visited: "https://example.test/", millis: 5 }
pure val hrefsValues = Set(List(), List("https://example.test/"))
pure val keptTimesValues = Set(List(), List(keptVisit))
pure val stampValues = Set(keptVisit, { ...keptVisit, millis: 0 }, { ...keptVisit, visited: "https://other.test/" })
pure def lawOnlyATimeOfKeptHistoryIsKept(hrefs: List[str], keptTimes: List[VisitTime], stamp: VisitTime): bool =
  keepVisitTime(hrefs, keptTimes, stamp) != keptTimes implies (hrefs.includes(stamp.visited) and stamp.millis > 0 and stamp.millis <= maxVisitMillis)
pure def lawNoHistoryKeepsNoVisitTime(keptTimes: List[VisitTime], stamp: VisitTime): bool = keepVisitTime(List(), keptTimes, stamp) == keptTimes
pure def lawTheFirstTimeOfAnAddressWins(hrefs: List[str], keptTimes: List[VisitTime], stamp: VisitTime): bool =
  keptTimes.some(k => k.visited == stamp.visited) implies keepVisitTime(hrefs, keptTimes, stamp) == keptTimes
```

### A snapshot offers the codec at most eight normal tabs whose address is known

The renderer skips private tabs before it asks for their address, and
offers up to eight normal tabs with a known address, in order; the codec
then drops any that are invalid, so an invalid early candidate can take one
of the eight places. A known address can come from a restored tab that has
not loaded yet.

```quint
pure def offerCandidate(rows: List[SavedTab], row: SavedTab): List[SavedTab] =
  if (rows.length() < maxSavedTabs and not(row.privateTab) and row.address.href != "") rows.append(row) else rows
pure def snapshotSession(record: SavedSession): SavedSession =
  normalizeSession(RendererCodec, { ...record, tabs: record.tabs.foldl(List(), (rows, row) => offerCandidate(rows, row)) })
pure def lawSnapshotOffersAtMostEightNormalTabs(rows: List[SavedTab], row: SavedTab): bool =
  (rows.length() <= maxSavedTabs implies offerCandidate(rows, row).length() <= maxSavedTabs) and
    (row.privateTab implies offerCandidate(rows, row) == rows)
```

### Only the bridge session that first used the store may use it

Every call names the native bridge's session; the first call binds it and
a different session is refused. A save is refused while a clear runs. A
record counts as committed only when it seals within its limit (2,000,000
bytes for the session, 800,000 for the bookmarks) and the synchronous
commit succeeds; an uncommitted save leaves the stored session as it was,
and the store holds the native codec's form of what was committed.

```quint
type ClearState = NoClear | ClearingSiteData | Cleared | ClearFailed({ sessionDeleted: bool })
type BookmarkName = Untitled | BookmarkTitle({ text: str, units: int, cleanText: bool })
type BookmarkEntry = { url: str, title: BookmarkName }
type Bookmarks = BookmarksUnread | BookmarksIntact({ entries: List[BookmarkEntry] }) | BookmarksDamaged
type RestoreOutcome = NotRestored | ReplacedNewTab | MergedHistoryOnly
type NativeBrowserStore = { session: int, clear: ClearState, saved: SavedSession, bookmarks: Bookmarks, lastRestore: RestoreOutcome }
pure val initial: NativeBrowserStore = { session: 0, clear: NoClear, saved: emptySession, bookmarks: BookmarksUnread, lastRestore: NotRestored }
pure def owns(s: NativeBrowserStore, ticket: int): bool = ticket > 0 and (s.session == 0 or s.session == ticket)
pure def canSaveSession(s: NativeBrowserStore, ticket: int): bool = owns(s, ticket) and s.clear != ClearingSiteData
pure def saveSession(s: NativeBrowserStore, ticket: int, record: SavedSession, committed: bool): NativeBrowserStore =
  { ...s, session: ticket, saved: if (committed) normalizeSession(NativeCodec, record) else s.saved }
pure val ticketValues = Set(0, 1, 2)
pure def stepBoundSessionNeverChanges(before: NativeBrowserStore, after: NativeBrowserStore): bool =
  before.session != 0 implies after.session == before.session
pure def sometimesSessionSaved(s: NativeBrowserStore): bool = s.saved.tabs.length() > 0
```

## Story: Restore my tabs only when nothing is open

> As a person opening the browser, I want my saved tabs back only when I
> have not started browsing yet, so that a slow restore never replaces or
> duplicates what I am using.

### Saved tabs replace only an untouched single new tab, and otherwise only history is merged

The renderer passes the saved record through its own codec. A view that
holds only one untouched new tab, with no metadata or editing, is pristine:
the saved tabs replace it, selecting the saved selection or else the first
saved tab. Any other view keeps its tabs and selection and restores no tab.
In both, the view's history comes first and the saved addresses it lacks
follow, up to 100. A restored tab loads its address only when it is shown,
with an ordinary request.

```quint
type Restore = { visits: List[str], restored: List[SavedTab], selected: str }
pure def mergeHistory(visits: List[str], record: SavedSession): List[str] = {
  val first = visits.foldl(List(), (kept, url) => if (kept.length() < maxSavedHistory) kept.append(url) else kept)
  record.history.foldl(first, (kept, a) => if (kept.length() < maxSavedHistory and not(kept.includes(a.href))) kept.append(a.href) else kept)
}
pure def restoreSession(record: SavedSession, visits: List[str], pristine: bool): Restore = {
  val canonical = normalizeSession(RendererCodec, record)
  val merged = mergeHistory(visits, canonical)
  if (pristine and canonical.tabs.length() > 0)
    { visits: merged, restored: canonical.tabs,
      selected: if (canonical.selected != "") canonical.selected else canonical.tabs.nthOr(0, publicRow).id }
  else { visits: merged, restored: List(), selected: "" }
}
pure def canRestore(s: NativeBrowserStore, ticket: int): bool = owns(s, ticket)
pure def restore(s: NativeBrowserStore, ticket: int, pristine: bool): NativeBrowserStore =
  { ...s, session: ticket, lastRestore: if (restoreSession(s.saved, List(), pristine).restored.length() > 0) ReplacedNewTab else MergedHistoryOnly }
pure val visitsValues = Set(List(), List("https://example.test/"))
pure def lawOpenViewRestoresNoTab(record: SavedSession, visits: List[str]): bool =
  restoreSession(record, visits, false).restored == List()
pure def lawRestoredSelectionIsARestoredTab(record: SavedSession, visits: List[str], pristine: bool): bool = {
  val result = restoreSession(record, visits, pristine)
  result.restored.length() > 0 implies hasTab(result.restored, result.selected)
}
pure def sometimesTabsRestored(s: NativeBrowserStore): bool = s.lastRestore == ReplacedNewTab
pure def sometimesOnlyHistoryMerged(s: NativeBrowserStore): bool = s.lastRestore == MergedHistoryOnly and s.saved.tabs.length() > 0
```

## Story: Keep my bookmarks whole

> As a person keeping bookmarks, I want them read and written as one whole
> list, so that a damaged record or a failed write never costs me the ones
> I already have, including the titles I chose to keep.

### A bookmark list is read whole, and a damaged record is never replaced

The first read takes the whole record. A record that cannot be opened,
holds more than 100 addresses, an address that is not a bookmark address,
or one address twice, is damaged: every later read and change is refused
and the record stays as it is. The addresses keep their installed sealed
format. Optional sealed titles name the exact sealed address record they
describe, in the same order. An earlier build can still open the addresses.
After an earlier build writes a new sealed address record, old titles are
ignored. Titles in a matching record must be well formed. A title record
that cannot be opened makes the list damaged. Earlier records can also
contain titles beside their addresses in the same sealed list. A read keeps
those titles. The next successful change writes the address-only format
with separate sealed titles.

```quint
type BookmarkTitles = NoTitles | OlderTitles | DamagedTitles | CurrentTitles({ names: List[BookmarkName] })
type BookmarkRecord = { readable: bool, urls: List[WebAddress], titles: BookmarkTitles }
pure val maxBookmarks = 100
pure val maxBookmarkTitleUnits = 300
pure def validBookmarkTitle(title: BookmarkName): bool = match title {
  | Untitled => true
  | BookmarkTitle(name) => name.cleanText and name.text != "" and name.units > 0 and name.units <= maxBookmarkTitleUnits
}
pure def wholeBookmarkTitles(found: BookmarkRecord): bool = {
  val stored = found.titles
  match stored {
    | DamagedTitles => false
    | CurrentTitles(titles) => titles.names.length() == found.urls.length() and titles.names.every(validBookmarkTitle)
    | _ => true
  }
}
pure def wholeBookmarks(found: BookmarkRecord): bool =
  found.readable and wholeBookmarkTitles(found) and found.urls.length() <= maxBookmarks and found.urls.every(a => bookmarkAddress(a)) and
    found.urls.foldl(Set(), (hrefs, a) => hrefs.union(Set(a.href))).size() == found.urls.length()
pure def storedBookmarkEntries(found: BookmarkRecord): List[BookmarkEntry] = {
  val stored = found.titles
  val titles = match stored { | CurrentTitles(current) => current.names | _ => List() }
  found.urls.foldl(List(), (entries, address) => entries.append({ url: address.href, title: titles.nthOr(entries.length(), Untitled) }))
}
pure def canReadBookmarks(s: NativeBrowserStore, ticket: int): bool = owns(s, ticket) and s.bookmarks == BookmarksUnread
pure def readBookmarks(s: NativeBrowserStore, ticket: int, found: BookmarkRecord): NativeBrowserStore =
  { ...s, session: ticket, bookmarks: if (wholeBookmarks(found)) BookmarksIntact({ entries: storedBookmarkEntries(found) }) else BookmarksDamaged }
pure val exampleBookmarkTitle: BookmarkName = BookmarkTitle({ text: "Example", units: 7, cleanText: true })
pure val foundValues = Set({ readable: true, urls: List(), titles: NoTitles }, { readable: false, urls: List(), titles: NoTitles },
  { readable: true, urls: List(secureAddress, secureAddress), titles: NoTitles },
  { readable: true, urls: List({ ...secureAddress, scheme: HttpScheme }), titles: NoTitles },
  { readable: true, urls: List(secureAddress), titles: OlderTitles },
  { readable: true, urls: List(secureAddress), titles: DamagedTitles },
  { readable: true, urls: List(secureAddress), titles: CurrentTitles({ names: List(exampleBookmarkTitle) }) })
pure def stepDamagedBookmarksStayDamaged(before: NativeBrowserStore, after: NativeBrowserStore): bool =
  before.bookmarks == BookmarksDamaged implies after.bookmarks == BookmarksDamaged
pure def sometimesBookmarksDamaged(s: NativeBrowserStore): bool = s.bookmarks == BookmarksDamaged
pure def lawAnOlderAddressWriteDoesNotRecoverOldTitles(found: BookmarkRecord): bool =
  found.titles == OlderTitles implies storedBookmarkEntries(found).every(entry => entry.title == Untitled)
```

### A bookmark change moves its address to the front or removes it, keeps at most 100, and is kept only when its commit succeeded

Removal uses the exact address. A present bookmark can move to the front
even at 100; a new one at 100 is refused. Saving without a title keeps the
existing title, a blank title clears it, and removal discards it. The host
turns title control characters into spaces, trims surrounding whitespace,
and keeps at most 300 UTF-16 units without splitting a surrogate pair.
Both sealed parts change in the same synchronous commit. The bridge still
returns the ordered addresses and also returns the entries with any titles.

```quint
type BookmarkTitleUpdate = KeepTitle | ReplaceTitle({ title: BookmarkName })
pure def changeBookmarks(entries: List[BookmarkEntry], href: str, keep: bool, titleUpdate: BookmarkTitleUpdate): List[BookmarkEntry] = {
  val rest = entries.select(row => row.url != href)
  val previous = entries.select(row => row.url == href).nthOr(0, { url: href, title: Untitled })
  val title = match titleUpdate { | KeepTitle => previous.title | ReplaceTitle(update) => update.title }
  if (keep) List({ url: href, title: title }).concat(rest) else rest
}
pure def bookmarkEntries(s: NativeBrowserStore): List[BookmarkEntry] = {
  val stored = s.bookmarks
  match stored { | BookmarksIntact(b) => b.entries | _ => List() }
}
pure def bookmarksIntact(s: NativeBrowserStore): bool = {
  val stored = s.bookmarks
  match stored { | BookmarksIntact(b) => true | _ => false }
}
pure def canSetBookmark(s: NativeBrowserStore, ticket: int, address: WebAddress, keep: bool, titleUpdate: BookmarkTitleUpdate): bool =
  (not(keep) or match titleUpdate { | KeepTitle => true | ReplaceTitle(update) => validBookmarkTitle(update.title) }) and
  owns(s, ticket) and bookmarkAddress(address) and bookmarksIntact(s) and
    changeBookmarks(bookmarkEntries(s), address.href, keep, titleUpdate).length() <= maxBookmarks
pure def setBookmark(s: NativeBrowserStore, ticket: int, address: WebAddress, keep: bool, titleUpdate: BookmarkTitleUpdate, committed: bool): NativeBrowserStore =
  { ...s, session: ticket,
    bookmarks: if (committed) BookmarksIntact({ entries: changeBookmarks(bookmarkEntries(s), address.href, keep, titleUpdate) }) else s.bookmarks }
pure val titleUpdateValues = Set(KeepTitle, ReplaceTitle({ title: Untitled }), ReplaceTitle({ title: exampleBookmarkTitle }))
pure def alwaysBookmarksWithinLimit(s: NativeBrowserStore): bool = bookmarkEntries(s).length() <= maxBookmarks
pure def sometimesBookmarkKept(s: NativeBrowserStore): bool = bookmarkEntries(s).length() > 0
pure def sometimesBookmarkTitleKept(s: NativeBrowserStore): bool = bookmarkEntries(s).some(entry => entry.title != Untitled)
```

## Story: Clear my browsing data for good

> As a person clearing my browsing data, I want my normal tabs, history and
> site data gone, and my private tabs and bookmarks kept, so that a clear
> does what it says and is never reported done when it was not.

### A clear deletes the saved session before the site data, and is reported cleared only when both are gone

A clear needs the bound session, a WebView that supports profiles and
deleting browsing data, and no clear already running. The host closes the
open normal tabs, then deletes the saved session, the website permissions
and the download history, then the profile's cookies and storage. The steps
are ordered, not atomic: a failure keeps what was already deleted and
reports the clear failed. No session is saved while the site data is being
deleted. Private tabs and bookmarks are not touched.

```quint
pure def canBeginClear(s: NativeBrowserStore, ticket: int, webViewCanDelete: bool): bool =
  owns(s, ticket) and webViewCanDelete and s.clear != ClearingSiteData
pure def beginClear(s: NativeBrowserStore, ticket: int, webViewCanDelete: bool, sessionDeleted: bool, othersDeleted: bool): NativeBrowserStore =
  { ...s, session: ticket, saved: if (sessionDeleted) emptySession else s.saved,
    clear: if (sessionDeleted and othersDeleted) ClearingSiteData else ClearFailed({ sessionDeleted: sessionDeleted }) }
pure def canFinishClear(s: NativeBrowserStore): bool = s.clear == ClearingSiteData
pure def finishClear(s: NativeBrowserStore, siteDataDeleted: bool): NativeBrowserStore =
  { ...s, clear: if (siteDataDeleted) Cleared else ClearFailed({ sessionDeleted: true }) }
pure def alwaysClearingHoldsNoSavedSession(s: NativeBrowserStore): bool = s.clear == ClearingSiteData implies s.saved == emptySession
pure def stepClearedOnlyAfterSiteDataDeletion(before: NativeBrowserStore, after: NativeBrowserStore): bool =
  (after.clear == Cleared and before.clear != Cleared) implies before.clear == ClearingSiteData
pure def stepClearKeepsBookmarks(before: NativeBrowserStore, via: str, after: NativeBrowserStore): bool =
  (via == "beginClear" or via == "finishClear") implies after.bookmarks == before.bookmarks
pure def sometimesCleared(s: NativeBrowserStore): bool = s.clear == Cleared
pure def sometimesClearFailedAfterSessionDeleted(s: NativeBrowserStore): bool = s.clear == ClearFailed({ sessionDeleted: true })
```

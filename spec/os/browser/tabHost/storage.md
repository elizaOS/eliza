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
import atomicPublication as P from "../../../core/atomicPublication"
pure val savedAddressUnitsLimit = 4096
pure def savedAddress(address: WebAddress): bool = isWebAddress(address) and address.units <= savedAddressUnitsLimit
pure def bookmarkAddress(address: WebAddress): bool = savedAddress(address) and isSecureWebAddress(address)
pure def lawNoCredentialOrOtherSchemeIsSaved(address: WebAddress): bool =
  (address.userInfo or address.scheme == OtherScheme or address.units > savedAddressUnitsLimit) implies not(savedAddress(address))
```

### A saved session keeps the first valid row of each tab and address

A row needs a tab ID of 1 to 80 letters, digits, underscores or dashes,
which the shell reads as `validId`, and a saved address. A private, invalid
or duplicate row is dropped before deduplication, so a dropped row reserves
no ID. History keeps the first occurrence of each saved address, in order.
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

### Only the bridge session that first used the store may use it, and a save is kept only when its commit succeeded

Every call names the native bridge's session; the first call binds it and
a different session is refused. A save is refused while a clear runs.
The store holds the native codec's form of what was committed.

```quint
type ClearState = NoClear | ClearingSiteData | Cleared | ClearFailed({ sessionDeleted: bool })
type Bookmarks = BookmarksUnread | BookmarksIntact({ urls: List[str] }) | BookmarksDamaged
type RestoreOutcome = NotRestored | ReplacedNewTab | MergedHistoryOnly
type NativeBrowserStore = { session: int, clear: ClearState, saved: SavedSession, bookmarks: Bookmarks, lastRestore: RestoreOutcome }
pure val initial: NativeBrowserStore = { session: 0, clear: NoClear, saved: emptySession, bookmarks: BookmarksUnread, lastRestore: NotRestored }
pure def owns(s: NativeBrowserStore, ticket: int): bool = ticket > 0 and (s.session == 0 or s.session == ticket)
pure def committed(receipt: P::PublicationReceipt): bool = receipt == P::SuccessReceipt
pure def canSaveSession(s: NativeBrowserStore, ticket: int, receipt: P::PublicationReceipt): bool =
  owns(s, ticket) and s.clear != ClearingSiteData and (receipt == P::SuccessReceipt or receipt == P::FailureReceipt)
pure def saveSession(s: NativeBrowserStore, ticket: int, record: SavedSession, receipt: P::PublicationReceipt): NativeBrowserStore =
  { ...s, session: ticket, saved: if (committed(receipt)) normalizeSession(NativeCodec, record) else s.saved }
pure val ticketValues = Set(0, 1, 2)
pure val receiptValues = Set(P::SuccessReceipt, P::FailureReceipt)
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
> I already have.

### A bookmark list is read whole, and a damaged record is never replaced

The first read takes the whole record. A record that cannot be opened,
holds more than 100 addresses, an address that is not a bookmark address,
or one address twice, is damaged: every later read and change is refused
and the record stays as it is.

```quint
type BookmarkRecord = { readable: bool, urls: List[WebAddress] }
pure val maxBookmarks = 100
pure def wholeBookmarks(found: BookmarkRecord): bool =
  found.readable and found.urls.length() <= maxBookmarks and found.urls.every(a => bookmarkAddress(a)) and
    found.urls.foldl(Set(), (hrefs, a) => hrefs.union(Set(a.href))).size() == found.urls.length()
pure def canReadBookmarks(s: NativeBrowserStore, ticket: int): bool = owns(s, ticket) and s.bookmarks == BookmarksUnread
pure def readBookmarks(s: NativeBrowserStore, ticket: int, found: BookmarkRecord): NativeBrowserStore =
  { ...s, session: ticket, bookmarks: if (wholeBookmarks(found)) BookmarksIntact({ urls: found.urls.listMap(a => a.href) }) else BookmarksDamaged }
pure val foundValues = Set({ readable: true, urls: List() }, { readable: false, urls: List() },
  { readable: true, urls: List(secureAddress, secureAddress) }, { readable: true, urls: List({ ...secureAddress, scheme: HttpScheme }) })
pure def stepDamagedBookmarksStayDamaged(before: NativeBrowserStore, after: NativeBrowserStore): bool =
  before.bookmarks == BookmarksDamaged implies after.bookmarks == BookmarksDamaged
pure def sometimesBookmarksDamaged(s: NativeBrowserStore): bool = s.bookmarks == BookmarksDamaged
```

### A bookmark change moves its address to the front or removes it, keeps at most 100, and is kept only when its commit succeeded

Removal uses the exact address. A present bookmark can move to the front
even at 100; a new one at 100 is refused.

```quint
pure def changeBookmarks(urls: List[str], href: str, keep: bool): List[str] = {
  val rest = urls.select(u => u != href)
  if (keep) List(href).concat(rest) else rest
}
pure def bookmarkUrls(s: NativeBrowserStore): List[str] = {
  val stored = s.bookmarks
  match stored { | BookmarksIntact(b) => b.urls | _ => List() }
}
pure def bookmarksIntact(s: NativeBrowserStore): bool = {
  val stored = s.bookmarks
  match stored { | BookmarksIntact(b) => true | _ => false }
}
pure def canSetBookmark(s: NativeBrowserStore, ticket: int, address: WebAddress, keep: bool, receipt: P::PublicationReceipt): bool =
  owns(s, ticket) and bookmarkAddress(address) and (receipt == P::SuccessReceipt or receipt == P::FailureReceipt) and
    bookmarksIntact(s) and changeBookmarks(bookmarkUrls(s), address.href, keep).length() <= maxBookmarks
pure def setBookmark(s: NativeBrowserStore, ticket: int, address: WebAddress, keep: bool, receipt: P::PublicationReceipt): NativeBrowserStore =
  { ...s, session: ticket,
    bookmarks: if (committed(receipt)) BookmarksIntact({ urls: changeBookmarks(bookmarkUrls(s), address.href, keep) }) else s.bookmarks }
pure def alwaysBookmarksWithinLimit(s: NativeBrowserStore): bool = bookmarkUrls(s).length() <= maxBookmarks
pure def sometimesBookmarkKept(s: NativeBrowserStore): bool = bookmarkUrls(s).length() > 0
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

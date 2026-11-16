# Browser session, bookmarks and origin-scoped storage

The native browser host keeps the saved browsing session, bookmarks and
site data of its normal profile, and purges keyed profiles. Every saved
session, native or renderer, goes through the one codec and the one
origin parser below. [Session restore](./sessionRestore.md) owns the
renderer's save queue and the merge into a running view, and
[document custody](./documentCustody.md) decides which tab may contribute.

## Story: Restore my saved normal-profile session

> As the person, I want my normal browsing tabs and history restored as I
> left them, so that a restart loses nothing I chose to keep and never
> brings back a private tab.

### An address is saved or bookmarked only when the origin parser admits it

The origin parser allows HTTP and HTTPS only, requires a host without
credentials and with no space, control character, backslash or DEL, and
parses only the scheme and authority, with an optional port of at most
65,535; the port a scheme implies is omitted. It bounds its input at
8,192 units, a saved address at 4,096, and a bookmark must be HTTPS.
Site filtering compares the canonical host with the exact site or a
dot-delimited subdomain of it; scheme and port do not matter there.

```quint
type WebScheme = ClearHttp | SecureHttps | OtherScheme
type WebAddress = { raw: str, units: int, scheme: WebScheme, hostQualified: bool, userInfo: bool, cleanText: bool, authorityParses: bool, port: int }
type SiteRelation = ExactHost | DotSubdomain | DifferentHost
pure val originUnitsLimit = 8192
pure val savedAddressUnitsLimit = 4096
pure def webOriginAllowed(address: WebAddress): bool =
  address.units > 0 and address.units <= originUnitsLimit and address.scheme != OtherScheme and address.hostQualified and
  not(address.userInfo) and address.cleanText and address.authorityParses and address.port <= 65535
pure def savedAddress(address: WebAddress): bool = address.raw != "" and address.units <= savedAddressUnitsLimit and webOriginAllowed(address)
pure def bookmarkAddress(address: WebAddress): bool = savedAddress(address) and address.scheme == SecureHttps
pure def effectivePort(scheme: WebScheme, port: int): int =
  if (port < 0 or (scheme == SecureHttps and port == 443) or (scheme == ClearHttp and port == 80)) -1 else port
pure def siteMatches(originUsable: bool, sitePresent: bool, relation: SiteRelation): bool = originUsable and sitePresent and relation != DifferentHost
pure val publicAddress: WebAddress = { raw: "https://example.test", units: 20, scheme: SecureHttps, hostQualified: true, userInfo: false, cleanText: true, authorityParses: true, port: -1 }
pure val addressValues = Set(publicAddress, { ...publicAddress, raw: "https://other.test" }, { ...publicAddress, userInfo: true },
  { ...publicAddress, units: 4097 }, { ...publicAddress, cleanText: false }, { ...publicAddress, scheme: ClearHttp, port: 8443 },
  { ...publicAddress, raw: "file:///local", scheme: OtherScheme })
pure def lawCredentialsNeverPersist(address: WebAddress): bool = address.userInfo implies not(savedAddress(address))
pure def lawOversizedAddressNeverPersists(address: WebAddress): bool = address.units > savedAddressUnitsLimit implies not(savedAddress(address))
pure def lawBookmarkRequiresHttps(address: WebAddress): bool = address.scheme != SecureHttps implies not(bookmarkAddress(address))
pure def lawDifferentDomainNeverMatches(originUsable: bool, sitePresent: bool): bool = not(siteMatches(originUsable, sitePresent, DifferentHost))
```

### A saved session keeps the first valid row of each tab and address

Reading and writing the saved `{history, tabs, selected}` record both go
through one codec. A tab needs an ID of 1 to 80 letters, digits,
underscores or dashes and a saved address; a private, invalid or
duplicate row is dropped, and dropping precedes deduplication, so a
dropped row reserves no ID. The first valid row of each ID is kept, and
history keeps the first occurrence of each admitted address, in order.
The native host keeps every such tab with its full title and every such
address: its only bound is the sealed write budget. The renderer keeps at
most eight tabs, cuts each title to 200 units and keeps at most 100
history entries. The selection survives only when its tab does. A visit
recorded natively moves the exact address to the front; a private or
invalid visit leaves history unchanged.

```quint
type SavedTab = { id: str, validId: bool, address: WebAddress, titleUnits: int, privateTab: bool }
type SavedSession = { history: List[str], tabs: List[SavedTab], selected: str }
type VisitMove = { skipped: bool, kept: List[str] }
type SessionCodec = NativeCodec | RendererCodec
pure val maxSavedTabs = 8
pure val maxSavedHistory = 100
pure val maxTitleUnits = 200
pure def underCap(codec: SessionCodec, count: int, cap: int): bool = codec == NativeCodec or count < cap
pure def savedTitle(codec: SessionCodec, units: int): int = if (codec == RendererCodec and units > maxTitleUnits) maxTitleUnits else units
pure def hasTab(tabs: List[SavedTab], id: str): bool = tabs.some(t => t.id == id)
pure def mayKeepTab(tabs: List[SavedTab], row: SavedTab): bool =
  not(row.privateTab) and row.validId and savedAddress(row.address) and not(hasTab(tabs, row.id))
pure def keepTab(codec: SessionCodec, tabs: List[SavedTab], row: SavedTab): List[SavedTab] =
  if (underCap(codec, tabs.length(), maxSavedTabs) and mayKeepTab(tabs, row)) tabs.append({ ...row, titleUnits: savedTitle(codec, row.titleUnits) }) else tabs
pure def keepVisit(codec: SessionCodec, visits: List[str], url: str): List[str] =
  if (underCap(codec, visits.length(), maxSavedHistory) and url != "" and not(visits.includes(url))) visits.append(url) else visits
pure def keepAddress(codec: SessionCodec, visits: List[str], address: WebAddress): List[str] = if (savedAddress(address)) keepVisit(codec, visits, address.raw) else visits
pure def normalizeSession(codec: SessionCodec, history: List[WebAddress], tabs: List[SavedTab], preferred: str): SavedSession = {
  val kept = tabs.foldl(List(), (rows, row) => keepTab(codec, rows, row))
  { history: history.foldl(List(), (visits, address) => keepAddress(codec, visits, address)), tabs: kept, selected: if (hasTab(kept, preferred)) preferred else "" }
}
pure def recordVisit(visits: List[str], url: str, valid: bool, ephemeral: bool): List[str] = {
  val relocatedVisit: VisitMove = visits.foldl({ skipped: false, kept: List(url) }, (walk, prior) =>
    if (not(walk.skipped) and prior == url) { ...walk, skipped: true } else { ...walk, kept: walk.kept.append(prior) })
  if (ephemeral or not(valid) or url == "") visits else relocatedVisit.kept
}
pure val publicTab: SavedTab = { id: "public", validId: true, address: publicAddress, titleUnits: 250, privateTab: false }
pure val rowValues = Set(publicTab, { ...publicTab, id: "private", privateTab: true }, { ...publicTab, address: { ...publicAddress, userInfo: true } })
pure val tabsValues = Set(List(), List(publicTab), List({ ...publicTab, id: "private", privateTab: true }, publicTab, publicTab))
pure val historyValues = Set(List(), List(publicAddress), List(publicAddress, publicAddress))
pure val preferredValues = Set("", "public", "private")
pure val visitsValues = Set(List(), List("https://example.test"))
pure val urlValues = Set("https://example.test", "https://other.test")
pure val codecValues = Set(NativeCodec, RendererCodec)
pure def lawPrivateTabNeverSaved(codec: SessionCodec, tabs: List[SavedTab], row: SavedTab): bool = row.privateTab implies keepTab(codec, tabs, row) == tabs
pure def lawNativeKeepsEveryFirstTabWithItsFullTitle(tabs: List[SavedTab], row: SavedTab): bool =
  mayKeepTab(tabs, row) implies keepTab(NativeCodec, tabs, row) == tabs.append(row)
pure def lawNativeHistoryHasNoCountCutoff(visits: List[str], url: str): bool =
  (url != "" and not(visits.includes(url))) implies keepVisit(NativeCodec, visits, url) == visits.append(url)
pure def lawRendererTitleIsBounded(tabs: List[SavedTab], row: SavedTab): bool = keepTab(RendererCodec, tabs, row).every(t => tabs.includes(t) or t.titleUnits <= maxTitleUnits)
pure def lawSelectedRowSurvivesCodec(codec: SessionCodec, history: List[WebAddress], tabs: List[SavedTab], preferred: str): bool = {
  val record = normalizeSession(codec, history, tabs, preferred)
  record.selected != "" implies hasTab(record.tabs, record.selected)
}
pure def lawPrivateVisitLeavesHistory(visits: List[str], url: str, valid: bool): bool = recordVisit(visits, url, valid, true) == visits
```

## Story: Keep bookmarks durable and clear only the browser data I selected

> As the person, I want my bookmarks kept intact and only the browsing
> data I chose cleared, so that a damaged store or a partial clear never
> costs me what I meant to keep.

### A bookmark list is read and written whole, and only a sealed commit is stored

The session and the bookmarks are each sealed and committed synchronously;
only a committed seal within its plaintext limit, 2,000,000 bytes for the
session and 800,000 for bookmarks, is a saved receipt. A missing session
reads as empty; an unreadable one is refused. Missing or damaged website
permission data grants nothing. A missing bookmark record reads as an
empty list; a damaged record, a duplicate or a list over 100 refuses the
whole read and any write that would replace it. A present bookmark can
move to the front even at capacity; a new one at capacity is refused.
Removal uses the exact URL.

```quint
type BookmarkInput = { readable: bool, unique: bool, allAddressesAdmitted: bool, count: int }
type BookmarkRequest = { admittedAddress: bool, alreadyPresent: bool, save: bool }
type StorageSeal = { plaintextBytes: int, sealSucceeded: bool, commitSucceeded: bool }
type BookmarkDecision = BookmarkRejected | BookmarkDamaged | BookmarkLimit | BookmarkUnconfirmed | BookmarkStored
pure def wholeBookmarkRecord(bookmarks: BookmarkInput): bool =
  bookmarks.readable and bookmarks.unique and bookmarks.allAddressesAdmitted and bookmarks.count >= 0 and bookmarks.count <= 100
pure def writeQualified(limit: int, seal: StorageSeal): bool = seal.plaintextBytes >= 0 and seal.plaintextBytes <= limit and seal.sealSucceeded and seal.commitSucceeded
pure def bookmarkChange(bookmarks: BookmarkInput, request: BookmarkRequest, seal: StorageSeal): BookmarkDecision =
  if (not(request.admittedAddress)) BookmarkRejected
  else if (not(wholeBookmarkRecord(bookmarks)) or (request.alreadyPresent and bookmarks.count == 0)) BookmarkDamaged
  else if (request.save and not(request.alreadyPresent) and bookmarks.count >= 100) BookmarkLimit
  else if (writeQualified(800000, seal)) BookmarkStored else BookmarkUnconfirmed
pure val bookmarksValues = Set(
  { readable: true, unique: true, allAddressesAdmitted: true, count: 0 },
  { readable: true, unique: true, allAddressesAdmitted: true, count: 100 },
  { readable: true, unique: false, allAddressesAdmitted: true, count: 2 },
  { readable: false, unique: false, allAddressesAdmitted: false, count: 2 }
)
pure val requestValues = Set(
  { admittedAddress: true, alreadyPresent: false, save: true },
  { admittedAddress: true, alreadyPresent: true, save: true },
  { admittedAddress: true, alreadyPresent: true, save: false },
  { admittedAddress: false, alreadyPresent: false, save: false }
)
pure val sealValues = Set(
  { plaintextBytes: 100, sealSucceeded: true, commitSucceeded: true },
  { plaintextBytes: 100, sealSucceeded: true, commitSucceeded: false },
  { plaintextBytes: 800001, sealSucceeded: false, commitSucceeded: false }
)
pure def lawDamagedBookmarksAreNeverReplaced(bookmarks: BookmarkInput, request: BookmarkRequest, seal: StorageSeal): bool =
  not(wholeBookmarkRecord(bookmarks)) implies bookmarkChange(bookmarks, request, seal) != BookmarkStored
pure def lawBookmarkAtCapacityMayMoveExisting(seal: StorageSeal): bool = writeQualified(800000, seal) implies
  bookmarkChange({ readable: true, unique: true, allAddressesAdmitted: true, count: 100 }, { admittedAddress: true, alreadyPresent: true, save: true }, seal) == BookmarkStored
pure def lawReceiptRequiresSealedCommit(limit: int, seal: StorageSeal): bool = writeQualified(limit, seal) implies seal.sealSucceeded and seal.commitSucceeded
```

### A normal-profile clear retires session state while selected-site clearing uses the exact live tab

The saved-data calls are bound to the native bridge's current session; a
different session is refused. Clearing the normal profile needs WebView
multi-profile and delete-browsing-data support and refuses an overlapping
clear or session write. It closes normal tabs, clears the session,
permissions and download history, then asks WebView to delete persistent
cookies and storage; private tabs and bookmarks remain. The steps are
ordered, not atomic: a failure after local deletion keeps that deletion
and reports the clear failed. Clearing one site needs the current
session, a live safe tab and that tab's exact URL; it deletes the site's
data from the tab's profile, its downloads and, in the normal profile,
its permission decisions, and never rewrites history or bookmarks.

```quint
type NativeStoragePhase = StoreServing | StoreClearing | StoreClearSucceeded | StoreClearFailed
type NativeBrowserStore = { phase: NativeStoragePhase, session: int, normalSnapshot: bool, privateTabs: bool, bookmarks: bool, localClear: bool }
pure val initial: NativeBrowserStore = { phase: StoreServing, session: 0, normalSnapshot: true, privateTabs: true, bookmarks: true, localClear: false }
pure def storageOwner(s: NativeBrowserStore, ticket: int): bool = ticket > 0 and (s.session == 0 or s.session == ticket)
pure def canPersistNativeSession(s: NativeBrowserStore, ticket: int, seal: StorageSeal): bool =
  s.phase != StoreClearing and storageOwner(s, ticket) and writeQualified(2000000, seal)
pure def persistNativeSession(s: NativeBrowserStore, ticket: int, seal: StorageSeal): NativeBrowserStore =
  { ...s, phase: StoreServing, session: ticket, normalSnapshot: true, localClear: false }
pure def canBeginNativeClear(s: NativeBrowserStore, ticket: int, multiProfile: bool, deleteSupported: bool): bool =
  s.phase != StoreClearing and storageOwner(s, ticket) and multiProfile and deleteSupported
pure def beginNativeClear(s: NativeBrowserStore, ticket: int, multiProfile: bool, deleteSupported: bool): NativeBrowserStore =
  { ...s, phase: StoreClearing, session: ticket, localClear: false }
pure def canRecordLocalClear(s: NativeBrowserStore): bool = s.phase == StoreClearing and not(s.localClear)
pure def recordLocalClear(s: NativeBrowserStore): NativeBrowserStore = { ...s, localClear: true, normalSnapshot: false }
pure def canSettleNativeClear(s: NativeBrowserStore, webViewCleared: bool): bool = s.phase == StoreClearing and (s.localClear or not(webViewCleared))
pure def settleNativeClear(s: NativeBrowserStore, webViewCleared: bool): NativeBrowserStore =
  { ...s, phase: if (webViewCleared) StoreClearSucceeded else StoreClearFailed }
pure def admitsSelectedSite(sessionExact: bool, tabLive: bool, safeAddress: bool, exactAddress: bool, supported: bool): bool =
  sessionExact and tabLive and safeAddress and exactAddress and supported
pure val ticketValues = Set(0, 1, 2)
pure def alwaysClearNeverErasesPrivateOrBookmarks(s: NativeBrowserStore): bool = s.privateTabs and s.bookmarks
pure def alwaysClearSuccessHasLocalDeletion(s: NativeBrowserStore): bool = s.phase == StoreClearSucceeded implies s.localClear and not(s.normalSnapshot)
pure def alwaysLocalClearRetiresSnapshot(s: NativeBrowserStore): bool = s.localClear implies not(s.normalSnapshot)
pure def lawSiteClearNeedsExactLiveAddress(sessionExact: bool, tabLive: bool, safeAddress: bool, supported: bool): bool =
  not(admitsSelectedSite(sessionExact, tabLive, safeAddress, false, supported))
pure def sometimesNativeClearCommits(s: NativeBrowserStore): bool = s.phase == StoreClearSucceeded
pure def sometimesNativeClearPartlyFails(s: NativeBrowserStore): bool = s.phase == StoreClearFailed and s.localClear
```

## Story: Sign the device out of websites by purging keyed profiles

> As a person signing out of an account, or out of every website, I want
> the browser profiles that hold those sign-ins deleted, and no other.

### A purge removes exactly the profiles its selector names

`purgeProfiles` takes exactly one selector. A profile key purges that
owner's keyed profile now and closes its surfaces. An idle age of at least
one hour purges every keyed profile of the owner unused for that long that
no surface has open. `all` purges every keyed and ephemeral profile of any
owner and closes their surfaces. A profile's name is a digest of its key,
never the key. Data is cleared at once; the directory goes once Android
releases it.

```quint
type PurgeSelector = PurgeKey | PurgeIdle | PurgeAll
type BrowserProfile = { owner: str, key: str, keyed: bool, open: bool, idleMs: int }
type PurgeRequest = { owner: str, selector: PurgeSelector, key: str, idleMs: int }
pure val oneHourMs = 3600000
pure def purgeAdmitted(purge: PurgeRequest): bool =
  purge.owner != "" and (if (purge.selector == PurgeKey) purge.key != "" else if (purge.selector == PurgeIdle) purge.idleMs >= oneHourMs else true)
pure def purges(purge: PurgeRequest, profile: BrowserProfile): bool =
  purgeAdmitted(purge) and (
    if (purge.selector == PurgeAll) true
    else if (purge.selector == PurgeKey) profile.keyed and profile.owner == purge.owner and profile.key == purge.key
    else profile.keyed and profile.owner == purge.owner and not(profile.open) and profile.idleMs >= purge.idleMs)
pure val profileValues = Set(
  { owner: "o1", key: "account1", keyed: true, open: true, idleMs: 0 },
  { owner: "o1", key: "account2", keyed: true, open: false, idleMs: 7200000 },
  { owner: "o2", key: "account1", keyed: true, open: false, idleMs: 7200000 },
  { owner: "o1", key: "", keyed: false, open: true, idleMs: 0 }
)
pure val purgeValues = Set(
  { owner: "o1", selector: PurgeKey, key: "account1", idleMs: 0 },
  { owner: "o1", selector: PurgeIdle, key: "", idleMs: 3600000 },
  { owner: "o1", selector: PurgeIdle, key: "", idleMs: 60000 },
  { owner: "o1", selector: PurgeAll, key: "", idleMs: 0 }
)
pure def lawKeyPurgeTouchesOnlyThatKey(purge: PurgeRequest, profile: BrowserProfile): bool =
  purge.selector == PurgeKey and purges(purge, profile) implies profile.owner == purge.owner and profile.key == purge.key
pure def lawIdlePurgeSparesOpenProfiles(purge: PurgeRequest, profile: BrowserProfile): bool =
  purge.selector == PurgeIdle and profile.open implies not(purges(purge, profile))
pure def lawIdlePurgeNeedsAnHour(purge: PurgeRequest, profile: BrowserProfile): bool =
  purge.selector == PurgeIdle and purge.idleMs < oneHourMs implies not(purges(purge, profile))
```

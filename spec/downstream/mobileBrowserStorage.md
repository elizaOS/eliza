# Native browser session, bookmarks and origin-scoped storage

AlphaPhone `8d44dfe5` uses Eliza `c518127a` through
`android/app/src/main/java/ai/alphacompute/alphaphone/AlphaBrowserPlugin.java`
and `AlphaBrowserStores.java`. Its `apps/app/src/prototype/browser-adapter.ts`
calls `browsingState`, `saveBrowsingState`, `bookmarks`, `setBookmark`,
`clearBrowsingData` and `clearSiteData` on the native host. Grace `48b43b9c`
stages the Android browser-surface module from Eliza `7743504b` in
`apps/app/native/android/host.json`. Its `OwnedBrowser.java` uses the
Chromium package admission path. Grace has no product `BrowserTabHostPlugin`
subclass or session and bookmark bridge call at this pin. The shared Java
policy stays covered at both pins. [Alpha's renderer persistence](./alpha/browserPersistence.md)
owns the adapter queues, the renderer limits of eight tabs, 100 history
entries and 200 title characters, and the merge into a running view.

## Story: Restore the full native normal-profile snapshot permitted by the stored format

### Native session normalization retains every valid first occurrence

`BrowserSessionPolicy.java` and `BrowserSessionStore.java` have identical
blobs at both pins. Java normalizes both read and write of the
`{history,tabs,cur}` record. A tab needs an ASCII `A–Z`, `a–z`, `0–9`,
underscore or dash ID of length 1–80 and an admissible storage address.
Null, invalid, private and duplicate tab rows are dropped. Filtering
invalid and private rows precedes deduplication, so they do not reserve
an ID. Keep the first valid row for an ID and first occurrence of each
exact admitted history address in input order. A selected ID survives
only when its tab is retained. The Java title replaces ASCII controls
and DEL with spaces and trims its end whitespace. It retains the rest
of the title without clipping. Native has no count cap for valid tabs
or history. The same-profile storage ingress must never supply private
history: Java receives history as strings without a privacy marker.
Its separate `recordVisit` helper takes an explicit ephemeral flag and
keeps history unchanged on an ephemeral or invalid visit. It otherwise
moves the exact visited address to the front and removes one prior
occurrence. The intended history input for that helper is canonical.

The port supplies selected Java URL admission independently of the
renderer parser. The model preserves full sanitized title tokens and
stable input sequence. The sealed native budget is an explicit storage
write outcome, separate from the renderer's count and title limits.

```quint
type NativeTabRow = { id: str, address: str, title: str, ephemeral: bool, validId: bool, validAddress: bool }
type NativeHistoryRow = { address: str, valid: bool }
type VisitMove = { skipped: bool, kept: List[str] }
type NativeSnapshot = { tabs: List[NativeTabRow], history: List[str], selected: str }
pure val emptySnapshot: NativeSnapshot = { tabs: List(), history: List(), selected: "" }
pure def containsTab(tabs: List[NativeTabRow], id: str): bool = tabs.foldl(false, (found, row) => found or row.id == id)
pure def mayKeepTab(row: NativeTabRow): bool = not(row.ephemeral) and row.validId and row.validAddress and row.id != "" and row.address != ""
pure def keepFirstTab(tabs: List[NativeTabRow], row: NativeTabRow): List[NativeTabRow] =
  if (mayKeepTab(row) and not(containsTab(tabs, row.id))) tabs.append(row) else tabs
pure def keepFirstAddress(rows: List[str], visit: NativeHistoryRow): List[str] =
  if (visit.valid and visit.address != "" and not(rows.includes(visit.address))) rows.append(visit.address) else rows
pure def normalizeSnapshot(tabs: List[NativeTabRow], incomingHistory: List[NativeHistoryRow], selected: str): NativeSnapshot = {
  val retainedTabs = tabs.foldl(List(), keepFirstTab)
  { tabs: retainedTabs, history: incomingHistory.foldl(List(), keepFirstAddress), selected: if (containsTab(retainedTabs, selected)) selected else "" }
}
pure def visitHistory(history: List[str], address: str, valid: bool, ephemeral: bool): List[str] = {
  val relocatedVisit: VisitMove = history.foldl({ skipped: false, kept: List(address) }, (walk, prior) =>
    if (not(walk.skipped) and prior == address) { ...walk, skipped: true } else { ...walk, kept: walk.kept.append(prior) })
  if (ephemeral or not(valid) or address == "") history else relocatedVisit.kept
}
pure val rowValues = Set(
  { id: "tab", address: "https://example.test/", title: "A complete title", ephemeral: false, validId: true, validAddress: true },
  { id: "tab", address: "https://example.test/private", title: "private", ephemeral: true, validId: true, validAddress: true },
  { id: "tab", address: "https://example.test/history", title: "second", ephemeral: false, validId: true, validAddress: true },
  { id: "invalid", address: "file:///local", title: "invalid", ephemeral: false, validId: true, validAddress: false }
)
pure val visitValues = Set({ address: "https://example.test/", valid: true }, { address: "https://other.test/", valid: true }, { address: "file:///local", valid: false })
pure val tabsValues = Set(List()).union(rowValues.map(row => List(row)))
pure val incomingHistoryValues = Set(List()).union(visitValues.map(visit => List(visit)))
pure val selectedValues = Set("", "tab", "invalid")
pure def lawPrivateTabNeverAdded(tabs: List[NativeTabRow], row: NativeTabRow): bool = row.ephemeral implies keepFirstTab(tabs, row) == tabs
pure def lawFirstQualifiedTabKeepsFullTitle(tabs: List[NativeTabRow], row: NativeTabRow): bool =
  (mayKeepTab(row) and not(containsTab(tabs, row.id))) implies keepFirstTab(tabs, row) == tabs.append(row)
pure def lawNewQualifiedHistoryHasNoCountCutoff(rows: List[str], visit: NativeHistoryRow): bool =
  (visit.valid and visit.address != "" and not(rows.includes(visit.address))) implies keepFirstAddress(rows, visit) == rows.append(visit.address)
pure def lawPrivateVisitLeavesHistory(history: List[str], address: str, valid: bool): bool = visitHistory(history, address, valid, true) == history
```

### Origin extraction and stored URL admission follow their pinned parser

Both origin helpers allow HTTP and HTTPS only, require a host without
credentials and produce lowercase `scheme://host[:port]`, omitting
port 80 for HTTP or 443 for HTTPS. They reject null, empty, control/DEL,
unsupported schemes and ports above 65,535. The origin helper bounds its
input at 8,192 characters. Session and policy bookmark URLs impose 4,096.
Grace's older `BrowserWebOrigin.of` parses the full address with Java
`URI`, so malformed path/query escapes or raw Java URI punctuation can
reject it. Alpha first rejects global whitespace and backslash and then
parses only scheme and authority, ignoring path/query/fragment grammar.
Raw Chromium delimiters such as `|`, braces, brackets or a literal `%`
after the host can be accepted. Alpha allows an optional numeric port of
at most five digits. An empty port normalizes like an omitted one. The
same-origin comparison requires matching scheme, canonical host and port
from valid origin parses. Site filtering compares the canonical host to
the lowercased exact site or a dot-delimited subdomain. Scheme and port
are irrelevant to this filter. The Java helper needs a site string from
the caller, and does not derive registrable domains itself.

```quint
type OriginPin = GraceOrigin | AlphaOrigin
type WebScheme = ClearHttp | SecureHttps | OtherScheme
type OriginFacts = { length: int, scheme: WebScheme, hostQualified: bool, userInfo: bool, cleanControls: bool,
  alphaCleanText: bool, graceFullUri: bool, alphaAuthority: bool, port: int }
type SiteRelation = ExactHost | DotSubdomain | DifferentHost
pure def webOriginAllowed(pin: OriginPin, facts: OriginFacts): bool =
  facts.length > 0 and facts.length <= 8192 and facts.scheme != OtherScheme and facts.hostQualified and not(facts.userInfo) and facts.cleanControls and facts.port <= 65535 and
  (if (pin == GraceOrigin) facts.graceFullUri else facts.alphaCleanText and facts.alphaAuthority)
pure def sessionAddressAllowed(pin: OriginPin, facts: OriginFacts): bool = facts.length <= 4096 and webOriginAllowed(pin, facts)
pure def policyBookmarkAllowed(pin: OriginPin, facts: OriginFacts): bool = sessionAddressAllowed(pin, facts) and facts.scheme == SecureHttps
pure def effectivePort(scheme: WebScheme, port: int): int =
  if (port < 0 or (scheme == SecureHttps and port == 443) or (scheme == ClearHttp and port == 80)) -1 else port
pure def siteMatches(originUsable: bool, sitePresent: bool, relation: SiteRelation): bool = originUsable and sitePresent and relation != DifferentHost
pure val factsValues = Set(
  { length: 40, scheme: SecureHttps, hostQualified: true, userInfo: false, cleanControls: true, alphaCleanText: true, graceFullUri: true, alphaAuthority: true, port: 443 },
  { length: 40, scheme: SecureHttps, hostQualified: true, userInfo: false, cleanControls: true, alphaCleanText: true, graceFullUri: false, alphaAuthority: true, port: -1 },
  { length: 40, scheme: SecureHttps, hostQualified: true, userInfo: false, cleanControls: true, alphaCleanText: false, graceFullUri: true, alphaAuthority: true, port: -1 },
  { length: 40, scheme: ClearHttp, hostQualified: true, userInfo: false, cleanControls: true, alphaCleanText: true, graceFullUri: true, alphaAuthority: true, port: 8443 },
  { length: 4097, scheme: SecureHttps, hostQualified: true, userInfo: false, cleanControls: true, alphaCleanText: true, graceFullUri: true, alphaAuthority: true, port: -1 },
  { length: 40, scheme: SecureHttps, hostQualified: true, userInfo: true, cleanControls: true, alphaCleanText: true, graceFullUri: true, alphaAuthority: true, port: -1 }
)
pure def lawNativeSessionRefusesCredentialedOrOversized(pin: OriginPin, facts: OriginFacts): bool =
  (facts.userInfo or facts.length > 4096) implies not(sessionAddressAllowed(pin, facts))
pure def lawBookmarkPolicyRequiresHttps(pin: OriginPin, facts: OriginFacts): bool = policyBookmarkAllowed(pin, facts) implies facts.scheme == SecureHttps
pure def lawDifferentDomainNeverMatches(originUsable: bool, sitePresent: bool): bool = not(siteMatches(originUsable, sitePresent, DifferentHost))
```

## Story: Keep bookmarks durable and clear only the browser data I selected

### Installed session and bookmark transactions keep their existing identifiers

The Alpha host keeps `alpha_browser_v1` as its normal WebView profile and
uses `alpha_private_` for private profiles and `alpha_public_` for retired
legacy ephemeral profiles. It binds `alpha-browser-session` and
`alpha-browser-bookmarks` preferences and their respective `-v1` Android
Keystore aliases. Both use the `sealed` value for state, with website
permission decisions in `permissions` within the session preferences.
The storage frame uses AES-GCM and Base64 IV plus ciphertext, separated
by a colon. The plaintext limits are 2,000,000 UTF-8 bytes for session
and 800,000 for bookmarks. A synchronous commit is required for a saved
receipt. Unavailable encryption, failed commit or oversized frame does
not qualify a proposed value. Absent session reads normalize an empty
JSON object. An unreadable or invalid JSON session rejects. Malformed
session rows can be sanitized inside an otherwise readable object.
Missing or damaged permission data grants nothing; a subsequent request
asks again rather than deriving a grant from corrupt bytes.

The Java policy exposes a strict whole-bookmark-list helper, and
Alpha's active `BrowserBookmarkStore.java` implements the same whole-list
integrity rule with its own Android `Uri` URL predicate. That predicate
checks HTTPS, host, no user info, at most 4,096 characters and excludes
ASCII control/space/DEL. Android URL interpretation is a port fact and
is not interchangeable with Java `BrowserWebOrigin.of`. A missing
record reads as an empty list. A damaged/unopened record, a duplicate,
or a list over 100 rejects the entire read and prevents a write from
substituting a new list. A present valid bookmark can move to the front
even when at capacity; a new addition at capacity rejects. Removal uses
exact URL identity. Explicit bookmarks may originate in a private tab
if the host offers the action. The model stores receipt facts and count;
the port owns validation of the ordered complete list and atomic seal.

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

The native bridge binds the saved-data calls to its current opaque session.
The first admitted bookmark or storage call can bind a nonempty session
up to 100 characters. A different session is refused. Normal-profile
Clear requires WebView multi-profile and delete-browsing-data support.
Its in-progress latch refuses overlapping native session writes and
second clears. The clear first closes normal native tabs, clears session
and permissions and download history, then requests persistent WebView
cookie/storage deletion. Private tabs and bookmarks remain. These
actions are ordered but are not one atomic transaction: a reject can
follow a completed earlier step. Renderer save retirement and merge
rules are in its separate model.

Selected-site clear requires the current session, a live safe tab and
the exact tab URL supplied with the command. AndroidX deletes the named
site's data from that tab's profile. The native host clears matching
download entries and, only for normal profile, matching permission
decisions. Native does not rewrite history or bookmarks on this bridge
method. `BrowserSessionPolicy.withoutSite` is a pure URL-list helper,
covered by JVM fixtures, and is unused by this host path. The model
represents one native storage slot: a failed clear returned after local
deletion keeps that local deletion and its failed overall verdict.

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

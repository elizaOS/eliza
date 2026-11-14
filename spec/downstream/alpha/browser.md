# Alpha browser document and private-session custody

Alpha's `apps/app/src/prototype/browser-adapter.ts` imports the pinned
Eliza `BrowserTabSession`, `BrowserPageBinding`, `BrowserTabState`, session
persistence and reading contracts from
`plugins/plugin-native-browser-surface/src/{tab-host,browsing-session,page-reading}.ts`.
The [native browser handoff](../mobileBrowser.md) owns native tap and popup
link transport authority. This model covers a registered renderer tab and
its committed document. Set membership, scroll/focus behavior, tab limits,
URL normalization and storage publication are additional adapter duties.

## Story: Read the page I chose without retaining a stale or private document

### Only a later event from this live tab can replace its displayed document

A tab creation is shared while pending or complete. Failed creation
releases only its own reservation. Its privacy is fixed locally at
creation and can be inherited from a private opener on a native popup.
A state event needs the live session and an already-owned tab. It cannot
regress the native event sequence. A new navigation clears commit and
advances the renderer revision before the native result arrives. A
nonempty changed URL or transition into loading also advances revision.
Only a settled internal success with a URL and native navigation number
can be bound for reading. The caller supplies live tab/session identity
after validation. Tab capacity has the configured bound, eight by default.

```quint
type BrowserTab = { session: int, tab: int, creating: bool, owned: bool, retired: bool, privacy: bool, seqNum: int, revision: int, navId: int, url: str, secureScheme: bool, loading: bool, error: bool, committed: bool, external: bool }
type TabObservation = { sessionId: int, tabId: int, seqNum: int, navId: int, url: str, secureScheme: bool, loading: bool, error: bool, committed: bool, external: bool, privacy: bool }
type PageIdentity = { sessionId: int, tabId: int, navId: int, url: str, revision: int }
pure val initial: BrowserTab = { session: 1, tab: 0, creating: false, owned: false, retired: false, privacy: false, seqNum: 0, revision: 0, navId: 0, url: "", secureScheme: false, loading: false, error: false, committed: false, external: false }
pure def canEnsureTab(s: BrowserTab, tabId: int): bool = not(s.retired) and not(s.creating or s.owned) and tabId > 0
pure def ensureTab(s: BrowserTab, tabId: int, privateTab: bool): BrowserTab = { ...s, tab: tabId, creating: true, privacy: privateTab }
pure def canFinishCreation(s: BrowserTab, tabId: int): bool = not(s.retired) and s.creating and tabId == s.tab
pure def finishCreation(s: BrowserTab, tabId: int, success: bool): BrowserTab =
  if (success) { ...s, owned: true, creating: false } else { ...initial, session: s.session }
pure def canOpenPopup(s: BrowserTab, tabId: int): bool = not(s.retired) and not(s.creating or s.owned) and tabId > 0
pure def openPopup(s: BrowserTab, tabId: int, reportedPrivate: bool, privateOpener: bool): BrowserTab =
  { ...s, tab: tabId, owned: true, privacy: reportedPrivate or privateOpener, revision: 1 }
pure def canBeginNavigation(s: BrowserTab, url: str): bool = not(s.retired) and s.owned and url != ""
pure def beginNavigation(s: BrowserTab, url: str): BrowserTab =
  { ...s, url: url, loading: true, committed: false, error: false, revision: s.revision + 1 }
pure def canObserveTab(s: BrowserTab, observation: TabObservation): bool =
  not(s.retired) and (s.creating or s.owned) and observation.sessionId == s.session and observation.tabId == s.tab and observation.seqNum > s.seqNum
pure def observeTab(s: BrowserTab, observation: TabObservation): BrowserTab = {
  val bump = (observation.url != "" and observation.url != s.url) or (observation.loading and not(s.loading))
  { ...s, seqNum: observation.seqNum, navId: observation.navId, url: observation.url, secureScheme: observation.secureScheme,
    loading: observation.loading, error: observation.error, committed: observation.committed and not(observation.external),
    external: observation.external, privacy: s.privacy or observation.privacy, revision: s.revision + (if (bump) 1 else 0) }
}
pure def canDispose(s: BrowserTab): bool = not(s.retired)
pure def dispose(s: BrowserTab): BrowserTab = { ...initial, session: s.session, retired: true }
pure def alwaysNoOwnershipAfterDisposal(s: BrowserTab): bool = s.retired implies not(s.creating or s.owned or s.committed)
pure def alwaysExternalIsNotCommitted(s: BrowserTab): bool = s.external implies not(s.committed)
pure def alwaysSingleCreation(s: BrowserTab): bool = not(s.creating and s.owned)
pure def alwaysHeldTabHasIdentity(s: BrowserTab): bool = (s.creating or s.owned) implies s.tab > 0 and s.session > 0
pure def stepNativeEventsIncreaseSequence(before: BrowserTab, via: str, after: BrowserTab): bool = via == "observeTab" implies after.seqNum > before.seqNum
pure val tabIdValues = Set(1, 2)
pure val urlValues = Set("", "https://example.test", "https://another.test")
pure val observationValues = Set(
  { sessionId: 1, tabId: 1, seqNum: 1, navId: 1, url: "https://example.test", secureScheme: true, loading: false, error: false, committed: true, external: false, privacy: false },
  { sessionId: 1, tabId: 1, seqNum: 2, navId: 2, url: "https://another.test", secureScheme: true, loading: false, error: false, committed: true, external: true, privacy: false },
  { sessionId: 2, tabId: 1, seqNum: 3, navId: 2, url: "https://another.test", secureScheme: true, loading: false, error: false, committed: true, external: false, privacy: false }
)
```

### A tab can reserve identity only in an established session

Discovered by the proof: a fabricated empty record with an invalid
session could otherwise reserve a tab. The session constructor supplies a
valid identity before any operation. Tab failures and disposal retain it.

```quint
pure def alwaysSessionIsEstablished(s: BrowserTab): bool = s.session > 0
```

### Reading and persistence have distinct admission rules

A captured page remains current only for the selected tab, settled
canonical URL, native navigation and renderer revision. Reading requires
HTTPS when configured and a nonsensitive view and content policy. Turning
away, loading a new page, retirement or owner change fences publication.
Only a known nonprivate tab with a permitted URL can contribute a saved
URL or history entry. Restoring normal tabs cannot expose private tabs.
The pinned browser answer uses an explicit bounded excerpt; full selected
source restoration is a distinct path. Its replacement must preserve
complete authorized source bytes and report hard limits explicitly.

```quint
pure def boundPage(s: BrowserTab, requireHttps: bool): bool =
  not(s.retired) and (s.creating or s.owned) and s.committed and not(s.loading or s.error or s.external) and s.url != "" and s.navId > 0 and (not(requireHttps) or s.secureScheme)
pure def isCurrentPage(s: BrowserTab, page: PageIdentity, selected: int, foreground: bool, nonsensitive: bool): bool =
  boundPage(s, true) and foreground and nonsensitive and selected == s.tab and page.sessionId == s.session and page.tabId == s.tab and
  page.navId == s.navId and page.url == s.url and page.revision == s.revision
pure def mayPersist(s: BrowserTab, validSavedUrl: bool): bool = boundPage(s, false) and not(s.privacy) and validSavedUrl
pure def lawPrivateTabCannotPersist(s: BrowserTab, validSavedUrl: bool): bool = s.privacy implies not(mayPersist(s, validSavedUrl))
pure def lawChangedDocumentCannotPublish(s: BrowserTab, page: PageIdentity, selected: int, foreground: bool, nonsensitive: bool): bool =
  page.revision != s.revision or page.navId != s.navId or page.tabId != s.tab implies not(isCurrentPage(s, page, selected, foreground, nonsensitive))
pure val pageValues = Set({ sessionId: 1, tabId: 1, navId: 1, url: "https://example.test", revision: 1 }, { sessionId: 2, tabId: 1, navId: 1, url: "https://example.test", revision: 1 })
pure def sometimesCanRead(s: BrowserTab): bool = boundPage(s, true)
pure def sometimesPrivatePageCannotPersist(s: BrowserTab): bool = s.privacy and boundPage(s, true) and not(mayPersist(s, true))
```

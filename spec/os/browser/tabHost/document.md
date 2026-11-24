# Browser tab document and private-session custody

The native tab host runs each browser tab of one host document in its own
WebView. The renderer creates tabs, starts navigations and hears each tab's
`stateChanged`, `tabOpened` and `tabClosed` events; the native host binds the
host document's session on its first call and refuses every other session.
This spec follows one tab: who holds it, which document it shows, whether it
is private, when its page may be read, saved or handed to another browser,
and how a pop-up and a link to another app leave it. The shell checks the
host's tab limit, builds every intent, and parses each event; the address
test is [the address spec](../address.md)'s and the saved-address test is
[storage](./storage.md)'s. [Page reading](./reading.md) decides what of a
current page is read.

## Story: Keep my tab's page and privacy stable

> As a person browsing, I want each tab to show only the page it really
> loaded and to stay private once private, so that a stale or private page
> never answers for, or is saved as, the one I am looking at.

### Only a later event from this live tab replaces its document

A tab is created once: the creation is shared while it runs, and a failed
creation releases only this tab, which may then be created again. A native
event needs the bound session, this held tab and a sequence number above
every earlier one. A loading event outranks a failure, a failure outranks a
page only another browser can show, and only a settled commit binds. The
renderer starting a navigation clears the commit before the native result
arrives. A tab the native host closes is forgotten; disposing the host
document ends every tab for good.

```quint
import address.* from "../address"
import storage as S from "./storage"
type Custody = Unclaimed | Creating | Owned | Retired
type TabPrivacy = NormalTab | PrivateTab
type TabOpening = OpenedByRenderer | FreshPopup | UsedPopup
type DocumentStatus = PageUncommitted | PageLoading | PageFailed | PageExternalOnly | PageCommitted
type Handoff = NoHandoff | DialHandoff | ComposeHandoff | ViewHandoff | HandoffRefused
type BrowserTab = { session: int, tab: int, custody: Custody, privacy: TabPrivacy, opening: TabOpening, seq: int,
  navId: int, revision: int, url: WebAddress, status: DocumentStatus, lastHandoff: Handoff }
type TabObservation = { session: int, tab: int, seq: int, navId: int, url: WebAddress, loading: bool, failed: bool,
  externalOnly: bool, committed: bool, privateTab: bool }
pure val initial: BrowserTab = { session: 0, tab: 0, custody: Unclaimed, privacy: NormalTab, opening: OpenedByRenderer, seq: 0,
  navId: 0, revision: 0, url: S::unknownAddress, status: PageUncommitted, lastHandoff: NoHandoff }
pure def held(s: BrowserTab): bool = s.custody == Creating or s.custody == Owned
pure def isPrivate(s: BrowserTab): bool = s.privacy == PrivateTab
pure def released(session: int): BrowserTab = { ...initial, session: session }
pure def statusOf(o: TabObservation): DocumentStatus =
  if (o.loading) PageLoading else if (o.failed) PageFailed else if (o.externalOnly) PageExternalOnly
  else if (o.committed) PageCommitted else PageUncommitted
pure def canEnsureTab(s: BrowserTab, session: int, tabId: int): bool =
  s.custody == Unclaimed and session > 0 and tabId > 0 and (s.session == 0 or s.session == session)
pure def ensureTab(s: BrowserTab, session: int, tabId: int, privacy: TabPrivacy): BrowserTab =
  { ...initial, session: session, tab: tabId, custody: Creating, privacy: privacy }
pure def canFinishCreation(s: BrowserTab): bool = s.custody == Creating
pure def finishCreation(s: BrowserTab, success: bool): BrowserTab = if (success) { ...s, custody: Owned } else released(s.session)
pure def canBeginNavigation(s: BrowserTab, url: WebAddress): bool = s.custody == Owned and isWebAddress(url)
pure def beginNavigation(s: BrowserTab, url: WebAddress): BrowserTab =
  { ...s, url: url, status: PageLoading, revision: s.revision + 1 }
pure def canObserveTab(s: BrowserTab, observation: TabObservation): bool =
  held(s) and observation.session == s.session and observation.tab == s.tab and observation.seq > s.seq
pure def observeTab(s: BrowserTab, observation: TabObservation): BrowserTab = {
  val advances = (observation.url.href != "" and observation.url.href != s.url.href) or (observation.loading and s.status != PageLoading)
  { ...s, seq: observation.seq, navId: observation.navId, url: observation.url, status: statusOf(observation),
    revision: if (advances) s.revision + 1 else s.revision,
    privacy: if (observation.privateTab) PrivateTab else s.privacy,
    opening: if (s.opening == FreshPopup and observation.committed) UsedPopup else s.opening }
}
pure def canCloseTab(s: BrowserTab): bool = held(s)
pure def closeTab(s: BrowserTab): BrowserTab = released(s.session)
pure def canDispose(s: BrowserTab): bool = s.custody != Retired
pure def dispose(s: BrowserTab): BrowserTab = { ...released(s.session), custody: Retired }
pure def stepRetiredTabIsFinal(before: BrowserTab, after: BrowserTab): bool = before.custody == Retired implies after == before
pure def stepSequenceNeverRegresses(before: BrowserTab, after: BrowserTab): bool =
  (held(before) and held(after)) implies after.seq >= before.seq
pure val sessionValues = Set(0, 1, 2)
pure val tabIdValues = Set(1, 2)
pure val httpAddress: WebAddress = { ...secureAddress, href: "http://example.test/", units: 20, scheme: HttpScheme }
pure val urlValues: Set[WebAddress] = List(secureAddress, httpAddress, { ...secureAddress, userInfo: true })
  .foldl(Set(), (acc, a) => acc.union(Set(a)))
pure val committedPage: TabObservation = { session: 1, tab: 1, seq: 1, navId: 1, url: secureAddress, loading: false,
  failed: false, externalOnly: false, committed: true, privateTab: false }
pure val observationValues: Set[TabObservation] = List(
  committedPage,
  { ...committedPage, seq: 2, navId: 2, url: httpAddress, loading: true, committed: false },
  { ...committedPage, seq: 3, navId: 2, url: httpAddress, failed: true, committed: false },
  { ...committedPage, seq: 4, navId: 2, url: httpAddress, externalOnly: true },
  { ...committedPage, seq: 5, navId: 3, privateTab: true },
  { ...committedPage, session: 2, seq: 6 }
).foldl(Set(), (acc, o) => acc.union(Set(o)))
pure def sometimesTabRetired(s: BrowserTab): bool = s.custody == Retired and s.session > 0
pure def sometimesLoadFailed(s: BrowserTab): bool = held(s) and s.status == PageFailed
pure def sometimesPageOnlyAnotherBrowserShows(s: BrowserTab): bool = held(s) and s.status == PageExternalOnly
```

### A tab reserves an identity only in the session the host bound

The first call binds the session; a tab of another session is refused, and
a failed creation or a close keeps the binding.

```quint
pure def alwaysHeldTabHasIdentity(s: BrowserTab): bool = held(s) implies (s.session > 0 and s.tab > 0)
pure def stepBoundSessionNeverChanges(before: BrowserTab, after: BrowserTab): bool =
  before.session > 0 implies after.session == before.session
```

### A private tab stays private for as long as it is held

Privacy is chosen at creation. A native report can make a tab private and
never makes it normal again.

```quint
pure def stepPrivateTabStaysPrivate(before: BrowserTab, after: BrowserTab): bool =
  (held(before) and held(after) and isPrivate(before)) implies isPrivate(after)
pure def sometimesReportedPrivate(s: BrowserTab): bool = isPrivate(s) and s.custody == Owned and s.status == PageCommitted
```

### Every new address moves the document revision forward, and it never moves back

A navigation the renderer starts, a nonempty address the host reports that
differs from the last, and the start of a load each advance the revision, so
a page captured before can never become current again.

```quint
pure def stepRevisionNeverGoesBack(before: BrowserTab, after: BrowserTab): bool =
  (held(before) and held(after)) implies after.revision >= before.revision
pure def stepNewAddressAdvancesRevision(before: BrowserTab, after: BrowserTab): bool =
  (held(before) and held(after) and after.url.href != "" and after.url.href != before.url.href) implies after.revision > before.revision
```

### A captured page is current only for the selected foreground tab, its navigation and its revision

A page binds only from a settled native commit with an address and a native
navigation. Reading, a question about the page and another browser need an
HTTPS page; another browser takes a private page only when I confirm it.

```quint
type PageIdentity = { session: int, tab: int, navId: int, href: str, revision: int }
pure def boundPage(s: BrowserTab): bool = held(s) and s.status == PageCommitted and s.url.href != "" and s.navId > 0
pure def pageOf(s: BrowserTab): PageIdentity = { session: s.session, tab: s.tab, navId: s.navId, href: s.url.href, revision: s.revision }
pure def isCurrentPage(s: BrowserTab, page: PageIdentity, selected: int, foreground: bool): bool =
  boundPage(s) and isSecureWebAddress(s.url) and foreground and selected == s.tab and page == pageOf(s)
pure def mayOpenInAnotherBrowser(s: BrowserTab, page: PageIdentity, selected: int, foreground: bool, privateConfirmed: bool): bool =
  isCurrentPage(s, page, selected, foreground) and (not(isPrivate(s)) or privateConfirmed)
pure def stepOnlyANativeCommitBindsAPage(before: BrowserTab, via: str, after: BrowserTab): bool =
  (boundPage(after) and not(boundPage(before))) implies via == "observeTab"
pure def sometimesHttpsPageBound(s: BrowserTab): bool = boundPage(s) and isSecureWebAddress(s.url)
```

### Only a bound normal tab whose address storage admits contributes to the saved session

```quint
pure def mayPersist(s: BrowserTab): bool = boundPage(s) and not(isPrivate(s)) and S::savedAddress(s.url)
pure def sometimesNormalPageSaved(s: BrowserTab): bool = mayPersist(s)
pure def sometimesPrivatePageNotSaved(s: BrowserTab): bool = boundPage(s) and isPrivate(s) and S::savedAddress(s.url)
```

## Story: Open new tabs and other apps only when I tap

> As a person browsing, I want a site to open a new tab or another app only
> from a link I tapped on the tab I am looking at, so that a script never
> opens windows or apps behind my back.

### A pop-up opens only from a tap on the selected settled tab, in its opener's privacy

A `target=_blank` link or `window.open` opens a tab in the opener's profile
only when the opener is selected, committed without an error, and the tap
is a native gesture; otherwise the opener hears a notice. The shell refuses
it outright while the host is paused or gone, or at the tab limit. The
renderer accepts it, already created, only for its own bound session and an
unknown tab.

```quint
type PopupRequest = { openerSettled: bool, openerSelected: bool, gesture: bool, openerPrivacy: TabPrivacy }
pure def popupAllowed(request: PopupRequest): bool = request.openerSettled and request.openerSelected and request.gesture
pure def canOpenPopup(s: BrowserTab, session: int, tabId: int, request: PopupRequest): bool =
  s.custody == Unclaimed and s.session > 0 and session == s.session and tabId > 0 and popupAllowed(request)
pure def openPopup(s: BrowserTab, session: int, tabId: int, request: PopupRequest): BrowserTab =
  { ...initial, session: session, tab: tabId, custody: Owned, privacy: request.openerPrivacy, opening: FreshPopup,
    status: PageLoading, revision: 1 }
pure val requestValues: Set[PopupRequest] = List(
  { openerSettled: true, openerSelected: true, gesture: true, openerPrivacy: NormalTab },
  { openerSettled: true, openerSelected: true, gesture: true, openerPrivacy: PrivateTab },
  { openerSettled: true, openerSelected: true, gesture: false, openerPrivacy: NormalTab }
).foldl(Set(), (acc, r) => acc.union(Set(r)))
pure def alwaysAPopupIsOwned(s: BrowserTab): bool = s.opening != OpenedByRenderer implies s.custody == Owned
pure def sometimesPrivatePopup(s: BrowserTab): bool = s.opening == FreshPopup and isPrivate(s)
```

### Another app opens only for a link I tapped on the selected tab, with a fixed review action

The shell classifies the link: a `tel:` link only opens the dialer, a
`mailto:`, `sms:` or `smsto:` link only opens a compose screen, and a
`geo:`, `market:` or `intent:` link is viewed. A host may take app links:
for it, a link with any other well-formed scheme is viewed too, unless the
scheme is the web's or the browser's own (`http`, `https`, `about`, `blob`,
`data`, `file`, `content`, `javascript`, `filesystem`, `ws`, `wss`,
`chrome`, `android-app`) or one of the host's. Any other link, one over
4,096 units or with a control character, an `intent:` link with another
action, a forbidden data scheme or the host's own package or schemes, and an
app link on a host that does not take them, is unsupported. A tab hands a link off only while selected and with a native
gesture. A fresh pop-up, not yet committed, carries its opener's tap once:
it hands off while it or its opener is selected, and its first handoff,
refused or not, spends that tap; the host then closes it unless it loads
the link's fallback address.
When the host itself handles the link, only a mail, phone, text or map link
is handed off. When no app resolves the intent, the shell may load the
link's HTTPS fallback address as a navigation.

```quint
type LinkKind = PhoneLink | MailLink | TextLink | MapLink | StoreLink | AppIntentLink | AppSchemeLink | UnsupportedLink
type LinkTap = { kind: LinkKind, gesture: bool, tabSelected: bool, openerSelected: bool, ownHandler: bool, hostTakesAppLinks: bool }
pure def systemLink(kind: LinkKind): bool = kind == PhoneLink or kind == MailLink or kind == TextLink or kind == MapLink
pure def tapAllowed(fresh: bool, tap: LinkTap): bool =
  if (fresh) tap.tabSelected or tap.openerSelected else tap.tabSelected and tap.gesture
pure def supportedLink(tap: LinkTap): bool =
  tap.kind != UnsupportedLink and (tap.kind != AppSchemeLink or tap.hostTakesAppLinks)
pure def linkHandoff(fresh: bool, tap: LinkTap): Handoff =
  if (not(tapAllowed(fresh, tap)) or not(supportedLink(tap)) or (tap.ownHandler and not(systemLink(tap.kind)))) HandoffRefused
  else if (tap.kind == PhoneLink) DialHandoff
  else if (tap.kind == MailLink or tap.kind == TextLink) ComposeHandoff
  else ViewHandoff
pure def freshPopup(s: BrowserTab): bool = s.custody == Owned and s.opening == FreshPopup
pure def canHandOff(s: BrowserTab): bool = s.custody == Owned
pure def handOff(s: BrowserTab, tap: LinkTap): BrowserTab =
  if (freshPopup(s)) { ...s, opening: UsedPopup, lastHandoff: linkHandoff(true, tap) }
  else { ...s, lastHandoff: linkHandoff(false, tap) }
pure def lawHandoffNeedsMyTap(fresh: bool, tap: LinkTap): bool =
  linkHandoff(fresh, tap) != HandoffRefused implies tapAllowed(fresh, tap)
pure def lawOwnHandlerTakesOnlySystemLinks(fresh: bool, tap: LinkTap): bool =
  (tap.ownHandler and linkHandoff(fresh, tap) != HandoffRefused) implies systemLink(tap.kind)
pure def lawAppLinkNeedsAHostThatTakesThem(fresh: bool, tap: LinkTap): bool =
  (tap.kind == AppSchemeLink and linkHandoff(fresh, tap) != HandoffRefused) implies tap.hostTakesAppLinks
pure def stepOnlyANewPopupCarriesItsOpenersTap(before: BrowserTab, via: str, after: BrowserTab): bool =
  (freshPopup(after) and not(freshPopup(before))) implies via == "openPopup"
pure def stepAHandoffSpendsTheOpenersTap(before: BrowserTab, via: str, after: BrowserTab): bool =
  via == "handOff" implies not(freshPopup(after))
pure val tapValues: Set[LinkTap] = List(
  { kind: MailLink, gesture: false, tabSelected: false, openerSelected: true, ownHandler: false, hostTakesAppLinks: false },
  { kind: PhoneLink, gesture: true, tabSelected: true, openerSelected: false, ownHandler: true, hostTakesAppLinks: false },
  { kind: AppIntentLink, gesture: true, tabSelected: true, openerSelected: false, ownHandler: true, hostTakesAppLinks: false },
  { kind: MapLink, gesture: false, tabSelected: true, openerSelected: false, ownHandler: false, hostTakesAppLinks: false },
  { kind: AppSchemeLink, gesture: true, tabSelected: true, openerSelected: false, ownHandler: false, hostTakesAppLinks: true },
  { kind: AppSchemeLink, gesture: true, tabSelected: true, openerSelected: false, ownHandler: false, hostTakesAppLinks: false }
).foldl(Set(), (acc, t) => acc.union(Set(t)))
pure def sometimesPopupHandedOff(s: BrowserTab): bool = s.opening == UsedPopup and s.status == PageLoading and s.lastHandoff == ComposeHandoff
pure def sometimesUntappedLinkRefused(s: BrowserTab): bool = s.custody == Owned and s.lastHandoff == HandoffRefused
pure def sometimesDialerOpened(s: BrowserTab): bool = s.custody == Owned and s.lastHandoff == DialHandoff
```

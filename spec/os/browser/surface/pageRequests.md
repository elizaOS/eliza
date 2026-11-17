# Browser surface pages and page requests

A native browser surface shows one page at a time and keeps its own
history. The consumer's renderer moves it with `navigate`,
`reloadSurface`, `goBack`, `goForward` and `stopLoading`, and hears
`pageStarted`, `navigationChanged` and `sitePermissionWithdrawn` on the
surface's one ordered event thread. A page can ask the person for
something: a JavaScript dialog, a file, a site permission, a download,
another app or a sign-in page that refuses embedded WebViews. The surface
holds each request under a request id and reports it (`dialogRequested`,
`fileChooserRequested`, `sitePermissionRequested`, `downloadRequested`,
`externalLinkRequested`, `identityProviderRequested`); the consumer's
renderer answers through `answerDialog`, `answerFileChooser`,
`answerSitePermission`, `saveDownload`, `openExternalLink` and
`openIdentityProvider`. [Surface lifecycle](./lifecycle.md) owns which
surfaces exist and which renderer may command them.

## Story: Answer what a website asks only for the page I am looking at

> As the person, I want a website's question held only while its page is
> the one I see, answered once by me, and never accepted for me.

### Each request is answered once, by its id, and only while it is held

A request is held under the surface and its request id, unique on that
surface, with the page it came from. Only a surface created to answer
requests holds them; any other surface dismisses a request at once. An
answer names the request id and the kind it answers; an answer for an id
that is not held, or for another kind, changes nothing. Once a request
has an outcome it never changes again, except that a started download
settles once. A surface holds at most one file request, one download, one
other-app link and one sign-in page at a time: a newer one of the same
kind ends the older, so the renderer can only open the last sign-in page
of a tab.

```quint
type RequestKind = DialogAsk | FileChooserAsk | SitePermissionAsk | DownloadAsk | ExternalLinkAsk | IdentityProviderAsk
type RequestOutcome = Pending | Accepted | Declined | PickerOpened | NoFile | Granted | SiteDenied | AndroidDenied | PermissionWithdrawn | Ended
  | Saving | Saved | SaveFailed | SaveUnconfirmed | SaveCancelled | Dispatched | ExternalAppUnavailable | BrowserUnavailable
type LinkKind = PhoneLink | MailLink | TextLink | MapLink | StoreLink | ForeignIntent | InvalidLink
type LoadKind = NoLoad | LoadAddress | LoadBack | LoadForward | LoadReload
type PageEventKind = WithdrawnEvent | StartedEvent | ChangedEvent
type PageEvent = { kind: PageEventKind, surface: int, requestId: int }
type PageRequest = { surface: int, requestId: int, kind: RequestKind, page: int, verdict: RequestOutcome, resolvable: bool, link: LinkKind }
type SurfacePage = { surface: int, page: int, visible: bool, paused: bool, holdsRequests: bool, back: int, forward: int, pending: LoadKind, loading: bool }
type PageRequests = { pages: List[SurfacePage], requests: List[PageRequest], popupGestureSpent: Set[int], lastEvents: List[PageEvent] }
pure val shownPage: SurfacePage = { surface: 1, page: 1, visible: true, paused: false, holdsRequests: true, back: 0, forward: 0, pending: NoLoad, loading: false }
pure val initial: PageRequests = {
  pages: List(shownPage, { ...shownPage, surface: 2, visible: false, holdsRequests: false }),
  requests: List(), popupGestureSpent: Set(), lastEvents: List()
}
pure val noPage: SurfacePage = { ...shownPage, surface: 0, page: 0, visible: false, holdsRequests: false }
pure val noRequest: PageRequest = { surface: 0, requestId: 0, kind: DialogAsk, page: 0, verdict: Ended, resolvable: false, link: InvalidLink }
pure def pageOf(s: PageRequests, surface: int): SurfacePage = s.pages.select(p => p.surface == surface).nthOr(0, noPage)
pure def requestOf(s: PageRequests, surface: int, requestId: int): PageRequest =
  s.requests.select(r => r.surface == surface and r.requestId == requestId).nthOr(0, noRequest)
pure def held(s: PageRequests, surface: int, requestId: int, kind: RequestKind): bool =
  s.requests.some(r => r.surface == surface and r.requestId == requestId and r.kind == kind and r.verdict == Pending)
pure def resolve(surface: int, s: PageRequests, requestId: int, verdict: RequestOutcome): PageRequests =
  { ...s, requests: s.requests.listMap(r => if (r.surface == surface and r.requestId == requestId) { ...r, verdict: verdict } else r), lastEvents: List() }
pure def singleSlot(kind: RequestKind): bool = kind != DialogAsk and kind != SitePermissionAsk
pure def pauseRefuses(kind: RequestKind): bool = kind == DialogAsk or kind == FileChooserAsk or kind == SitePermissionAsk
pure def admitsAsk(p: SurfacePage, kind: RequestKind): bool = p.holdsRequests and p.visible and not(p.paused and pauseRefuses(kind))
pure def canAsk(s: PageRequests, surface: int, requestId: int, kind: RequestKind, resolvable: bool, link: LinkKind): bool =
  pageOf(s, surface).surface > 0 and requestId > 0 and not(s.requests.some(r => r.surface == surface and r.requestId == requestId))
pure def ask(s: PageRequests, surface: int, requestId: int, kind: RequestKind, resolvable: bool, link: LinkKind): PageRequests = {
  val p = pageOf(s, surface)
  val replaced = s.requests.listMap(r => if (singleSlot(kind) and r.surface == surface and r.kind == kind and r.verdict == Pending) { ...r, verdict: Ended } else r)
  { ...s, lastEvents: List(), requests: replaced.append({ surface: surface, requestId: requestId, kind: kind, page: p.page,
    verdict: if (admitsAsk(p, kind)) Pending else Ended, resolvable: resolvable,
    link: if (kind == ExternalLinkAsk) link else InvalidLink }) }
}
pure def canAnswerDialog(s: PageRequests, surface: int, requestId: int, accept: bool): bool = held(s, surface, requestId, DialogAsk)
pure def answerDialog(s: PageRequests, surface: int, requestId: int, accept: bool): PageRequests =
  resolve(surface, s, requestId, if (accept) Accepted else Declined)
pure def canDeclineRequest(s: PageRequests, surface: int, requestId: int): bool =
  held(s, surface, requestId, DownloadAsk) or held(s, surface, requestId, ExternalLinkAsk) or held(s, surface, requestId, IdentityProviderAsk)
pure def declineRequest(s: PageRequests, surface: int, requestId: int): PageRequests = resolve(surface, s, requestId, Declined)
pure def settledOutcome(o: RequestOutcome): bool = o != Pending and o != Saving
pure def alwaysRequestIdsUnique(s: PageRequests): bool =
  s.requests.every(r => s.requests.select(q => q.surface == r.surface and q.requestId == r.requestId).length() == 1)
pure def alwaysOneHeldRequestPerSlot(s: PageRequests): bool =
  s.requests.every(r => s.requests.every(q => not(r.verdict == Pending and q.verdict == Pending and singleSlot(r.kind) and q.kind == r.kind and q.surface == r.surface) or q.requestId == r.requestId))
pure def stepSettledRequestNeverChanges(before: PageRequests, after: PageRequests): bool =
  before.requests.every(r => not(settledOutcome(r.verdict)) or after.requests.includes(r))
pure def stepOutcomeNeverReturnsToPending(before: PageRequests, after: PageRequests): bool =
  before.requests.every(r => r.verdict == Pending or after.requests.every(q => q.surface != r.surface or q.requestId != r.requestId or q.verdict != Pending))
pure def sometimesDialogAccepted(s: PageRequests): bool = s.requests.some(r => r.verdict == Accepted)
pure def sometimesNewerSignInReplacesOlder(s: PageRequests): bool =
  s.requests.some(r => r.kind == IdentityProviderAsk and r.verdict == Ended) and s.requests.some(r => r.kind == IdentityProviderAsk and r.verdict == Pending)
pure val surfaceValues = Set(1, 2)
pure val requestIdValues = Set(1, 2, 3)
pure val linkValues = Set(PhoneLink, StoreLink, InvalidLink)
```

### A page that starts ends everything it asked, hiding ends what only the shown page may ask, and pausing ends only its dialogs

Nothing a page asked is ever accepted for the person when it ends this
way. When the surface's page starts a new document, every request that
page still holds ends: a dialog is cancelled, a file request gets no file
and a permission is denied. Hiding the surface, and a host `navigate`,
`reloadSurface`, `goBack` or `goForward` that moves it, end its dialogs,
file requests, site permissions and downloads, but keep a held other-app
link and sign-in page, which only a page start, a newer one or an answer
ends. Pausing the surface cancels its dialogs only; held file requests and
site permissions stay open, since the system picker or Android's own
permission prompt may be what covers the page, and while it is paused a
new dialog, file request or site permission is refused at once. Showing
or resuming it again brings nothing back.

```quint
type EndScope = EndAll | EndUnseen | EndDialogs
pure def hideEnds(kind: RequestKind): bool = kind != ExternalLinkAsk and kind != IdentityProviderAsk
pure def ends(scope: EndScope, kind: RequestKind): bool =
  if (scope == EndAll) true else if (scope == EndUnseen) hideEnds(kind) else kind == DialogAsk
pure def endHeld(s: PageRequests, surface: int, scope: EndScope): List[PageRequest] =
  s.requests.listMap(r => if (r.surface == surface and r.verdict == Pending and ends(scope, r.kind)) { ...r, verdict: Ended } else r)
pure def withdrawnOf(r: PageRequest): PageEvent = { kind: WithdrawnEvent, surface: r.surface, requestId: r.requestId }
pure def withdrawals(s: PageRequests, surface: int): List[PageEvent] =
  s.requests.select(r => r.surface == surface and r.kind == SitePermissionAsk and r.verdict == Pending).listMap(r => withdrawnOf(r))
pure def startedPage(p: SurfacePage): SurfacePage =
  { ...p, page: p.page + 1, pending: NoLoad, loading: true,
    back: if (p.pending == LoadBack) p.back - 1 else if (p.pending == LoadReload) p.back else p.back + 1,
    forward: if (p.pending == LoadBack) p.forward + 1 else if (p.pending == LoadForward) p.forward - 1 else if (p.pending == LoadReload) p.forward else 0 }
pure def canStartPage(s: PageRequests, surface: int): bool = pageOf(s, surface).surface > 0
pure def startPage(s: PageRequests, surface: int): PageRequests =
  { ...s, pages: s.pages.listMap(p => if (p.surface == surface) startedPage(p) else p), requests: endHeld(s, surface, EndAll),
    lastEvents: withdrawals(s, surface).append({ kind: StartedEvent, surface: surface, requestId: 0 }) }
pure def canSetPageVisible(s: PageRequests, surface: int, visible: bool): bool = pageOf(s, surface).surface > 0 and pageOf(s, surface).visible != visible
pure def setPageVisible(s: PageRequests, surface: int, visible: bool): PageRequests =
  { ...s, pages: s.pages.listMap(p => if (p.surface == surface) { ...p, visible: visible } else p),
    requests: if (visible) s.requests else endHeld(s, surface, EndUnseen), lastEvents: if (visible) List() else withdrawals(s, surface) }
pure def canSetPagePaused(s: PageRequests, surface: int, paused: bool): bool = pageOf(s, surface).surface > 0 and pageOf(s, surface).paused != paused
pure def setPagePaused(s: PageRequests, surface: int, paused: bool): PageRequests =
  { ...s, pages: s.pages.listMap(p => if (p.surface == surface) { ...p, paused: paused } else p),
    requests: if (paused) endHeld(s, surface, EndDialogs) else s.requests, lastEvents: List() }
pure def heldAllowed(p: SurfacePage, r: PageRequest): bool =
  p.page == r.page and p.holdsRequests and (p.visible or not(hideEnds(r.kind))) and not(p.paused and r.kind == DialogAsk)
pure def alwaysHeldRequestIsOnItsPage(s: PageRequests): bool =
  s.requests.every(r => r.verdict != Pending or heldAllowed(pageOf(s, r.surface), r))
pure def stepLookingAwayNeverAccepts(before: PageRequests, via: str, after: PageRequests): bool =
  (via == "startPage" or via == "setPageVisible" or via == "setPagePaused" or via == "requestLoad") implies
    after.requests.every(r => before.requests.includes(r) or r.verdict == Ended)
pure def sometimesRequestEndedByLookingAway(s: PageRequests): bool = s.requests.some(r => r.verdict == Ended and pageOf(s, r.surface).holdsRequests)
pure def sometimesHandoffKeptWhileHidden(s: PageRequests): bool =
  s.requests.some(r => r.verdict == Pending and not(hideEnds(r.kind)) and not(pageOf(s, r.surface).visible))
pure def sometimesPermissionKeptWhilePaused(s: PageRequests): bool =
  s.requests.some(r => r.verdict == Pending and r.kind == SitePermissionAsk and pageOf(s, r.surface).paused)
```

### A site permission is never remembered, and each request is granted only by its own answer

The surface keeps no site permission between requests: a request is
granted only by the `answerSitePermission` that names it, never by an
earlier answer for the same site.

```quint
pure def stepGrantOnlyByItsOwnAnswer(before: PageRequests, via: str, after: PageRequests): bool =
  via != "answerSitePermission" implies after.requests.every(r => r.verdict != Granted or before.requests.includes(r))
```

## Story: Move the page through its own history

> As the consumer's renderer, I want the surface to load, reload, go back,
> go forward and stop only as I ask, and to tell me what changed in the
> order it happened, so my tab's address and history always match the
> page.

### The history moves only when a page starts, and a step past it does nothing

`navigate`, `reloadSurface`, `goBack` and `goForward` end what the page
holds, as hiding does, and ask for a load; the history records the step
only when the new page starts, so `canGoBack` and `canGoForward` change
then and not before. `goBack` with nothing behind, or `goForward` with
nothing ahead, resolves and changes nothing. A page that starts by itself
adds a new entry and drops what was ahead. `stopLoading` stops the load
where it is, ends nothing the page holds, and sends `navigationChanged`
so the renderer reads the state again; so does a load that finishes.

```quint
pure def loadAccepted(p: SurfacePage, load: LoadKind): bool =
  load != NoLoad and (load != LoadBack or p.back > 0) and (load != LoadForward or p.forward > 0)
pure def canRequestLoad(s: PageRequests, surface: int, load: LoadKind): bool = pageOf(s, surface).surface > 0 and load != NoLoad
pure def requestLoad(s: PageRequests, surface: int, load: LoadKind): PageRequests =
  if (not(loadAccepted(pageOf(s, surface), load))) { ...s, lastEvents: List() }
  else { ...s, pages: s.pages.listMap(p => if (p.surface == surface and loadAccepted(p, load)) { ...p, pending: load, loading: true } else p),
    requests: endHeld(s, surface, EndUnseen), lastEvents: withdrawals(s, surface) }
pure def changedEvent(surface: int): PageEvent = { kind: ChangedEvent, surface: surface, requestId: 0 }
pure def canStopLoading(s: PageRequests, surface: int): bool = pageOf(s, surface).surface > 0
pure def stopLoading(s: PageRequests, surface: int): PageRequests =
  { ...s, pages: s.pages.listMap(p => if (p.surface == surface) { ...p, pending: NoLoad, loading: false } else p), lastEvents: List(changedEvent(surface)) }
pure def canFinishLoad(s: PageRequests, surface: int): bool = pageOf(s, surface).loading and pageOf(s, surface).pending == NoLoad
pure def finishLoad(s: PageRequests, surface: int): PageRequests =
  { ...s, pages: s.pages.listMap(p => if (p.surface == surface) { ...p, loading: false } else p), lastEvents: List(changedEvent(surface)) }
pure val loadValues = Set(LoadAddress, LoadBack, LoadForward, LoadReload)
pure def lawStepPastHistoryIsIgnored(tab: PageRequests, surface: int, load: LoadKind): bool =
  ((load == LoadBack and pageOf(tab, surface).back <= 0) or (load == LoadForward and pageOf(tab, surface).forward <= 0)) implies
    requestLoad(tab, surface, load).pages == tab.pages and requestLoad(tab, surface, load).requests == tab.requests
pure val tabValues = Set(initial, { ...initial, pages: List({ ...shownPage, back: 1 }), requests: List({ ...noRequest, surface: 1, requestId: 1, page: 1, verdict: Pending }) },
  { ...initial, pages: List({ ...shownPage, forward: 2 }), requests: List({ ...noRequest, surface: 1, requestId: 1, page: 1, verdict: Pending }) })
pure def alwaysHistoryIsCounted(s: PageRequests): bool =
  s.pages.every(p => p.back >= 0 and p.forward >= 0 and (p.pending == LoadBack implies p.back > 0) and (p.pending == LoadForward implies p.forward > 0))
pure def stepHistoryMovesOnlyAtPageStart(before: PageRequests, via: str, after: PageRequests): bool =
  via != "startPage" implies after.pages.every(p => before.pages.some(q => q.surface == p.surface and q.back == p.back and q.forward == p.forward))
pure def stepStopEndsNothingAndReports(before: PageRequests, via: str, after: PageRequests): bool =
  via == "stopLoading" implies after.requests == before.requests and after.lastEvents.length() == 1 and after.lastEvents.nthOr(0, withdrawnOf(noRequest)).kind == ChangedEvent
pure def sometimesWentBackWithForwardAhead(s: PageRequests): bool = s.pages.some(p => p.back > 0 and p.forward > 0)
pure def sometimesLoadStopped(s: PageRequests): bool = s.lastEvents.some(e => e.kind == ChangedEvent)
```

### A page start reports every permission it withdrew before the start itself

Events of one surface reach the renderer in the order the surface sent
them. When a page starts, whatever started the load, every site
permission request of the old page that it ends is reported
(`sitePermissionWithdrawn`) before `pageStarted`, so the renderer closes
those prompts before it hears of the new page, and it hears any request of
the new page only after `pageStarted`.

```quint
pure def stepPageStartReportsWithdrawalsFirst(before: PageRequests, via: str, after: PageRequests): bool = {
  val started = after.lastEvents.nthOr(after.lastEvents.length() - 1, withdrawnOf(noRequest))
  via == "startPage" implies started.kind == StartedEvent and
    before.requests.every(r => not(r.surface == started.surface and r.kind == SitePermissionAsk and r.verdict == Pending) or after.lastEvents.includes(withdrawnOf(r)))
}
pure def sometimesWithdrawalBeforeStart(s: PageRequests): bool =
  s.lastEvents.some(e => e.kind == WithdrawnEvent) and s.lastEvents.some(e => e.kind == StartedEvent)
```

### A site gets a device permission only when I allow it for the current presentation and Android allows it too

`answerSitePermission` answers one held permission request with grant or
deny. A grant asks Android for the device permission when the app does
not already hold it, and the site gets the permission only when Android
allows it too; Android's refusal denies it. The answer must come while the
request is still held for the same tab visit and document: selecting
another tab, changing the document, a page start or a withdrawal first
denies it. When the page withdraws its request (`sitePermissionWithdrawn`),
no later answer can grant it. An embedded frame's request carries no id
and is denied by the surface itself.

```quint
pure def canAnswerSitePermission(s: PageRequests, surface: int, requestId: int, grant: bool, androidAllows: bool): bool =
  held(s, surface, requestId, SitePermissionAsk)
pure def permissionOutcome(grant: bool, androidAllows: bool): RequestOutcome =
  if (not(grant)) SiteDenied else if (androidAllows) Granted else AndroidDenied
pure def answerSitePermission(s: PageRequests, surface: int, requestId: int, grant: bool, androidAllows: bool): PageRequests =
  resolve(surface, s, requestId, permissionOutcome(grant, androidAllows))
pure def lawGrantNeedsPersonAndAndroid(grant: bool, androidAllows: bool): bool =
  (permissionOutcome(grant, androidAllows) == Granted) iff (grant and androidAllows)
pure def canWithdrawSitePermission(s: PageRequests, surface: int, requestId: int): bool = held(s, surface, requestId, SitePermissionAsk)
pure def withdrawSitePermission(s: PageRequests, surface: int, requestId: int): PageRequests =
  { ...resolve(surface, s, requestId, PermissionWithdrawn), lastEvents: List({ kind: WithdrawnEvent, surface: surface, requestId: requestId }) }
pure def alwaysGrantedOnlyForSitePermission(s: PageRequests): bool = s.requests.every(r => r.verdict == Granted implies r.kind == SitePermissionAsk)
pure def stepWithdrawnPermissionIsNeverGranted(before: PageRequests, after: PageRequests): bool =
  before.requests.every(r => r.verdict != PermissionWithdrawn or after.requests.includes(r))
pure def sometimesSitePermissionGranted(s: PageRequests): bool = s.requests.some(r => r.verdict == Granted)
pure def sometimesAndroidRefusesPermission(s: PageRequests): bool = s.requests.some(r => r.verdict == AndroidDenied)
pure def sometimesPermissionWithdrawn(s: PageRequests): bool = s.requests.some(r => r.verdict == PermissionWithdrawn)
```

### A file request opens the system picker only when I choose to, and a busy picker keeps the request

`answerFileChooser` answers one held file request. Open starts Android's
file picker for that request; the page receives only the files the person
picks there. Not opening gives the page no file. When another picker is
already open the call fails with `FILE_CHOOSER_BUSY` and the request stays
held, so the renderer can answer it again; when the picker cannot open,
the renderer answers again without opening, so the page is never left
waiting.

```quint
pure def canAnswerFileChooser(s: PageRequests, surface: int, requestId: int, open: bool, pickerBusy: bool): bool =
  held(s, surface, requestId, FileChooserAsk)
pure def fileChooserOutcome(open: bool, pickerBusy: bool): RequestOutcome =
  if (open and pickerBusy) Pending else if (open) PickerOpened else NoFile
pure def answerFileChooser(s: PageRequests, surface: int, requestId: int, open: bool, pickerBusy: bool): PageRequests =
  resolve(surface, s, requestId, fileChooserOutcome(open, pickerBusy))
pure def lawBusyPickerKeepsRequest(pickerBusy: bool): bool = pickerBusy implies fileChooserOutcome(true, pickerBusy) == Pending
pure def lawNotOpeningGivesNoFile(pickerBusy: bool): bool = fileChooserOutcome(false, pickerBusy) == NoFile
pure def sometimesPickerOpened(s: PageRequests): bool = s.requests.some(r => r.verdict == PickerOpened)
pure def sometimesPageGetsNoFile(s: PageRequests): bool = s.requests.some(r => r.verdict == NoFile)
```

### A download is saved only after I chose Save and the host published the file

Nothing is downloaded when the page asks. `saveDownload` on a held
download request starts the host-owned copy. The copy is published to the
device's Downloads by one claim; removing the entry before the claim
cancels it, and cancellation and publication exclude each other.
`downloadFinished` reports saved only after the provider confirmed the
publication. A failed copy or publication reports failure and keeps no
file. A publication committed without a receipt is reported unconfirmed
and keeps the file. The download address may carry access tokens and
stays out of models, threads and logs.

```quint
type DownloadSettlement = PublishedWithReceipt | PublicationFailed | EntryRemovedBeforeClaim | CommittedWithoutReceipt
pure def canSaveDownload(s: PageRequests, surface: int, requestId: int): bool = held(s, surface, requestId, DownloadAsk)
pure def saveDownload(s: PageRequests, surface: int, requestId: int): PageRequests = resolve(surface, s, requestId, Saving)
pure def canFinishDownload(s: PageRequests, surface: int, requestId: int, settlement: DownloadSettlement): bool =
  requestOf(s, surface, requestId).verdict == Saving
pure def finishDownload(s: PageRequests, surface: int, requestId: int, settlement: DownloadSettlement): PageRequests =
  resolve(surface, s, requestId,
    if (settlement == PublishedWithReceipt) Saved else if (settlement == PublicationFailed) SaveFailed
    else if (settlement == EntryRemovedBeforeClaim) SaveCancelled else SaveUnconfirmed)
pure val fair_finishDownload = "weak"
pure def alwaysSavingOnlyForDownloads(s: PageRequests): bool =
  s.requests.every(r => (r.verdict == Saving or r.verdict == Saved or r.verdict == SaveFailed or r.verdict == SaveCancelled or r.verdict == SaveUnconfirmed) implies r.kind == DownloadAsk)
pure def stepSavedFollowsSaving(before: PageRequests, after: PageRequests): bool =
  after.requests.every(r => r.verdict != Saved or before.requests.some(q => q.surface == r.surface and q.requestId == r.requestId and (q.verdict == Saving or q.verdict == Saved)))
pure def leadsToDownloadSettles(s: PageRequests, later: PageRequests): bool =
  s.requests.every(r => r.verdict != Saving or later.requests.some(q => q.surface == r.surface and q.requestId == r.requestId and q.verdict != Saving))
pure def sometimesDownloadSaved(s: PageRequests): bool = s.requests.some(r => r.verdict == Saved)
pure def sometimesDownloadUnconfirmed(s: PageRequests): bool = s.requests.some(r => r.verdict == SaveUnconfirmed)
```

### Another app opens only for the link I tapped on the selected tab, with a fixed review action

`openExternalLink` opens a held other-app request only from the current,
live, foreground tab: a direct tab needs to be selected and to carry a
native gesture. A fresh popup, created by a gesture and not yet committed
to a page, carries its opener's gesture once, while the opener or popup is
selected; the first attempt spends that allowance even when no app can
handle the link. The intent is rebuilt from the held request's own
address, for a supported destination with a fixed review action: dial for a phone link, compose for mail or text, view for
a map, store or app link. It never calls or sends by itself; that stays
the person's action in Android. When the host itself is the handler, only
a phone, mail, text or map link is reviewed. When no app resolves the
intent it fails with `EXTERNAL_APP_UNAVAILABLE` and the page stays where
it is.

```quint
type ReviewAction = NoReview | DialReview | ComposeReview | ViewReview
type TabHostLinkContext = { tabLive: bool, foreground: bool, tabCurrent: bool, tabSelected: bool, gesture: bool, popupFresh: bool, openerSelected: bool, ownHandler: bool }
pure def systemLink(kind: LinkKind): bool =
  kind == PhoneLink or kind == MailLink or kind == TextLink or kind == MapLink
pure def reviewAction(kind: LinkKind): ReviewAction =
  if (kind == PhoneLink) DialReview
  else if (kind == MailLink or kind == TextLink) ComposeReview
  else if (kind == MapLink or kind == StoreLink or kind == ForeignIntent) ViewReview
  else NoReview
pure def tabHostGesture(c: TabHostLinkContext): bool =
  if (c.popupFresh) c.tabSelected or c.openerSelected else c.tabSelected and c.gesture
pure def tabHostReview(c: TabHostLinkContext, kind: LinkKind): ReviewAction =
  if (not(c.tabLive) or not(c.foreground) or not(c.tabCurrent) or not(tabHostGesture(c))) NoReview
  else if (c.ownHandler and not(systemLink(kind))) NoReview
  else reviewAction(kind)
pure def canOpenExternalLink(s: PageRequests, surface: int, requestId: int, context: TabHostLinkContext): bool =
  held(s, surface, requestId, ExternalLinkAsk) and tabHostReview(context, requestOf(s, surface, requestId).link) != NoReview and
  not(context.popupFresh and s.popupGestureSpent.contains(surface))
pure def openExternalLink(s: PageRequests, surface: int, requestId: int, context: TabHostLinkContext): PageRequests = {
  val opened = resolve(surface, s, requestId, if (requestOf(s, surface, requestId).resolvable) Dispatched else ExternalAppUnavailable)
  if (context.popupFresh) { ...opened, popupGestureSpent: s.popupGestureSpent.union(Set(surface)) } else opened
}
pure val contextValues = Set(
  {tabLive: true, foreground: true, tabCurrent: true, tabSelected: true, gesture: true, popupFresh: false, openerSelected: false, ownHandler: true},
  {tabLive: true, foreground: true, tabCurrent: true, tabSelected: false, gesture: true, popupFresh: true, openerSelected: true, ownHandler: false},
  {tabLive: true, foreground: true, tabCurrent: true, tabSelected: false, gesture: false, popupFresh: true, openerSelected: false, ownHandler: false},
  {tabLive: true, foreground: false, tabCurrent: true, tabSelected: true, gesture: true, popupFresh: false, openerSelected: false, ownHandler: false},
  {tabLive: true, foreground: true, tabCurrent: true, tabSelected: true, gesture: false, popupFresh: false, openerSelected: false, ownHandler: false}
)
pure def lawLinkReviewNeedsTheCurrentTabGesture(context: TabHostLinkContext, kind: LinkKind): bool =
  tabHostReview(context, kind) != NoReview implies context.tabLive and context.foreground and context.tabCurrent and tabHostGesture(context)
pure def lawOwnHandlerReviewsOnlySystemLinks(context: TabHostLinkContext, kind: LinkKind): bool =
  context.ownHandler and tabHostReview(context, kind) != NoReview implies systemLink(kind)
pure def stepSpentPopupGestureNeverReturns(before: PageRequests, after: PageRequests): bool =
  before.popupGestureSpent.subseteq(after.popupGestureSpent)
pure def sometimesExternalAppUnavailable(s: PageRequests): bool = s.requests.some(r => r.verdict == ExternalAppUnavailable)
pure def sometimesPopupGestureSpentWithoutHandler(s: PageRequests): bool =
  s.popupGestureSpent.size() > 0 and s.requests.some(r => r.verdict == ExternalAppUnavailable)
```

### A sign-in page that refuses embedded browsers opens in a full browser only when I choose to

A sign-in page that refuses embedded WebViews is not loaded in the
surface. `openIdentityProvider` on that held request opens its address in
the device's full browser, with that browser's own storage; it is a
dispatch, not a sign-in, and the surface learns nothing of the result.
When no full browser can open it, the call fails and the request ends
unopened.

```quint
pure def canOpenIdentityProvider(s: PageRequests, surface: int, requestId: int): bool = held(s, surface, requestId, IdentityProviderAsk)
pure def openIdentityProvider(s: PageRequests, surface: int, requestId: int): PageRequests =
  resolve(surface, s, requestId, if (requestOf(s, surface, requestId).resolvable) Dispatched else BrowserUnavailable)
pure def alwaysDispatchOnlyForHandoffs(s: PageRequests): bool =
  s.requests.every(r => r.verdict == Dispatched implies (r.kind == ExternalLinkAsk or r.kind == IdentityProviderAsk) and r.resolvable)
pure def sometimesIdentityProviderOpened(s: PageRequests): bool = s.requests.some(r => r.kind == IdentityProviderAsk and r.verdict == Dispatched)
```

## Story: Hear what the surface did in a fixed vocabulary

> As the consumer's renderer, I want every request and answer to name its
> kind from a closed set, so I can show each one and nothing unknown
> reaches the person.

### A permission answer is granted, denied, refused by Android or ended, and only granted gives the page anything

`answerSitePermission` resolves with one outcome: `granted` when the page
has every kind it asked for, `denied` when the renderer said no,
`android-refused` when Android's own dialog left a permission missing,
and `ended` when the request ended unanswered: the page withdrew it, a
start, hide or close ended it while Android asked, or Android could not
ask.

```quint
type PermissionAnswer = AnswerGranted | AnswerDenied | AnswerAndroidRefused | AnswerEnded
pure def permissionAnswer(o: RequestOutcome): PermissionAnswer =
  if (o == Granted) AnswerGranted else if (o == SiteDenied) AnswerDenied else if (o == AndroidDenied) AnswerAndroidRefused else AnswerEnded
pure def lawOnlyGrantedGivesThePage(o: RequestOutcome): bool = (permissionAnswer(o) == AnswerGranted) iff (o == Granted)
pure val oValues = Set(Granted, SiteDenied, AndroidDenied, PermissionWithdrawn, Ended, Pending)
```

### Dialogs, other-app handoffs, sign-in providers and site permission kinds come from closed sets

A dialog is an alert, a confirm, a prompt or a leave-page dialog; a
dismissed dialog is cancelled, and a dismissed leave-page dialog keeps the
page and drops the navigation. An other-app link is handed off as
send-to, dial, view or refuse, matching its review action, and a refused
link can never open. A sign-in page that refuses embedded browsers comes
from Google or Facebook. A site asks for the camera, the microphone or
the location, and a kind the host app declares no Android permission for
is never offered to the person.

```quint
type DialogKind = AlertDialog | ConfirmDialog | PromptDialog | LeavePageDialog
type DialogDismissal = DialogCancelled | LeavePageKept
pure def dismissal(kind: DialogKind): DialogDismissal = if (kind == LeavePageDialog) LeavePageKept else DialogCancelled
type Handoff = SendToHandoff | DialHandoff | ViewHandoff | RefuseHandoff
pure def handoffOf(kind: LinkKind): Handoff =
  if (kind == PhoneLink) DialHandoff
  else if (kind == MailLink or kind == TextLink) SendToHandoff
  else if (kind == InvalidLink) RefuseHandoff
  else ViewHandoff
type SignInProvider = GoogleSignInPage | FacebookSignInPage
type SitePermissionKind = CameraKind | MicrophoneKind | LocationKind
pure def offeredKinds(requested: Set[SitePermissionKind], declared: Set[SitePermissionKind]): Set[SitePermissionKind] = requested.intersect(declared)
pure def lawLeavePageDismissalKeepsThePage(dialog: DialogKind): bool = (dismissal(dialog) == LeavePageKept) iff (dialog == LeavePageDialog)
pure def lawHandoffMatchesReview(tapped: LinkKind): bool =
  ((handoffOf(tapped) == RefuseHandoff) iff (reviewAction(tapped) == NoReview)) and ((handoffOf(tapped) == DialHandoff) iff (reviewAction(tapped) == DialReview))
pure def lawUndeclaredKindNeverOffered(requested: Set[SitePermissionKind], declared: Set[SitePermissionKind]): bool =
  offeredKinds(requested, declared).subseteq(declared) and offeredKinds(requested, declared).subseteq(requested)
pure val signInProviders: Set[SignInProvider] = Set(GoogleSignInPage, FacebookSignInPage)
```

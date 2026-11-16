# Browser surface page requests

A page in a native browser surface can ask the person for something: a
JavaScript dialog, a file, a site permission, a download, another app or
a sign-in page that refuses embedded WebViews. The surface holds each
request under a request id and reports it (`dialogRequested`,
`fileChooserRequested`, `sitePermissionRequested`, `downloadRequested`,
`externalLinkRequested`, `identityProviderRequested`); the consumer's
renderer answers through `answerDialog`, `answerFileChooser`,
`answerSitePermission`, `saveDownload`, `openExternalLink` and
`openIdentityProvider` of `plugins/plugin-native-browser-surface`. The
answering methods `answerFileChooser`, `answerSitePermission`,
`saveDownload` and `openIdentityProvider` are specified here first, ahead
of their producer code. This spec ports the producer's
`BrowserSitePermissionPresentation`, `BrowserDownloadPublication` and
`BrowserExternalHandoff` models. [Surface lifecycle](./lifecycle.md) owns
which surfaces exist; [external links](../externalLinks.md) owns the
link parser and the older bridge.

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
settles once.

```quint
type RequestKind = DialogAsk | FileChooserAsk | SitePermissionAsk | DownloadAsk | ExternalLinkAsk | IdentityProviderAsk
type RequestOutcome = Pending | Accepted | Declined | PickerOpened | NoFile | Granted | SiteDenied | AndroidDenied | PermissionWithdrawn | Ended
  | Saving | Saved | SaveFailed | SaveUnconfirmed | SaveCancelled | Dispatched | ExternalAppUnavailable | BrowserUnavailable
type PageRequest = { surface: int, requestId: int, kind: RequestKind, page: int, verdict: RequestOutcome, resolvable: bool }
type SurfacePage = { surface: int, page: int, visible: bool, holdsRequests: bool }
type PageRequests = { pages: List[SurfacePage], requests: List[PageRequest] }
pure val initial: PageRequests = { pages: List({ surface: 1, page: 1, visible: true, holdsRequests: true }, { surface: 2, page: 1, visible: false, holdsRequests: false }), requests: List() }
pure val noPage: SurfacePage = { surface: 0, page: 0, visible: false, holdsRequests: false }
pure val noRequest: PageRequest = { surface: 0, requestId: 0, kind: DialogAsk, page: 0, verdict: Ended, resolvable: false }
pure def pageOf(s: PageRequests, surface: int): SurfacePage = s.pages.select(p => p.surface == surface).nthOr(0, noPage)
pure def requestOf(s: PageRequests, surface: int, requestId: int): PageRequest =
  s.requests.select(r => r.surface == surface and r.requestId == requestId).nthOr(0, noRequest)
pure def held(s: PageRequests, surface: int, requestId: int, kind: RequestKind): bool =
  s.requests.some(r => r.surface == surface and r.requestId == requestId and r.kind == kind and r.verdict == Pending)
pure def resolve(surface: int, s: PageRequests, requestId: int, verdict: RequestOutcome): PageRequests =
  { ...s, requests: s.requests.listMap(r => if (r.surface == surface and r.requestId == requestId) { ...r, verdict: verdict } else r) }
pure def canAsk(s: PageRequests, surface: int, requestId: int, kind: RequestKind, resolvable: bool): bool =
  pageOf(s, surface).surface > 0 and requestId > 0 and not(s.requests.some(r => r.surface == surface and r.requestId == requestId))
pure def ask(s: PageRequests, surface: int, requestId: int, kind: RequestKind, resolvable: bool): PageRequests = {
  val p = pageOf(s, surface)
  { ...s, requests: s.requests.append({ surface: surface, requestId: requestId, kind: kind, page: p.page,
    verdict: if (p.visible and p.holdsRequests) Pending else Ended, resolvable: resolvable }) }
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
pure def stepSettledRequestNeverChanges(before: PageRequests, after: PageRequests): bool =
  before.requests.every(r => not(settledOutcome(r.verdict)) or after.requests.includes(r))
pure def stepOutcomeNeverReturnsToPending(before: PageRequests, after: PageRequests): bool =
  before.requests.every(r => r.verdict == Pending or after.requests.every(q => q.surface != r.surface or q.requestId != r.requestId or q.verdict != Pending))
pure def sometimesDialogAccepted(s: PageRequests): bool = s.requests.some(r => r.verdict == Accepted)
pure val surfaceValues = Set(1, 2)
pure val requestIdValues = Set(1, 2, 3)
```

### A page that starts, or a surface I stop seeing, ends what it asked and never accepts it

When the surface's page starts a new document, or the surface is hidden
or paused, every request that page still holds ends without being
accepted: a dialog is cancelled, a file request gets no file and a
permission is denied. The renderer hears that page started before it
hears any request of the new page.

```quint
pure def endHeld(s: PageRequests, surface: int): List[PageRequest] =
  s.requests.listMap(r => if (r.surface == surface and r.verdict == Pending) { ...r, verdict: Ended } else r)
pure def canStartPage(s: PageRequests, surface: int): bool = pageOf(s, surface).surface > 0
pure def startPage(s: PageRequests, surface: int): PageRequests =
  { pages: s.pages.listMap(p => if (p.surface == surface) { ...p, page: p.page + 1 } else p), requests: endHeld(s, surface) }
pure def canSetPageVisible(s: PageRequests, surface: int, visible: bool): bool = pageOf(s, surface).surface > 0 and pageOf(s, surface).visible != visible
pure def setPageVisible(s: PageRequests, surface: int, visible: bool): PageRequests =
  { pages: s.pages.listMap(p => if (p.surface == surface) { ...p, visible: visible } else p),
    requests: if (visible) s.requests else endHeld(s, surface) }
pure def alwaysHeldRequestIsOnItsVisiblePage(s: PageRequests): bool =
  s.requests.every(r => r.verdict != Pending or (pageOf(s, r.surface).page == r.page and pageOf(s, r.surface).visible and pageOf(s, r.surface).holdsRequests))
pure def stepLookingAwayNeverAccepts(before: PageRequests, via: str, after: PageRequests): bool =
  (via == "startPage" or via == "setPageVisible") implies
    after.requests.every(r => before.requests.includes(r) or r.verdict == Ended)
pure def sometimesRequestEndedByLookingAway(s: PageRequests): bool = s.requests.some(r => r.verdict == Ended and pageOf(s, r.surface).holdsRequests)
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
pure def withdrawSitePermission(s: PageRequests, surface: int, requestId: int): PageRequests = resolve(surface, s, requestId, PermissionWithdrawn)
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

### Another app opens only for the link I tapped, and an unresolvable link reports that no app is available

`openExternalLink` opens a held other-app request (`tel:`, `mailto:`,
`sms:`, `geo:`, `market:` or `intent:`) with a fresh intent and a fixed
review action; it never calls or sends by itself, and it rejects any
other address. When no app resolves the intent it fails with
`EXTERNAL_APP_UNAVAILABLE` and the page stays where it is.

```quint
pure def canOpenExternalLink(s: PageRequests, surface: int, requestId: int): bool = held(s, surface, requestId, ExternalLinkAsk)
pure def openExternalLink(s: PageRequests, surface: int, requestId: int): PageRequests =
  resolve(surface, s, requestId, if (requestOf(s, surface, requestId).resolvable) Dispatched else ExternalAppUnavailable)
pure def alwaysDispatchedLinkWasResolvable(s: PageRequests): bool =
  s.requests.every(r => r.kind == ExternalLinkAsk and r.verdict == Dispatched implies r.resolvable)
pure def sometimesExternalAppUnavailable(s: PageRequests): bool = s.requests.some(r => r.verdict == ExternalAppUnavailable)
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

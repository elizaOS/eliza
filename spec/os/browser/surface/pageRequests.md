# Browser surface page requests

A website on a native surface can ask the person for something: a
JavaScript dialog, a file, a site permission (camera, microphone,
location), a download, another app for a link, or a full browser for a
sign-in page that refuses embedded WebViews. The surface holds each request
under an id, reports it to the app's renderer and waits for the answer.
[Surface lifecycle](./lifecycle.md) owns the surfaces; this spec wraps its
commands so that each also ends what it no longer lets a page ask. The
shell keeps the WebView's callbacks under the request ids.

## Story: Answer what a page asks, once, only while it is mine

> As the person, I want a website's question held only while its page is
> one I can answer, answered once by me, and never answered yes for me.

### A request is held only on a surface created to answer requests, and only while the page may ask it

Without `answersRequests` the platform default applies at once: nothing is
held. A dialog, a file request and a site permission need the page shown
and running; a download needs it shown; a tapped other-app link and a
refused sign-in page need neither. At most
`maxWaiting` dialogs and `maxWaiting` site permissions wait per page; more
are dismissed. A file request, a download, a link and a sign-in page wait
one at a time per page: a newer one ends the older. Request ids come from
one counter, so a stale or repeated answer finds nothing. Only a held
request is reported (`dialogRequested`, `fileChooserRequested`,
`sitePermissionRequested`, `downloadRequested`, `externalLinkRequested`,
`identityProviderRequested`).

```quint
import lifecycle as L from "./lifecycle"
type RequestKind = Dialog | FileChoice | SitePermission | Download | OtherApp | BlockedSignIn
type PermissionAnswer = Granted | Denied | AndroidRefused | Ended
type RequestStatus = Waiting | PickerOpen | AskingAndroid | Saving | DialogAccepted | DialogCancelled | FilesGiven | NoFiles
  | PermissionAnswered({ answer: PermissionAnswer }) | Saved | SaveFailed | Dispatched | NoHandler | Dismissed
type PageRequest = { id: int, surface: str, gen: int, kind: RequestKind, status: RequestStatus }
type Picker = PickerIdle | PickerFor({ request: int })
type PageRequests = { host: L::SurfaceHost, requests: List[PageRequest], issued: int, picker: Picker }
type PageNotice = Asked({ surface: str, request: int, kind: RequestKind }) | PermissionWithdrawn({ surface: str, request: int })
  | Started({ surface: str, href: str }) | DownloadFinished({ surface: str, request: int, saved: bool })
type PageChange = { state: PageRequests, out: List[PageNotice] }
pure val initial: PageRequests = { host: L::initial, requests: List(), issued: 0, picker: PickerIdle }
pure val maxWaiting = 4
pure def active(st: RequestStatus): bool = st == Waiting or st == PickerOpen or st == AskingAndroid
pure def shownOnly(kind: RequestKind): bool = kind != OtherApp and kind != BlockedSignIn
pure def pauseRefuses(kind: RequestKind): bool = kind == Dialog or kind == FileChoice or kind == SitePermission
pure def oneAtATime(kind: RequestKind): bool = kind != Dialog and kind != SitePermission
pure def ended(kind: RequestKind): RequestStatus =
  if (kind == Dialog) DialogCancelled else if (kind == FileChoice) NoFiles
  else if (kind == SitePermission) PermissionAnswered({ answer: Ended }) else Dismissed
pure def allowedOn(x: L::NativeSurface, kind: RequestKind): bool =
  x.policy.answersRequests and (shownOnly(kind) implies x.presented) and (kind == Dialog implies not(x.paused))
pure def mayHold(host: L::SurfaceHost, r: PageRequest): bool = host.surfaces.some(x => x.id == r.surface and x.gen == r.gen and allowedOn(x, r.kind))
pure def canPageAsks(s: PageRequests, id: str, kind: RequestKind): bool = L::hasSurface(s.host, id)
pure def pageAsks(s: PageRequests, id: str, kind: RequestKind): PageChange = {
  val gen = s.host.surfaces.foldl(0, (g, x) => if (x.id == id) x.gen else g)
  val waiting = s.requests.select(r => r.gen == gen and r.kind == kind and active(r.status)).length()
  val held = s.host.surfaces.some(x => x.id == id and x.gen == gen and allowedOn(x, kind) and not(pauseRefuses(kind) and x.paused)) and
    (oneAtATime(kind) or waiting < maxWaiting)
  val replaced = s.requests.listMap(r => if (held and oneAtATime(kind) and r.gen == gen and r.kind == kind and active(r.status)) { ...r, status: ended(r.kind) } else r)
  { state: { ...s, issued: s.issued + 1, requests: replaced.append({ id: s.issued + 1, surface: id, gen: gen, kind: kind, status: if (held) Waiting else ended(kind) }) },
    out: if (held) List(Asked({ surface: id, request: s.issued + 1, kind: kind })) else List() }
}
pure def alwaysHeldRequestsAreOnSurfacesThatMayHoldThem(s: PageRequests): bool = s.requests.every(r => active(r.status) implies mayHold(s.host, r))
pure def alwaysRequestIdsAreIssuedOnce(s: PageRequests): bool =
  s.issued >= 0 and s.requests.every(a => a.id >= 1 and a.id <= s.issued and s.requests.every(b => a.id == b.id implies a == b))
pure def alwaysOneAtATimeKindsWaitAlone(s: PageRequests): bool = s.requests.every(a => s.requests.every(b =>
  a.id == b.id or not(oneAtATime(a.kind) and a.kind == b.kind and a.gen == b.gen and active(a.status) and active(b.status))))
pure def stepOnlyAHeldRequestIsReported(before: PageRequests, via: str, after: PageRequests, out: List[PageNotice]): bool =
  out.every(n => match n {
    | Asked(a) => after.requests.some(r => r.id == a.request and r.status == Waiting) and not(before.requests.some(r => r.id == a.request))
    | _ => true
  })
pure val realmValues: Set[L::Realm] = Set(L::appRealm)
pure val idValues = Set("t1", "t2")
pure val policyValues: Set[L::SurfacePolicy] = Set(L::keyedPolicy).union(Set({ ...L::keyedPolicy, answersRequests: false }))
pure val isolatedRendererValues = Set(true)
pure val multiProfileValues = Set(true)
pure val requestValues = Set(1, 2, 3)
pure val weight_pageAsks = 4
pure def sometimesAskedOnASurfaceThatDoesNotAnswer(s: PageRequests): bool =
  s.requests.some(r => s.host.surfaces.some(x => x.gen == r.gen and not(x.policy.answersRequests)))
pure def sometimesNewerSignInReplacedOlder(s: PageRequests): bool =
  s.requests.some(a => a.kind == BlockedSignIn and a.status == Dismissed and s.requests.some(b => b.kind == BlockedSignIn and b.gen == a.gen and b.status == Waiting))
```

### Each request is answered once, by its id, while it is held, and every outcome is its own answer or an ending that gives the page nothing

An answer names the owner's live realm, the surface and a held request of
that kind; anything else is refused and changes nothing. An ending (page
start, hiding, pausing, closing, withdrawal, a newer request) cancels: no
dialog result, no file, no permission, nothing dispatched.

```quint
pure def waitingOn(s: PageRequests, realm: L::Realm, id: str, request: int, kind: RequestKind): bool =
  L::owns(s.host, realm, id) and s.requests.some(r => r.id == request and r.surface == id and r.kind == kind and r.status == Waiting)
pure def setStatus(request: int, s: PageRequests, st: RequestStatus): PageRequests =
  { ...s, requests: s.requests.listMap(r => if (r.id == request) { ...r, status: st } else r) }
pure def canAnswerDialog(s: PageRequests, realm: L::Realm, id: str, request: int, accept: bool): bool = waitingOn(s, realm, id, request, Dialog)
pure def answerDialog(s: PageRequests, realm: L::Realm, id: str, request: int, accept: bool): PageRequests =
  setStatus(request, s, if (accept) DialogAccepted else DialogCancelled)
pure def answerStep(via: str, kind: RequestKind, was: RequestStatus, now: RequestStatus): bool =
  (via == "answerDialog" and kind == Dialog and was == Waiting and (now == DialogAccepted or now == DialogCancelled)) or
  (via == "answerFileChooser" and kind == FileChoice and was == Waiting and (now == PickerOpen or now == NoFiles)) or
  (via == "pickerReturned" and kind == FileChoice and was == PickerOpen and (now == FilesGiven or now == NoFiles)) or
  (via == "answerSitePermission" and kind == SitePermission and was == Waiting and (now == AskingAndroid or now == PermissionAnswered({ answer: Denied }))) or
  (via == "androidAnswered" and kind == SitePermission and was == AskingAndroid and
    (now == PermissionAnswered({ answer: Granted }) or now == PermissionAnswered({ answer: AndroidRefused }) or now == PermissionAnswered({ answer: Ended }))) or
  (via == "saveDownload" and kind == Download and was == Waiting and now == Saving) or
  (via == "downloadFinished" and kind == Download and was == Saving and (now == Saved or now == SaveFailed)) or
  (via == "openExternalLink" and kind == OtherApp and was == Waiting and (now == Dispatched or now == NoHandler)) or
  (via == "openIdentityProvider" and kind == BlockedSignIn and was == Waiting and (now == Dispatched or now == NoHandler))
pure def stepEveryOutcomeIsItsAnswerOrAnEnding(before: PageRequests, via: str, after: PageRequests): bool =
  after.requests.every(r => before.requests.includes(r) or
    (via == "pageAsks" and r.id == after.issued and (r.status == Waiting or r.status == ended(r.kind))) or
    before.requests.some(b => b.id == r.id and b.surface == r.surface and b.gen == r.gen and b.kind == r.kind and
      (answerStep(via, r.kind, b.status, r.status) or (active(b.status) and r.status == ended(r.kind)))))
pure def stepRequestsAreNeverForgotten(before: PageRequests, after: PageRequests): bool =
  before.requests.every(b => after.requests.some(r => r.id == b.id))
pure def sometimesDialogAccepted(s: PageRequests): bool = s.requests.some(r => r.status == DialogAccepted)
```

### A page start ends everything its page asked and reports each withdrawn permission before the start

When the page starts a new document, every request it holds ends, the
other-app link and sign-in page included. Every site permission that ends
without an answer, by a page start, hiding, closing or the page itself
(`withdrawSitePermission`), is reported `sitePermissionWithdrawn`; a page
start reports them before `pageStarted`, so the renderer closes those
prompts before it hears of the new page.

```quint
pure def withdrawn(gone: List[PageRequest]): List[PageNotice] =
  gone.select(r => r.kind == SitePermission).listMap(r => PermissionWithdrawn({ surface: r.surface, request: r.id }))
pure def onPage(host: L::SurfaceHost, id: str, r: PageRequest): bool = active(r.status) and host.surfaces.some(x => x.id == id and x.gen == r.gen)
pure def canPageStarted(s: PageRequests, id: str, href: str): bool = L::canPageStarted(s.host, id, href)
pure def pageStarted(s: PageRequests, id: str, href: str): PageChange =
  { state: { ...s, host: L::pageStarted(s.host, id, href), requests: s.requests.listMap(r => if (onPage(s.host, id, r)) { ...r, status: ended(r.kind) } else r) },
    out: withdrawn(s.requests.select(r => onPage(s.host, id, r))).append(Started({ surface: id, href: href })) }
pure def canWithdrawSitePermission(s: PageRequests, request: int): bool =
  s.requests.some(r => r.id == request and r.kind == SitePermission and active(r.status))
pure def withdrawSitePermission(s: PageRequests, request: int): PageChange =
  { state: setStatus(request, s, PermissionAnswered({ answer: Ended })), out: withdrawn(s.requests.select(r => r.id == request)) }
pure def isStarted(n: PageNotice): bool = match n { | Started(x) => true | _ => false }
pure def isWithdrawal(n: PageNotice): bool = match n { | PermissionWithdrawn(x) => true | _ => false }
pure def stepEndedPermissionsAreWithdrawnBeforeTheStart(before: PageRequests, via: str, after: PageRequests, out: List[PageNotice]): bool = {
  val gone = after.requests.select(r => r.status == PermissionAnswered({ answer: Ended }) and before.requests.some(b => b.id == r.id and active(b.status)))
  val final = out.nthOr(out.length() - 1, Asked({ surface: "", request: 0, kind: Dialog }))
  out.select(n => isWithdrawal(n)) == (if (via == "androidAnswered") List() else withdrawn(gone)) and
    (via == "pageStarted" implies out.length() > 0 and isStarted(final))
}
pure def sometimesStartEndedAHandoff(s: PageRequests): bool =
  s.requests.some(r => r.kind == OtherApp and r.status == Dismissed and s.host.surfaces.some(x => x.gen == r.gen and x.policy.answersRequests) and
    not(s.requests.some(b => b.kind == OtherApp and b.gen == r.gen and b.id > r.id)))
```

### Hiding ends what only the shown page may ask, pausing ends its dialogs, and closing ends everything

Each wrapped lifecycle command applies, then ends every held request the
surface may no longer hold. Presenting one
surface hides its owner's others, and reconciling hides every surface of
the owner: their dialogs, file requests, site permissions and downloads
end, while a held other-app link or sign-in page stays until a page start,
a newer one or the answer. Pausing cancels dialogs only: a held file
request or permission stays, since the system picker or Android's own
permission dialog may be what covers the page. Destroying a surface ends
all it holds; a download already saving finishes but reports nothing.

```quint
pure def endsOn(host: L::SurfaceHost, r: PageRequest): bool = active(r.status) and not(mayHold(host, r))
pure def endUnheld(host: L::SurfaceHost, s: PageRequests): PageChange =
  { state: { ...s, host: host, requests: s.requests.listMap(r => if (endsOn(host, r)) { ...r, status: ended(r.kind) } else r) },
    out: withdrawn(s.requests.select(r => endsOn(host, r))) }
pure def canLearnSupport(s: PageRequests): bool = L::canLearnSupport(s.host)
pure def learnSupport(s: PageRequests, isolatedRenderer: bool, multiProfile: bool): PageChange = endUnheld(L::learnSupport(s.host, isolatedRenderer, multiProfile), s)
pure def canReconcileOwner(s: PageRequests, realm: L::Realm, desiredIds: Set[str]): bool = L::canReconcileOwner(s.host, realm, desiredIds)
pure def reconcileOwner(s: PageRequests, realm: L::Realm, desiredIds: Set[str]): PageChange = endUnheld(L::reconcileOwner(s.host, realm, desiredIds), s)
pure def canCreateSurface(s: PageRequests, realm: L::Realm, id: str, policy: L::SurfacePolicy, url: str): bool = L::canCreateSurface(s.host, realm, id, policy, url)
pure def createSurface(s: PageRequests, realm: L::Realm, id: str, policy: L::SurfacePolicy, url: str): PageChange = endUnheld(L::createSurface(s.host, realm, id, policy, url), s)
pure def canPresentSurface(s: PageRequests, realm: L::Realm, id: str): bool = L::canPresentSurface(s.host, realm, id)
pure def presentSurface(s: PageRequests, realm: L::Realm, id: str): PageChange = endUnheld(L::presentSurface(s.host, realm, id), s)
pure def canPauseSurface(s: PageRequests, realm: L::Realm, id: str): bool = L::canPauseSurface(s.host, realm, id)
pure def pauseSurface(s: PageRequests, realm: L::Realm, id: str): PageChange = endUnheld(L::pauseSurface(s.host, realm, id), s)
pure def canResumeSurface(s: PageRequests, realm: L::Realm, id: str): bool = L::canResumeSurface(s.host, realm, id)
pure def resumeSurface(s: PageRequests, realm: L::Realm, id: str): PageChange = endUnheld(L::resumeSurface(s.host, realm, id), s)
pure def canDestroySurface(s: PageRequests, realm: L::Realm, id: str): bool = L::canDestroySurface(s.host, realm, id)
pure def destroySurface(s: PageRequests, realm: L::Realm, id: str): PageChange = endUnheld(L::destroySurface(s.host, realm, id), s)
pure def sometimesSignInKeptWhileHidden(s: PageRequests): bool =
  s.requests.some(r => r.kind == BlockedSignIn and r.status == Waiting and s.host.surfaces.some(x => x.gen == r.gen and not(x.presented)))
pure def sometimesPermissionKeptWhilePaused(s: PageRequests): bool =
  s.requests.some(r => r.kind == SitePermission and active(r.status) and s.host.surfaces.some(x => x.gen == r.gen and x.paused))
```

## Story: Let a site have the device, my files or a download only as I choose

> As the person, I want a website to get a device permission, a file or a
> download only when I said yes, and Android too where it decides.

### A site permission is never remembered, and is granted only by my grant and then Android's

A deny answers `Denied` at once. A grant asks Android for any runtime
permission the app still lacks; `androidAnswered` then settles `Granted`
when Android allows every kind (or the app held them), `AndroidRefused`
when one is missing, `Ended` when Android could not ask. Only `Granted`
gives the page anything, and nothing is kept between requests. A page
start, hiding or closing while Android asks ends the request for good.

```quint
type AndroidReply = AndroidAllows | AndroidRefuses | AndroidCannotAsk
pure def canAnswerSitePermission(s: PageRequests, realm: L::Realm, id: str, request: int, grant: bool): bool = waitingOn(s, realm, id, request, SitePermission)
pure def answerSitePermission(s: PageRequests, realm: L::Realm, id: str, request: int, grant: bool): PageRequests =
  setStatus(request, s, if (grant) AskingAndroid else PermissionAnswered({ answer: Denied }))
pure def canAndroidAnswered(s: PageRequests, request: int): bool = s.requests.some(r => r.id == request and r.status == AskingAndroid)
pure def androidAnswered(s: PageRequests, request: int, reply: AndroidReply): PageRequests =
  setStatus(request, s, PermissionAnswered({ answer: if (reply == AndroidAllows) Granted else if (reply == AndroidRefuses) AndroidRefused else Ended }))
pure def fitsKind(kind: RequestKind, st: RequestStatus): bool = match st {
  | Waiting => true | DialogAccepted => kind == Dialog | DialogCancelled => kind == Dialog
  | PickerOpen => kind == FileChoice | FilesGiven => kind == FileChoice | NoFiles => kind == FileChoice
  | AskingAndroid => kind == SitePermission | PermissionAnswered(a) => kind == SitePermission
  | Saving => kind == Download | Saved => kind == Download | SaveFailed => kind == Download
  | Dispatched => not(shownOnly(kind)) | NoHandler => not(shownOnly(kind)) | Dismissed => kind == Download or not(shownOnly(kind))
}
pure def alwaysOutcomeFitsItsKind(s: PageRequests): bool = s.requests.every(r => fitsKind(r.kind, r.status))
pure def stepGrantFollowsMyGrantAndAndroid(before: PageRequests, via: str, after: PageRequests): bool =
  after.requests.every(r => r.status != PermissionAnswered({ answer: Granted }) or before.requests.includes(r) or
    (via == "androidAnswered" and before.requests.some(b => b.id == r.id and b.status == AskingAndroid)))
pure def sometimesSitePermissionGranted(s: PageRequests): bool = s.requests.some(r => r.status == PermissionAnswered({ answer: Granted }))
pure def sometimesAndroidRefused(s: PageRequests): bool = s.requests.some(r => r.status == PermissionAnswered({ answer: AndroidRefused }))
```

### A file request opens the system picker only when I choose, the page gets only files I pick, and a busy picker keeps the request

`answerFileChooser` with open shows Android's document picker; without
it the page gets no file. One picker serves the app: while it is open,
opening another is refused (`FILE_CHOOSER_BUSY`) and that request stays
held. The picked files reach the page only if its request is still held.

```quint
pure def pickerRequest(p: Picker): int = match p { | PickerFor(f) => f.request | PickerIdle => 0 }
pure def canAnswerFileChooser(s: PageRequests, realm: L::Realm, id: str, request: int, open: bool): bool =
  waitingOn(s, realm, id, request, FileChoice) and not(open and s.picker != PickerIdle)
pure def answerFileChooser(s: PageRequests, realm: L::Realm, id: str, request: int, open: bool): PageRequests =
  if (open) { ...setStatus(request, s, PickerOpen), picker: PickerFor({ request: request }) } else setStatus(request, s, NoFiles)
pure def canPickerReturned(s: PageRequests, picked: bool): bool = s.picker != PickerIdle
pure def pickerReturned(s: PageRequests, picked: bool): PageRequests =
  { ...s, picker: PickerIdle, requests: s.requests.listMap(r =>
    if (r.id == pickerRequest(s.picker) and r.status == PickerOpen) { ...r, status: if (picked) FilesGiven else NoFiles } else r) }
pure def alwaysAnOpenPickerServesItsRequest(s: PageRequests): bool =
  s.requests.every(r => r.status == PickerOpen implies s.picker == PickerFor({ request: r.id }))
pure def sometimesBusyPickerKeepsARequest(s: PageRequests): bool =
  s.picker != PickerIdle and s.requests.some(r => r.kind == FileChoice and r.status == Waiting)
pure def sometimesFilesGiven(s: PageRequests): bool = s.requests.some(r => r.status == FilesGiven)
```

### A download is saved only after I chose Save and the host published the file

Nothing is fetched when the page asks. `saveDownload` on a held download
starts the host's copy into Downloads with the surface's own cookie for
the page's origin; it is no longer held, so a page start or hiding does
not stop it. `downloadFinished` reports `saved` only after the file was
published, else `failed`, and only while the surface still exists.

```quint
pure def canSaveDownload(s: PageRequests, realm: L::Realm, id: str, request: int): bool = waitingOn(s, realm, id, request, Download)
pure def saveDownload(s: PageRequests, realm: L::Realm, id: str, request: int): PageRequests = setStatus(request, s, Saving)
pure def canDownloadFinished(s: PageRequests, request: int, published: bool): bool = s.requests.some(r => r.id == request and r.status == Saving)
pure def downloadFinished(s: PageRequests, request: int, published: bool): PageChange =
  { state: setStatus(request, s, if (published) Saved else SaveFailed),
    out: s.requests.select(r => r.id == request and s.host.surfaces.some(x => x.id == r.surface and x.gen == r.gen))
      .listMap(r => DownloadFinished({ surface: r.surface, request: r.id, saved: published })) }
pure def sometimesDownloadSaved(s: PageRequests): bool = s.requests.some(r => r.status == Saved)
```

## Story: Leave the page for another app or a full browser only when I choose

> As the person, I want a link I tapped to open its app, and a sign-in page
> that refuses embedded browsers to open in my full browser, only when I
> say so.

### Another app opens only for the held link I tapped, and a refused sign-in page opens in a full browser only when I choose

`openExternalLink` opens the held link with a fresh intent that only
reviews (dial, compose or view; it never calls or sends by itself).
`openIdentityProvider` opens the held sign-in page in the person's other
browser, with its own storage. Either settles `Dispatched`, or `NoHandler`
when nothing can open it (`EXTERNAL_APP_UNAVAILABLE`,
`IDENTITY_BROWSER_UNAVAILABLE`); the page stays where it is.

```quint
pure def canOpenExternalLink(s: PageRequests, realm: L::Realm, id: str, request: int, found: bool): bool = waitingOn(s, realm, id, request, OtherApp)
pure def openExternalLink(s: PageRequests, realm: L::Realm, id: str, request: int, found: bool): PageRequests =
  setStatus(request, s, if (found) Dispatched else NoHandler)
pure def canOpenIdentityProvider(s: PageRequests, realm: L::Realm, id: str, request: int, found: bool): bool = waitingOn(s, realm, id, request, BlockedSignIn)
pure def openIdentityProvider(s: PageRequests, realm: L::Realm, id: str, request: int, found: bool): PageRequests =
  setStatus(request, s, if (found) Dispatched else NoHandler)
pure def sometimesSignInOpened(s: PageRequests): bool = s.requests.some(r => r.kind == BlockedSignIn and r.status == Dispatched)
pure def sometimesNoAppForLink(s: PageRequests): bool = s.requests.some(r => r.kind == OtherApp and r.status == NoHandler)
```

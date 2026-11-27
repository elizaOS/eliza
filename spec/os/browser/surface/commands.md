# Browser surface commands

The app's renderer drives a native surface with a fixed set of commands:
`navigate`, `reloadSurface`, `goBack`, `goForward`, `stopLoading`,
`readPage`, `controlPage`, `observeHistory` and `navigateHistory`. A surface
created with `interceptsNavigation` also holds every move of its page to
another origin until the app loads it. [Surface lifecycle](./lifecycle.md)
owns the surfaces; this spec wraps its commands and keeps, per surface, the
page's origin, the load the app approved, the history observation and
whether a page dialog waits. What a page command does on the page
(`controlPage`'s snapshots and receipts) is `../pageCommands.md`'s. The
shell parses every call, runs it on the main thread, resolves it only after
the WebView call returned, and computes each address's origin.

## Story: Drive a page only as the app asks

> As the app's renderer, I want each command to act on the page I name,
> only while that page can take it, so that I never read or drive a page
> the person cannot see.

### A command changes only the one surface its realm names, and a refused one changes nothing

Every command names the lease's session and epoch and a surface of that
realm (`L::owns`); anything else, or invalid arguments, rejects and leaves
everything as it was. A load the app asks for (`navigate`, `reloadSurface`,
`goBack`, `goForward`) ends the page's history observation and cancels its
waiting dialog, since a held dialog would block the load. `goBack` and
`goForward` approve the origin of the entry they move to; `navigate`,
`reloadSurface` and `stopLoading` end any pending approval, and
`stopLoading` keeps the dialog. `navigate` loads with GET, puts the page
on the address's origin and ends a security block (`lifecycle.md`).

```quint
import lifecycle as L from "./lifecycle"
type HistoryObservation = NotObserved | ObservedAt({ ref: int })
type Approval = NoApproval | ApprovedOrigin({ origin: str })
type SurfaceControl = { gen: int, origin: str, approval: Approval, history: HistoryObservation, dialogOpen: bool }
type SurfaceCommands = { host: L::SurfaceHost, controls: List[SurfaceControl], issued: int }
type HistoryRefusal = StaleRef | DialogOpen
type CommandReply = PageRead({ id: str, href: str }) | PageDriven({ id: str }) | HistoryObserved({ id: str, ref: int })
  | HistoryStepped({ id: str, ref: int }) | HistoryRefused({ id: str, reason: HistoryRefusal }) | NavigationRequested({ id: str, realm: L::Realm, href: str })
type CommandChange = { state: SurfaceCommands, out: List[CommandReply] }
pure val initial: SurfaceCommands = { host: L::initial, controls: List(), issued: 0 }
pure def forId(s: SurfaceCommands, id: str, c: SurfaceControl): bool = s.host.surfaces.some(x => x.id == id and x.gen == c.gen)
pure def load(id: str, s: SurfaceCommands, approval: Approval, closesDialog: bool): SurfaceCommands =
  { ...s, controls: s.controls.listMap(c => if (forId(s, id, c)) { ...c, approval: approval, history: NotObserved, dialogOpen: c.dialogOpen and not(closesDialog) } else c) }
pure def canNavigate(s: SurfaceCommands, realm: L::Realm, id: str, href: str, origin: str): bool = L::owns(s.host, realm, id) and href != "" and origin != ""
pure def navigate(s: SurfaceCommands, realm: L::Realm, id: str, href: str, origin: str): SurfaceCommands = {
  val startedHost = { ...s.host, surfaces: s.host.surfaces.listMap(x => if (x.id == id) { ...x, page: { href: href, result: L::PageLoading } } else x) }
  val cleared = load(id, s, NoApproval, true)
  afterHostChange(startedHost, { ...cleared, controls: cleared.controls.listMap(c => if (forId(s, id, c)) { ...c, origin: origin } else c) })
}
pure def canReloadSurface(s: SurfaceCommands, realm: L::Realm, id: str): bool = L::owns(s.host, realm, id)
pure def reloadSurface(s: SurfaceCommands, realm: L::Realm, id: str): SurfaceCommands = load(id, s, NoApproval, true)
pure def canGoBack(s: SurfaceCommands, realm: L::Realm, id: str, origin: str): bool = L::owns(s.host, realm, id) and origin != ""
pure def goBack(s: SurfaceCommands, realm: L::Realm, id: str, origin: str): SurfaceCommands = load(id, s, ApprovedOrigin({ origin: origin }), true)
pure def canGoForward(s: SurfaceCommands, realm: L::Realm, id: str, origin: str): bool = L::owns(s.host, realm, id) and origin != ""
pure def goForward(s: SurfaceCommands, realm: L::Realm, id: str, origin: str): SurfaceCommands = load(id, s, ApprovedOrigin({ origin: origin }), true)
pure def canStopLoading(s: SurfaceCommands, realm: L::Realm, id: str): bool = L::owns(s.host, realm, id)
pure def stopLoading(s: SurfaceCommands, realm: L::Realm, id: str): SurfaceCommands = load(id, s, NoApproval, false)
pure def hostCommand(via: str): bool =
  via == "navigate" or via == "reloadSurface" or via == "goBack" or via == "goForward" or via == "stopLoading" or
  via == "readPage" or via == "controlPage" or via == "observeHistory" or via == "navigateHistory"
pure def stepACommandChangesOnlyTheSurfaceItNames(before: SurfaceCommands, via: str, after: SurfaceCommands): bool =
  hostCommand(via) implies before.host.surfaces.select(x => not(after.host.surfaces.includes(x)) or
    before.controls.some(c => c.gen == x.gen and not(after.controls.includes(c)))).length() <= 1
pure val realmValues: Set[L::Realm] = Set(L::appRealm)
pure val idValues = Set("t1", "t2")
pure val originValues = Set("https://example.test", "https://other.test")
pure val isolatedRendererValues = Set(true)
pure val multiProfileValues = Set(true)
```

### A lifecycle change keeps a history observation only on a ready page and a waiting dialog only on a shown, running page

Each wrapped lifecycle command applies, then drops what the surface no
longer allows: a history observation needs the page shown, running and
loaded; a dialog waits only on a surface created to answer requests while
its page is shown and running (`pageRequests.md` answers it). Each live
surface has exactly one record, made when it is created and dropped when it
closes.

```quint
pure def ready(x: L::NativeSurface): bool = x.presented and not(x.paused) and x.page.result == L::PageLoaded
pure def mayHoldDialog(x: L::NativeSurface): bool = x.policy.answersRequests and x.presented and not(x.paused)
pure def keepValid(c: SurfaceControl, x: L::NativeSurface): SurfaceControl =
  { ...c, history: if (ready(x)) c.history else NotObserved, dialogOpen: c.dialogOpen and mayHoldDialog(x) }
pure def afterHostChange(host: L::SurfaceHost, s: SurfaceCommands): SurfaceCommands =
  { ...s, host: host, controls: s.controls.select(c => host.surfaces.some(x => x.gen == c.gen))
    .listMap(c => host.surfaces.foldl(c, (acc, x) => if (x.gen == c.gen) keepValid(acc, x) else acc)) }
pure def canLearnSupport(s: SurfaceCommands): bool = L::canLearnSupport(s.host)
pure def learnSupport(s: SurfaceCommands, isolatedRenderer: bool, multiProfile: bool): SurfaceCommands = afterHostChange(L::learnSupport(s.host, isolatedRenderer, multiProfile), s)
pure def canReconcileOwner(s: SurfaceCommands, realm: L::Realm, desiredIds: Set[str]): bool = L::canReconcileOwner(s.host, realm, desiredIds)
pure def reconcileOwner(s: SurfaceCommands, realm: L::Realm, desiredIds: Set[str]): SurfaceCommands = afterHostChange(L::reconcileOwner(s.host, realm, desiredIds), s)
pure def canCreateSurface(s: SurfaceCommands, realm: L::Realm, id: str, policy: L::SurfacePolicy, url: str, origin: str): bool =
  L::canCreateSurface(s.host, realm, id, policy, url) and origin != ""
pure def createSurface(s: SurfaceCommands, realm: L::Realm, id: str, policy: L::SurfacePolicy, url: str, origin: str): SurfaceCommands = {
  val made = afterHostChange(L::createSurface(s.host, realm, id, policy, url), s)
  { ...made, controls: made.controls.append({ gen: s.host.issued + 1, origin: origin, approval: NoApproval, history: NotObserved, dialogOpen: false }) }
}
pure def canPresentSurface(s: SurfaceCommands, realm: L::Realm, id: str): bool = L::canPresentSurface(s.host, realm, id)
pure def presentSurface(s: SurfaceCommands, realm: L::Realm, id: str): SurfaceCommands = afterHostChange(L::presentSurface(s.host, realm, id), s)
pure def canPauseSurface(s: SurfaceCommands, realm: L::Realm, id: str): bool = L::canPauseSurface(s.host, realm, id)
pure def pauseSurface(s: SurfaceCommands, realm: L::Realm, id: str): SurfaceCommands = afterHostChange(L::pauseSurface(s.host, realm, id), s)
pure def canResumeSurface(s: SurfaceCommands, realm: L::Realm, id: str): bool = L::canResumeSurface(s.host, realm, id)
pure def resumeSurface(s: SurfaceCommands, realm: L::Realm, id: str): SurfaceCommands = afterHostChange(L::resumeSurface(s.host, realm, id), s)
pure def canDestroySurface(s: SurfaceCommands, realm: L::Realm, id: str): bool = L::canDestroySurface(s.host, realm, id)
pure def destroySurface(s: SurfaceCommands, realm: L::Realm, id: str): SurfaceCommands = afterHostChange(L::destroySurface(s.host, realm, id), s)
pure def canPageFinished(s: SurfaceCommands, id: str): bool = L::canPageFinished(s.host, id)
pure def pageFinished(s: SurfaceCommands, id: str): SurfaceCommands = afterHostChange(L::pageFinished(s.host, id).state, s)
pure def canDialogOpened(s: SurfaceCommands, id: str): bool = s.host.surfaces.some(x => x.id == id and mayHoldDialog(x))
pure def dialogOpened(s: SurfaceCommands, id: str): SurfaceCommands = { ...s, controls: s.controls.listMap(c => if (forId(s, id, c)) { ...c, dialogOpen: true } else c) }
pure def canDialogClosed(s: SurfaceCommands, id: str): bool = s.controls.some(c => forId(s, id, c) and c.dialogOpen)
pure def dialogClosed(s: SurfaceCommands, id: str): SurfaceCommands = { ...s, controls: s.controls.listMap(c => if (forId(s, id, c)) { ...c, dialogOpen: false } else c) }
pure def alwaysEachSurfaceHasOneRecord(s: SurfaceCommands): bool =
  L::alwaysIssuedOnce(s.host) and s.controls.every(c => s.host.surfaces.some(x => x.gen == c.gen)) and
    s.host.surfaces.every(x => s.host.surfaces.select(y => y.id == x.id).length() == 1 and s.controls.select(c => c.gen == x.gen).length() == 1)
pure def refOf(h: HistoryObservation): int = match h { | ObservedAt(o) => o.ref | NotObserved => 0 }
pure def alwaysObservationsAreOnReadyPages(s: SurfaceCommands): bool =
  s.issued >= 0 and s.controls.every(c => refOf(c.history) <= s.issued and (c.history == NotObserved or s.host.surfaces.some(x => x.gen == c.gen and ready(x))))
pure def alwaysDialogsWaitOnShownRunningPages(s: SurfaceCommands): bool =
  s.controls.every(c => not(c.dialogOpen) or s.host.surfaces.some(x => x.gen == c.gen and mayHoldDialog(x)))
pure val policyValues: Set[L::SurfacePolicy] = Set(L::keyedPolicy).union(Set({ ...L::keyedPolicy, interceptsNavigation: true }))
pure def sometimesDialogWaitsOnAnObservedPage(s: SurfaceCommands): bool = s.controls.some(c => c.dialogOpen and c.history != NotObserved)
```

### Reading needs the shown, loaded page, and a paused page is never driven or observed

`readPage` reads visible text from the surface's own page, never the
host's, and needs it shown and loaded without error; a paused page still
reads. `controlPage` and `observeHistory` need the page shown, running and
loaded. A read or command whose page changed before it answered is
discarded (shell).

```quint
pure def canReadPage(s: SurfaceCommands, realm: L::Realm, id: str): bool =
  L::owns(s.host, realm, id) and s.host.surfaces.some(x => x.id == id and x.presented and x.page.result == L::PageLoaded)
pure def readPage(s: SurfaceCommands, realm: L::Realm, id: str): CommandChange =
  { state: s, out: s.host.surfaces.select(x => x.id == id).listMap(x => PageRead({ id: id, href: x.page.href })) }
pure def canControlPage(s: SurfaceCommands, realm: L::Realm, id: str): bool = L::owns(s.host, realm, id) and s.host.surfaces.some(x => x.id == id and ready(x))
pure def controlPage(s: SurfaceCommands, realm: L::Realm, id: str): CommandChange = { state: s, out: List(PageDriven({ id: id })) }
pure def canObserveHistory(s: SurfaceCommands, realm: L::Realm, id: str): bool = canControlPage(s, realm, id)
pure def observeHistory(s: SurfaceCommands, realm: L::Realm, id: str): CommandChange =
  { state: { ...s, issued: s.issued + 1, controls: s.controls.listMap(c => if (forId(s, id, c)) { ...c, history: ObservedAt({ ref: s.issued + 1 }) } else c) },
    out: List(HistoryObserved({ id: id, ref: s.issued + 1 })) }
pure def shownAndLoaded(s: SurfaceCommands, id: str, running: bool): bool =
  s.host.surfaces.some(x => x.id == id and x.presented and x.page.result == L::PageLoaded and (running implies not(x.paused)))
pure def stepOnlyAShownLoadedPageIsReadOrDriven(before: SurfaceCommands, via: str, after: SurfaceCommands, out: List[CommandReply]): bool =
  out.every(n => match n {
    | PageRead(r) => shownAndLoaded(before, r.id, false)
    | PageDriven(r) => shownAndLoaded(before, r.id, true)
    | HistoryObserved(r) => shownAndLoaded(before, r.id, true)
    | HistoryStepped(r) => shownAndLoaded(before, r.id, true)
    | _ => true
  })
pure def sometimesPausedPageLoaded(s: SurfaceCommands): bool = s.host.surfaces.some(x => x.presented and x.paused and x.page.result == L::PageLoaded)
```

### A history step goes only to the entry the host just observed, and an open dialog keeps its reference

`observeHistory` lists the adjacent same-origin entries under a fresh
reference from one counter, replacing any earlier one. `navigateHistory`
spends the reference before it dispatches, so a lost reply never repeats
the step; a reference that is not the current observation is answered
`STALE_REF` and also ends the observation. While the page holds a dialog
the step is refused `DIALOG_OPEN` and the observation stays, since
answering the dialog may leave the page where it was. A sent step is known
only after reading the page back.

```quint
pure def canNavigateHistory(s: SurfaceCommands, realm: L::Realm, id: str, ref: int): bool = L::owns(s.host, realm, id)
pure def navigateHistory(s: SurfaceCommands, realm: L::Realm, id: str, ref: int): CommandChange = {
  val mine = s.controls.select(c => forId(s, id, c))
  if (mine.some(c => c.dialogOpen)) { state: s, out: List(HistoryRefused({ id: id, reason: DialogOpen })) }
  else { state: { ...s, controls: s.controls.listMap(c => if (forId(s, id, c)) { ...c, history: NotObserved } else c) },
    out: List(if (mine.some(c => c.history == ObservedAt({ ref: ref }))) HistoryStepped({ id: id, ref: ref }) else HistoryRefused({ id: id, reason: StaleRef })) }
}
pure def recordOf(s: SurfaceCommands, id: str): List[SurfaceControl] = s.controls.select(c => forId(s, id, c))
pure def stepAHistoryStepSpendsTheReferenceJustObserved(before: SurfaceCommands, via: str, after: SurfaceCommands, out: List[CommandReply]): bool =
  out.every(n => match n {
    | HistoryStepped(r) => recordOf(before, r.id).some(c => c.history == ObservedAt({ ref: r.ref }) and not(c.dialogOpen)) and
        recordOf(after, r.id).every(c => c.history == NotObserved)
    | HistoryRefused(r) => r.reason == DialogOpen implies after == before
    | _ => true
  })
pure val refValues = Set(1, 2)
pure def sometimesHistoryObserved(s: SurfaceCommands): bool = s.controls.some(c => c.history != NotObserved)
```

## Story: Keep a guarded page on the sites the app approved

> As the app, I want a page that I guard to ask me before it moves to
> another site, so that I can check the address before anything is
> requested from it.

### A page on an intercepting surface reaches another origin only through a load the app asked for, and a held navigation is reported and changes nothing

On an intercepting surface a main-frame navigation of the page itself, a
server redirect included, proceeds only within the page's origin or to the
origin of the load the app just approved (`goBack`, `goForward`). Any other
is cancelled before a request and reported as `navigationRequested`, with
the address, whether it is a redirect, the person's gesture and its method;
the app loads it with `navigate` once its own check allows it. A held POST
is never replayed. Non-web schemes and addresses with credentials never
load here (`pageRequests.md` offers other-app links). Any other surface
navigates by itself.

```quint
pure def interceptsAt(host: L::SurfaceHost, gen: int): bool = host.surfaces.some(x => x.gen == gen and x.policy.interceptsNavigation)
pure def held(s: SurfaceCommands, id: str, origin: str): bool =
  recordOf(s, id).some(c => interceptsAt(s.host, c.gen) and origin != c.origin and c.approval != ApprovedOrigin({ origin: origin }))
pure def canPageNavigates(s: SurfaceCommands, id: str, href: str, origin: str): bool = L::canPageStarted(s.host, id, href) and origin != ""
pure def pageNavigates(s: SurfaceCommands, id: str, href: str, origin: str): CommandChange =
  if (held(s, id, origin)) { state: s, out: s.host.surfaces.select(x => x.id == id).listMap(x => NavigationRequested({ id: id, realm: x.realm, href: href })) }
  else { state: afterHostChange(L::pageStarted(s.host, id, href),
    { ...s, controls: s.controls.listMap(c => if (forId(s, id, c)) { ...c, origin: origin, approval: NoApproval } else c) }), out: List() }
pure def stepAnInterceptingPageLeavesItsOriginOnlyAsApproved(before: SurfaceCommands, via: str, after: SurfaceCommands): bool =
  after.controls.every(c => before.controls.every(b => b.gen != c.gen or b.origin == c.origin or not(interceptsAt(before.host, b.gen)) or
    via == "navigate" or (via == "pageNavigates" and b.approval == ApprovedOrigin({ origin: c.origin }))))
pure def stepAHeldNavigationIsReportedAndChangesNothing(before: SurfaceCommands, via: str, after: SurfaceCommands, out: List[CommandReply]): bool =
  out.every(n => match n {
    | NavigationRequested(r) => after == before and before.host.surfaces.some(x => x.id == r.id and x.realm == r.realm and x.policy.interceptsNavigation)
    | _ => true
  })
pure def sometimesGuardedPageLoadedOnAnotherSite(s: SurfaceCommands): bool =
  s.controls.some(c => interceptsAt(s.host, c.gen) and c.origin == "https://other.test" and
    s.host.surfaces.some(x => x.gen == c.gen and x.page.href == "https://other.test/" and x.page.result == L::PageLoaded))
```

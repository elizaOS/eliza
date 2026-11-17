# Views

The agent's views are the declarations its plugins and its launch make:
each names a view, its type and the installation the agent gave it. They
are fixed at boot. A renderer reaches them through three Root routes:
`POST /api/views/:id/navigate` with `prepareOnly: true`,
`POST /api/views/interact-claim` and `POST /api/views/interact-result`.
An interaction the agent asks of a view goes to the `view-interact` stream
of that renderer's client only (`conversation/events.md`).
[Core views](../core/views.md) own the request lifecycle and the rule that
a completion matches its request, renderer, installation and view; core
`viewNavigation` is the renderer's own queue and fences. This machine
decides which requests the agent waits on, who may claim and answer each,
and which view the agent records as shown.

The binding a renderer presents is
`{requestId, clientId, viewId, viewType, installationId}`; the prepare
reply returns it, and claim and result must repeat it exactly. The shell
makes each claim id a fresh UUID, and decodes a navigation's result body,
which must be exactly `{switched}` with no error.

## Story: Declare my views once

> As the owner, I want the views my product declares to stay the same
> while my agent runs, so that a binding a renderer holds always names a
> view that exists.

### Views are declared once at boot, each id and type once, and never change after

```quint
import views as V from "../core/views"
type ViewType = Gui | Tui | Xr
type DeclaredView = { viewId: str, viewType: ViewType, installationId: str }
type HostPhase = Booting | Serving | Closed
type WaiterKind = Navigation | Interaction
type Claim = Unclaimed | Claimed({ claimId: str })
type Waiter = { req: V::ViewRequest, kind: WaiterKind, viewType: ViewType, claim: Claim }
type ViewHost = { phase: HostPhase, views: List[DeclaredView], requestIds: List[str], waiters: str -> Waiter, openNavigation: str -> str, shownClients: List[str], shown: str -> str }
pure val initial: ViewHost = { phase: Booting, views: List(), requestIds: List(), waiters: Map(), openNavigation: Map(), shownClients: List(), shown: Map() }
pure def viewsDistinct(views: List[DeclaredView]): bool =
  views.every(d => d.viewId != "" and d.installationId != "" and views.select(o => o.viewId == d.viewId and o.viewType == d.viewType).length() == 1)
pure def canBootViews(h: ViewHost, views: List[DeclaredView]): bool = h.phase == Booting and viewsDistinct(views)
pure def bootViews(h: ViewHost, views: List[DeclaredView]): ViewHost = { ...h, phase: Serving, views: views }
pure def alwaysViewsDistinct(h: ViewHost): bool =
  viewsDistinct(h.views) and (h.phase == Booting implies (h.views == List() and h.requestIds == List() and h.shownClients == List()))
pure def stepViewsFixedAfterBoot(before: ViewHost, after: ViewHost): bool = before.phase != Booting implies after.views == before.views
pure val chatView: DeclaredView = { viewId: "chat", viewType: Gui, installationId: "i1" }
pure val notesView: DeclaredView = { viewId: "notes", viewType: Gui, installationId: "i2" }
pure val notesText: DeclaredView = { viewId: "notes", viewType: Tui, installationId: "i3" }
pure val viewsValues = Set(List(chatView, notesView, notesText), List(chatView, { ...chatView, installationId: "i9" }))
```

## Story: Switch to the view the agent named

> As the owner, I want my screen to switch to the view the agent named
> only through my renderer, and the agent to record that view only when
> my renderer confirms the switch, so that it never believes I see a view
> I do not.

### A navigation is prepared only for a declared graphical view and a request id not seen before

```quint
pure val noView: DeclaredView = { viewId: "", viewType: Gui, installationId: "" }
pure val noWaiter: Waiter = { req: V::initial, kind: Interaction, viewType: Gui, claim: Unclaimed }
pure def declares(h: ViewHost, viewId: str, viewType: ViewType): bool = h.views.some(d => d.viewId == viewId and d.viewType == viewType)
pure def declaredAt(h: ViewHost, viewId: str, viewType: ViewType): DeclaredView =
  h.views.select(d => d.viewId == viewId and d.viewType == viewType).nthOr(0, noView)
pure def known(h: ViewHost, requestId: str): bool = h.waiters.keys().contains(requestId)
pure def waiterAt(h: ViewHost, requestId: str): Waiter = if (h.waiters.keys().contains(requestId)) h.waiters.get(requestId) else noWaiter
pure def pending(w: Waiter): bool = w.req.phase == V::Pending
pure def isOpen(h: ViewHost, w: Waiter): bool = h.phase == Serving and pending(w)
pure def isClaimed(c: Claim): bool = match c { | Unclaimed => false | _ => true }
pure def opened(h: ViewHost, requestId: str, clientId: str, viewId: str, viewType: ViewType): bool =
  h.phase == Serving and declares(h, viewId, viewType) and not(known(h, requestId))
    and V::canRequest(V::initial, requestId, clientId, declaredAt(h, viewId, viewType).installationId, viewId)
pure def withNewWaiter(kind: WaiterKind, requestId: str, clientId: str, viewId: str, viewType: ViewType, h: ViewHost): ViewHost = {
  val w = { req: V::request(V::initial, requestId, clientId, declaredAt(h, viewId, viewType).installationId, viewId), kind: kind, viewType: viewType, claim: Unclaimed }
  { ...h, requestIds: h.requestIds.append(requestId), waiters: h.waiters.put(requestId, w) }
}
pure def canPrepareNavigation(h: ViewHost, requestId: str, clientId: str, viewId: str): bool =
  opened(h, requestId, clientId, viewId, Gui) and not(busy(h, clientId))
pure def prepareNavigation(h: ViewHost, requestId: str, clientId: str, viewId: str): ViewHost = {
  val old = openNavigationOf(h, clientId)
  val w = waiterAt(h, old)
  val retired = if (known(h, old) and pending(w)) { ...h, waiters: h.waiters.put(old, { ...w, req: V::retire(w.req) }) } else h
  { ...withNewWaiter(Navigation, requestId, clientId, viewId, Gui, retired), openNavigation: h.openNavigation.put(clientId, requestId) }
}
pure def alwaysRequestsAreListed(h: ViewHost): bool = h.requestIds.every(id => known(h, id))
pure def namesDeclaredView(views: List[DeclaredView], id: str, w: Waiter): bool =
  views.includes({ viewId: w.req.viewId, viewType: w.viewType, installationId: w.req.installationId }) and w.req.requestId == id
    and w.req.phase != V::Available and w.req.epoch == w.req.capturedEpoch and (w.kind == Navigation implies w.viewType == Gui)
pure def alwaysWaitersNameDeclaredViews(h: ViewHost): bool = h.requestIds.every(id => namesDeclaredView(h.views, id, waiterAt(h, id)))
pure val requestIdValues = Set("r1", "r2", "r3")
pure val clientIdValues = Set("c1", "c2")
pure val viewIdValues = Set("chat", "notes")
```

### Preparing again supersedes the client's unclaimed navigation and is refused while one is claimed

A navigation the renderer already claimed is being applied, so a second
one could commit out of order; the client must wait for its result. A
client's only pending navigation is therefore its latest.

```quint
pure def openNavigationOf(h: ViewHost, clientId: str): str =
  if (h.openNavigation.keys().contains(clientId)) h.openNavigation.get(clientId) else ""
pure def busy(h: ViewHost, clientId: str): bool = {
  val w = waiterAt(h, openNavigationOf(h, clientId))
  isOpen(h, w) and isClaimed(w.claim)
}
pure def latestIfPending(h: ViewHost, id: str): bool = {
  val w = waiterAt(h, id)
  (w.kind == Navigation and pending(w)) implies openNavigationOf(h, w.req.clientId) == id
}
pure def alwaysPendingNavigationIsTheLatest(h: ViewHost): bool = h.requestIds.every(id => latestIfPending(h, id))
pure def supersededBy(h: ViewHost, id: str): bool = {
  val w = waiterAt(h, id)
  w.kind == Navigation and w.req.phase == V::Retired and not(isClaimed(w.claim)) and isOpen(h, waiterAt(h, openNavigationOf(h, w.req.clientId)))
}
pure def sometimesNavigationSuperseded(h: ViewHost): bool = h.requestIds.some(id => supersededBy(h, id))
pure def sometimesNavigationBeingApplied(h: ViewHost): bool = h.requestIds.some(id => busy(h, waiterAt(h, id).req.clientId))
```

### A claim names its request's exact binding and succeeds once

```quint
type Binding = { requestId: str, clientId: str, viewId: str, viewType: ViewType, installationId: str }
pure def boundTo(w: Waiter, binding: Binding): bool =
  V::canDeliver(w.req, binding.requestId, binding.clientId, binding.installationId, binding.viewId) and w.viewType == binding.viewType
pure def withWaiter(changed: Waiter, h: ViewHost): ViewHost = { ...h, waiters: h.waiters.put(changed.req.requestId, changed) }
pure def canClaimRequest(h: ViewHost, binding: Binding, claimId: str): bool = {
  val w = waiterAt(h, binding.requestId)
  h.phase == Serving and known(h, binding.requestId) and boundTo(w, binding) and not(isClaimed(w.claim)) and claimId != ""
}
pure def claimRequest(h: ViewHost, binding: Binding, claimId: str): ViewHost =
  withWaiter({ ...waiterAt(h, binding.requestId), claim: Claimed({ claimId: claimId }) }, h)
pure def stepClaimIsFinal(before: ViewHost, after: ViewHost): bool =
  before.requestIds.every(id => isClaimed(waiterAt(before, id).claim) implies waiterAt(after, id).claim == waiterAt(before, id).claim)
pure def bindingOf(requestId: str, clientId: str, view: DeclaredView): Binding =
  { requestId: requestId, clientId: clientId, viewId: view.viewId, viewType: view.viewType, installationId: view.installationId }
pure val bindingValues = Set(
  bindingOf("r1", "c1", chatView), bindingOf("r1", "c1", notesView), bindingOf("r2", "c1", chatView), bindingOf("r2", "c2", notesView),
  bindingOf("r3", "c2", notesText), bindingOf("r3", "c1", chatView), bindingOf("r1", "c2", { ...chatView, installationId: "i9" }), bindingOf("r2", "c1", { ...notesView, viewType: Tui }))
pure val claimIdValues = Set("k1", "k2", "")
```

### A result is accepted once, with its claim id, and a navigation result says whether it switched

```quint
type Reply = Switched | NotSwitched | OtherReply
pure def replyFits(kind: WaiterKind, success: bool, reply: Reply): bool = kind == Interaction or reply == (if (success) Switched else NotSwitched)
pure def claimIdOf(c: Claim): str = match c { | Claimed(x) => x.claimId | Unclaimed => "" }
pure def canAnswerRequest(h: ViewHost, binding: Binding, claimId: str, success: bool, reply: Reply): bool = {
  val w = waiterAt(h, binding.requestId)
  h.phase == Serving and known(h, binding.requestId) and boundTo(w, binding) and isClaimed(w.claim) and claimIdOf(w.claim) == claimId and replyFits(w.kind, success, reply)
}
pure def answerRequest(h: ViewHost, binding: Binding, claimId: str, success: bool, reply: Reply): ViewHost = {
  val w = waiterAt(h, binding.requestId)
  val answered = withWaiter({ ...w, req: V::deliver(w.req, binding.requestId, binding.clientId, binding.installationId, binding.viewId) }, h)
  if (w.kind == Navigation and success)
    { ...answered, shown: h.shown.put(binding.clientId, binding.viewId),
      shownClients: if (h.shownClients.includes(binding.clientId)) h.shownClients else h.shownClients.append(binding.clientId) }
  else answered
}
pure def alwaysAnsweredWasClaimed(h: ViewHost): bool = h.requestIds.every(id => waiterAt(h, id).req.phase == V::Delivered implies isClaimed(waiterAt(h, id).claim))
pure def lawNavigationReplyMatchesSuccess(success: bool, reply: Reply): bool =
  replyFits(Navigation, success, reply) implies (reply != OtherReply and (reply == Switched iff success))
```

### Only a confirmed switch changes the view the agent records as shown

The shown view of each client feeds the planner's view-scoped actions
(core views).

```quint
pure def shownViewOf(h: ViewHost, clientId: str): str = if (h.shown.keys().contains(clientId)) h.shown.get(clientId) else ""
pure def alwaysShownViewsAreDeclaredGraphical(h: ViewHost): bool = h.shownClients.every(c => declares(h, shownViewOf(h, c), Gui))
pure def stepShownChangesOnlyOnConfirmedSwitch(before: ViewHost, via: str, after: ViewHost): bool =
  not(after.shown == before.shown) implies via == "answerRequest"
pure def sometimesSwitchConfirmed(h: ViewHost): bool = h.shownClients.length() > 0
```

## Story: Answer what the agent asks a view

> As the owner, I want a question the agent sends to one of my views to be
> answered at most once, by that view on the client it was sent to, so
> that a lost or late answer never runs it twice.

### The agent asks only a declared view, on one client's interaction stream

The request is published on the `view-interact` stream bound to its
client; it shares the claim and result rules above.

```quint
pure def canAskView(h: ViewHost, requestId: str, clientId: str, viewId: str, viewType: ViewType): bool = opened(h, requestId, clientId, viewId, viewType)
pure def askView(h: ViewHost, requestId: str, clientId: str, viewId: str, viewType: ViewType): ViewHost =
  withNewWaiter(Interaction, requestId, clientId, viewId, viewType, h)
pure def sometimesInteractionAnswered(h: ViewHost): bool =
  h.requestIds.some(id => waiterAt(h, id).kind == Interaction and waiterAt(h, id).req.phase == V::Delivered)
```

### A request whose renderer left or whose wait ran out ends unknown and is never claimed or answered again

The agent's wait sees a refusal whose outcome is unknown, never a failure
or a success, and the request is not offered again.

```quint
pure def canAbandonRequest(h: ViewHost, requestId: str): bool = known(h, requestId) and isOpen(h, waiterAt(h, requestId))
pure def abandonRequest(h: ViewHost, requestId: str): ViewHost = withWaiter({ ...waiterAt(h, requestId), req: V::retire(waiterAt(h, requestId).req) }, h)
pure def stepEndedRequestStaysEnded(before: ViewHost, after: ViewHost): bool =
  before.requestIds.every(id => V::stepTerminalHandoffStaysTerminal(waiterAt(before, id).req, waiterAt(after, id).req))
pure def sometimesClaimedRequestLost(h: ViewHost): bool =
  h.phase == Serving and h.requestIds.some(id => waiterAt(h, id).req.phase == V::Retired and isClaimed(waiterAt(h, id).claim))
```

## Story: Stop waiting when my agent stops

> As the owner, I want stopping my agent to end every request it waits
> on, so that no renderer can claim or answer one afterwards.

### Closing ends every open request, and nothing changes after

A request still pending when the agent closes is no longer open: its wait
ends unknown, and no route can prepare, ask, claim or answer again.

```quint
pure def canCloseHost(h: ViewHost): bool = h.phase != Closed
pure def closeHost(h: ViewHost): ViewHost = { ...h, phase: Closed }
pure def stepNothingChangesAfterClose(before: ViewHost, after: ViewHost): bool = before.phase == Closed implies after == before
pure def sometimesClosedWithPendingRequest(h: ViewHost): bool = h.phase == Closed and h.requestIds.some(id => pending(waiterAt(h, id)))
```

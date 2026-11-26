# Views

The agent's views are the graphical views its launch declares and the
plugins loaded before this module declare, fixed at boot. A renderer reaches them through three Root routes:
`POST /api/views/:id/navigate` (prepare only), `POST
/api/views/interact-claim` and `POST /api/views/interact-result`.
[Core views](../core/views.md) own the request lifecycle and the rule that
a completion matches its request, renderer, installation and view; the
renderer's own queue and fences are core `viewNavigation`, which this
machine does not hold. This machine decides which requests the agent waits
on and which binding claims and answers each. The routes are Root, so the one owner is the only caller: a
binding routes a claim or a result to its request and carries no owner, and
no role gate is checked at claim or result (`access/routes.md`).

A binding is `{requestId, clientId, viewId, viewType: "gui",
installationId}`; the shell refuses any other `viewType`. Wire shapes:

- Prepare: body exactly `{clientId, delivery: "completed-action",
  prepareOnly: true, viewType: "gui", completedActionHandoffId,
  resolvedAlias?, source?}`, where `source` is `agent` or `user` and the
  request id is `completedActionHandoffId`. Reply `{ok: true, status:
  "prepared", viewId, completedActionHandoffId, navigationBinding}`; a
  refused prepare is 409.
- Claim: body the binding; reply `{claimId}` (a fresh UUID); a refused
  claim is 409. A renderer that supports saved Notes editors adds
  `targetProtocol: "saved-note-v1"`. Only an exact saved-editor claim returns
  a `target: {kind: "saved-note", noteId}`.
- Result: body the binding, `claimId`, `success`, and for a navigation
  `result: {switched}`. Reply always `{ok: true, accepted}`; a refused
  result is `accepted: false`. A successful saved-editor switch additionally
  sends `result.shown: {kind: "saved-note", noteId}`.
- The client id comes from the `x-elizaos-client-id` header or the body;
  a missing binding field is 400.
- An ask goes out as `{type: "view:interact", installationId, viewId,
  viewType: "gui", capability, params, requestId}` with an agent-made UUID,
  on the `view-interact` feed of that client (`conversation/events.md`).

## Story: Declare my views once

> As the owner, I want the views my product declares to stay the same
> while my agent runs, so that a binding a renderer holds always names a
> view that exists.

### Views are declared once at boot with distinct ids, paths and names, and never change after

A launch declaration (`launch.views`, at most 32 entries and 16384 bytes)
is exactly `{id, label, path, aliases?}`: `id` matches
`^[a-z][a-z0-9_-]{0,63}$`; `label` is trimmed, nonempty, at most 80
characters, with no control character; `path` matches
`^/(?:[a-zA-Z0-9_-]+/)*[a-zA-Z0-9_-]+$` and has at most 256 characters;
`aliases` holds 1 to 4 entries matching `^[a-z](?:[a-z0-9 _-]{0,30}[a-z0-9])?$`.
It may not replace a built-in view other than a preview one. Ids, labels
and aliases are names, compared case-folded (the shell folds them): no name
belongs to two views. An invalid declaration refuses boot with exit class
`Config` (`host/launch.md`).

```quint
import views as V from "../core/views"
type DeclaredView = { viewId: str, label: str, path: str, aliases: List[str], installationId: str }
type HostPhase = Booting | Serving | Closed
type WaiterKind = Navigation | Interaction
type Claim = Unclaimed | Claimed({ claimId: str })
type WaitOutcome = Waiting | Replied | Unknown | Superseded | Stopped
type Waiter = { req: V::ViewRequest, kind: WaiterKind, claim: Claim, outcome: WaitOutcome }
type ViewHost = { phase: HostPhase, views: List[DeclaredView], requestIds: List[str], waiters: str -> Waiter, openNavigation: str -> str }
pure val initial: ViewHost = { phase: Booting, views: List(), requestIds: List(), waiters: Map(), openNavigation: Map() }
pure def namesOf(d: DeclaredView): List[str] = List(d.viewId, d.label).concat(d.aliases)
pure def viewsDistinct(views: List[DeclaredView]): bool =
  views.every(d => d.viewId != "" and d.label != "" and d.path != "" and d.installationId != ""
    and views.select(o => o.path == d.path or namesOf(o).some(n => namesOf(d).includes(n))).length() == 1)
pure def canBootViews(h: ViewHost, views: List[DeclaredView]): bool = h.phase == Booting and viewsDistinct(views)
pure def bootViews(h: ViewHost, views: List[DeclaredView]): ViewHost = { ...h, phase: Serving, views: views }
pure def alwaysViewsDistinct(h: ViewHost): bool =
  viewsDistinct(h.views) and (h.phase == Booting implies (h.views == List() and h.requestIds == List()))
pure def stepViewsFixedAfterBoot(before: ViewHost, after: ViewHost): bool = before.phase != Booting implies after.views == before.views
pure val viewsValues = Set(
  List({ viewId: "chat", label: "Chat", path: "/chat", aliases: List("home"), installationId: "i1" },
    { viewId: "notes", label: "Notes", path: "/notes", aliases: List("memo"), installationId: "i2" }),
  List({ viewId: "chat", label: "Chat", path: "/chat", aliases: List(), installationId: "i1" },
    { viewId: "chat", label: "Talk", path: "/talk", aliases: List(), installationId: "i9" }),
  List({ viewId: "chat", label: "Chat", path: "/chat", aliases: List(), installationId: "i1" },
    { viewId: "notes", label: "Notes", path: "/notes", aliases: List("chat"), installationId: "i2" }))
```

### Every request names a declared view, and its outcome agrees with its phase

```quint
pure val noView: DeclaredView = { viewId: "", label: "", path: "", aliases: List(), installationId: "" }
pure val noWaiter: Waiter = { req: V::initial, kind: Interaction, claim: Unclaimed, outcome: Waiting }
pure def declares(h: ViewHost, viewId: str): bool = h.views.some(d => d.viewId == viewId)
pure def declaredAt(h: ViewHost, viewId: str): DeclaredView = h.views.select(d => d.viewId == viewId).nthOr(0, noView)
pure def known(h: ViewHost, requestId: str): bool = h.requestIds.includes(requestId)
pure def waiterAt(h: ViewHost, requestId: str): Waiter = if (h.waiters.keys().contains(requestId)) h.waiters.get(requestId) else noWaiter
pure def pending(w: Waiter): bool = w.req.phase == V::Pending
pure def isOpen(h: ViewHost, w: Waiter): bool = h.phase == Serving and pending(w)
pure def isClaimed(c: Claim): bool = match c { | Unclaimed => false | _ => true }
pure def withWaiter(id: str, changed: Waiter, h: ViewHost): ViewHost = { ...h, waiters: h.waiters.put(id, changed) }
pure def namesDeclaredView(views: List[DeclaredView], id: str, w: Waiter): bool =
  views.some(d => d.viewId == w.req.viewId and d.installationId == w.req.installationId) and w.req.requestId == id
    and w.req.phase != V::Available and (pending(w) iff w.outcome == Waiting) and ((w.req.phase == V::Delivered) iff (w.outcome == Replied))
pure def alwaysRequestsAreListed(h: ViewHost): bool = h.requestIds.every(id => h.waiters.keys().contains(id))
pure def alwaysWaitersNameDeclaredViews(h: ViewHost): bool = h.requestIds.every(id => namesDeclaredView(h.views, id, waiterAt(h, id)))
```

## Story: Switch to the view the agent named

> As the owner, I want my screen to switch to the view the agent named
> only through my renderer, and the agent to hear from my renderer whether
> it switched, so that it never believes I see a view I do not.

### A navigation is prepared only for a declared view and a request id not seen before

Every request id the run has used stays known until the agent stops, so a
late or replayed id is never a new request. A prepared navigation waits
`navigationWaitMs`. A renderer may also prepare, with its own request id
and `source: user`, a switch the owner already made, and confirm it the
same way.

```quint
pure val navigationWaitMs = 120000
pure def opened(h: ViewHost, requestId: str, clientId: str, viewId: str): bool =
  h.phase == Serving and declares(h, viewId) and not(known(h, requestId))
    and V::canRequest(V::initial, requestId, clientId, declaredAt(h, viewId).installationId, viewId)
pure def withNewWaiter(kind: WaiterKind, requestId: str, clientId: str, viewId: str, h: ViewHost): ViewHost = {
  val w = { req: V::request(V::initial, requestId, clientId, declaredAt(h, viewId).installationId, viewId), kind: kind, claim: Unclaimed, outcome: Waiting }
  { ...h, requestIds: h.requestIds.append(requestId), waiters: h.waiters.put(requestId, w) }
}
pure def canPrepareNavigation(h: ViewHost, requestId: str, clientId: str, viewId: str): bool =
  opened(h, requestId, clientId, viewId) and not(busy(h, clientId))
pure def prepareNavigation(h: ViewHost, requestId: str, clientId: str, viewId: str): ViewHost = {
  val old = openNavigationOf(h, clientId)
  val w = waiterAt(h, old)
  val retired = if (known(h, old) and pending(w)) withWaiter(old, { ...w, req: V::retire(w.req), outcome: Superseded }, h) else h
  { ...withNewWaiter(Navigation, requestId, clientId, viewId, retired), openNavigation: h.openNavigation.put(clientId, requestId) }
}
pure val requestIdValues = Set("r1", "r2", "r3")
pure val clientIdValues = Set("c1", "c2")
pure val viewIdValues = Set("chat", "notes", "files")
```

### Preparing again supersedes the client's unclaimed navigation and is refused while one is claimed

A navigation the renderer already claimed is being applied, so a second
one could commit out of order; the client must wait for its result. A
preparation first waits up to `navigationBusyWaitMs`, under the show
action's own deadline, for the client's claimed navigation to end, and
then prepares against the state that one left, so a turn that arrives just
after a renderer's report is queued rather than refused. The superseded
navigation's wait ends with the outcome `Superseded`. A client's only
pending navigation is therefore its latest.

```quint
pure val navigationBusyWaitMs = 4000
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
pure def sometimesNavigationSuperseded(h: ViewHost): bool = h.phase == Serving and h.requestIds.some(id => waiterAt(h, id).outcome == Superseded)
pure def sometimesNavigationBeingApplied(h: ViewHost): bool = h.requestIds.some(id => busy(h, waiterAt(h, id).req.clientId))
```

### The agent prepares a navigation only for the renderer bound to its turn and one view its name resolves to

The show action reads the turn's renderer from message metadata
(`viewClientId`, with `viewDelivery: "completed-action"`) and refuses a
turn without one. It resolves the name to the one view with that id, label
or alias; boot makes a name ambiguous never, so an unknown name is refused.
It prepares with a fresh UUID, refuses unless the returned binding is
exactly its own, and returns `values {mode: "show", viewId, viewPath,
viewType: "gui", label, completedActionDelivered: false,
completedActionHandoffId, navigationPrepared: true, navigationBinding}`
and no other key (core views parses them). The turn's completed action
includes the validated prepared handoff in its reply's action data, so the
renderer can claim the request using that exact binding. A refusal carries
no prepared handoff. The renderer applies the navigation only after the
reply is shown, and a screen that cannot show the view stays where it is,
so the show action's text says the view opens once the reply is shown and
is not open yet: the reply then never says the view already opened.
When the turn's renderer says which views it can show now (`uiViews`,
`spec/agent/conversation/turnContext.md`), a view outside that list, a
saved Notes editor included as the Notes view, is refused before anything
is prepared, with text saying that screen cannot show it, so the reply
says so instead of promising an open that will not happen. A renderer that
says nothing keeps every declared view.

```quint
pure def targets(h: ViewHost, target: str): List[DeclaredView] = h.views.select(d => namesOf(d).includes(target))
pure def canShowView(h: ViewHost, requestId: str, clientId: str, target: str): bool =
  targets(h, target).length() == 1 and canPrepareNavigation(h, requestId, clientId, targets(h, target).nthOr(0, noView).viewId)
pure def showView(h: ViewHost, requestId: str, clientId: str, target: str): ViewHost =
  prepareNavigation(h, requestId, clientId, targets(h, target).nthOr(0, noView).viewId)
pure val targetValues = Set("Notes", "home", "nowhere")
pure def screenCanShow(stated: bool, screenViews: List[str], viewId: str): bool = not(stated) or screenViews.includes(viewId)
pure def lawAViewTheScreenCannotShowIsNeverPrepared(stated: bool): bool =
  stated implies not(screenCanShow(stated, List("home", "notes"), "messages"))
pure def lawASilentRendererKeepsEveryView(stated: bool): bool =
  not(stated) implies screenCanShow(stated, List(), "messages")
```

### The model is told every declared view by its names, and on a bound turn the view the owner's screen showed

The show action's description names every declared view by its label,
with its aliases, and says that a view is a screen of the app on the
owner's device: going to a view by its name, such as going home, is
showing that view, and only directions, a route or travel to a place
belong to Maps. On a turn bound to a renderer, its
turn note names the declared view the turn's observation says the screen
showed as the message was sent, as the only view showing now; a turn whose
observation names no declared view gets no such line. So the model picks a
view among those that exist, by what is on screen now, not by a name it
guessed, a screen an earlier turn showed, or a place the view shares a
name with.

```quint
pure def screenTold(h: ViewHost, observed: str): bool = targets(h, observed).length() == 1
```

### A specific saved Notes editor is prepared only after a matching current lookup on a supported renderer

The model opens one saved note, in whatever words the owner asked for it,
by calling VIEWS with `view: "notes-editor"` and `note` set to the note's
title or text, or to the ID the lookup read it by, only after a unique
successful `NOTES_GET` in the same turn.
The canonical resident collection must still match that `note` uniquely to
the note the lookup found. A note the same turn created with `NOTES_CREATE`
is found exactly by that creation instead: `note` names its title, the
turn created that one note, and the collection still holds it by its id,
even when other notes share the title. A call without `note`, an uncertain
or changed record, a private surface, a phone-native Notes source, or a
renderer without the saved-editor protocol has no prepared saved-editor
switch. The
prepared action has `subview: "saved-note-v1"` and carries no note id or
note text. Any other view name opens that view, including the Notes list,
whatever note the call names. A renderer with the saved-editor protocol
tells the model how to open a saved note on each of its turns.

```quint
pure def savedNotePreparationAllowed(noteNamed: bool, rendererBound: bool, rendererSupports: bool, residentSource: bool, privateView: bool, exactCurrentLookup: bool): bool =
  noteNamed and rendererBound and rendererSupports and residentSource and not(privateView) and exactCurrentLookup
pure def lawAnUnnamedNoteOpensNoEditor(rendererBound: bool, rendererSupports: bool, residentSource: bool, privateView: bool, exactCurrentLookup: bool): bool =
  not(savedNotePreparationAllowed(false, rendererBound, rendererSupports, residentSource, privateView, exactCurrentLookup))
pure def lawAnUnconfirmedLookupOpensNoEditor(noteNamed: bool, rendererBound: bool, rendererSupports: bool, residentSource: bool, privateView: bool): bool =
  not(savedNotePreparationAllowed(noteNamed, rendererBound, rendererSupports, residentSource, privateView, false))
```

### A saved Notes editor claim requires support and only its exact editor can confirm the switch

A prepared saved-editor request adds its exact saved note id to the living
Notes navigation wait. Only the renderer bound to the request can claim it,
with saved-editor support, and the claim is how that renderer learns the id.
A refusal leaves the view unconfirmed. The host never treats a generic switch
or a different editor as a successful switch for that request.

```quint
pure def savedNoteClaimAllowed(expected: str, supportsSavedNote: bool): bool =
  expected == "" or supportsSavedNote
pure def savedNoteResultAllowed(expected: str, refused: bool, shown: str): bool =
  expected == "" or refused or (shown != "" and shown == expected)
```

### A claim names its request's exact binding and succeeds once

A request is answered only after its claim, and a claim never changes.

```quint
type Binding = { requestId: str, clientId: str, viewId: str, installationId: str }
pure def boundTo(w: Waiter, binding: Binding): bool = V::canDeliver(w.req, binding.requestId, binding.clientId, binding.installationId, binding.viewId)
pure def canClaimRequest(h: ViewHost, binding: Binding, claimId: str): bool = {
  val w = waiterAt(h, binding.requestId)
  h.phase == Serving and known(h, binding.requestId) and boundTo(w, binding) and not(isClaimed(w.claim)) and claimId != ""
}
pure def claimRequest(h: ViewHost, binding: Binding, claimId: str): ViewHost =
  withWaiter(binding.requestId, { ...waiterAt(h, binding.requestId), claim: Claimed({ claimId: claimId }) }, h)
pure def stepClaimIsFinal(before: ViewHost, after: ViewHost): bool =
  before.requestIds.every(id => isClaimed(waiterAt(before, id).claim) implies waiterAt(after, id).claim == waiterAt(before, id).claim)
pure def alwaysAnsweredWasClaimed(h: ViewHost): bool = h.requestIds.every(id => waiterAt(h, id).req.phase == V::Delivered implies isClaimed(waiterAt(h, id).claim))
pure val bindingValues = Set(
  { requestId: "r1", clientId: "c1", viewId: "chat", installationId: "i1" }, { requestId: "r1", clientId: "c1", viewId: "notes", installationId: "i2" },
  { requestId: "r2", clientId: "c1", viewId: "chat", installationId: "i1" }, { requestId: "r2", clientId: "c2", viewId: "notes", installationId: "i2" },
  { requestId: "r3", clientId: "c1", viewId: "chat", installationId: "i1" }, { requestId: "r1", clientId: "c2", viewId: "chat", installationId: "i9" })
pure val claimIdValues = Set("k1", "k2", "")
```

### A result is accepted once, with its claim id, and a navigation result says whether it switched

The shell decodes a navigation's `{success, result: {switched}}` into
`Switched` or `NotSwitched`, and an interaction's into `Answered`.

```quint
type Reply = Switched | NotSwitched | Answered
pure def replyFits(kind: WaiterKind, reply: Reply): bool = (kind == Navigation) iff (reply != Answered)
pure def claimIdOf(c: Claim): str = match c { | Claimed(x) => x.claimId | Unclaimed => "" }
pure def canAnswerRequest(h: ViewHost, binding: Binding, claimId: str, reply: Reply): bool = {
  val w = waiterAt(h, binding.requestId)
  h.phase == Serving and known(h, binding.requestId) and boundTo(w, binding) and isClaimed(w.claim) and claimIdOf(w.claim) == claimId and replyFits(w.kind, reply)
}
pure def answerRequest(h: ViewHost, binding: Binding, claimId: str, reply: Reply): ViewHost = {
  val w = waiterAt(h, binding.requestId)
  withWaiter(binding.requestId, { ...w, req: V::deliver(w.req, binding.requestId, binding.clientId, binding.installationId, binding.viewId), outcome: Replied }, h)
}
```

## Story: Answer what the agent asks a view

> As the owner, I want a question the agent sends to one of my views to be
> answered at most once, by the renderer it was sent to, so that a lost or
> late answer never runs it twice.

### The agent asks only a declared view, for a capability the view grants the agent, on a live feed

The ask names a capability. It is admitted only when the caller's role
meets the view's role gate, the capability is standard or the view
declares it, the view's manifest allows it (a standard non-read-only
surface capability needs the view's `agent-surface` grant), and the view
does not reserve it for direct human use. The client must have a live
`view-interact` feed: zero receivers refuses the ask as unavailable. A
refused ask publishes no frame. An admitted ask waits `interactionWaitMs`.

```quint
type CapabilityGrant = { roleAllowed: bool, standard: bool, declared: bool, manifestAllows: bool, agentAuthority: bool }
pure val interactionWaitMs = 5000
pure def viewInteractAdmitted(grant: CapabilityGrant): bool =
  grant.roleAllowed and (grant.standard or grant.declared) and grant.manifestAllows and grant.agentAuthority
pure def lawUndeclaredCapabilityIsRefused(grant: CapabilityGrant): bool = not(grant.standard or grant.declared) implies not(viewInteractAdmitted(grant))
pure def lawManifestDecidesAgentAuthority(grant: CapabilityGrant): bool =
  not(grant.manifestAllows and grant.agentAuthority) implies not(viewInteractAdmitted(grant))
pure def canAskView(h: ViewHost, requestId: str, clientId: str, viewId: str, capability: str, grant: CapabilityGrant, subscribed: bool): bool =
  opened(h, requestId, clientId, viewId) and capability != "" and viewInteractAdmitted(grant) and subscribed
pure def askView(h: ViewHost, requestId: str, clientId: str, viewId: str, capability: str, grant: CapabilityGrant, subscribed: bool): ViewHost =
  withNewWaiter(Interaction, requestId, clientId, viewId, h)
pure def sometimesInteractionAnswered(h: ViewHost): bool =
  h.requestIds.some(id => waiterAt(h, id).kind == Interaction and waiterAt(h, id).req.phase == V::Delivered)
pure val capabilityValues = Set("get-state", "")
pure val grantValues = Set(
  { roleAllowed: true, standard: true, declared: false, manifestAllows: true, agentAuthority: true },
  { roleAllowed: true, standard: false, declared: false, manifestAllows: true, agentAuthority: true },
  { roleAllowed: true, standard: false, declared: true, manifestAllows: true, agentAuthority: false },
  { roleAllowed: false, standard: false, declared: true, manifestAllows: true, agentAuthority: true })
```

### A request whose renderer left, whose delivery failed or whose wait ran out ends unknown and never changes again

The shell abandons the request when its wait ends, its client's renderer
disconnects, or publishing its frame throws. A claimed navigation's wait
also ends `navigationClaimLeaseMs` after its claim: the renderer may have
lost the claim reply, and nobody else can answer that claim, so it would
otherwise keep the client busy for the whole `navigationWaitMs`. The
agent's wait then sees the outcome `Unknown`, never a failure or a
success, and the request is not offered again; a late result for it is not
accepted.

```quint
pure val navigationClaimLeaseMs = 10000
pure def canAbandonRequest(h: ViewHost, requestId: str): bool = known(h, requestId) and isOpen(h, waiterAt(h, requestId))
pure def abandonRequest(h: ViewHost, requestId: str): ViewHost = {
  val w = waiterAt(h, requestId)
  withWaiter(requestId, { ...w, req: V::retire(w.req), outcome: Unknown }, h)
}
pure def stepEndedRequestStaysEnded(before: ViewHost, after: ViewHost): bool =
  before.requestIds.every(id => not(pending(waiterAt(before, id))) implies waiterAt(after, id) == waiterAt(before, id))
pure def sometimesClaimedRequestLost(h: ViewHost): bool =
  h.phase == Serving and h.requestIds.some(id => waiterAt(h, id).outcome == Unknown and isClaimed(waiterAt(h, id).claim))
```

## Story: Stop waiting when my agent stops

> As the owner, I want stopping my agent to end every request it waits
> on, so that no renderer can claim or answer one afterwards.

### Closing ends every pending request with the outcome Stopped, and nothing changes after

```quint
pure def stopped(m: str -> Waiter, id: str): str -> Waiter =
  if (m.keys().contains(id) and m.get(id).req.phase == V::Pending) m.put(id, { ...m.get(id), req: V::retire(m.get(id).req), outcome: Stopped }) else m
pure def canCloseHost(h: ViewHost): bool = h.phase != Closed
pure def closeHost(h: ViewHost): ViewHost = { ...h, phase: Closed, waiters: h.requestIds.foldl(h.waiters, (m, id) => stopped(m, id)) }
pure def alwaysClosedHoldsNoPending(h: ViewHost): bool = h.phase == Closed implies h.requestIds.every(id => not(pending(waiterAt(h, id))))
pure def stepNothingChangesAfterClose(before: ViewHost, after: ViewHost): bool = before.phase == Closed implies after == before
pure def sometimesRequestStoppedByClose(h: ViewHost): bool = h.phase == Closed and h.requestIds.some(id => waiterAt(h, id).outcome == Stopped)
```

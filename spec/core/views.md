# View declarations and completed-action handoffs

Sources are `views/{declarations,surface-manifest,host-external-contract,view-interact-protocol,view-action-handoff,completed-action-navigation}.ts` and `events.ts`. Preserve GUI/TUI/XR modality resolution, view visibility, exact capability ids, surface ownership and renderer-safe imports. Client ids route requests and supply no authority by themselves.

## Story: Deliver a completed action to the intended view

> As a user, I want a completed action to reach the view that requested it,
> so that it neither overrides navigation I made since nor lands in the
> wrong view.

### Completion requires matching request renderer installation and view identities

Prepared navigation binds the request id, completed-action handoff id, client id, installation id, view id and GUI view type. The parser accepts successful qualifying VIEWS, APP-browser and BROWSER-workspace actions according to the source rules, scanning newest first. Invalid prepared bindings are skipped. Duplicate handoffs remain suppressed while retained by the bounded source cache. A changed navigation epoch invalidates the captured navigation permission even if the path later returns to its original value.

```quint
type ViewPhase = Available | Pending | Delivered | Retired
type ViewRequest = { phase: ViewPhase, requestId: str, clientId: str, installationId: str, viewId: str, epoch: int, capturedEpoch: int }
pure val initial: ViewRequest = { phase: Available, requestId: "", clientId: "", installationId: "", viewId: "", epoch: 0, capturedEpoch: 0 }
pure def canRequest(v: ViewRequest, requestId: str, clientId: str, installationId: str, viewId: str): bool = v.phase == Available and requestId != "" and clientId != "" and installationId != "" and viewId != ""
pure def request(v: ViewRequest, requestId: str, clientId: str, installationId: str, viewId: str): ViewRequest = { ...v, phase: Pending, requestId: requestId, clientId: clientId, installationId: installationId, viewId: viewId, capturedEpoch: v.epoch }
pure def navigate(v: ViewRequest): ViewRequest = { ...v, epoch: v.epoch + 1 }
pure def canDeliver(v: ViewRequest, requestId: str, clientId: str, installationId: str, viewId: str): bool = v.phase == Pending and v.epoch == v.capturedEpoch and v.requestId == requestId and v.clientId == clientId and v.installationId == installationId and v.viewId == viewId
pure def deliver(v: ViewRequest, requestId: str, clientId: str, installationId: str, viewId: str): ViewRequest = { ...v, phase: Delivered }
pure def canRetire(v: ViewRequest): bool = v.phase == Pending
pure def retire(v: ViewRequest): ViewRequest = { ...v, phase: Retired }
pure def alwaysEpochMonotonic(v: ViewRequest): bool = v.epoch >= v.capturedEpoch and v.capturedEpoch >= 0
pure def stepDeliveryUsesCapturedEpoch(before: ViewRequest, via: str, after: ViewRequest): bool = via == "deliver" implies before.epoch == before.capturedEpoch
pure def stepTerminalHandoffStaysTerminal(before: ViewRequest, after: ViewRequest): bool = (before.phase == Delivered or before.phase == Retired) implies before.phase == after.phase
pure def sometimesViewDelivered(v: ViewRequest): bool = v.phase == Delivered
pure def sometimesViewRetired(v: ViewRequest): bool = v.phase == Retired
```

## Story: Offer a caller only the actions its view allows

> As the owner, a view sees only the actions its declaration allows, so an
> action meant for another view is never offered there.

### A view offers only registered actions its declaration lists

A view's declaration lists the actions it scopes. Within that view, the
caller is offered exactly the registered actions the declaration lists; an
unlisted action is unavailable there whatever the caller's role. Whether
the caller's role may run an offered action is [action
planning](./actionPlanning.md)'s check.

```quint
pure def offeredInView(viewActions: Set[str], registeredActions: Set[str]): Set[str] = registeredActions.intersect(viewActions)
pure def lawUnlistedActionUnavailable(viewActions: Set[str], registeredActions: Set[str], actionName: str): bool =
  not(viewActions.contains(actionName)) implies not(offeredInView(viewActions, registeredActions).contains(actionName))
pure val viewActionsValues = Set(Set(), Set("reply"), Set("reply", "manage"))
pure val registeredActionsValues = Set(Set("reply", "manage", "browse"), Set("reply"))
pure val actionNameValues = Set("reply", "manage", "browse")
```

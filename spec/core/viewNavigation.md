# Renderer handoff deduplication and navigation fences

Source `views/completed-action-navigation.ts` owns per-renderer pending and handled handoff indexes, a navigation epoch and its observed window. Each index retains at most 256 identities. This is a separate lifecycle from the interaction request in `views.md`.

## Story: Respect navigation made while a completed-action handoff is pending

As a user, I want a late response to preserve navigation I made after the original request.

### Pending handoffs capture the pre-dispatch epoch and path

A handled id is suppressed. A pending id whose epoch or path changed is retired without redispatch. Otherwise the renderer emits the cancelable navigation event. If a shell handles it, the id enters the handled index. If unhandled and new, the pending index retains the pre-dispatch snapshot. An absent normalized id is dispatched without tracking. A handler can navigate synchronously during dispatch; its new epoch does not replace the captured snapshot.

```quint
type PendingHandoff = { id: str, epoch: int, path: str }
type Navigation = { windowId: str, epoch: int, path: str, handled: List[str], pending: List[PendingHandoff], lastEmitted: bool, lastId: str }
pure val emptyPending: PendingHandoff = { id: "", epoch: 0, path: "" }
pure val initial: Navigation = { windowId: "", epoch: 0, path: "", handled: List(), pending: List(), lastEmitted: false, lastId: "" }
pure def observeWindow(s: Navigation, windowId: str, path: str): Navigation = { ...s, windowId: windowId, path: path }
pure def navigate(s: Navigation, path: str): Navigation = { ...s, path: path, epoch: s.epoch + 1 }
pure def pendingAt(s: Navigation, id: str): PendingHandoff = s.pending.select(entry => entry.id == id).nthOr(0, emptyPending)
pure def rememberHandled(id: str, s: Navigation): Navigation = {
  val entries = s.handled.select(entry => entry != id).append(id)
  { ...s, pending: s.pending.select(entry => entry.id != id), handled: if (entries.length() > 256) entries.tail() else entries }
}
pure def rememberPending(entry: PendingHandoff, s: Navigation): Navigation = {
  val entries = s.pending.select(previous => previous.id != entry.id).append(entry)
  { ...s, pending: if (entries.length() > 256) entries.tail() else entries }
}
pure def dispatchHandoff(s: Navigation, id: str, handledByShell: bool, handlerNavigates: bool, pathAfterHandler: str): Navigation = {
  val pending = pendingAt(s, id)
  val stale = id != "" and pending.id == id and (pending.epoch != s.epoch or pending.path != s.path)
  val refused = s.windowId == "" or (id != "" and s.handled.includes(id)) or stale
  val observed = { ...s, lastId: id, lastEmitted: not(refused) }
  val delivered = if (handlerNavigates and not(refused)) { ...observed, epoch: s.epoch + 1, path: pathAfterHandler } else observed
  if (stale) rememberHandled(id, observed)
  else if (refused or id == "") delivered
  else if (handledByShell) rememberHandled(id, delivered)
  else if (pending.id == "") rememberPending({ id: id, epoch: s.epoch, path: s.path }, delivered)
  else delivered
}
pure def resetNavigation(s: Navigation): Navigation = initial
pure def fenceValid(s: Navigation, windowId: str, epoch: int, path: str): bool = s.windowId == windowId and s.epoch == epoch and s.path == path
pure def alwaysBoundedNavigationIndexes(s: Navigation): bool = s.handled.length() <= 256 and s.pending.length() <= 256 and s.epoch >= 0
pure def alwaysUniqueNavigationIndexes(s: Navigation): bool = s.handled.every(id => s.handled.select(other => other == id).length() == 1) and s.pending.every(entry => s.pending.select(other => other.id == entry.id).length() == 1 and not(s.handled.includes(entry.id)))
pure def sometimesPendingNavigation(s: Navigation): bool = s.pending.length() > 0
pure def sometimesHandledNavigation(s: Navigation): bool = s.handled.length() > 0
pure val entryValues = Set({ id: "first", epoch: 0, path: "/chat" }, { id: "second", epoch: 1, path: "/files" })
```

# Maps attribution

The map shows the provider's copyright for the area in view. Moving the
view outside the attributed area hides the current attribution and asks
again; only the reply to the latest request, for the view it was asked
about, is shown. A failed reply shows nothing, and a disposed map shows
nothing. The connected provider is the
[Cloud Maps connection](./cloudConnection.md).

## Story: Show the right copyright for the map I am looking at

> As the owner, I want the attribution on the map to belong to the area
> I am looking at, never to an area I moved away from.

### Moving the view or asking again hides the shown attribution

Moving the view out of the attributed area hides any attribution and
forgets the pending request. A new request is numbered, remembers which
view it was for, and hides the attribution until it is answered. Moving
within the attributed area changes nothing.

```quint
type MapAttribution = { view: int, nextToken: int, pending: int, requestedView: int, shownView: int, visible: bool, failed: bool, alive: bool }
pure val initial: MapAttribution = { view: 0, nextToken: 1, pending: 0, requestedView: -1, shownView: -1, visible: false, failed: false, alive: true }
pure def canMoveView(s: MapAttribution): bool = s.alive
pure def moveView(s: MapAttribution): MapAttribution = { ...s, view: s.view + 1, pending: 0, visible: false, shownView: -1 }
pure def canRequestAttribution(s: MapAttribution): bool = s.alive
pure def requestAttribution(s: MapAttribution): MapAttribution =
  { ...s, pending: s.nextToken, nextToken: s.nextToken + 1, requestedView: s.view, visible: false, shownView: -1 }
pure def sometimesAwaitingAttribution(s: MapAttribution): bool = s.pending > 0 and s.view > 0
```

### Only the reply to the latest request, for the current view, is shown

A reply shows its attribution only if the map is still alive and the
reply answers the pending request; it is then for the view that request
was about, which is still the view in place. A failed reply shows
nothing and marks the failure until the next success. A late reply to
an older request, or one after the map was disposed, changes nothing.

```quint
pure val tokenValues = Set(1, 2, 3)
pure def canReplyAttribution(s: MapAttribution, token: int, success: bool): bool = token > 0 and token < s.nextToken
pure def replyAttribution(s: MapAttribution, token: int, success: bool): MapAttribution =
  if (s.alive and token == s.pending)
    { ...s, pending: 0, shownView: if (success) s.requestedView else -1, visible: success, failed: not(success) }
  else s
pure def canDisposeMap(s: MapAttribution): bool = s.alive
pure def disposeMap(s: MapAttribution): MapAttribution = { ...s, alive: false, pending: 0, visible: false, shownView: -1 }
pure def alwaysPendingRequestIsForCurrentView(s: MapAttribution): bool = s.pending > 0 implies s.requestedView == s.view and s.alive
pure def alwaysShownAttributionMatchesView(s: MapAttribution): bool =
  s.visible implies s.alive and not(s.failed) and s.pending == 0 and s.shownView == s.view
pure def sometimesAttributionShown(s: MapAttribution): bool = s.visible and s.view > 0
pure def sometimesNewerAttributionShown(s: MapAttribution): bool = s.visible and s.nextToken > 2
```

# Native browser external link authority

A consumer's browser plugin extends the Eliza `BrowserTabHostPlugin`
(`plugins/plugin-native-browser-surface/android`). The Android plugin
owns selection, lifecycle and external intent construction. The
producer's `BrowserExternalHandoff` model covers the direct-tab path;
[page requests](./surface/pageRequests.md) states its resolvable-or-unavailable
rule. The native source additionally admits a one-use gesture-created
popup and has a checked fallback when no app resolves an intent.

A consumer may instead use the older `BrowserSurfacePlugin` bridge. Its
`openExternalLink` accepts only a matching, pending link for the
current owner and surface. It consumes that pending link before
resolving a handler and refuses handlers in its own package. The tab
host instead permits a fixed review action when Android dispatches a
system link to the host itself. Both paths are producer contracts that
each consumer must preserve.

## Story: Hand off a user-selected link to a native review screen

> As the person, I want to hand off a user-selected link to a native
> review screen.

### The tab host admits a tap or a single fresh popup carryover at the selected surface

A direct tab must be selected and have a native gesture. A fresh popup
was created by a gesture, has not committed a page, and may carry its
opener's gesture only while the opener or popup is selected. The first
attempt consumes the allowance even if no capable handler exists.
The intent parser admits only supported destinations and reconstructs
fixed actions. Calling a number or sending a message remains the
person's action in Android.

```quint
type LinkKind = PhoneLink | MailLink | TextLink | MapLink | StoreLink | ForeignIntent | InvalidLink
type ReviewAction = Refused | DialReview | ComposeReview | ViewReview
type TabHostLinkContext = { tabLive: bool, foreground: bool, tabCurrent: bool, tabSelected: bool, gesture: bool, popupFresh: bool, openerSelected: bool, ownHandler: bool }
type SurfaceLinkContext = { ownerActive: bool, sameSurface: bool, pendingId: int, chosenId: int, ownHandler: bool }
pure def systemLink(kind: LinkKind): bool =
  kind == PhoneLink or kind == MailLink or kind == TextLink or kind == MapLink
pure def reviewAction(kind: LinkKind): ReviewAction =
  if (kind == PhoneLink) DialReview
  else if (kind == MailLink or kind == TextLink) ComposeReview
  else if (kind == MapLink or kind == StoreLink or kind == ForeignIntent) ViewReview
  else Refused
pure def tabHostGesture(c: TabHostLinkContext): bool =
  if (c.popupFresh) c.tabSelected or c.openerSelected else c.tabSelected and c.gesture
pure def tabHostReview(c: TabHostLinkContext, kind: LinkKind): ReviewAction =
  if (not(c.tabLive) or not(c.foreground) or not(c.tabCurrent) or not(tabHostGesture(c))) Refused
  else if (c.ownHandler and not(systemLink(kind))) Refused
  else reviewAction(kind)
pure def lawTabHostReviewUsesCurrentTab(c: TabHostLinkContext, kind: LinkKind): bool =
  tabHostReview(c, kind) != Refused implies c.tabLive and c.foreground and c.tabCurrent and tabHostGesture(c)
pure def lawTabHostOwnHandlerIsOnlySystemReview(c: TabHostLinkContext, kind: LinkKind): bool =
  c.ownHandler and tabHostReview(c, kind) != Refused implies systemLink(kind)
pure val cValues = Set(
  {tabLive: true, foreground: true, tabCurrent: true, tabSelected: true, gesture: true, popupFresh: false, openerSelected: false, ownHandler: true},
  {tabLive: true, foreground: true, tabCurrent: true, tabSelected: false, gesture: false, popupFresh: true, openerSelected: true, ownHandler: false},
  {tabLive: true, foreground: false, tabCurrent: true, tabSelected: true, gesture: true, popupFresh: false, openerSelected: false, ownHandler: false},
  {tabLive: true, foreground: true, tabCurrent: true, tabSelected: true, gesture: false, popupFresh: false, openerSelected: false, ownHandler: false}
)
```

### The surface bridge consumes a matching pending link and only a foreign handler may review it

This older surface adapter chooses the supported action from its own
parser. The selected identity represents an exact URL match. A stale
renderer call cannot substitute a different link. The bridge consumes
the matching link even if resolution fails, and does not delegate to
its own private routes.

```quint
pure def acceptsSurfaceLink(g: SurfaceLinkContext): bool =
  g.ownerActive and g.sameSurface and g.pendingId > 0 and g.chosenId == g.pendingId
pure def surfaceReview(g: SurfaceLinkContext, selectedAction: ReviewAction): ReviewAction =
  if (acceptsSurfaceLink(g) and not(g.ownHandler)) selectedAction else Refused
pure def afterSurfaceReview(g: SurfaceLinkContext): int = if (acceptsSurfaceLink(g)) 0 else g.pendingId
pure def lawSurfaceReviewConsumesPending(g: SurfaceLinkContext, selectedAction: ReviewAction): bool =
  surfaceReview(g, selectedAction) != Refused implies acceptsSurfaceLink(g) and afterSurfaceReview(g) == 0 and not(g.ownHandler)
pure def lawSurfaceForeignLinkCannotConsume(g: SurfaceLinkContext): bool =
  g.chosenId != g.pendingId implies afterSurfaceReview(g) == g.pendingId
pure val gValues = Set(
  {ownerActive: true, sameSurface: true, pendingId: 1, chosenId: 1, ownHandler: false},
  {ownerActive: true, sameSurface: true, pendingId: 1, chosenId: 1, ownHandler: true},
  {ownerActive: true, sameSurface: true, pendingId: 1, chosenId: 2, ownHandler: false},
  {ownerActive: false, sameSurface: true, pendingId: 1, chosenId: 1, ownHandler: false}
)
```

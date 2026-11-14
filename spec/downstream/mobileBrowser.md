# Native browser external link authority

Alpha's `android/app/src/main/java/ai/alphacompute/alphaphone/AlphaBrowserPlugin.java`
extends the pinned Eliza `BrowserTabHostPlugin`. The Android plugin
owns selection, lifecycle and external intent construction. The
producer's `plugins/plugin-native-browser-surface/quint/BrowserExternalHandoff.qnt`
models the direct-tab path. The native source additionally admits a
one-use gesture-created popup and has a checked fallback when no app
resolves an intent.

Grace uses the older `BrowserSurfacePlugin` bridge at its pin. Its
`openExternalLink` accepts only a matching, pending link for the
current owner and surface. It consumes that pending link before
resolving a handler and refuses handlers in its own package. Alpha
instead permits a fixed review action when Android dispatches a
system link to the host itself. This distinction is a producer
contract that each app must preserve.

## Story: Hand off a user-selected link to a native review screen

### Alpha admits a tap or a single fresh popup carryover at the selected surface

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
type AlphaLinkContext = { tabLive: bool, foreground: bool, tabCurrent: bool, tabSelected: bool, gesture: bool, popupFresh: bool, openerSelected: bool, ownHandler: bool }
type GraceLinkContext = { ownerActive: bool, sameSurface: bool, pendingId: int, chosenId: int, ownHandler: bool }
pure def systemLink(kind: LinkKind): bool =
  kind == PhoneLink or kind == MailLink or kind == TextLink or kind == MapLink
pure def reviewAction(kind: LinkKind): ReviewAction =
  if (kind == PhoneLink) DialReview
  else if (kind == MailLink or kind == TextLink) ComposeReview
  else if (kind == MapLink or kind == StoreLink or kind == ForeignIntent) ViewReview
  else Refused
pure def alphaGesture(c: AlphaLinkContext): bool =
  if (c.popupFresh) c.tabSelected or c.openerSelected else c.tabSelected and c.gesture
pure def alphaReview(c: AlphaLinkContext, kind: LinkKind): ReviewAction =
  if (not(c.tabLive) or not(c.foreground) or not(c.tabCurrent) or not(alphaGesture(c))) Refused
  else if (c.ownHandler and not(systemLink(kind))) Refused
  else reviewAction(kind)
pure def lawAlphaReviewUsesCurrentTab(c: AlphaLinkContext, kind: LinkKind): bool =
  alphaReview(c, kind) != Refused implies c.tabLive and c.foreground and c.tabCurrent and alphaGesture(c)
pure def lawAlphaOwnHandlerIsOnlySystemReview(c: AlphaLinkContext, kind: LinkKind): bool =
  c.ownHandler and alphaReview(c, kind) != Refused implies systemLink(kind)
pure val cValues = Set(
  {tabLive: true, foreground: true, tabCurrent: true, tabSelected: true, gesture: true, popupFresh: false, openerSelected: false, ownHandler: true},
  {tabLive: true, foreground: true, tabCurrent: true, tabSelected: false, gesture: false, popupFresh: true, openerSelected: true, ownHandler: false},
  {tabLive: true, foreground: false, tabCurrent: true, tabSelected: true, gesture: true, popupFresh: false, openerSelected: false, ownHandler: false},
  {tabLive: true, foreground: true, tabCurrent: true, tabSelected: true, gesture: false, popupFresh: false, openerSelected: false, ownHandler: false}
)
```

### Grace consumes a matching pending link and only a foreign handler may review it

This older surface adapter chooses the supported action from its own
parser. The selected identity represents an exact URL match. A stale
renderer call cannot substitute a different link. The bridge consumes
the matching link even if resolution fails, and does not delegate to
its own private routes.

```quint
pure def acceptsGraceLink(g: GraceLinkContext): bool =
  g.ownerActive and g.sameSurface and g.pendingId > 0 and g.chosenId == g.pendingId
pure def graceReview(g: GraceLinkContext, selectedAction: ReviewAction): ReviewAction =
  if (acceptsGraceLink(g) and not(g.ownHandler)) selectedAction else Refused
pure def afterGraceReview(g: GraceLinkContext): int = if (acceptsGraceLink(g)) 0 else g.pendingId
pure def lawGraceReviewConsumesPending(g: GraceLinkContext, selectedAction: ReviewAction): bool =
  graceReview(g, selectedAction) != Refused implies acceptsGraceLink(g) and afterGraceReview(g) == 0 and not(g.ownHandler)
pure def lawGraceForeignLinkCannotConsume(g: GraceLinkContext): bool =
  g.chosenId != g.pendingId implies afterGraceReview(g) == g.pendingId
pure val gValues = Set(
  {ownerActive: true, sameSurface: true, pendingId: 1, chosenId: 1, ownHandler: false},
  {ownerActive: true, sameSurface: true, pendingId: 1, chosenId: 1, ownHandler: true},
  {ownerActive: true, sameSurface: true, pendingId: 1, chosenId: 2, ownHandler: false},
  {ownerActive: false, sameSurface: true, pendingId: 1, chosenId: 1, ownHandler: false}
)
```

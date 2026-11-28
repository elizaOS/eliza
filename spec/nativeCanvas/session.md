# Native canvas session

## Story: Manage canvas lifecycle, attachment, layers, and touch routing

> As the owner, I want a canvas created with valid positive dimensions, attached before touch delivery, and cleanly destroyed so retired canvases never accept layer mutations or input.

### Canvas session state tracks creation, attachment, layer count, and touch eligibility

Creating a canvas (`createCanvasSession`) requires no live canvas and positive dimensions (`widthPx > 0`, `heightPx > 0`), activating the session with one default layer and incrementing `generation`. Attaching (`attachCanvasSession`) and detaching (`detachCanvasSession`) toggle `attached` on a live canvas, adding (`addCanvasLayer`) and removing (`removeCanvasLayer`) layers keep `layerCount >= 1` while live, and destroying (`destroyCanvasSession`) clears `live`, `attached`, `layerCount`, and dimensions.

```quint
type CanvasSessionState = {
  live: bool,
  attached: bool,
  widthPx: int,
  heightPx: int,
  layerCount: int,
  generation: int,
}

pure val initial: CanvasSessionState = {
  live: false,
  attached: false,
  widthPx: 0,
  heightPx: 0,
  layerCount: 0,
  generation: 0,
}

pure def canCreateCanvasSession(s: CanvasSessionState, widthPx: int, heightPx: int): bool =
  not(s.live) and widthPx > 0 and heightPx > 0

pure def createCanvasSession(s: CanvasSessionState, widthPx: int, heightPx: int): CanvasSessionState = {
  live: true,
  attached: false,
  widthPx: widthPx,
  heightPx: heightPx,
  layerCount: 1,
  generation: s.generation + 1,
}

pure def canAttachCanvasSession(s: CanvasSessionState): bool = s.live and not(s.attached)
pure def attachCanvasSession(s: CanvasSessionState): CanvasSessionState = { ...s, attached: true }

pure def canDetachCanvasSession(s: CanvasSessionState): bool = s.live and s.attached
pure def detachCanvasSession(s: CanvasSessionState): CanvasSessionState = { ...s, attached: false }

pure def canAddCanvasLayer(s: CanvasSessionState): bool = s.live and s.layerCount < 16
pure def addCanvasLayer(s: CanvasSessionState): CanvasSessionState = { ...s, layerCount: s.layerCount + 1 }

pure def canRemoveCanvasLayer(s: CanvasSessionState): bool = s.live and s.layerCount > 1
pure def removeCanvasLayer(s: CanvasSessionState): CanvasSessionState = { ...s, layerCount: s.layerCount - 1 }

pure def canDestroyCanvasSession(s: CanvasSessionState): bool = s.live
pure def destroyCanvasSession(s: CanvasSessionState): CanvasSessionState = {
  live: false,
  attached: false,
  widthPx: 0,
  heightPx: 0,
  layerCount: 0,
  generation: s.generation,
}

pure def alwaysAttachedImpliesLive(s: CanvasSessionState): bool = s.attached implies s.live
pure def alwaysLiveHasPositiveSizeAndLayer(s: CanvasSessionState): bool =
  s.live implies (s.widthPx > 0 and s.heightPx > 0 and s.layerCount >= 1)
pure def alwaysRetiredCanvasIsEmpty(s: CanvasSessionState): bool =
  not(s.live) implies (not(s.attached) and s.widthPx == 0 and s.heightPx == 0 and s.layerCount == 0)
pure def stepCanvasGenerationMonotonic(before: CanvasSessionState, after: CanvasSessionState): bool =
  after.generation >= before.generation
pure def sometimesAttachedMultiLayerCanvas(s: CanvasSessionState): bool = s.live and s.attached and s.layerCount >= 2

pure val widthPxValues = Set(0, 320, 800)
pure val heightPxValues = Set(0, 240, 600)
```

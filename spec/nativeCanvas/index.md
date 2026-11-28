# Native canvas

A canvas is a logical document with layers, presentation and interaction on its chosen host. Native rendering, pixels, snapshots, pointer callbacks, navigation and A2UI transport stay in the shell. See also [Session](./session.md).

## Story: Render and interact with the current canvas only

> As the owner, I want drawing commands and user input applied to the current canvas instance and authorized layer.

### Visual operations use live layers and input requires an attached canvas

Each active canvas has a live identity. Attachment is necessary for touch delivery but a detached canvas may still draw and snapshot. Bounds and coordinates are decoded from the platform before use.

```quint
type CanvasOperation = DrawCanvas | ClearCanvas | ReadCanvasPixels | ObserveCanvasTouch | PushCanvasUi | ResetCanvasUi
type CanvasFrame = { canvasId: str, widthPx: int, heightPx: int, live: bool, attached: bool, touchEnabled: bool }
pure def validCanvasSize(widthPx: int, heightPx: int): bool = widthPx > 0 and heightPx > 0
pure def mayUseCanvas(frame: CanvasFrame, canvasId: str, op: CanvasOperation, layerExists: bool): bool =
  frame.live and frame.canvasId != "" and frame.canvasId == canvasId and
  validCanvasSize(frame.widthPx, frame.heightPx) and
  (op != DrawCanvas or layerExists) and
  (op != ObserveCanvasTouch or (frame.attached and frame.touchEnabled))
pure def lawDetachedCanvasCannotReceiveTouch(frame: CanvasFrame, canvasId: str, layerExists: bool): bool =
  not(frame.attached) implies not(mayUseCanvas(frame, canvasId, ObserveCanvasTouch, layerExists))
pure def lawRetiredCanvasCannotReceiveOperations(frame: CanvasFrame, canvasId: str, op: CanvasOperation, layerExists: bool): bool =
  not(frame.live) implies not(mayUseCanvas(frame, canvasId, op, layerExists))
pure val frameValues = Set(
  { canvasId: "drawing", widthPx: 800, heightPx: 600, live: true, attached: true, touchEnabled: true },
  { canvasId: "drawing", widthPx: 800, heightPx: 600, live: true, attached: false, touchEnabled: true },
  { canvasId: "drawing", widthPx: 800, heightPx: 600, live: false, attached: false, touchEnabled: false })
pure val canvasIdValues = Set("", "drawing", "other")
```

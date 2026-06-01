# @elizaos/capacitor-canvas

A [Capacitor](https://capacitorjs.com/) plugin for elizaOS that provides an interactive 2D canvas with layer management, drawing primitives, web view embedding, and an A2UI bridge for building rich visual UIs in Eliza agent surfaces.

Supported platforms: **browser**, **node** (Electrobun desktop), **iOS**, **Android**.

## What it does

- **Canvas with layers** — create canvases of any size, manage named composited layers with independent opacity, z-index, and transform.
- **Drawing primitives** — rectangles (with corner radius), ellipses, lines, arbitrary paths (Bezier, arc, ellipse, closePath), text with font/align/baseline control, and images (URL or base64).
- **Batch drawing** — submit a typed array of draw commands in a single call for efficient rendering.
- **Gradients, blend modes, shadows, transforms** — applied per draw call or globally.
- **Export** — capture the canvas to a base64 PNG/JPEG/WEBP image or read raw pixel data.
- **Web view** — load any URL inline, fullscreen, or in a popup; evaluate JavaScript in it; capture a screenshot.
- **A2UI bridge** — push structured agent-to-UI messages (text cards, action buttons, forms, status indicators) into a loaded web view and receive back action events.
- **Touch/pointer events** — emit normalized `CanvasTouchEvent` on touch start/move/end/cancel and equivalent mouse drag.

## Installation

```bash
bun add @elizaos/capacitor-canvas
```

Peer dependency (must be installed by the host):

```bash
bun add @capacitor/core
```

For iOS add the pod:

```bash
npx cap sync ios
```

The podspec is `ElizaosCapacitorCanvas.podspec`. iOS deployment target is 15.0, Swift 5.9, frameworks UIKit / CoreGraphics / WebKit.

## Usage

```ts
import { Canvas } from "@elizaos/capacitor-canvas";

// Create a canvas
const { canvasId } = await Canvas.create({ size: { width: 800, height: 600 } });

// Add a layer
const { layerId } = await Canvas.createLayer({
  canvasId,
  layer: { visible: true, opacity: 1, zIndex: 1 },
});

// Draw on it
await Canvas.drawRect({
  canvasId,
  rect: { x: 10, y: 10, width: 200, height: 100 },
  fill: { color: { r: 255, g: 100, b: 0, a: 0.9 } },
  cornerRadius: 8,
  drawOptions: { layerId },
});

// Batch draw
await Canvas.drawBatch({
  canvasId,
  commands: [
    { type: "ellipse", args: { center: { x: 400, y: 300 }, radiusX: 50, radiusY: 50, fill: { color: "#3399ff" } } },
    { type: "text", args: { text: "Hello", position: { x: 400, y: 300 }, style: { font: "sans-serif", size: 24, color: "#fff", align: "center" } } },
  ],
});

// Export to image
const image = await Canvas.toImage({ canvasId, format: "png" });
// image.base64, image.width, image.height

// Attach to DOM (browser/desktop)
await Canvas.attach({ canvasId, element: document.getElementById("canvas-host")! });

// Enable touch events
await Canvas.setTouchEnabled({ canvasId, enabled: true });
const handle = await Canvas.addListener("touch", (evt) => {
  console.log(evt.type, evt.touches);
});

// Embed a web view
await Canvas.navigate({ url: "https://example.com", placement: "inline" });

// Evaluate JS in it
const { result } = await Canvas.eval({ script: "document.title" });

// Push A2UI messages
await Canvas.a2uiPush({
  messages: [
    { role: "assistant", type: "text", content: "Hello from the agent!" },
  ],
});

// Listen for A2UI actions triggered in the web content
await Canvas.addListener("a2uiAction", (evt) => {
  console.log(evt.action, evt.data);
});

// Cleanup
await handle.remove();
await Canvas.destroy({ canvasId });
```

## A2UI message types

| `type`    | Use |
|-----------|-----|
| `text`    | Plain text bubble |
| `card`    | Structured card with title/body |
| `action`  | Clickable action button |
| `form`    | Input form |
| `list`    | Ordered/unordered list |
| `image`   | Image display |
| `status`  | Status indicator |

## Web view events

| Event | Payload | When |
|-------|---------|------|
| `webViewReady` | `{ url, title }` | Navigation completed |
| `navigationError` | `{ url, code, message }` | Load failed |
| `deepLink` | `{ url, path, params }` | `eliza://` URL intercepted |
| `a2uiAction` | `{ action, data, messageId? }` | Web content triggered an action |

## Canvas events

| Event | Payload | When |
|-------|---------|------|
| `touch` | `CanvasTouchEvent` | Touch or mouse drag on canvas |
| `render` | `CanvasRenderEvent` | Each rendered frame (FPS telemetry) |

## Notes

- `snapshot()` only works with `placement: "inline"` or `"fullscreen"`. Cross-origin iframes render a placeholder.
- `eval()` requires the loaded page to handle `eliza:eval` postMessages and reply with `eliza:evalResult`; times out after 5 seconds.
- `a2uiPush` and `a2uiReset` prefer the `window.elizaA2UI` bridge when present; otherwise fall back to `postMessage`.
- Call `attach()` before calling `setTouchEnabled()` — touch handlers are wired on attach.
- Layer canvases are absolute-positioned siblings of the base canvas element; the host container should be `position: relative`.

## License

MIT — elizaOS

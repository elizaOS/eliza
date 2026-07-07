/**
 * Registration entry point for the `ElizaCanvas` Capacitor plugin: the
 * multi-layer 2D canvas, drawing-primitive, and A2UI web-view bridge that
 * elizaOS UI surfaces import as `Canvas`. The web implementation
 * (`CanvasWeb`) is loaded lazily so non-web platforms fall through to their
 * native iOS/Android bridges instead of pulling in DOM-dependent code.
 */

import { registerPlugin } from "@capacitor/core";

import type { CanvasPlugin } from "./definitions";

export * from "./definitions";

const loadWeb = () => import("./web").then((m) => new m.CanvasWeb());

export const Canvas = registerPlugin<CanvasPlugin>("ElizaCanvas", {
  web: loadWeb,
});

import { registerPlugin } from "@capacitor/core";

import type { CanvasPlugin } from "./definitions";

export * from "./definitions";

const loadWeb = () => import("./web").then((m) => new m.CanvasWeb());

export const Canvas = registerPlugin<CanvasPlugin>("ElizaCanvas", {
  web: loadWeb,
});

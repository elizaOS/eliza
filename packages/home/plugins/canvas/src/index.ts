import { registerPlugin } from "@capacitor/core";

import type { CanvasPlugin } from "./definitions";

const loadWeb = () => import("./web").then((m) => new m.CanvasWeb());

export const Canvas = registerPlugin<CanvasPlugin>("Canvas", {
  web: loadWeb,
  electron: loadWeb,
});

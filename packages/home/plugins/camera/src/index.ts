import { registerPlugin } from "@capacitor/core";

import type { CameraPlugin } from "./definitions";

const loadWeb = () => import("./web").then((m) => new m.CameraWeb());

export const Camera = registerPlugin<CameraPlugin>("Camera", {
  web: loadWeb,
  electron: loadWeb,
});

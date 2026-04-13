import { registerPlugin } from "@capacitor/core";

import type { CameraPlugin } from "./definitions";

const loadWeb = () => import("./web").then((m) => new m.CameraWeb());

export const Camera = registerPlugin<CameraPlugin>("ElizaCamera", {
  web: loadWeb,
});

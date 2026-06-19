import { registerPlugin } from "@capacitor/core";

import type { ScreenCapturePlugin } from "./definitions";

export * from "./definitions";

const loadWeb = () => import("./web").then((m) => new m.ScreenCaptureWeb());

export const ScreenCapture = registerPlugin<ScreenCapturePlugin>(
  "ScreenCapture",
  {
    web: loadWeb,
  },
);

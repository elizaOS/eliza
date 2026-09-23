/** Entry point: registers the `ScreenCapture` Capacitor plugin, lazy-loading the web implementation, and re-exports the type contract. */
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

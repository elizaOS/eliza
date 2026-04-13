import { registerPlugin } from "@capacitor/core";

import type { DesktopPlugin } from "./definitions";

const loadWeb = () => import("./web").then((m) => new m.DesktopWeb());

export const Desktop = registerPlugin<DesktopPlugin>("Desktop", {
  web: loadWeb,
});

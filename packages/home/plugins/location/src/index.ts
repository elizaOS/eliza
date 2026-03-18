import { registerPlugin } from "@capacitor/core";

import type { LocationPlugin } from "./definitions";

const loadWeb = () => import("./web").then((m) => new m.LocationWeb());

export const Location = registerPlugin<LocationPlugin>("Location", {
  web: loadWeb,
  electron: loadWeb,
});

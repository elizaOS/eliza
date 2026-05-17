import { registerPlugin } from "@capacitor/core";

import type { LocationPlugin } from "./definitions";

export * from "./definitions";

const loadWeb = () => import("./web").then((m) => new m.LocationWeb());

export const Location = registerPlugin<LocationPlugin>("ElizaLocation", {
  web: loadWeb,
});

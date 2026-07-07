/**
 * TS host entry point for the location Capacitor plugin: registers "ElizaLocation"
 * with the Capacitor bridge and re-exports the shared type surface. The `web`
 * factory lazy-loads `LocationWeb` (web.ts) only on browser/Electrobun targets;
 * iOS/Android resolve their native implementations through the bridge itself.
 */
import { registerPlugin } from "@capacitor/core";

import type { LocationPlugin } from "./definitions";

export * from "./definitions";

const loadWeb = () => import("./web").then((m) => new m.LocationWeb());

export const Location = registerPlugin<LocationPlugin>("ElizaLocation", {
  web: loadWeb,
});

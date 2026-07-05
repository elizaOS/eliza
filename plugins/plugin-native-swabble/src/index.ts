/** Registers the `Swabble` Capacitor bridge and re-exports its types; see `./definitions.ts` for the API surface. */

import { registerPlugin } from "@capacitor/core";

import type { SwabblePlugin } from "./definitions";

export * from "./definitions";

const loadWeb = () => import("./web").then((m) => new m.SwabbleWeb());

export const Swabble = registerPlugin<SwabblePlugin>("Swabble", {
  web: loadWeb,
});

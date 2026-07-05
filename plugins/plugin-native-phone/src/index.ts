/** Registers the `ElizaPhone` Capacitor bridge and re-exports its types; see `./definitions.ts` for the API surface. */

import { registerPlugin } from "@capacitor/core";

import type { PhonePlugin } from "./definitions";

export * from "./definitions";

const loadWeb = () => import("./web").then((m) => new m.PhoneWeb());

export const Phone = registerPlugin<PhonePlugin>("ElizaPhone", {
  web: loadWeb,
});

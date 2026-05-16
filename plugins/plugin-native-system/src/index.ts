import { registerPlugin } from "@capacitor/core";

import type { SystemPlugin } from "./definitions";

export * from "./definitions";

const loadWeb = () => import("./web").then((m) => new m.SystemWeb());

export const System = registerPlugin<SystemPlugin>("ElizaSystem", {
  web: loadWeb,
});

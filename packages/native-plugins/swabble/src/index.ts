import { registerPlugin } from "@capacitor/core";

import type { SwabblePlugin } from "./definitions";

const loadWeb = () => import("./web").then((m) => new m.SwabbleWeb());

export const Swabble = registerPlugin<SwabblePlugin>("Swabble", {
  web: loadWeb,
});

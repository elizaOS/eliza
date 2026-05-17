import { registerPlugin } from "@capacitor/core";
import type { MobileSignalsPlugin } from "./definitions";

export * from "./definitions";

const loadWeb = () => import("./web").then((m) => new m.MobileSignalsWeb());

export const MobileSignals = registerPlugin<MobileSignalsPlugin>(
  "MobileSignals",
  {
    web: loadWeb,
  },
);

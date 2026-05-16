import { registerPlugin } from "@capacitor/core";
import type { TalkModePlugin } from "./definitions";

export * from "./definitions";

const loadWeb = () => import("./web").then((m) => new m.TalkModeWeb());

export const TalkMode = registerPlugin<TalkModePlugin>("TalkMode", {
  web: loadWeb,
});

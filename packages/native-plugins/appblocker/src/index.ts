import { registerPlugin } from "@capacitor/core";

import type { AppBlockerPlugin } from "./definitions";

export * from "./definitions";

const loadWeb = () =>
  import("./web").then((module) => new module.AppBlockerWeb());

export const AppBlocker = registerPlugin<AppBlockerPlugin>("ElizaAppBlocker", {
  web: loadWeb,
});

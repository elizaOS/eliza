import { registerPlugin } from "@capacitor/core";

import type { WebsiteBlockerPlugin } from "./definitions";

export * from "./definitions";

const loadWeb = () =>
  import("./web").then((module) => new module.WebsiteBlockerWeb());

export const WebsiteBlocker = registerPlugin<WebsiteBlockerPlugin>(
  "ElizaWebsiteBlocker",
  {
    web: loadWeb,
  },
);

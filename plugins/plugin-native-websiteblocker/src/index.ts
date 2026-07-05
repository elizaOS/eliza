/** Registers the `ElizaWebsiteBlocker` Capacitor plugin, re-exports its types, and re-exports the `@elizaos/plugin-blocker` adapter from `./backend.ts`. */

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

export {
  createNativeWebsiteBlockerBackend,
  type NativeWebsiteBlockerBackend,
} from "./backend";

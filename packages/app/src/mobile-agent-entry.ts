/** The application host composes its Android receiver before starting the portable agent. */

import { browserPlugin } from "@elizaos/plugin-browser";
import { STATIC_ELIZA_PLUGINS } from "../../agent/src/runtime/plugin-types";
import { mobileRemoteTargetPlugin } from "./mobile-remote-target";

STATIC_ELIZA_PLUGINS["@elizaos/app/mobile-remote-target"] = {
  default: mobileRemoteTargetPlugin,
};
STATIC_ELIZA_PLUGINS["@elizaos/plugin-browser"] = { default: browserPlugin };
await import("../../agent/src/bin");

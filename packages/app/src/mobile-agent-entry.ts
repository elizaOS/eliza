/** The application host composes its Android receiver before starting the portable agent. */
import { STATIC_ELIZA_PLUGINS } from "../../agent/src/runtime/plugin-types";
import { mobileRemoteTargetPlugin } from "./mobile-remote-target";

STATIC_ELIZA_PLUGINS["@elizaos/app/mobile-remote-target"] = {
  default: mobileRemoteTargetPlugin,
};
await import("../../agent/src/bin");

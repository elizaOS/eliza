/**
 * Public entry point for the opt-in Omarchy Linux desktop integration.
 */
import type { Plugin } from "@elizaos/core";
import {
  createOmarchyDesktopActions,
  omarchyDesktopActions,
} from "./actions/desktop.js";
import { isOmarchyHost, OmarchyBridge, omarchyBridge } from "./bridge.js";
import {
  createOmarchyDesktopProvider,
  omarchyDesktopProvider,
} from "./providers/desktop.js";

export type {
  CommandOutput,
  CommandRunner,
  NotificationUrgency,
  OmarchyPluginStatus,
  OmarchySnapshot,
} from "./bridge.js";
export {
  createOmarchyDesktopActions,
  createOmarchyDesktopProvider,
  isOmarchyHost,
  OmarchyBridge,
  omarchyBridge,
  omarchyDesktopActions,
  omarchyDesktopProvider,
};

export const omarchyPlugin: Plugin = {
  name: "omarchy",
  description:
    "Opt-in Omarchy Linux desktop integration: read shell state, show explicit local notifications, and summon the Eliza quick-chat pill through fixed commands.",
  actions: omarchyDesktopActions,
  providers: [omarchyDesktopProvider],
};

export default omarchyPlugin;

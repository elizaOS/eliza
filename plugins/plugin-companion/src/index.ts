/**
 * Entry point for `@elizaos/plugin-companion` — the opt-in ESP32 companion
 * device bridge. Assembles the WebSocket client service, the
 * SET_COMPANION_MOOD / GET_COMPANION_STATUS actions, and the companionDevice
 * provider. Desktop/node only (registered via UNBUNDLED_OPTIONAL_PLUGINS);
 * never auto-enables — a character must list the plugin and configure
 * `COMPANION_WS_URL` plus an explicit `COMPANION_PAIRING_TOKEN`.
 */
import type { Plugin } from "@elizaos/core";
import { getCompanionStatusAction, setCompanionMoodAction } from "./actions";
import { companionDeviceProvider } from "./provider";
import { CompanionService } from "./service";

export { getCompanionStatusAction, setCompanionMoodAction } from "./actions";
export type {
  CommandResultFrame,
  CompanionCommand,
  DeviceFrame,
  EventFrame,
  PongFrame,
  RegisterFrame,
  WelcomeFrame,
} from "./protocol";
export { parseDeviceFrame } from "./protocol";
export { companionDeviceProvider } from "./provider";
export {
  COMPANION_SERVICE_TYPE,
  type CompanionEvent,
  type CompanionIdentity,
  CompanionService,
  type CompanionSnapshot,
} from "./service";

export const companionPlugin: Plugin = {
  name: "companion",
  description:
    "Opt-in ESP32 companion device bridge: mood control, status, and touch events over the device's authenticated WebSocket protocol.",
  services: [CompanionService],
  actions: [setCompanionMoodAction, getCompanionStatusAction],
  providers: [companionDeviceProvider],
};

export default companionPlugin;

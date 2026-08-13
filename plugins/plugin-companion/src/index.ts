/**
 * Opt-in ESP32 companion plugin. Registers COMPANION_SERVICE, mood/status
 * actions, and a companionDevice provider. No autoEnable — add
 * `@elizaos/plugin-companion` to a character plugin list.
 */

import type { Plugin } from "@elizaos/core";
import { getCompanionStatusAction } from "./actions/get-status";
import { setCompanionMoodAction } from "./actions/set-mood";
import { CompanionService } from "./companion-service";
import { companionDeviceProvider } from "./providers/companion-device";

export const companionPlugin: Plugin = {
  name: "@elizaos/plugin-companion",
  description: "ESP32 companion bridge — SET_COMPANION_MOOD, GET_COMPANION_STATUS, touch events",
  services: [CompanionService],
  actions: [setCompanionMoodAction, getCompanionStatusAction],
  providers: [companionDeviceProvider],
  async dispose(runtime) {
    await runtime.getService<CompanionService>(CompanionService.serviceType)?.stop();
  },
};

export default companionPlugin;

export { CompanionClient, CompanionClientError } from "./companion-client";
export { CompanionService } from "./companion-service";
export {
  buildCommand,
  buildPing,
  COMPANION_MOODS,
  COMPANION_PROTOCOL,
  COMPANION_SERVICE_TYPE,
  COMPANION_WS_PATH,
  normalizeMood,
  parseFrame,
  withPairingToken,
} from "./protocol";
export { companionDeviceProvider } from "./providers/companion-device";

import type { Plugin } from "@elizaos/core";
import { actions } from "./actions";
import { providers } from "./providers";
import { AinexService } from "./service";

export { actions } from "./actions";
export { AinexBridgeClient } from "./bridge-client";
export {
  actionGroupSchema,
  actionLibrarySchema,
  assetPathsSchema,
  bridgeCommandSchema,
  cameraSpecSchema,
  controlSpecSchema,
  extrinsicsRpyXyzSchema,
  frameSchema,
  gaitControllerSchema,
  gaitParamsSchema,
  jointGroupSchema,
  jointSpecSchema,
  kinematicsSchema,
  loadProfileFromBridge,
  parseRobotProfileDescriptor,
  robotProfileDescriptorSchema,
  safetyLimitsSchema,
  sensorSpecsSchema,
} from "./profile-schema";
export { providers } from "./providers";
export { AinexService } from "./service";
export * from "./types";

export const ainexPlugin: Plugin = {
  name: "ainex",
  description:
    "Drives Hiwonder AiNex (and other) humanoid robots via a websocket bridge; integrates camera into plugin-vision and exposes joystick + servo + action-group control to the agent.",
  services: [AinexService],
  providers,
  actions,
  autoEnable: {
    shouldEnable: (env, config) => {
      if (env?.ELIZA_AINEX_BRIDGE_URL) return true;
      const features = config?.features as
        | Record<string, unknown>
        | undefined;
      const ainex = features?.ainex;
      if (ainex === true) return true;
      if (
        typeof ainex === "object" &&
        ainex !== null &&
        (ainex as { enabled?: unknown }).enabled !== false
      ) {
        return Boolean((ainex as { enabled?: unknown }).enabled);
      }
      return false;
    },
  },
  init: async (_config, _runtime) => {},
  async dispose(runtime) {
    const svc = runtime.getService<AinexService>(AinexService.serviceType);
    await svc?.stop();
  },
};

export default ainexPlugin;

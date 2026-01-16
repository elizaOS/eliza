import type { Plugin, TestSuite } from "@elizaos/core";
import {
  captureImageAction,
  describeSceneAction,
  identifyPersonAction,
  killAutonomousAction,
  nameEntityAction,
  setVisionModeAction,
  trackEntityAction,
} from "./action";
import { visionProvider } from "./provider";
import { VisionService } from "./service";
import { testSuites } from "./tests/e2e/index";

export const visionPlugin: Plugin = {
  name: "vision",
  description: "Provides visual perception through camera integration and scene analysis",
  services: [VisionService],
  providers: [visionProvider],
  actions: [
    describeSceneAction,
    captureImageAction,
    killAutonomousAction,
    setVisionModeAction,
    nameEntityAction,
    identifyPersonAction,
    trackEntityAction,
  ],
  tests: testSuites as unknown as TestSuite[],
  init: async (_config, _runtime) => {},
};

export default visionPlugin;

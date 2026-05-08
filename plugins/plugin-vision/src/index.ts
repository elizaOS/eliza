import type { Plugin, TestSuite } from "@elizaos/core";
import { visionAction } from "./action";
import { visionProvider } from "./provider";
import { VisionService } from "./service";
import { testSuites } from "./tests/e2e/index";

export const visionPlugin: Plugin = {
  name: "vision",
  description:
    "Provides visual perception through camera integration and scene analysis",
  services: [VisionService],
  providers: [visionProvider],
  actions: [visionAction],
  tests: testSuites as unknown as TestSuite[],
  init: async (_config, _runtime) => {},
};

export default visionPlugin;

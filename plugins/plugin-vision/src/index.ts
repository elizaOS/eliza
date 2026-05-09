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
  tests: testSuites as TestSuite[],
  // Self-declared auto-enable: activate when features.vision is enabled OR
  // when media.vision.provider is configured.
  autoEnable: {
    shouldEnable: (_env, config) => {
      const f = (config?.features as Record<string, unknown> | undefined)
        ?.vision;
      const featureOn =
        f === true ||
        (typeof f === "object" &&
          f !== null &&
          (f as { enabled?: unknown }).enabled !== false);
      if (featureOn) return true;
      const media = config?.media as Record<string, unknown> | undefined;
      const visionMedia = media?.vision as
        | { enabled?: unknown; provider?: unknown }
        | undefined;
      return Boolean(
        visionMedia &&
          visionMedia.enabled !== false &&
          typeof visionMedia.provider === "string" &&
          visionMedia.provider.length > 0,
      );
    },
  },
  init: async (_config, _runtime) => {},
};

export default visionPlugin;

/**
 * Configuration tests verify that capture stays idle by default while explicit
 * camera and screen selections remain available.
 */

import { describe, expect, it } from "vitest";
import {
  ConfigurationManager,
  defaultVisionConfig,
  VisionConfigSchema,
} from "./config";
import { VisionMode } from "./types";

function makeRuntime(settings: Record<string, string> = {}) {
  return {
    getSetting: (key: string) => settings[key],
  };
}

describe("vision configuration capture defaults", () => {
  it("keeps every configuration entry point off by default", () => {
    expect(defaultVisionConfig.visionMode).toBe(VisionMode.OFF);
    expect(VisionConfigSchema.parse({}).visionMode).toBe(VisionMode.OFF);
    expect(new ConfigurationManager(makeRuntime()).get().visionMode).toBe(
      VisionMode.OFF,
    );
  });

  it.each([VisionMode.CAMERA, VisionMode.SCREEN, VisionMode.BOTH])(
    "honors an explicit %s selection",
    (visionMode) => {
      const config = new ConfigurationManager(
        makeRuntime({ VISION_MODE: visionMode }),
      ).get();

      expect(config.visionMode).toBe(visionMode);
    },
  );
});

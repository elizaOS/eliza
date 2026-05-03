import { describe, expect, it } from "vitest";

import type { ElizaConfig } from "../config/config.js";
import {
  ADVANCED_CAPABILITY_PLUGIN_IDS,
  applyAdvancedCapabilitiesConfig,
  applyAdvancedCapabilitySettings,
  resolveAdvancedCapabilitiesEnabled,
} from "./advanced-capabilities-config.js";

describe("advanced-capabilities-config", () => {
  it("defaults advanced capabilities to enabled when config is silent", () => {
    expect(resolveAdvancedCapabilitiesEnabled({} as ElizaConfig)).toBe(true);
  });

  it("respects an explicit advanced capability toggle from plugin entries", () => {
    expect(
      resolveAdvancedCapabilitiesEnabled({
        plugins: {
          entries: {
            experience: { enabled: false },
          },
        },
      } as ElizaConfig),
    ).toBe(false);
  });

  it("writes a shared enabled flag for every advanced capability alias", () => {
    const config = {
      plugins: {
        entries: {
          experience: { enabled: false, keep: "value" },
        },
      },
    } as ElizaConfig;

    applyAdvancedCapabilitiesConfig(config, true);

    for (const pluginId of ADVANCED_CAPABILITY_PLUGIN_IDS) {
      expect(config.plugins?.entries?.[pluginId]?.enabled).toBe(true);
    }
    expect(config.plugins?.entries?.experience?.keep).toBe("value");
  });

  it("mirrors the resolved flag into the runtime character settings", () => {
    expect(
      applyAdvancedCapabilitySettings(
        {
          MEMORY_SUMMARY_MODEL_TYPE: "TEXT_SMALL",
        },
        true,
      ),
    ).toMatchObject({
      ADVANCED_CAPABILITIES: "true",
      ENABLE_EXTENDED_CAPABILITIES: "true",
      MEMORY_SUMMARY_MODEL_TYPE: "TEXT_SMALL",
    });

    expect(
      applyAdvancedCapabilitySettings(
        {
          MEMORY_SUMMARY_MODEL_TYPE: "TEXT_SMALL",
        },
        false,
      ),
    ).toMatchObject({
      ADVANCED_CAPABILITIES: "false",
      ENABLE_EXTENDED_CAPABILITIES: "false",
    });
  });
});

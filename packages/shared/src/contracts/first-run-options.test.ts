import { describe, expect, it } from "vitest";
import { migrateLegacyRuntimeConfig } from "./first-run-options.js";

describe("migrateLegacyRuntimeConfig", () => {
  it("preserves cloud.enabled=false as the local-only runtime-mode signal", () => {
    const config = {
      cloud: {
        enabled: false,
        provider: "elizacloud",
        inferenceMode: "cloud",
        services: {
          tts: false,
        },
      },
    };

    migrateLegacyRuntimeConfig(config);

    expect(config).toEqual({
      cloud: {
        enabled: false,
      },
    });
  });

  it("still prunes cloud.enabled=true with the other legacy routing fields", () => {
    const config = {
      cloud: {
        enabled: true,
        provider: "elizacloud",
        runtime: "local",
        services: {
          tts: false,
        },
      },
    };

    migrateLegacyRuntimeConfig(config);

    expect(config).toEqual({
      serviceRouting: {
        llmText: {
          accountId: "elizacloud",
          backend: "elizacloud",
          transport: "cloud-proxy",
        },
      },
    });
  });
});

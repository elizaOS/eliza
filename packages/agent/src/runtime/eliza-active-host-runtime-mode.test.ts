/** Proves desktop fallback changes only the serving topology while preserving durable remote intent. */

import { describe, expect, it } from "vitest";
import type { ElizaConfig } from "../config/config";
import { applyActiveHostRuntimeMode } from "./eliza";
import { collectPluginNames } from "./plugin-collector";

describe("applyActiveHostRuntimeMode", () => {
  it("presents an embedded local topology without mutating remote intent", () => {
    const previousKey = process.env.CEREBRAS_API_KEY;
    process.env.CEREBRAS_API_KEY = "csk-test";
    try {
      const config = {
        deploymentTarget: {
          runtime: "remote",
          provider: "remote",
          remoteApiBase: "http://127.0.0.1:2250",
        },
        serviceRouting: {
          llmText: {
            backend: "cerebras",
            transport: "direct",
          },
        },
      } as ElizaConfig;

      const activeConfig = applyActiveHostRuntimeMode(config, {
        ELIZA_ACTIVE_API_RUNTIME_MODE: "local",
      });

      expect(activeConfig).not.toBe(config);
      expect(activeConfig.deploymentTarget).toEqual({ runtime: "local" });
      expect(config.deploymentTarget?.runtime).toBe("remote");
      expect(
        collectPluginNames(activeConfig).has("@elizaos/plugin-openai"),
      ).toBe(true);
    } finally {
      if (previousKey === undefined) delete process.env.CEREBRAS_API_KEY;
      else process.env.CEREBRAS_API_KEY = previousKey;
    }
  });

  it("retains an explicit local-only boundary in the active clone", () => {
    const env = { ELIZA_ACTIVE_API_RUNTIME_MODE: "local" };
    const config = {
      deploymentTarget: {
        runtime: "remote",
        remoteApiBase: "http://127.0.0.1:2250",
      },
      cloud: { enabled: false },
    } as ElizaConfig;

    const activeConfig = applyActiveHostRuntimeMode(config, env);

    expect(activeConfig.deploymentTarget).toEqual({ runtime: "local" });
    expect(activeConfig.cloud?.enabled).toBe(false);
    expect(config.deploymentTarget?.runtime).toBe("remote");
    expect(env.ELIZA_ACTIVE_API_RUNTIME_MODE).toBe("local-only");
  });
});

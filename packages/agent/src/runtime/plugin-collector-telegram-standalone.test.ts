/**
 * Exercises the pre-runtime standalone Telegram decision against the final
 * configured plugin set, without constructing an AgentRuntime or bot client.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ElizaConfig } from "../config/config.ts";
import { collectPluginNames } from "./plugin-collector.ts";

const ENV_KEYS = [
  "ELIZA_TELEGRAM_STANDALONE_BOT",
  "ELIZA_LIFEOPS_PASSIVE_CONNECTORS",
  "LIFEOPS_PASSIVE_CONNECTORS",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("collectPluginNames standalone Telegram policy", () => {
  it("loads Telegram for a plain agent that opts into the standalone poller", () => {
    process.env.ELIZA_TELEGRAM_STANDALONE_BOT = "true";

    expect(collectPluginNames({} as ElizaConfig)).toContain(
      "@elizaos/plugin-telegram",
    );
  });

  it("keeps standalone Telegram dormant when LifeOps is configured", () => {
    process.env.ELIZA_TELEGRAM_STANDALONE_BOT = "true";
    const config = {
      plugins: {
        entries: {
          "personal-assistant": { enabled: true },
        },
      },
    } as ElizaConfig;

    const names = collectPluginNames(config);
    expect(names).toContain("@elizaos/plugin-personal-assistant");
    expect(names).not.toContain("@elizaos/plugin-telegram");
  });

  it("honors an explicit passive-mode opt-out for a LifeOps deployment", () => {
    process.env.ELIZA_TELEGRAM_STANDALONE_BOT = "true";
    process.env.ELIZA_LIFEOPS_PASSIVE_CONNECTORS = "false";
    const config = {
      plugins: {
        entries: {
          "personal-assistant": { enabled: true },
        },
      },
    } as ElizaConfig;

    const names = collectPluginNames(config);
    expect(names).toContain("@elizaos/plugin-personal-assistant");
    expect(names).toContain("@elizaos/plugin-telegram");
  });
});

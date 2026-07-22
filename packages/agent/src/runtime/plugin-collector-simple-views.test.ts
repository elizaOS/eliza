/** Verifies the desktop-only explicit gate for the Simple Views developer workbench. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ElizaConfig } from "../config/config.ts";
import { collectPluginNames } from "./plugin-collector.ts";

const SIMPLE_VIEWS = "@elizaos/plugin-simple-views";
const ENV_KEYS = ["ELIZA_PLATFORM", "ELIZA_SIMPLE_VIEWS"] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  delete process.env.ELIZA_PLATFORM;
  delete process.env.ELIZA_SIMPLE_VIEWS;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("collectPluginNames Simple Views gate", () => {
  it("stays disabled by default", () => {
    expect(collectPluginNames({}).has(SIMPLE_VIEWS)).toBe(false);
  });

  it.each(["1", "true", "yes", "y", "on", "enabled"])(
    "loads on canonical truthy ELIZA_SIMPLE_VIEWS=%s",
    (value) => {
      process.env.ELIZA_SIMPLE_VIEWS = value;
      expect(collectPluginNames({}).has(SIMPLE_VIEWS)).toBe(true);
    },
  );

  it("does not load in a mobile runtime", () => {
    process.env.ELIZA_PLATFORM = "ios";
    process.env.ELIZA_SIMPLE_VIEWS = "1";
    expect(collectPluginNames({}).has(SIMPLE_VIEWS)).toBe(false);
  });

  it("cannot be enabled indirectly without the explicit developer gate", () => {
    const config: ElizaConfig = {
      plugins: {
        allow: [SIMPLE_VIEWS],
        installs: {
          [SIMPLE_VIEWS]: {
            source: "path",
            sourcePath: "plugins/plugin-simple-views",
          },
        },
      },
    };

    expect(collectPluginNames(config).has(SIMPLE_VIEWS)).toBe(false);
  });

  it.each<{
    label: string;
    deploymentTarget: NonNullable<ElizaConfig["deploymentTarget"]>;
  }>([
    {
      label: "remote",
      deploymentTarget: {
        runtime: "remote",
        provider: "remote",
        remoteApiBase: "https://agent.example.test",
      },
    },
    {
      label: "cloud",
      deploymentTarget: { runtime: "cloud", provider: "elizacloud" },
    },
  ])(
    "stays unavailable in a $label runtime even through additive plugin config",
    ({ deploymentTarget }) => {
      process.env.ELIZA_SIMPLE_VIEWS = "1";
      const config: ElizaConfig = {
        deploymentTarget,
        plugins: {
          allow: [SIMPLE_VIEWS],
          installs: {
            [SIMPLE_VIEWS]: {
              source: "path",
              sourcePath: "plugins/plugin-simple-views",
            },
          },
        },
      };

      expect(collectPluginNames(config).has(SIMPLE_VIEWS)).toBe(false);
    },
  );
});

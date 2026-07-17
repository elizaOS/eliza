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
    expect(collectPluginNames({} as ElizaConfig).has(SIMPLE_VIEWS)).toBe(false);
  });

  it.each(["1", "true", "yes"])("loads on ELIZA_SIMPLE_VIEWS=%s", (value) => {
    process.env.ELIZA_SIMPLE_VIEWS = value;
    expect(collectPluginNames({} as ElizaConfig).has(SIMPLE_VIEWS)).toBe(true);
  });

  it("does not load in a mobile runtime", () => {
    process.env.ELIZA_PLATFORM = "ios";
    process.env.ELIZA_SIMPLE_VIEWS = "1";
    expect(collectPluginNames({} as ElizaConfig).has(SIMPLE_VIEWS)).toBe(false);
  });
});

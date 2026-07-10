/**
 * Locks the plugin's Vitest discovery contract so co-located script probes
 * cannot silently fall out of the test lane.
 */

import { describe, expect, it } from "vitest";

import config from "../../vitest.config";

describe("plugin-elizacloud vitest config", () => {
  it("discovers script-level mjs tests for the built-package probe", () => {
    expect(config.test?.include).toContain("scripts/**/*.test.mjs");
  });
});

/**
 * Unit tests for getLogPrefix in packages/shared/src/utils/log-prefix.ts.
 * Exercises prefix precedence (APP_CLI_NAME, npm_package_name, --name flag, cwd),
 * empty name argument handling, cache retention, and cache reset helper.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLogPrefix, resetLogPrefixCacheForTesting } from "./log-prefix.js";

describe("getLogPrefix", () => {
  const originalEnv = { ...process.env };
  const originalArgv = [...process.argv];

  beforeEach(() => {
    resetLogPrefixCacheForTesting();
    delete process.env.APP_CLI_NAME;
    delete process.env.npm_package_name;
    process.argv = ["node", "app.js"];
  });

  afterEach(() => {
    resetLogPrefixCacheForTesting();
    process.env = { ...originalEnv };
    process.argv = [...originalArgv];
  });

  it("prioritizes APP_CLI_NAME environment variable", () => {
    process.env.APP_CLI_NAME = "custom-cli";
    expect(getLogPrefix()).toBe("[custom-cli]");
  });

  it("extracts package name from scoped npm_package_name", () => {
    process.env.npm_package_name = "@elizaos/plugin-browser";
    expect(getLogPrefix()).toBe("[plugin-browser]");

    resetLogPrefixCacheForTesting();
    process.env.npm_package_name = "@elizaos/eliza-core";
    expect(getLogPrefix()).toBe("[eliza]");

    resetLogPrefixCacheForTesting();
    process.env.npm_package_name = "@elizaos/core";
    expect(getLogPrefix()).toBe("[core]");
  });

  it("extracts name from --name= CLI flag", () => {
    process.argv = ["node", "app.js", "--name=worker-agent"];
    expect(getLogPrefix()).toBe("[worker-agent]");
  });

  it("ignores empty --name= CLI flag and falls back", () => {
    process.argv = ["node", "app.js", "--name="];
    expect(getLogPrefix()).toBe("[eliza]");
  });

  it("caches the computed prefix until reset", () => {
    process.env.APP_CLI_NAME = "cached-cli";
    expect(getLogPrefix()).toBe("[cached-cli]");

    // Change env without reset - should remain cached
    process.env.APP_CLI_NAME = "different-cli";
    expect(getLogPrefix()).toBe("[cached-cli]");

    // Reset clears cache
    resetLogPrefixCacheForTesting();
    expect(getLogPrefix()).toBe("[different-cli]");
  });
});

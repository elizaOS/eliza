/**
 * Unit tests for getLogPrefix and resetLogPrefixForTesting in packages/shared/src/utils/log-prefix.ts.
 * Exercises env resolution (APP_CLI_NAME, npm_package_name), CLI argv flags (--name=),
 * empty name argument fallbacks, caching behavior, and test cache reset.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLogPrefix, resetLogPrefixForTesting } from "./log-prefix.js";

describe("log-prefix", () => {
  const originalEnv = { ...process.env };
  const originalArgv = [...process.argv];

  beforeEach(() => {
    resetLogPrefixForTesting();
    delete process.env.APP_CLI_NAME;
    delete process.env.npm_package_name;
    process.argv = ["node", "script.js"];
  });

  afterEach(() => {
    resetLogPrefixForTesting();
    process.env = { ...originalEnv };
    process.argv = [...originalArgv];
  });

  it("prioritizes APP_CLI_NAME when present in env", () => {
    process.env.APP_CLI_NAME = "custom-app";
    expect(getLogPrefix()).toBe("[custom-app]");
  });

  it("resolves log prefix from npm_package_name", () => {
    process.env.npm_package_name = "elizaos";
    expect(getLogPrefix()).toBe("[eliza]");

    resetLogPrefixForTesting();
    process.env.npm_package_name = "@elizaos/core";
    expect(getLogPrefix()).toBe("[core]");

    resetLogPrefixForTesting();
    process.env.npm_package_name = "my-worker";
    expect(getLogPrefix()).toBe("[my-worker]");
  });

  it("resolves log prefix from --name= argument", () => {
    process.argv = ["node", "script.js", "--name=worker-node"];
    expect(getLogPrefix()).toBe("[worker-node]");
  });

  it("ignores empty --name= and falls back to default prefix", () => {
    process.argv = ["node", "script.js", "--name="];
    expect(getLogPrefix()).toBe("[eliza]");
  });

  it("caches the computed prefix until reset", () => {
    process.env.APP_CLI_NAME = "first-name";
    expect(getLogPrefix()).toBe("[first-name]");

    process.env.APP_CLI_NAME = "second-name";
    // Should still return cached value
    expect(getLogPrefix()).toBe("[first-name]");

    resetLogPrefixForTesting();
    expect(getLogPrefix()).toBe("[second-name]");
  });
});

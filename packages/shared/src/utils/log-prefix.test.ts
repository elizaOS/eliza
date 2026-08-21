/**
 * Unit tests for log line prefix derivation in packages/shared/src/utils/log-prefix.ts.
 * Exercises prefix resolution order across APP_CLI_NAME, scoped and unscoped npm_package_name,
 * --name= CLI arguments, cwd path fallback, and singleton prefix caching.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("log-prefix utilities", () => {
  const originalEnv = { ...process.env };
  const originalArgv = [...process.argv];

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    process.argv = [...originalArgv];
    delete process.env.APP_CLI_NAME;
    delete process.env.npm_package_name;
  });

  afterEach(() => {
    process.env = originalEnv;
    process.argv = originalArgv;
  });

  it("prioritizes APP_CLI_NAME environment variable", async () => {
    process.env.APP_CLI_NAME = "custom-app";
    process.env.npm_package_name = "@elizaos/core";
    process.argv = ["node", "index.js", "--name=ignored"];

    const { getLogPrefix } = await import("./log-prefix.js");
    expect(getLogPrefix()).toBe("[custom-app]");
  });

  it("extracts package name from scoped and unscoped npm_package_name", async () => {
    process.env.npm_package_name = "@elizaos/agent";
    const { getLogPrefix: getAgentPrefix } = await import("./log-prefix.js");
    expect(getAgentPrefix()).toBe("[agent]");

    vi.resetModules();
    process.env.npm_package_name = "@elizaos/plugin-sql";
    const { getLogPrefix: getPluginPrefix } = await import("./log-prefix.js");
    expect(getPluginPrefix()).toBe("[plugin-sql]");

    vi.resetModules();
    process.env.npm_package_name = "elizaos";
    const { getLogPrefix: getRootPrefix } = await import("./log-prefix.js");
    expect(getRootPrefix()).toBe("[eliza]");
  });

  it("extracts name from --name= CLI argument when env vars are unset", async () => {
    process.argv = ["node", "index.js", "--name=worker-node"];

    const { getLogPrefix } = await import("./log-prefix.js");
    expect(getLogPrefix()).toBe("[worker-node]");
  });

  it("ignores an empty --name= argument and uses the default", async () => {
    process.argv = ["node", "index.js", "--name=   "];

    const { getLogPrefix } = await import("./log-prefix.js");
    expect(getLogPrefix()).toBe("[eliza]");
  });

  it("caches the computed prefix on subsequent calls within the module instance", async () => {
    process.env.APP_CLI_NAME = "initial-name";
    const { getLogPrefix } = await import("./log-prefix.js");
    expect(getLogPrefix()).toBe("[initial-name]");

    // Mutate environment after initial read
    process.env.APP_CLI_NAME = "mutated-name";
    expect(getLogPrefix()).toBe("[initial-name]");
  });

  it("falls back to [eliza] default when no specific name is configured", async () => {
    process.argv = ["node", "index.js"];
    const { getLogPrefix } = await import("./log-prefix.js");
    expect(getLogPrefix()).toBe("[eliza]");
  });
});

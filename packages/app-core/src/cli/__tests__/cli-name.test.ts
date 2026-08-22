/**
 * Deterministic unit coverage for CLI display-name resolution and command
 * rewriting, with module reloads isolating the import-time environment value.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

async function loadCliName() {
  return import("../cli-name.ts");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("resolveCliName", () => {
  it("uses the default for an empty environment value", async () => {
    vi.stubEnv("APP_CLI_NAME", "");
    const { resolveCliName } = await loadCliName();
    expect(resolveCliName()).toBe("eliza");
  });

  it("trims the configured environment value", async () => {
    vi.stubEnv("APP_CLI_NAME", "  mycli  ");
    const { resolveCliName } = await loadCliName();
    expect(resolveCliName()).toBe("mycli");
  });
});

describe("replaceCliName", () => {
  it("replaces a leading eliza token", async () => {
    const { replaceCliName } = await loadCliName();
    expect(replaceCliName("eliza start", "mycli")).toBe("mycli start");
    expect(replaceCliName("elizaos run", "mycli")).toBe("mycli run");
  });

  it("preserves the runner prefix", async () => {
    const { replaceCliName } = await loadCliName();
    expect(replaceCliName("bun eliza start", "mycli")).toBe("bun mycli start");
    expect(replaceCliName("npx elizaos dev", "mycli")).toBe("npx mycli dev");
  });

  it("leaves unrelated commands untouched", async () => {
    const { replaceCliName } = await loadCliName();
    expect(replaceCliName("git commit", "mycli")).toBe("git commit");
    expect(replaceCliName("", "mycli")).toBe("");
  });

  it("uses the configured name when an override is not passed", async () => {
    vi.stubEnv("APP_CLI_NAME", "mycli");
    const { replaceCliName } = await loadCliName();
    expect(replaceCliName("eliza start")).toBe("mycli start");
  });

  it("CLI_PREFIX_RE matches runner and eliza forms", async () => {
    const { CLI_PREFIX_RE } = await loadCliName();
    expect(CLI_PREFIX_RE.test("eliza start")).toBe(true);
    expect(CLI_PREFIX_RE.test("bunx elizaos x")).toBe(true);
    expect(CLI_PREFIX_RE.test("other eliza")).toBe(false);
  });
});

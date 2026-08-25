/**
 * Behavioral coverage for the runtime VERSION constant. Drives the real
 * module: import-time resolution from this file's location, package.json
 * match when no bundle override is set, ELIZA_BUNDLED_VERSION preference on
 * a fresh load, empty-override fallthrough, whitespace-only override, and
 * the 0.0.0 fallback when require() cannot see the agent package.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveElizaVersion } from "../version-resolver.ts";
import { VERSION } from "./version.ts";

const VERSION_MODULE_URL = new URL("./version.ts", import.meta.url).href;
const AGENT_PACKAGE_JSON = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "package.json",
);
const agentPackage = JSON.parse(readFileSync(AGENT_PACKAGE_JSON, "utf8")) as {
  version: string;
};
const originalBundledVersion = process.env.ELIZA_BUNDLED_VERSION;

afterEach(() => {
  if (originalBundledVersion === undefined) {
    delete process.env.ELIZA_BUNDLED_VERSION;
  } else {
    process.env.ELIZA_BUNDLED_VERSION = originalBundledVersion;
  }
});

describe("VERSION", () => {
  it("exports a non-empty string resolved at import time", () => {
    expect(typeof VERSION).toBe("string");
    expect(VERSION.length).toBeGreaterThan(0);
  });

  it("matches the agent package.json version when no bundle override is set", () => {
    expect(process.env.ELIZA_BUNDLED_VERSION).toBeUndefined();
    expect(agentPackage.version.length).toBeGreaterThan(0);
    expect(VERSION).toBe(agentPackage.version);
  });

  it("equals resolveElizaVersion for this module's import.meta.url", () => {
    expect(VERSION).toBe(resolveElizaVersion(VERSION_MODULE_URL));
  });

  it("is the same constant across a re-import of the cached module", async () => {
    const again = await import("./version.ts");
    expect(again.VERSION).toBe(VERSION);
  });

  it("is not the stripped-bundle 0.0.0 fallback while package.json is visible", () => {
    expect(VERSION).not.toBe("0.0.0");
  });

  it("anchors require() at this module so a foreign URL cannot see the agent package.json", () => {
    expect(resolveElizaVersion("file:///tmp/not-an-agent-module.ts")).toBe(
      "0.0.0",
    );
    expect(VERSION).toBe(agentPackage.version);
  });

  it("prefers ELIZA_BUNDLED_VERSION when the module is loaded under that env", async () => {
    process.env.ELIZA_BUNDLED_VERSION = "9.9.9-bundled";
    vi.resetModules();
    const { VERSION: bundledVersion } = await import("./version.ts");
    expect(bundledVersion).toBe("9.9.9-bundled");
  });

  it("falls through an empty ELIZA_BUNDLED_VERSION to package.json", async () => {
    process.env.ELIZA_BUNDLED_VERSION = "";
    vi.resetModules();
    const { VERSION: resolved } = await import("./version.ts");
    expect(resolved).toBe(agentPackage.version);
  });

  it("uses a whitespace-only ELIZA_BUNDLED_VERSION as a truthy override", async () => {
    process.env.ELIZA_BUNDLED_VERSION = " ";
    vi.resetModules();
    const { VERSION: resolved } = await import("./version.ts");
    expect(resolved).toBe(" ");
  });
});

/**
 * Direct unit coverage for the CLI_VERSION load-time constant. Drives the
 * real `version` module: import-time resolution from this file's location,
 * app-core package.json match when no bundle override is set, env preference
 * on a fresh load, empty and whitespace overrides, and the 0.0.0 fallback
 * when require() cannot see the package. Does not mock the module under test.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElizaVersion } from "@elizaos/agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLI_VERSION } from "./version";

const VERSION_MODULE_URL = new URL("./version.ts", import.meta.url).href;
const APP_CORE_PACKAGE_JSON = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "package.json",
);
const appCorePackage = JSON.parse(
  readFileSync(APP_CORE_PACKAGE_JSON, "utf8"),
) as {
  name: string;
  version: string;
};
const originalBundledVersion = process.env.ELIZA_BUNDLED_VERSION;

afterEach(() => {
  if (originalBundledVersion === undefined) {
    delete process.env.ELIZA_BUNDLED_VERSION;
  } else {
    process.env.ELIZA_BUNDLED_VERSION = originalBundledVersion;
  }
  vi.unstubAllGlobals();
});

describe("CLI_VERSION", () => {
  it("exports a non-empty string resolved at import time", () => {
    expect(typeof CLI_VERSION).toBe("string");
    expect(CLI_VERSION.length).toBeGreaterThan(0);
  });

  it("is the module's only named export", async () => {
    const versionModule = await import("./version");
    expect(Object.keys(versionModule).sort()).toEqual(["CLI_VERSION"]);
  });

  it("matches the app-core package.json version when no bundle override is set", () => {
    expect(process.env.ELIZA_BUNDLED_VERSION).toBeUndefined();
    expect(appCorePackage.name).toBe("@elizaos/app-core");
    expect(appCorePackage.version.length).toBeGreaterThan(0);
    expect(CLI_VERSION).toBe(appCorePackage.version);
  });

  it("equals resolveElizaVersion for this module's import.meta.url", () => {
    expect(CLI_VERSION).toBe(resolveElizaVersion(VERSION_MODULE_URL));
  });

  it("is the same constant across a re-import of the cached module", async () => {
    const again = await import("./version");
    expect(again.CLI_VERSION).toBe(CLI_VERSION);
  });

  it("is not the stripped-bundle 0.0.0 fallback while package.json is visible", () => {
    expect(CLI_VERSION).not.toBe("0.0.0");
  });

  it("anchors require() at version.ts so a foreign URL cannot see app-core package.json", () => {
    expect(resolveElizaVersion("file:///tmp/not-an-app-core-module.ts")).toBe(
      "0.0.0",
    );
    expect(CLI_VERSION).toBe(appCorePackage.version);
  });

  it("does not observe ELIZA_BUNDLED_VERSION mutations after the module has loaded", () => {
    const snapshot = CLI_VERSION;
    process.env.ELIZA_BUNDLED_VERSION = "mutated-after-load";
    expect(CLI_VERSION).toBe(snapshot);
    expect(resolveElizaVersion(VERSION_MODULE_URL)).toBe("mutated-after-load");
  });

  it("prefers ELIZA_BUNDLED_VERSION when the module is loaded under that env", async () => {
    process.env.ELIZA_BUNDLED_VERSION = "9.9.9-bundled";
    vi.resetModules();
    const { CLI_VERSION: bundledVersion } = await import("./version");
    expect(bundledVersion).toBe("9.9.9-bundled");
  });

  it("falls through an empty ELIZA_BUNDLED_VERSION to package.json", async () => {
    process.env.ELIZA_BUNDLED_VERSION = "";
    vi.resetModules();
    const { CLI_VERSION: resolved } = await import("./version");
    expect(resolved).toBe(appCorePackage.version);
  });

  it("uses a whitespace-only ELIZA_BUNDLED_VERSION as a truthy override", async () => {
    process.env.ELIZA_BUNDLED_VERSION = " ";
    vi.resetModules();
    const { CLI_VERSION: resolved } = await import("./version");
    expect(resolved).toBe(" ");
  });

  it("treats ELIZA_BUNDLED_VERSION 0.0.0 as an override, not the missing-package fallback", async () => {
    process.env.ELIZA_BUNDLED_VERSION = "0.0.0";
    vi.resetModules();
    const { CLI_VERSION: resolved } = await import("./version");
    expect(resolved).toBe("0.0.0");
    expect(appCorePackage.version).not.toBe("0.0.0");
  });
});

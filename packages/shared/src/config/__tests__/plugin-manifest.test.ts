// Unit tests for the plugin manifest auto-enable engine.
//
// These tests use a temp directory with fake plugin packages — each one has a
// package.json declaring elizaos.plugin.autoEnableModule and a small check
// module that exports shouldEnable / shouldForce. The engine reads them
// without booting the actual plugin runtime.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyPluginManifestVerdicts,
  evaluatePluginManifest,
  evaluatePluginManifests,
  type PluginManifestCandidate,
  type PluginManifestVerdict,
  pluginShortId,
} from "../plugin-manifest";

let tmpRoot: string;

async function writeFakePlugin(opts: {
  pkgName: string;
  manifestBlock?: Record<string, unknown> | null; // null = no elizaos.plugin block
  checkSource?: string; // contents of the check module
  checkPath?: string; // override default "./auto-enable.js"
}): Promise<PluginManifestCandidate> {
  const dirName = opts.pkgName.replace(/[/@]/g, "_");
  const pkgRoot = path.join(tmpRoot, dirName);
  await fs.mkdir(pkgRoot, { recursive: true });

  const pkgJson: Record<string, unknown> = { name: opts.pkgName };
  if (opts.manifestBlock !== null) {
    pkgJson.elizaos = {
      plugin: opts.manifestBlock ?? {
        autoEnableModule: opts.checkPath ?? "./auto-enable.js",
      },
    };
  }
  await fs.writeFile(
    path.join(pkgRoot, "package.json"),
    JSON.stringify(pkgJson, null, 2),
  );

  if (opts.checkSource !== undefined) {
    const target = path.resolve(pkgRoot, opts.checkPath ?? "./auto-enable.js");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, opts.checkSource);
  }

  return { packageName: opts.pkgName, packageRoot: pkgRoot };
}

const baseCtx = {
  env: {},
  config: {},
  isNativePlatform: false,
};

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-manifest-test-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("pluginShortId", () => {
  it("strips @scope/plugin- prefix", () => {
    expect(pluginShortId("@elizaos/plugin-anthropic")).toBe("anthropic");
  });
  it("returns name as-is for unscoped plugins", () => {
    expect(pluginShortId("custom-plugin")).toBe("custom-plugin");
  });
  it("handles @scope/app- (does not match the /plugin- guard)", () => {
    expect(pluginShortId("@elizaos/app-companion")).toBe(
      "@elizaos/app-companion",
    );
  });
});

describe("evaluatePluginManifest", () => {
  it("returns null when package.json is missing", async () => {
    const verdict = await evaluatePluginManifest(
      { packageName: "@x/missing", packageRoot: path.join(tmpRoot, "missing") },
      baseCtx,
    );
    expect(verdict).toBeNull();
  });

  it("returns null when package.json has no elizaos.plugin block", async () => {
    const candidate = await writeFakePlugin({
      pkgName: "@x/no-block",
      manifestBlock: null,
    });
    const verdict = await evaluatePluginManifest(candidate, baseCtx);
    expect(verdict).toBeNull();
  });

  it("returns enabled=false with no error when no autoEnableModule", async () => {
    const candidate = await writeFakePlugin({
      pkgName: "@x/no-module",
      manifestBlock: { capabilities: ["just-data"] },
    });
    const verdict = await evaluatePluginManifest(candidate, baseCtx);
    expect(verdict).not.toBeNull();
    expect(verdict?.enabled).toBe(false);
    expect(verdict?.error).toBeNull();
    expect(verdict?.capabilities).toEqual(["just-data"]);
  });

  it("returns enabled=true when shouldEnable returns true (env match)", async () => {
    const candidate = await writeFakePlugin({
      pkgName: "@x/env-match",
      checkSource:
        "export function shouldEnable(ctx) { return Boolean(ctx.env.MY_KEY); }",
    });
    const verdict = await evaluatePluginManifest(candidate, {
      ...baseCtx,
      env: { MY_KEY: "yes" },
    });
    expect(verdict?.enabled).toBe(true);
    expect(verdict?.reason).toMatch(/manifest:/);
    expect(verdict?.error).toBeNull();
  });

  it("returns enabled=false when shouldEnable returns false", async () => {
    const candidate = await writeFakePlugin({
      pkgName: "@x/env-miss",
      checkSource:
        "export function shouldEnable(ctx) { return Boolean(ctx.env.MY_KEY); }",
    });
    const verdict = await evaluatePluginManifest(candidate, baseCtx);
    expect(verdict?.enabled).toBe(false);
    expect(verdict?.reason).toBeNull();
  });

  it("supports default-export check modules", async () => {
    const candidate = await writeFakePlugin({
      pkgName: "@x/default-export",
      checkSource: "export default { shouldEnable: () => true };",
    });
    const verdict = await evaluatePluginManifest(candidate, baseCtx);
    expect(verdict?.enabled).toBe(true);
  });

  it("supports async shouldEnable predicates", async () => {
    const candidate = await writeFakePlugin({
      pkgName: "@x/async",
      checkSource:
        "export async function shouldEnable(ctx) { return ctx.env.ASYNC === 'go'; }",
    });
    const verdict = await evaluatePluginManifest(candidate, {
      ...baseCtx,
      env: { ASYNC: "go" },
    });
    expect(verdict?.enabled).toBe(true);
  });

  it("captures error when autoEnableModule path doesn't exist", async () => {
    const candidate = await writeFakePlugin({
      pkgName: "@x/missing-module",
      manifestBlock: { autoEnableModule: "./does-not-exist.js" },
    });
    const verdict = await evaluatePluginManifest(candidate, baseCtx);
    expect(verdict?.enabled).toBe(false);
    expect(verdict?.error).toMatch(/did not export a shouldEnable function/);
  });

  it("captures error when shouldEnable throws", async () => {
    const candidate = await writeFakePlugin({
      pkgName: "@x/thrower",
      checkSource:
        'export function shouldEnable() { throw new Error("boom"); }',
    });
    const verdict = await evaluatePluginManifest(candidate, baseCtx);
    expect(verdict?.enabled).toBe(false);
    expect(verdict?.error).toMatch(/shouldEnable threw: boom/);
  });

  it("respects manifest.force = true even when shouldEnable matches", async () => {
    const candidate = await writeFakePlugin({
      pkgName: "@x/forced",
      manifestBlock: {
        autoEnableModule: "./auto-enable.js",
        force: true,
      },
      checkSource: "export function shouldEnable() { return true; }",
    });
    const verdict = await evaluatePluginManifest(candidate, baseCtx);
    expect(verdict?.force).toBe(true);
  });

  it("respects shouldForce predicate", async () => {
    const candidate = await writeFakePlugin({
      pkgName: "@x/conditional-force",
      checkSource: `
        export function shouldEnable() { return true; }
        export function shouldForce(ctx) { return ctx.env.FORCE === '1'; }
      `,
    });
    const allowed = await evaluatePluginManifest(candidate, baseCtx);
    expect(allowed?.force).toBe(false);
    const forced = await evaluatePluginManifest(candidate, {
      ...baseCtx,
      env: { FORCE: "1" },
    });
    expect(forced?.force).toBe(true);
  });
});

describe("evaluatePluginManifests (batch)", () => {
  it("returns one verdict per candidate that has a manifest", async () => {
    const a = await writeFakePlugin({
      pkgName: "@x/a",
      checkSource: "export function shouldEnable() { return true; }",
    });
    const b = await writeFakePlugin({
      pkgName: "@x/b",
      checkSource: "export function shouldEnable() { return false; }",
    });
    const c = await writeFakePlugin({
      pkgName: "@x/c-no-block",
      manifestBlock: null,
    });
    const verdicts = await evaluatePluginManifests([a, b, c], baseCtx);
    expect(verdicts.map((v) => v.packageName).sort()).toEqual(["@x/a", "@x/b"]);
    expect(verdicts.find((v) => v.packageName === "@x/a")?.enabled).toBe(true);
    expect(verdicts.find((v) => v.packageName === "@x/b")?.enabled).toBe(false);
  });

  it("does not throw when a single manifest evaluation fails", async () => {
    const ok = await writeFakePlugin({
      pkgName: "@x/ok",
      checkSource: "export function shouldEnable() { return true; }",
    });
    const broken = await writeFakePlugin({
      pkgName: "@x/broken",
      checkSource: "export function shouldEnable() { throw new Error('x'); }",
    });
    const verdicts = await evaluatePluginManifests([ok, broken], baseCtx);
    expect(verdicts).toHaveLength(2);
    expect(verdicts.find((v) => v.packageName === "@x/ok")?.enabled).toBe(true);
    expect(verdicts.find((v) => v.packageName === "@x/broken")?.error).toMatch(
      /shouldEnable threw/,
    );
  });
});

describe("applyPluginManifestVerdicts", () => {
  function makeVerdict(
    overrides: Partial<PluginManifestVerdict>,
  ): PluginManifestVerdict {
    return {
      packageName: "@x/test",
      shortId: "test",
      enabled: false,
      force: false,
      capabilities: [],
      reason: null,
      error: null,
      ...overrides,
    };
  }

  it("adds enabled plugins to plugins.allow with both shortId and full name", () => {
    const config: {
      plugins?: {
        allow?: string[];
        entries?: Record<string, { enabled?: boolean }>;
      };
    } = {};
    const changes: string[] = [];
    applyPluginManifestVerdicts(
      config,
      [
        makeVerdict({
          enabled: true,
          reason: "manifest: @x/test/auto-enable.js",
        }),
      ],
      changes,
    );
    expect(config.plugins?.allow).toContain("test");
    expect(config.plugins?.allow).toContain("@x/test");
    expect(changes[0]).toMatch(/Auto-enabled plugin: @x\/test/);
  });

  it("respects entries.enabled=false (does not add)", () => {
    const config: {
      plugins: {
        entries: Record<string, { enabled?: boolean }>;
        allow?: string[];
      };
    } = {
      plugins: { entries: { test: { enabled: false } } },
    };
    const changes: string[] = [];
    applyPluginManifestVerdicts(
      config,
      [makeVerdict({ enabled: true, reason: "x" })],
      changes,
    );
    expect(config.plugins?.allow ?? []).not.toContain("test");
    expect(changes).toHaveLength(0);
  });

  it("force overrides entries.enabled=false", () => {
    const config: {
      plugins: {
        entries: Record<string, { enabled?: boolean }>;
        allow?: string[];
      };
    } = {
      plugins: { entries: { test: { enabled: false } } },
    };
    const changes: string[] = [];
    applyPluginManifestVerdicts(
      config,
      [makeVerdict({ enabled: true, force: true, reason: "force" })],
      changes,
    );
    expect(config.plugins?.allow).toContain("test");
    expect(config.plugins?.entries?.test?.enabled).toBe(true);
  });

  it("force adds a plugin even when the enable predicate is false", () => {
    const config: {
      plugins?: {
        allow?: string[];
        entries?: Record<string, { enabled?: boolean }>;
      };
    } = {};
    const changes: string[] = [];

    applyPluginManifestVerdicts(
      config,
      [
        makeVerdict({
          packageName: "@x/forced-provider",
          shortId: "forced-provider",
          enabled: false,
          force: true,
          reason: "manifest: @x/forced-provider/auto-enable.js",
        }),
      ],
      changes,
    );

    expect(config.plugins?.allow).toContain("forced-provider");
    expect(config.plugins?.allow).toContain("@x/forced-provider");
    expect(changes[0]).toMatch(/Auto-enabled plugin: @x\/forced-provider/);
  });

  it("dedupes when called twice with the same verdict", () => {
    const config: { plugins?: { allow?: string[] } } = {};
    const changes: string[] = [];
    const v = makeVerdict({ enabled: true, reason: "first" });
    applyPluginManifestVerdicts(config, [v], changes);
    applyPluginManifestVerdicts(config, [v], changes);
    expect(config.plugins?.allow?.filter((n) => n === "test")).toHaveLength(1);
  });

  it("surfaces verdict errors as changes", () => {
    const changes: string[] = [];
    applyPluginManifestVerdicts({}, [makeVerdict({ error: "boom" })], changes);
    expect(changes[0]).toMatch(/Plugin auto-enable error for @x\/test: boom/);
  });
});

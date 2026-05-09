// Unit tests for app-level manifest helpers (elizaos.app block in
// the host app's package.json).

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyAppManifestDefaults,
  filterCandidatesByAppManifest,
  readAppManifest,
} from "../app-manifest";
import type { PluginManifestCandidate } from "../plugin-manifest";

let tmpRoot: string;

async function writeAppPackageJson(
  json: Record<string, unknown>,
): Promise<string> {
  await fs.writeFile(
    path.join(tmpRoot, "package.json"),
    JSON.stringify(json, null, 2),
  );
  return tmpRoot;
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "app-manifest-test-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("readAppManifest", () => {
  it("returns null when package.json is missing", async () => {
    const manifest = await readAppManifest(path.join(tmpRoot, "missing"));
    expect(manifest).toBeNull();
  });

  it("returns null when package.json has no elizaos.app block", async () => {
    await writeAppPackageJson({ name: "no-block" });
    const manifest = await readAppManifest(tmpRoot);
    expect(manifest).toBeNull();
  });

  it("returns the elizaos.app block when present", async () => {
    await writeAppPackageJson({
      name: "with-block",
      elizaos: {
        app: {
          candidates: ["@elizaos/plugin-anthropic"],
          defaults: { wallet: { enabled: false } },
          capabilities: { browser: "required" },
        },
      },
    });
    const manifest = await readAppManifest(tmpRoot);
    expect(manifest?.candidates).toEqual(["@elizaos/plugin-anthropic"]);
    expect(manifest?.defaults).toEqual({ wallet: { enabled: false } });
    expect(manifest?.capabilities).toEqual({ browser: "required" });
  });
});

describe("filterCandidatesByAppManifest", () => {
  const candidates: PluginManifestCandidate[] = [
    { packageName: "@elizaos/plugin-anthropic", packageRoot: "/a" },
    { packageName: "@elizaos/plugin-openai", packageRoot: "/b" },
    { packageName: "@elizaos/plugin-wallet", packageRoot: "/c" },
  ];

  it("returns all candidates when manifest is null", () => {
    expect(filterCandidatesByAppManifest(candidates, null)).toEqual(candidates);
  });

  it("returns all candidates when candidates is undefined", () => {
    expect(filterCandidatesByAppManifest(candidates, {})).toEqual(candidates);
  });

  it("returns all candidates when candidates is empty array", () => {
    expect(
      filterCandidatesByAppManifest(candidates, { candidates: [] }),
    ).toEqual(candidates);
  });

  it("filters by full package name", () => {
    const result = filterCandidatesByAppManifest(candidates, {
      candidates: ["@elizaos/plugin-anthropic", "@elizaos/plugin-wallet"],
    });
    expect(result.map((c) => c.packageName).sort()).toEqual([
      "@elizaos/plugin-anthropic",
      "@elizaos/plugin-wallet",
    ]);
  });

  it("filters by short id", () => {
    const result = filterCandidatesByAppManifest(candidates, {
      candidates: ["anthropic", "openai"],
    });
    expect(result.map((c) => c.packageName).sort()).toEqual([
      "@elizaos/plugin-anthropic",
      "@elizaos/plugin-openai",
    ]);
  });

  it("accepts mixed full-name and short-id forms", () => {
    const result = filterCandidatesByAppManifest(candidates, {
      candidates: ["@elizaos/plugin-anthropic", "wallet"],
    });
    expect(result.map((c) => c.packageName).sort()).toEqual([
      "@elizaos/plugin-anthropic",
      "@elizaos/plugin-wallet",
    ]);
  });

  it("returns empty array when nothing matches", () => {
    const result = filterCandidatesByAppManifest(candidates, {
      candidates: ["nonexistent"],
    });
    expect(result).toEqual([]);
  });
});

describe("applyAppManifestDefaults", () => {
  it("does nothing when manifest is null", () => {
    const config: { plugins?: { entries?: Record<string, { enabled?: boolean }> } } = {};
    expect(applyAppManifestDefaults(config, null)).toEqual([]);
    expect(config.plugins?.entries).toBeUndefined();
  });

  it("does nothing when manifest has no defaults", () => {
    const config = {};
    expect(applyAppManifestDefaults(config, {})).toEqual([]);
  });

  it("populates entries from defaults", () => {
    const config: { plugins?: { entries?: Record<string, { enabled?: boolean }> } } = {};
    const applied = applyAppManifestDefaults(config, {
      defaults: { wallet: { enabled: false }, anthropic: { enabled: true } },
    });
    expect(applied.sort()).toEqual(["anthropic", "wallet"]);
    expect(config.plugins?.entries?.wallet).toEqual({ enabled: false });
    expect(config.plugins?.entries?.anthropic).toEqual({ enabled: true });
  });

  it("user-set entries win over defaults", () => {
    const config = {
      plugins: { entries: { wallet: { enabled: true } } },
    };
    const applied = applyAppManifestDefaults(config, {
      defaults: { wallet: { enabled: false }, anthropic: { enabled: true } },
    });
    expect(applied).toEqual(["anthropic"]);
    expect(config.plugins?.entries.wallet).toEqual({ enabled: true });
    expect(config.plugins?.entries.anthropic).toEqual({ enabled: true });
  });

  it("creates plugins.entries when missing", () => {
    const config: { plugins?: { entries?: Record<string, { enabled?: boolean }> } } = {};
    applyAppManifestDefaults(config, {
      defaults: { x: { enabled: true } },
    });
    expect(config.plugins?.entries).toBeDefined();
    expect(config.plugins?.entries?.x).toEqual({ enabled: true });
  });
});

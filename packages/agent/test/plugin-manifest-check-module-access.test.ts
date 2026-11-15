/**
 * A check module that cannot be read is a broken manifest, not an absent one.
 * Only ENOENT means "this plugin ships no auto-enable check module"; any other
 * access failure (EACCES, ELOOP, EIO) must reach the verdict's `error` field so
 * the operator sees the real cause instead of "did not export shouldEnable".
 */
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluatePluginManifest,
  type PluginAutoEnableContext,
} from "../src/host-manifests/plugin-manifest.ts";

const roots: string[] = [];
const ctx = {} as PluginAutoEnableContext;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function pluginRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "eliza-plugin-manifest-"));
  roots.push(root);
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "@elizaos/plugin-probe",
      version: "1.0.0",
      elizaos: { plugin: { autoEnableModule: "./auto-enable.js" } },
    }),
  );
  return root;
}

describe("plugin manifest check-module access", () => {
  it("surfaces an unreadable check module as an access failure", async () => {
    const packageRoot = await pluginRoot();
    await symlink("auto-enable.js", path.join(packageRoot, "auto-enable.js"));

    const verdict = await evaluatePluginManifest(
      { packageName: "@elizaos/plugin-probe", packageRoot },
      ctx,
    );

    expect(verdict).not.toBeNull();
    // Before the fix the ELOOP access failure was swallowed as "missing" and
    // reported as the unrelated "did not export a shouldEnable function".
    expect(verdict?.error).toMatch(/failed to import autoEnableModule/);
    expect(verdict?.error).not.toMatch(/did not export/);
  });

  it("keeps a genuinely absent check module on the documented tolerance path", async () => {
    const packageRoot = await pluginRoot();

    const verdict = await evaluatePluginManifest(
      { packageName: "@elizaos/plugin-probe", packageRoot },
      ctx,
    );

    expect(verdict?.enabled).toBe(false);
    expect(verdict?.error).toMatch(/did not export a shouldEnable function/);
  });
});

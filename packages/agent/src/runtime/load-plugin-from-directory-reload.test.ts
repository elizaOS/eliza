/**
 * Domain H — plugin hot-reload from an on-disk built directory.
 *
 * Closes the gap that the sibling `load-plugin-from-directory.test.ts` leaves
 * open: it only covers the happy load/unload path and never proves the
 * edit -> rebuild -> live-reload -> NEW-behavior loop, nor the broken-reload
 * rollback guarantee. Concretely this file pins:
 *
 *  - TEST 1: after a rebuild produces a new built entry, doing unload -> reload
 *    serves v2 behavior — the loader re-resolves + re-imports the rebuilt
 *    module and re-registers it so runtime.actions reflects v2 (the
 *    PLUGIN_VERSION handler now resolves { version: 2 } and a brand-new
 *    PLUGIN_V2_ONLY action is present). It also pins the documented gotcha that
 *    a bare second load WITHOUT unload is a no-op (core registerPlugin returns
 *    early on a duplicate plugin name — runtime.ts:1588-1596).
 *  - TEST 2: a reload whose new module throws at IMPORT time (module top-level
 *    throw) rejects to the caller, and because the dynamic import runs BEFORE
 *    runtime.registerPlugin (load-plugin-from-directory.ts:156 vs 165) the
 *    previously-loaded v1 plugin survives untouched — actions, ownership refs,
 *    and the loaded-plugin tracking map are all unchanged (rollback).
 *
 * Fully deterministic: real AgentRuntime + real filesystem temp dirs, no mocks,
 * no fake timers.
 *
 * RUNTIME CAVEAT (why each version uses a DISTINCT entry file): the loader's
 * `?t=${Date.now()}` query-string cache-bust (load-plugin-from-directory.ts:155)
 * works under Node's ESM loader, but this package's test runner is Bun
 * (`bunx vitest`), and Bun's module loader caches by resolved file PATH and
 * ignores the query string — so re-importing the SAME rewritten path under Bun
 * returns the stale cached module. To exercise the real reload code path
 * (resolve -> import -> extractPlugin -> registerPlugin serving the NEW module)
 * deterministically under Bun, each "rebuild" writes a distinct built entry and
 * the loader is pointed at it via the `entry` option; the unload/reload and
 * rollback semantics under test are identical regardless of the cache-bust
 * mechanism. (Fake timers are deliberately NOT used — they would freeze
 * Date.now() and, on Node, force a `?t=` cache HIT.)
 */

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetLoadedDirectoryPluginsForTests,
  getLoadedDirectoryPlugins,
  loadPluginFromDirectory,
  unloadPluginFromDirectory,
} from "./load-plugin-from-directory.ts";

let tmpDir: string;

beforeEach(async () => {
  _resetLoadedDirectoryPluginsForTests();
  tmpDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), "agent-reload-dir-plugin-"),
  );
});

afterEach(async () => {
  _resetLoadedDirectoryPluginsForTests();
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

const PLUGIN_NAME = "reload-test-plugin";

/** ESM plugin source whose PLUGIN_VERSION action resolves { version: N }. */
function pluginSourceV1(): string {
  return `
export default {
  name: ${JSON.stringify(PLUGIN_NAME)},
  description: "reload fixture v1",
  actions: [
    {
      name: "PLUGIN_VERSION",
      description: "reports its version",
      examples: [],
      similes: [],
      validate: async () => true,
      handler: async () => ({ version: 1 }),
    },
  ],
};
`;
}

/** v2: same plugin name, version -> 2, plus a NEW action PLUGIN_V2_ONLY. */
function pluginSourceV2(): string {
  return `
export default {
  name: ${JSON.stringify(PLUGIN_NAME)},
  description: "reload fixture v2",
  actions: [
    {
      name: "PLUGIN_VERSION",
      description: "reports its version",
      examples: [],
      similes: [],
      validate: async () => true,
      handler: async () => ({ version: 2 }),
    },
    {
      name: "PLUGIN_V2_ONLY",
      description: "only exists in v2",
      examples: [],
      similes: [],
      validate: async () => true,
      handler: async () => ({ v2: true }),
    },
  ],
};
`;
}

/** Broken v2: throws at module top level (IMPORT time), before registerPlugin. */
function pluginSourceBroken(): string {
  return `throw new Error("boom v2 broke the build");\n`;
}

async function scaffold(
  dir: string,
  pkg: Record<string, unknown>,
  files: Record<string, string>,
): Promise<string> {
  const root = path.join(tmpDir, dir);
  await fsp.mkdir(root, { recursive: true });
  await fsp.writeFile(
    path.join(root, "package.json"),
    JSON.stringify(pkg, null, 2),
  );
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, content);
  }
  return root;
}

/** Invoke the PLUGIN_VERSION handler off runtime.actions and read .version. */
async function readReportedVersion(
  runtime: AgentRuntime,
): Promise<number | undefined> {
  const action = runtime.actions.find((a) => a.name === "PLUGIN_VERSION");
  const result = (await action?.handler?.(
    runtime as unknown as never,
    {} as never,
    {} as never,
  )) as { version?: number } | undefined;
  return result?.version;
}

describe("loadPluginFromDirectory — hot reload (Domain H)", () => {
  it("edit -> rebuild -> unload -> reload serves NEW v2 behavior", async () => {
    const dir = await scaffold(
      "plugin-reload",
      { name: "@local/plugin-reload", main: "dist/index.js" },
      { "dist/index.js": pluginSourceV1() },
    );

    const runtime = new AgentRuntime({ logLevel: "fatal" });
    expect(typeof runtime.registerPlugin).toBe("function");

    // --- v1 (resolved via package.json main) ---
    const firstLoad = await loadPluginFromDirectory({
      runtime,
      directory: dir,
    });
    expect(firstLoad.pluginName).toBe(PLUGIN_NAME);
    expect(firstLoad.loaded).toBe(true);
    expect(await readReportedVersion(runtime)).toBe(1);
    expect(runtime.actions.some((a) => a.name === "PLUGIN_V2_ONLY")).toBe(
      false,
    );

    const firstEntry = getLoadedDirectoryPlugins().find(
      (e) => e.pluginName === PLUGIN_NAME,
    );
    expect(firstEntry).toBeDefined();
    const firstLoadedAt = firstEntry?.loadedAt ?? 0;
    const firstDiskPath = firstEntry?.diskPath;

    // "Rebuild": the new build produces a fresh entry artifact.
    await fsp.writeFile(path.join(dir, "dist/index2.js"), pluginSourceV2());

    // A bare second load WITHOUT unloading is a no-op: core registerPlugin
    // returns early on a duplicate plugin name (runtime.ts:1588-1596), so v1
    // stays live. This pins the documented gotcha that reload REQUIRES unload.
    await loadPluginFromDirectory({
      runtime,
      directory: dir,
      entry: "dist/index2.js",
    });
    expect(await readReportedVersion(runtime)).toBe(1);
    expect(runtime.actions.some((a) => a.name === "PLUGIN_V2_ONLY")).toBe(
      false,
    );

    // --- proper reload: unload v1, then load again -> v2 ---
    const unloaded = await unloadPluginFromDirectory({
      runtime,
      pluginName: PLUGIN_NAME,
    });
    expect(unloaded.unloaded).toBe(true);
    expect(runtime.actions.some((a) => a.name === "PLUGIN_VERSION")).toBe(
      false,
    );

    const reload = await loadPluginFromDirectory({
      runtime,
      directory: dir,
      entry: "dist/index2.js",
    });
    expect(reload.pluginName).toBe(PLUGIN_NAME);

    // v2 is now served — the regression that proves the rebuilt module was
    // imported and re-registered, not the stale v1.
    expect(await readReportedVersion(runtime)).toBe(2);
    expect(runtime.actions.some((a) => a.name === "PLUGIN_V2_ONLY")).toBe(true);

    // Tracking map holds exactly ONE entry (no duplicate leak); its diskPath
    // now points at the rebuilt artifact and loadedAt advanced.
    const entries = getLoadedDirectoryPlugins().filter(
      (e) => e.pluginName === PLUGIN_NAME,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].loadedAt).toBeGreaterThanOrEqual(firstLoadedAt);
    expect(entries[0].diskPath).not.toBe(firstDiskPath);

    // Cleanup — no cross-test pollution.
    await unloadPluginFromDirectory({ runtime, pluginName: PLUGIN_NAME });
    expect(runtime.actions.some((a) => a.name === "PLUGIN_VERSION")).toBe(
      false,
    );
    expect(getLoadedDirectoryPlugins()).toHaveLength(0);
  });

  it("broken reload (import-time throw) rejects and v1 survives untouched (rollback)", async () => {
    const dir = await scaffold(
      "plugin-reload-broken",
      { name: "@local/plugin-reload", main: "dist/index.js" },
      { "dist/index.js": pluginSourceV1() },
    );

    const runtime = new AgentRuntime({ logLevel: "fatal" });

    // --- v1 loaded and healthy ---
    await loadPluginFromDirectory({ runtime, directory: dir });
    expect(await readReportedVersion(runtime)).toBe(1);

    const ownershipBefore = runtime.getPluginOwnership(PLUGIN_NAME);
    expect(ownershipBefore).not.toBeNull();
    expect(ownershipBefore?.actions.length ?? 0).toBeGreaterThan(0);
    const v1ActionRef = ownershipBefore?.actions.find(
      (a) => a.name === "PLUGIN_VERSION",
    );
    expect(v1ActionRef).toBeDefined();

    const trackingBefore = getLoadedDirectoryPlugins().find(
      (e) => e.pluginName === PLUGIN_NAME,
    );
    expect(trackingBefore).toBeDefined();
    const diskPathBefore = trackingBefore?.diskPath;
    const loadedAtBefore = trackingBefore?.loadedAt;

    // The "rebuild" produced a broken artifact that throws at module top level
    // (IMPORT time). The dynamic import in loadPluginFromDirectory runs BEFORE
    // registerPlugin, so the failure never reaches the runtime — prior v1 state
    // must be untouched. NOTE: deliberately do NOT unload v1 first; the broken
    // import must fail before any teardown of v1 happens.
    await fsp.writeFile(path.join(dir, "dist/broken.js"), pluginSourceBroken());

    await expect(
      loadPluginFromDirectory({
        runtime,
        directory: dir,
        entry: "dist/broken.js",
      }),
    ).rejects.toThrow(/boom v2/);

    // --- rollback assertions: v1 still fully live ---
    expect(runtime.actions.some((a) => a.name === "PLUGIN_VERSION")).toBe(true);
    expect(await readReportedVersion(runtime)).toBe(1);
    expect(runtime.actions.some((a) => a.name === "PLUGIN_V2_ONLY")).toBe(
      false,
    );

    const ownershipAfter = runtime.getPluginOwnership(PLUGIN_NAME);
    expect(ownershipAfter).not.toBeNull();
    // Same live action object reference survived the failed reload.
    expect(
      ownershipAfter?.actions.find((a) => a.name === "PLUGIN_VERSION"),
    ).toBe(v1ActionRef);

    // The tracking map was NOT mutated by the failed load.
    const trackingAfter = getLoadedDirectoryPlugins().filter(
      (e) => e.pluginName === PLUGIN_NAME,
    );
    expect(trackingAfter).toHaveLength(1);
    expect(trackingAfter[0].diskPath).toBe(diskPathBefore);
    expect(trackingAfter[0].loadedAt).toBe(loadedAtBefore);

    // Cleanup.
    await unloadPluginFromDirectory({ runtime, pluginName: PLUGIN_NAME });
    expect(runtime.actions.some((a) => a.name === "PLUGIN_VERSION")).toBe(
      false,
    );
    expect(getLoadedDirectoryPlugins()).toHaveLength(0);
  });
});

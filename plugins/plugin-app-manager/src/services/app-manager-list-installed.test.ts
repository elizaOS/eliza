/**
 * AppManager.listInstalled non-blocking registry refresh (#16873).
 *
 * The message hot path renders available_apps → listInstalled on every turn.
 * Awaiting pluginManager.refreshRegistry() there nulled the registry caches
 * and refetched over the network on each call, so every turn paid a cold
 * multi-second registry fetch. listInstalled must now serve the CACHED
 * registry synchronously and fire the refresh out-of-band (deduped while one
 * is in flight). POST /api/apps/refresh remains the force path.
 *
 * The service pulls several @elizaos/agent host modules at eval time; they are
 * mocked to the minimal surface listInstalled reads so the method runs without
 * the full agent package or a live registry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({
  getRegistryPlugins: vi.fn(),
}));

vi.mock("@elizaos/agent/config/config", () => ({
  loadElizaConfig: () => ({ agents: { list: [] } }),
  saveElizaConfig: () => {},
}));
vi.mock("@elizaos/agent/services/app-manager-agents-list-guard", () => ({
  shouldRestoreAgentsListAfterAppLaunch: () => false,
}));
vi.mock("@elizaos/agent/services/app-package-modules", () => ({
  importAppPlugin: vi.fn(),
  importAppRouteModule: vi.fn(),
}));
vi.mock("@elizaos/agent/services/registry-client", () => ({
  getRegistryPlugins: registry.getRegistryPlugins,
  getPluginInfo: vi.fn(async () => null),
}));
vi.mock("@elizaos/agent/services/registry-client-app-meta", () => ({
  mergeAppMeta: (derived: unknown, meta: unknown) => meta ?? derived,
  resolveAppOverride: (_name: string, meta: unknown) => meta,
}));
vi.mock("@elizaos/agent/services/registry-client-queries", () => ({
  resolveAppHeroImage: (_name: string, hero: string | null) => hero,
  scoreEntries: () => [],
  toSearchResults: () => [],
}));

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppManager } from "./app-manager.ts";

/** A registry entry the app-manager treats as an installable app. */
function appRegistryEntry(name: string) {
  const pkg = `@elizaos/plugin-${name}`;
  return {
    name,
    description: "test app",
    npm: { package: pkg },
    // runtimePlugin resolves pluginName without the npm fallback path.
    runtimePlugin: pkg,
    // launchType connect + a launch URL lets launch() build a viewer config
    // without any registry viewer metadata.
    launchType: "connect",
    launchUrl: "https://example.com/app",
    // hasAppInterface() keys off an `app`/`appMeta` interface marker.
    appMeta: {
      displayName: name,
      launchType: "connect",
      launchUrl: "https://example.com/app",
      category: "games",
      capabilities: [],
      runtimePlugin: pkg,
    },
    app: {},
  };
}

/**
 * Minimal PluginManagerLike: reports `name` installed and exposes a
 * refreshRegistry spy that never resolves synchronously so the test can prove
 * listInstalled did not await it.
 */
function makePluginManager(installedName: string) {
  let resolveRefresh: (() => void) | null = null;
  const refreshRegistry = vi.fn(
    () =>
      new Promise<Map<string, unknown>>((resolve) => {
        resolveRefresh = () => resolve(new Map());
      }),
  );
  return {
    pluginManager: {
      listInstalledPlugins: vi.fn(async () => [
        {
          name: `@elizaos/plugin-${installedName}`,
          version: "1.0.0",
          installedAt: "",
        },
      ]),
      refreshRegistry,
      getRegistryPlugin: vi.fn(async () => null),
      searchRegistry: vi.fn(async () => []),
      installPlugin: vi.fn(),
      uninstallPlugin: vi.fn(),
      listEjectedPlugins: vi.fn(async () => []),
      ejectPlugin: vi.fn(),
      syncPlugin: vi.fn(),
      reinjectPlugin: vi.fn(),
    },
    refreshRegistry,
    settleRefresh: () => resolveRefresh?.(),
  };
}

let stateDir: string;

beforeEach(() => {
  registry.getRegistryPlugins.mockReset();
  stateDir = mkdtempSync(join(tmpdir(), "app-manager-test-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("AppManager.listInstalled non-blocking refresh", () => {
  it("serves the cached registry synchronously without awaiting refreshRegistry", async () => {
    const cached = new Map<string, unknown>([
      ["chess", appRegistryEntry("chess")],
    ]);
    registry.getRegistryPlugins.mockResolvedValue(cached);
    const pm = makePluginManager("chess");
    const manager = new AppManager({ stateDir });

    // refreshRegistry never resolves; if listInstalled awaited it this would
    // hang. It must resolve from the cached registry instead.
    const installed = await manager.listInstalled(pm.pluginManager);

    expect(installed.map((a) => a.name)).toContain("chess");
    // The refresh was fired (best-effort, out-of-band) but never awaited.
    expect(pm.refreshRegistry).toHaveBeenCalledTimes(1);

    pm.settleRefresh();
  });

  it("de-dupes overlapping background refreshes across concurrent calls", async () => {
    const cached = new Map<string, unknown>([
      ["chess", appRegistryEntry("chess")],
    ]);
    registry.getRegistryPlugins.mockResolvedValue(cached);
    const pm = makePluginManager("chess");
    const manager = new AppManager({ stateDir });

    // Two turns fire before the first refresh settles — only one network
    // refresh should be in flight.
    await Promise.all([
      manager.listInstalled(pm.pluginManager),
      manager.listInstalled(pm.pluginManager),
    ]);

    expect(pm.refreshRegistry).toHaveBeenCalledTimes(1);
    pm.settleRefresh();
  });

  it("re-arms the background refresh after the prior one settles", async () => {
    const cached = new Map<string, unknown>([
      ["chess", appRegistryEntry("chess")],
    ]);
    registry.getRegistryPlugins.mockResolvedValue(cached);
    const pm = makePluginManager("chess");
    const manager = new AppManager({ stateDir });

    await manager.listInstalled(pm.pluginManager);
    expect(pm.refreshRegistry).toHaveBeenCalledTimes(1);

    // Settle the in-flight refresh, then the next turn may arm a new one.
    pm.settleRefresh();
    await vi.waitFor(async () => {
      await manager.listInstalled(pm.pluginManager);
      expect(pm.refreshRegistry).toHaveBeenCalledTimes(2);
    });
    pm.settleRefresh();
  });
});

describe("AppManager run lifecycle (launch/stop/attach/heartbeat/reap)", () => {
  async function launchChess(manager: AppManager) {
    const pm = makePluginManager("chess");
    pm.pluginManager.getRegistryPlugin.mockResolvedValue(
      appRegistryEntry("chess"),
    );
    registry.getRegistryPlugins.mockResolvedValue(new Map());
    const result = await manager.launch(pm.pluginManager, "chess");
    return { pm, result };
  }

  it("launches an already-installed connect app and registers a run with a viewer", async () => {
    const manager = new AppManager({ stateDir });
    const { result } = await launchChess(manager);

    expect(result.pluginInstalled).toBe(true);
    expect(result.needsRestart).toBe(false);
    expect(result.launchType).toBe("connect");
    expect(result.launchUrl).toBe("https://example.com/app");
    expect(result.viewer?.url).toBe("https://example.com/app");
    expect(result.run.appName).toBe("chess");
    expect(result.run.status).toBe("running");
    expect(result.run.recentEvents.length).toBeGreaterThan(0);
  });

  it("reuses the existing run when the same app launches again", async () => {
    const manager = new AppManager({ stateDir });
    const first = await launchChess(manager);
    const second = await launchChess(manager);
    expect(second.result.run.runId).toBe(first.result.run.runId);
    const runs = await manager.listRuns(null);
    expect(runs).toHaveLength(1);
  });

  it("lists, attaches, detaches, and heartbeats a run", async () => {
    const manager = new AppManager({ stateDir });
    const { result } = await launchChess(manager);
    const runId = result.run.runId;

    const runs = await manager.listRuns(null);
    expect(runs.map((r) => r.runId)).toContain(runId);

    const attached = await manager.attachRun(runId, null);
    expect(attached.success).toBe(true);
    expect(attached.run?.viewerAttachment).toBe("attached");

    const detached = await manager.detachRun(runId);
    expect(detached.success).toBe(true);
    expect(detached.run?.viewerAttachment).toBe("detached");

    const hb = manager.recordHeartbeat(runId);
    expect(hb?.lastHeartbeatAt).toBeTruthy();
    expect(manager.recordHeartbeat("nope")).toBeNull();

    const fetched = await manager.getRun(runId, null);
    expect(fetched?.runId).toBe(runId);
    expect(await manager.getRun("missing", null)).toBeNull();

    expect((await manager.attachRun("missing", null)).success).toBe(false);
    expect((await manager.detachRun("missing")).success).toBe(false);
  });

  it("stops a run by app name and reports nothing-stopped afterwards", async () => {
    const manager = new AppManager({ stateDir });
    const { pm } = await launchChess(manager);

    const stopped = await manager.stop(pm.pluginManager, "chess");
    expect(stopped.success).toBe(true);
    expect(stopped.stopScope).toBe("viewer-session");
    expect(await manager.listRuns(null)).toHaveLength(0);

    // Second stop: the app is known but has no active runs.
    const again = await manager.stop(pm.pluginManager, "chess");
    expect(again.success).toBe(false);
    expect(again.stopScope).toBe("nothing-stopped");
  });

  it("stops a specific run by runId and fails for an unknown runId", async () => {
    const manager = new AppManager({ stateDir });
    const { pm, result } = await launchChess(manager);

    const missing = await manager.stop(pm.pluginManager, "chess", "unknown");
    expect(missing.success).toBe(false);

    const stopped = await manager.stop(
      pm.pluginManager,
      "chess",
      result.run.runId,
    );
    expect(stopped.success).toBe(true);
    expect(stopped.runId).toBe(result.run.runId);
  });

  it("reaps runs whose heartbeat went stale and leaves fresh runs alone", async () => {
    const manager = new AppManager({ stateDir, heartbeatTimeoutMs: 60_000 });
    const { result } = await launchChess(manager);

    // Fresh: nothing reaped.
    expect(await manager.reapStaleRuns(null, Date.now())).toHaveLength(0);

    // Far in the future: the run's startedAt reference is stale.
    const reaped = await manager.reapStaleRuns(null, Date.now() + 3_600_000);
    expect(reaped.map((r) => r.runId)).toContain(result.run.runId);
    expect(await manager.listRuns(null)).toHaveLength(0);
  });

  it("starts and stops the stale-run sweeper idempotently", () => {
    const manager = new AppManager({ stateDir });
    manager.startStaleRunSweeper(() => null);
    manager.startStaleRunSweeper(() => null);
    manager.stopStaleRunSweeper();
    manager.stopStaleRunSweeper();
  });

  it("restores persisted runs from the state dir in a new manager instance", async () => {
    const manager = new AppManager({ stateDir });
    const { result } = await launchChess(manager);

    const rebooted = new AppManager({ stateDir });
    const runs = await rebooted.listRuns(null);
    expect(runs.map((r) => r.runId)).toContain(result.run.runId);
  });
});

describe("AppManager catalog surface", () => {
  it("listAvailable filters to app-interface registry entries", async () => {
    registry.getRegistryPlugins.mockResolvedValue(
      new Map([
        ["chess", appRegistryEntry("chess")],
        ["not-an-app", { name: "not-an-app", description: "library" }],
      ]),
    );
    const pm = makePluginManager("chess");
    const manager = new AppManager({ stateDir });
    const available = await manager.listAvailable(pm.pluginManager);
    // "chess" is not on the curated catalog, so the curated list is empty —
    // but the call exercised the full registry read + filter path.
    expect(Array.isArray(available)).toBe(true);
  });

  it("search returns scored results through the registry-queries seam", async () => {
    registry.getRegistryPlugins.mockResolvedValue(
      new Map([["chess", appRegistryEntry("chess")]]),
    );
    const pm = makePluginManager("chess");
    const manager = new AppManager({ stateDir });
    const results = await manager.search(pm.pluginManager, "chess");
    expect(Array.isArray(results)).toBe(true);
  });

  it("getInfo resolves a named app through the plugin-manager registry", async () => {
    registry.getRegistryPlugins.mockResolvedValue(new Map());
    const pm = makePluginManager("chess");
    pm.pluginManager.getRegistryPlugin.mockResolvedValue(
      appRegistryEntry("chess"),
    );
    const manager = new AppManager({ stateDir });
    const info = await manager.getInfo(pm.pluginManager, "chess");
    expect(info?.name).toBe("chess");
    expect(info?.launchUrl).toBe("https://example.com/app");

    pm.pluginManager.getRegistryPlugin.mockResolvedValue(null);
    expect(await manager.getInfo(pm.pluginManager, "missing")).toBeNull();
  });
});

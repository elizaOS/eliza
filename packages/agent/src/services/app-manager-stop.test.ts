/**
 * Explicit Stop-button lifecycle tests for AppManager.
 *
 * Covers the code path users hit when they click the Stop button (on the
 * running-app card in AppsView or inside GameView): app-manager removes
 * the run from its registry AND invokes the plugin's `stopRun` hook so
 * server-side resources (bot connections, game-loop timers, embedded
 * servers) actually tear down.
 *
 * The plugin route module is mocked at the import boundary so we can
 * observe `stopRun` invocations without spinning up a real plugin.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import type { AppRunSummary } from "../contracts/apps.js";
import { writeAppRunStore } from "./app-run-store.js";

const stopRunMock = vi.fn(async () => {});

vi.mock("./app-package-modules.js", () => ({
  importAppRouteModule: vi.fn(async () => ({
    stopRun: stopRunMock,
  })),
  importAppPlugin: vi.fn(async () => null),
}));

const { AppManager } = await import("./app-manager.js");

function makeRun(overrides: Partial<AppRunSummary>): AppRunSummary {
  const now = new Date().toISOString();
  return {
    runId: "run-1",
    appName: "@elizaos/app-defense-of-the-agents",
    displayName: "Defense of the Agents",
    pluginName: "@elizaos/app-defense-of-the-agents",
    launchType: "connect",
    launchUrl: null,
    viewer: null,
    session: null,
    characterId: null,
    agentId: null,
    status: "running",
    summary: null,
    startedAt: now,
    updatedAt: now,
    lastHeartbeatAt: now,
    supportsBackground: true,
    supportsViewerDetach: false,
    chatAvailability: "unknown",
    controlAvailability: "unknown",
    viewerAttachment: "unavailable",
    recentEvents: [],
    awaySummary: null,
    health: { state: "healthy", message: null },
    healthDetails: {
      checkedAt: now,
      auth: { state: "unknown", message: null },
      runtime: { state: "healthy", message: null },
      viewer: { state: "unknown", message: null },
      chat: { state: "unknown", message: null },
      control: { state: "unknown", message: null },
      message: null,
    },
    ...overrides,
  };
}

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "milady-app-manager-stop-test-"));
  stopRunMock.mockClear();
  (stopRunMock as Mock).mockImplementation(async () => {});
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

/** Minimal PluginManagerLike stub — AppManager.stop only touches
 * `getRegistryPlugin` in the branch where a run is not found. With a
 * pre-existing run our tests don't hit that branch. */
const stubPluginManager = {
  getRegistryPlugin: vi.fn(async () => null),
  listInstalledPlugins: vi.fn(async () => []),
  // biome-ignore lint/suspicious/noExplicitAny: stub covers shape used in tests
} as unknown as any;

describe("AppManager.stop (explicit Stop button)", () => {
  it("invokes stopRun after removing the run from the registry", async () => {
    const run = makeRun({ runId: "run-to-stop" });
    writeAppRunStore([run], stateDir);

    const manager = new AppManager({ stateDir });
    const result = (await manager.stop(
      stubPluginManager,
      "",
      "run-to-stop",
      /* runtime */ null,
    )) as { success: boolean; stopScope?: string };

    expect(result.success).toBe(true);
    expect(result.stopScope).toBe("viewer-session");
    expect(stopRunMock).toHaveBeenCalledOnce();
    const firstArg = stopRunMock.mock.calls[0]?.[0] as
      | { runId?: string; appName?: string; runtime?: unknown }
      | undefined;
    expect(firstArg?.runId).toBe("run-to-stop");
    expect(firstArg?.appName).toBe("@elizaos/app-defense-of-the-agents");
  });

  it("passes runtime through to stopRun so plugins can resolve their service", async () => {
    const run = makeRun({ runId: "run-with-runtime" });
    writeAppRunStore([run], stateDir);

    const runtime = { agentId: "agent-test-1" };
    const manager = new AppManager({ stateDir });
    await manager.stop(
      stubPluginManager,
      "",
      "run-with-runtime",
      runtime as never,
    );

    const firstArg = stopRunMock.mock.calls[0]?.[0] as {
      runtime?: unknown;
    };
    expect(firstArg?.runtime).toBe(runtime);
  });

  it("still succeeds when stopRun throws — removal from registry is authoritative", async () => {
    (stopRunMock as Mock).mockImplementation(async () => {
      throw new Error("plugin teardown failed");
    });
    const run = makeRun({ runId: "run-that-errors" });
    writeAppRunStore([run], stateDir);

    const manager = new AppManager({ stateDir });
    const result = (await manager.stop(
      stubPluginManager,
      "",
      "run-that-errors",
      null,
    )) as { success: boolean };

    expect(result.success).toBe(true);
    expect(stopRunMock).toHaveBeenCalledOnce();
    // The run is gone from the registry even though stopRun threw.
    const runs = await manager.listRuns();
    expect(runs).toEqual([]);
  });

  it("returns a no-op success:false when the runId is unknown", async () => {
    const manager = new AppManager({ stateDir });
    const result = (await manager.stop(
      stubPluginManager,
      "",
      "ghost-run-id",
      null,
    )) as { success: boolean; stopScope?: string };

    expect(result.success).toBe(false);
    expect(result.stopScope).toBe("no-op");
    expect(stopRunMock).not.toHaveBeenCalled();
  });

  it("invokes stopRun once per run when stopping all runs of an app by name", async () => {
    writeAppRunStore(
      [
        makeRun({ runId: "run-a", appName: "@elizaos/app-scape" }),
        makeRun({ runId: "run-b", appName: "@elizaos/app-scape" }),
        makeRun({ runId: "run-c", appName: "@elizaos/app-hyperscape" }),
      ],
      stateDir,
    );

    const manager = new AppManager({ stateDir });
    const result = (await manager.stop(
      stubPluginManager,
      "@elizaos/app-scape",
      undefined,
      null,
    )) as { success: boolean };

    expect(result.success).toBe(true);
    // Two scape runs → two stopRun invocations; the hyperscape run is
    // untouched.
    expect(stopRunMock).toHaveBeenCalledTimes(2);
    const stoppedRunIds = stopRunMock.mock.calls
      .map((c) => (c[0] as { runId?: string }).runId)
      .sort();
    expect(stoppedRunIds).toEqual(["run-a", "run-b"]);
  });
});

import { describe, expect, it, vi } from "vitest";
import { DynamicViewRegistry } from "../dynamic-views/registry";
import { DynamicViewSessionManager } from "../dynamic-views/session-manager";
import { createDatabaseSnapshot } from "../database";
import { LaunchOrchestrator } from "./launch-orchestrator";
import type { LaunchBugReportBundleInfo } from "./types";
import type { JsonValue } from "@elizaos/plugin-remote-manifest";

class FakeCanvas {
  readonly windows: Array<{ id: string; title?: string }> = [];
  readonly pushes: Array<{ id: string; payload: JsonValue }> = [];

  async createWindow(options: { title?: string }): Promise<{ id: string }> {
    const id = `window-${this.windows.length + 1}`;
    this.windows.push({ id, title: options.title });
    return { id };
  }

  async destroyWindow(): Promise<void> {}

  async a2uiPush(options: { id: string; payload: JsonValue }): Promise<void> {
    this.pushes.push(options);
  }
}

function createAgent(
  state: "not_started" | "starting" | "running" | "stopped" | "error",
) {
  return {
    getStatus: vi.fn(() => ({
      state,
      agentName: state === "running" ? "Eliza" : null,
      port: state === "not_started" ? null : 31337,
      startedAt: state === "running" ? 1000 : null,
      error: state === "error" ? "boom" : null,
    })),
    start: vi.fn(async () => ({
      state: "running" as const,
      agentName: "Eliza",
      port: 31337,
      startedAt: 1000,
      error: null,
    })),
    restart: vi.fn(async () => ({
      state: "running" as const,
      agentName: "Eliza",
      port: 31337,
      startedAt: 1000,
      error: null,
    })),
  };
}

function createOrchestrator(options?: {
  state?: "not_started" | "starting" | "running" | "stopped" | "error";
  authRequired?: boolean;
  onboardingComplete?: boolean;
  cloudProvisioned?: boolean;
  withViews?: boolean;
  databaseFailed?: boolean;
}) {
  const agent = createAgent(options?.state ?? "running");
  const canvas = new FakeCanvas();
  const registry = new DynamicViewRegistry();
  const sessions = new DynamicViewSessionManager({
    registry,
    canvas,
    sessionIdFactory: () => "launch",
  });
  const bundle: LaunchBugReportBundleInfo = {
    directory: "/tmp/report",
    reportMarkdownPath: "/tmp/report/report.md",
    reportJsonPath: "/tmp/report/report.json",
    startupLogPath: "/tmp/report/startup.log",
    startupStatusPath: "/tmp/report/startup-status.json",
  };
  const createBugReportBundle = vi.fn(async () => bundle);
  const orchestrator = new LaunchOrchestrator({
    agent,
    readBootProgress: async () => ({
      state: agent.getStatus().state,
      phase: agent.getStatus().state === "running" ? "running" : null,
      lastError: agent.getStatus().error,
      pluginsLoaded: agent.getStatus().state === "running" ? 12 : null,
      pluginsFailed: 0,
      database: agent.getStatus().state === "running" ? "ok" : null,
      agentName: agent.getStatus().agentName,
      port: agent.getStatus().port,
      startedAt: agent.getStatus().startedAt,
      updatedAt: "2026-05-17T00:00:00.000Z",
    }),
    readAuthStatus: async () => ({
      required: options?.authRequired === true,
      pairingEnabled: options?.authRequired === true,
      expiresAt: null,
      authenticated: options?.authRequired !== true,
    }),
    readOnboardingStatus: async () => ({
      complete: options?.onboardingComplete ?? true,
      cloudProvisioned: options?.cloudProvisioned === true ? true : undefined,
    }),
    readDiagnostics: () => ({
      state: agent.getStatus().state,
      phase: "ready",
      updatedAt: "2026-05-17T00:00:00.000Z",
      lastError: agent.getStatus().error,
      agentName: agent.getStatus().agentName,
      port: agent.getStatus().port,
      startedAt: agent.getStatus().startedAt,
      logPath: "/tmp/startup.log",
      statusPath: "/tmp/startup-status.json",
    }),
    readDatabaseStatus: () =>
      options?.databaseFailed === true
        ? createDatabaseSnapshot({
            mode: "pglite-persistent",
            status: "migration-failed",
            postgresUrlSet: false,
            pgliteDataDir: "/tmp/pglite",
            effectiveTarget: "/tmp/pglite",
            error: "migration failed",
          })
        : createDatabaseSnapshot({
            mode: "pglite-persistent",
            status: "ready",
            postgresUrlSet: false,
            pgliteDataDir: "/tmp/pglite",
            effectiveTarget: "/tmp/pglite",
          }),
    readDiagnosticLogTail: () => "tail",
    listSatelliteStatuses: () => [
      {
        id: "eliza.runtime",
        state: "running",
        error: null,
        required: true,
      },
    ],
    createBugReportBundle,
    dynamicViewRegistry: options?.withViews ? registry : undefined,
    dynamicViewSessions: options?.withViews ? sessions : undefined,
    now: () => new Date("2026-05-17T00:00:00.000Z"),
  });
  return { orchestrator, agent, canvas, createBugReportBundle };
}

describe("LaunchOrchestrator", () => {
  it("reports ready without blocking on model background queue", async () => {
    const { orchestrator } = createOrchestrator();

    const snapshot = await orchestrator.getProgress();

    expect(snapshot.phase).toBe("ready");
    expect(snapshot.localModel).toEqual({
      backgroundDownloadQueued: false,
      blocking: false,
    });
  });

  it("classifies onboarding and pairing gates", async () => {
    const pairing = await createOrchestrator({
      authRequired: true,
    }).orchestrator.getProgress();
    const onboarding = await createOrchestrator({
      onboardingComplete: false,
    }).orchestrator.getProgress();
    const cloud = await createOrchestrator({
      onboardingComplete: false,
      cloudProvisioned: true,
    }).orchestrator.getProgress();

    expect(pairing.phase).toBe("pairing-required");
    expect(onboarding.phase).toBe("runtime-gate-required");
    expect(cloud.phase).toBe("cloud-bootstrap-required");
  });

  it("treats database failure as launch failure before onboarding", async () => {
    const snapshot = await createOrchestrator({
      onboardingComplete: false,
      databaseFailed: true,
    }).orchestrator.getProgress();

    expect(snapshot.phase).toBe("error");
    expect(snapshot.recovery.suggestedAction).toContain("database recovery");
  });

  it("retry starts stopped agents and does not double-spawn starting agents", async () => {
    const stopped = createOrchestrator({ state: "stopped" });
    await stopped.orchestrator.retry();
    expect(stopped.agent.start).toHaveBeenCalledTimes(1);
    expect(stopped.agent.restart).not.toHaveBeenCalled();

    const starting = createOrchestrator({ state: "starting" });
    await starting.orchestrator.retry();
    expect(starting.agent.start).not.toHaveBeenCalled();
    expect(starting.agent.restart).not.toHaveBeenCalled();
  });

  it("opens diagnostics as a dynamic view on request", async () => {
    const { orchestrator, canvas } = createOrchestrator({ withViews: true });

    const result = await orchestrator.openDiagnosticsView();

    expect(result.sessionId).toBe("dynamic-view-launch");
    expect(canvas.windows[0].title).toBe("Launch Diagnostics");
    expect(canvas.pushes[0].payload).toMatchObject({
      type: "dynamic-view.session.opened",
      viewId: "launch.diagnostics",
    });
  });

  it("creates a structured bug report bundle", async () => {
    const { orchestrator, createBugReportBundle } = createOrchestrator();

    const bundle = await orchestrator.createBugReport();

    expect(bundle.directory).toBe("/tmp/report");
    expect(createBugReportBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        prefix: "launch-diagnostics",
      }),
    );
  });
});

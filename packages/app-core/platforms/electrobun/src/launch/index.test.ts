/** Exercises launch barrel behavior with deterministic app-core test fixtures. */
import type { JsonValue } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createDatabaseSnapshot, type DatabaseSnapshot } from "../database";
import { DynamicViewRegistry } from "../dynamic-views/registry";
import { DynamicViewSessionManager } from "../dynamic-views/session-manager";
import type {
  AuthStatusSnapshot,
  BootProgressSnapshot,
  EmbeddedAgentStatus,
  FirstRunStatusSnapshot,
} from "../rpc-schema";
import {
  createLaunchDiagnosticsViewManifest,
  LAUNCH_DIAGNOSTICS_VIEW_ID,
  LaunchOrchestrator,
  LaunchStore,
} from "./index";
import type { LaunchBugReportBundleInfo, LaunchSnapshot } from "./types";

const FIXED_ISO = "2026-05-17T00:00:00.000Z";
const FIXED_NOW = () => new Date(FIXED_ISO);

type AgentState = EmbeddedAgentStatus["state"];

function snapshot(phase: LaunchSnapshot["phase"]): LaunchSnapshot {
  return {
    phase,
    agent: {
      state: "running",
      port: 4242,
      apiBase: "http://127.0.0.1:4242",
      startedAt: 1000,
      error: null,
    },
    boot: {
      runtimePhase: "running",
      pluginsLoaded: 3,
      pluginsFailed: 0,
      database: "ok",
    },
    database: createDatabaseSnapshot({
      mode: "pglite-persistent",
      status: "ready",
      postgresUrlSet: false,
      pgliteDataDir: "/tmp/pglite",
      effectiveTarget: "/tmp/pglite",
      updatedAt: FIXED_ISO,
    }),
    auth: {
      checked: true,
      required: false,
      pairingEnabled: false,
      error: null,
    },
    firstRun: {
      checked: true,
      complete: true,
      requiredGate: null,
      error: null,
    },
    localModel: {
      backgroundDownloadQueued: false,
      blocking: false,
      error: null,
    },
    diagnostics: {
      logPath: "/tmp/launch.log",
      statusPath: "/tmp/launch-status.json",
      logTail: "",
    },
    recovery: {
      canRetry: true,
      canOpenLogs: true,
      canCreateBugReport: true,
    },
    updatedAt: FIXED_ISO,
  };
}

describe("LaunchStore via the launch barrel", () => {
  it("builds a deterministic empty state on the injected clock", () => {
    const store = new LaunchStore({ now: FIXED_NOW });

    expect(store.getSnapshot()).toEqual({
      phase: "static-shell",
      agent: {
        state: "not_started",
        port: null,
        apiBase: null,
        startedAt: null,
        error: null,
      },
      boot: {
        runtimePhase: null,
        pluginsLoaded: null,
        pluginsFailed: null,
        database: null,
      },
      database: {
        mode: "unknown",
        status: "unconfigured",
        postgresUrlSet: false,
        databaseUrlMapped: false,
        pgliteDataDir: null,
        effectiveTarget: null,
        error: null,
        warnings: [],
        recoveryActions: ["retry", "open-logs", "switch-to-postgres"],
        updatedAt: FIXED_ISO,
      },
      auth: { checked: false, required: null },
      firstRun: { checked: false, complete: null, requiredGate: null },
      localModel: { backgroundDownloadQueued: false, blocking: false },
      diagnostics: { logPath: "", statusPath: "" },
      recovery: {
        canRetry: false,
        canOpenLogs: false,
        canCreateBugReport: false,
      },
      updatedAt: FIXED_ISO,
    });
  });

  it("hands out defensive clones and never adopts caller mutations", () => {
    const store = new LaunchStore({ now: FIXED_NOW });

    const view = store.getSnapshot();
    view.phase = "ready";
    view.agent.port = 9999;

    expect(store.getSnapshot().phase).toBe("static-shell");
    expect(store.getSnapshot().agent.port).toBeNull();

    const installed = snapshot("agent-api-waiting");
    store.update(installed);
    installed.phase = "ready";

    expect(store.getSnapshot().phase).toBe("agent-api-waiting");
  });

  it("installs a supplied initial snapshot verbatim", () => {
    const initial = snapshot("pairing-required");
    const store = new LaunchStore({ initialSnapshot: initial, now: FIXED_NOW });

    expect(store.getSnapshot()).toEqual(initial);
  });

  it("records explicit update events without inventing phase-change noise", () => {
    const store = new LaunchStore({ now: FIXED_NOW });

    store.update(snapshot("static-shell"), {
      name: "custom.note",
      payload: { note: "hello" },
    });
    store.update(snapshot("static-shell"));

    expect(store.tailEvents().events.map((event) => event.name)).toEqual([
      "custom.note",
    ]);

    store.update(snapshot("ready"));
    const tail = store.tailEvents();
    expect(tail.events.map((event) => event.name)).toEqual([
      "custom.note",
      "launch.phase.changed",
    ]);
    expect(tail.events[1].payload).toEqual({
      previousPhase: "static-shell",
      phase: "ready",
    });
  });

  it("sequences events monotonically and clones payloads defensively", () => {
    const store = new LaunchStore({ now: FIXED_NOW });
    const payload = { v: 1 };

    const first = store.recordEvent("one", "static-shell", payload);
    payload.v = 999;
    const second = store.recordEvent("two");

    first.sequence = 42;

    expect(second.sequence).toBe(2);
    expect(second.phase).toBe("static-shell");
    expect(second.payload).toBeUndefined();

    const tail = store.tailEvents();
    expect(tail.events[0].sequence).toBe(1);
    expect(tail.events[0].payload).toEqual({ v: 1 });
  });

  it("retains only the newest events within maxEvents", () => {
    const store = new LaunchStore({ maxEvents: 1, now: FIXED_NOW });

    store.recordEvent("old", "static-shell");
    store.recordEvent("new", "static-shell");

    const tail = store.tailEvents();
    expect(tail.events.map((event) => event.name)).toEqual(["new"]);
    expect(tail.nextSequence).toBe(2);
  });

  it("clamps tail limits and filters strictly above afterSequence", () => {
    const store = new LaunchStore({ now: FIXED_NOW });
    for (const name of ["a", "b", "c"]) {
      store.recordEvent(name, "static-shell");
    }

    expect(store.tailEvents(0, 0).events.map((event) => event.name)).toEqual([
      "c",
    ]);
    expect(store.tailEvents(2).events.map((event) => event.name)).toEqual([
      "c",
    ]);
    expect(store.tailEvents(3).events).toEqual([]);
    expect(store.tailEvents().events.map((event) => event.name)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(store.tailEvents(undefined, 2).events.length).toBe(2);
  });

  it("reset reinstalls a supplied snapshot and restarts sequences at one", () => {
    const store = new LaunchStore({ now: FIXED_NOW });
    store.update(snapshot("ready"));
    store.recordEvent("noise", "ready");

    store.reset(snapshot("agent-process-starting"));

    expect(store.getSnapshot().phase).toBe("agent-process-starting");
    expect(store.tailEvents()).toEqual({ events: [], nextSequence: 0 });
    expect(store.recordEvent("fresh").sequence).toBe(1);
  });

  it("reset without input rebuilds the empty state on the injected clock", () => {
    const store = new LaunchStore({ now: FIXED_NOW });
    store.update(snapshot("ready"));
    store.recordEvent("noise", "ready");

    store.reset();

    expect(store.getSnapshot().phase).toBe("static-shell");
    expect(store.getSnapshot().updatedAt).toBe(FIXED_ISO);
    expect(store.tailEvents()).toEqual({ events: [], nextSequence: 0 });
  });
});

function okAuth(): AuthStatusSnapshot {
  return { required: false, pairingEnabled: false, expiresAt: null };
}

function bootProgress(phase: string | null): BootProgressSnapshot {
  return {
    state: "running",
    phase,
    lastError: null,
    pluginsLoaded: 12,
    pluginsFailed: 0,
    database: "ok",
    agentName: "Eliza",
    port: 31337,
    startedAt: 1000,
    updatedAt: FIXED_ISO,
  };
}

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

function createOrchestrator(options?: {
  agentState?: AgentState;
  agentPort?: number | null;
  agentError?: string | null;
  bootPhase?: string | null;
  bootRejection?: unknown;
  auth?: AuthStatusSnapshot | null;
  authRejection?: unknown;
  firstRun?: FirstRunStatusSnapshot | null;
  firstRunRejection?: unknown;
  databaseStatus?: DatabaseSnapshot["status"];
  diagnosticsLastError?: string | null;
  diagnosticsPhase?: string | null;
  views?: "full" | "registry-only" | "none";
  store?: LaunchStore;
}) {
  const views = options?.views ?? "full";
  const agentState = options?.agentState ?? "running";
  const agentPort =
    options?.agentPort !== undefined ? options.agentPort : 31337;

  const agent = {
    getStatus: vi.fn(() => ({
      state: agentState,
      agentName: "Eliza",
      port: agentPort,
      startedAt: agentState === "running" ? 1000 : null,
      error: options?.agentError ?? null,
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

  const seenReaderPorts: number[] = [];
  const readAuthStatus = vi.fn(async (port: number) => {
    seenReaderPorts.push(port);
    if (options?.authRejection !== undefined) throw options.authRejection;
    return options?.auth === undefined ? okAuth() : options.auth;
  });
  const readFirstRunStatus = vi.fn(async (port: number) => {
    seenReaderPorts.push(port);
    if (options?.firstRunRejection !== undefined) {
      throw options.firstRunRejection;
    }
    return options?.firstRun === undefined
      ? { complete: true }
      : options.firstRun;
  });

  const registry = new DynamicViewRegistry();
  const canvas = new FakeCanvas();
  const sessions = new DynamicViewSessionManager({
    registry,
    canvas,
    sessionIdFactory: () => "session-seed",
  });

  const bundle: LaunchBugReportBundleInfo = {
    directory: "/tmp/launch-report",
    reportMarkdownPath: "/tmp/launch-report/report.md",
    reportJsonPath: "/tmp/launch-report/report.json",
    startupLogPath: null,
    startupStatusPath: null,
  };
  const createBugReportBundle = vi.fn(
    (_input: {
      reportMarkdown: string;
      reportJson: Record<string, JsonValue>;
      prefix?: string;
    }) => bundle,
  );

  const viewHosts =
    views === "none"
      ? {}
      : views === "registry-only"
        ? { dynamicViewRegistry: registry }
        : { dynamicViewRegistry: registry, dynamicViewSessions: sessions };

  const orchestrator = new LaunchOrchestrator({
    agent,
    readBootProgress: async () => {
      if (options?.bootRejection !== undefined) throw options.bootRejection;
      return bootProgress(options?.bootPhase ?? "running");
    },
    readAuthStatus,
    readFirstRunStatus,
    readDiagnostics: () => ({
      state: agentState,
      phase: options?.diagnosticsPhase ?? "running",
      updatedAt: FIXED_ISO,
      lastError: options?.diagnosticsLastError ?? null,
      agentName: "Eliza",
      port: agentPort,
      startedAt: agentState === "running" ? 1000 : null,
      logPath: "/tmp/startup.log",
      statusPath: "/tmp/startup-status.json",
    }),
    readDatabaseStatus: () =>
      createDatabaseSnapshot({
        mode: "pglite-persistent",
        status: options?.databaseStatus ?? "ready",
        postgresUrlSet: false,
        pgliteDataDir: "/tmp/pglite",
        effectiveTarget: "/tmp/pglite",
      }),
    readDiagnosticLogTail: () => "tail-lines",
    createBugReportBundle,
    ...viewHosts,
    store: options?.store,
    now: FIXED_NOW,
  });

  return {
    orchestrator,
    agent,
    readAuthStatus,
    readFirstRunStatus,
    seenReaderPorts,
    registry,
    canvas,
    createBugReportBundle,
    bundle,
  };
}

describe("LaunchOrchestrator phase classification via the launch barrel", () => {
  it("maps inactive agent states to static-shell or error phases", async () => {
    const errorState = await createOrchestrator({
      agentState: "error",
    }).orchestrator.getProgress();
    const notStarted = await createOrchestrator({
      agentState: "not_started",
    }).orchestrator.getProgress();
    const stopped = await createOrchestrator({
      agentState: "stopped",
    }).orchestrator.getProgress();

    expect(errorState.phase).toBe("error");
    expect(notStarted.phase).toBe("static-shell");
    expect(stopped.phase).toBe("static-shell");
  });

  it("separates process starting from API waiting by port presence", async () => {
    const processStarting = await createOrchestrator({
      agentState: "starting",
      agentPort: null,
    }).orchestrator.getProgress();
    const apiWaiting = await createOrchestrator({
      agentState: "starting",
      agentPort: 4001,
    }).orchestrator.getProgress();

    expect(processStarting.phase).toBe("agent-process-starting");
    expect(processStarting.agent.apiBase).toBeNull();
    expect(processStarting.recovery.canRetry).toBe(false);

    expect(apiWaiting.phase).toBe("agent-api-waiting");
    expect(apiWaiting.agent.apiBase).toBe("http://127.0.0.1:4001");
  });

  it("reports agent-api-ready while boot is still progressing", async () => {
    const progress = await createOrchestrator({
      bootPhase: "loading_plugins",
    }).orchestrator.getProgress();

    expect(progress.phase).toBe("agent-api-ready");
    expect(progress.boot.runtimePhase).toBe("loading_plugins");
    expect(progress.boot.pluginsLoaded).toBe(12);
    expect(progress.boot.pluginsFailed).toBe(0);
  });

  it("holds auth-checking while the auth endpoint returns nothing", async () => {
    const progress = await createOrchestrator({
      auth: null,
    }).orchestrator.getProgress();

    expect(progress.phase).toBe("auth-checking");
    expect(progress.auth.checked).toBe(false);
    expect(progress.auth.required).toBeNull();
    expect(progress.firstRun.requiredGate).toBeNull();
  });

  it("escalates to cloud bootstrap when auth reports bootstrapRequired", async () => {
    const progress = await createOrchestrator({
      auth: {
        required: false,
        pairingEnabled: false,
        expiresAt: null,
        bootstrapRequired: true,
      },
    }).orchestrator.getProgress();

    expect(progress.phase).toBe("cloud-bootstrap-required");
    expect(progress.firstRun.requiredGate).toBe("bootstrap");
  });

  it("holds first-run checking while that endpoint returns nothing", async () => {
    const progress = await createOrchestrator({
      firstRun: null,
    }).orchestrator.getProgress();

    expect(progress.phase).toBe("first-run-checking");
    expect(progress.firstRun.checked).toBe(false);
    expect(progress.firstRun.complete).toBeNull();
  });

  it("prefers pairing over bootstrap over first-run gates", async () => {
    const pairingWins = await createOrchestrator({
      auth: {
        required: true,
        pairingEnabled: true,
        expiresAt: null,
        bootstrapRequired: true,
      },
      firstRun: { complete: false, cloudProvisioned: true },
    }).orchestrator.getProgress();
    const bootstrapWins = await createOrchestrator({
      auth: {
        required: false,
        pairingEnabled: false,
        expiresAt: null,
        bootstrapRequired: true,
      },
      firstRun: { complete: false, cloudProvisioned: true },
    }).orchestrator.getProgress();
    const cloudFirstRun = await createOrchestrator({
      firstRun: { complete: false, cloudProvisioned: true },
    }).orchestrator.getProgress();
    const localFirstRun = await createOrchestrator({
      firstRun: { complete: false },
    }).orchestrator.getProgress();

    expect(pairingWins.phase).toBe("pairing-required");
    expect(pairingWins.firstRun.requiredGate).toBe("pairing");
    expect(bootstrapWins.phase).toBe("cloud-bootstrap-required");
    expect(bootstrapWins.firstRun.requiredGate).toBe("bootstrap");
    expect(cloudFirstRun.phase).toBe("cloud-bootstrap-required");
    expect(cloudFirstRun.firstRun.requiredGate).toBe("bootstrap");
    expect(localFirstRun.phase).toBe("runtime-gate-required");
    expect(localFirstRun.firstRun.requiredGate).toBe("runtime");
  });

  it("does not consult gate readers until the agent exposes a port", async () => {
    const harness = createOrchestrator({ agentPort: null });
    const progress = await harness.orchestrator.getProgress();

    expect(harness.readAuthStatus).not.toHaveBeenCalled();
    expect(harness.readFirstRunStatus).not.toHaveBeenCalled();
    expect(harness.seenReaderPorts).toEqual([]);
    expect(progress.agent.apiBase).toBeNull();
    expect(progress.phase).toBe("auth-checking");
  });

  it("passes port zero through to readers and the api base", async () => {
    const harness = createOrchestrator({ agentPort: 0 });
    const progress = await harness.orchestrator.getProgress();

    expect(harness.seenReaderPorts).toEqual([0, 0]);
    expect(progress.agent.apiBase).toBe("http://127.0.0.1:0");
    expect(progress.phase).toBe("ready");
  });

  it("survives boot reader failure by falling back to diagnostics", async () => {
    const harness = createOrchestrator({
      bootRejection: new Error("boot read failed"),
      diagnosticsPhase: "diagnostic-phase",
    });
    const progress = await harness.orchestrator.getProgress();

    expect(progress.boot.runtimePhase).toBe("diagnostic-phase");
    expect(progress.boot.pluginsLoaded).toBeNull();
    expect(progress.boot.database).toBeNull();
    expect(progress.phase).toBe("ready");
  });

  it("stringifies non-Error reader failures without faking a check", async () => {
    const progress = await createOrchestrator({
      authRejection: "socket hang up",
      firstRunRejection: new Error("first-run boom"),
    }).orchestrator.getProgress();

    expect(progress.auth.checked).toBe(false);
    expect(progress.auth.error).toBe("socket hang up");
    expect(progress.firstRun.checked).toBe(false);
    expect(progress.firstRun.error).toBe("first-run boom");
    expect(progress.firstRun.requiredGate).toBeNull();
    expect(progress.phase).toBe("ready");
  });

  it("prefers the live agent error over the diagnostics lastError", async () => {
    const liveWins = await createOrchestrator({
      agentState: "error",
      agentError: "agent crashed",
      diagnosticsLastError: "stale diagnostic failure",
    }).orchestrator.getProgress();
    const diagnosticFallback = await createOrchestrator({
      diagnosticsLastError: "diagnostic failure",
    }).orchestrator.getProgress();

    expect(liveWins.agent.error).toBe("agent crashed");
    expect(diagnosticFallback.agent.error).toBe("diagnostic failure");
    expect(diagnosticFallback.phase).toBe("ready");
  });

  it("blocks launch with recovery guidance on every blocking database status", async () => {
    for (const status of [
      "migration-failed",
      "corrupt",
      "permission-error",
      "path-error",
      "locked",
    ] as const) {
      const progress = await createOrchestrator({
        databaseStatus: status,
        firstRun: { complete: false },
      }).orchestrator.getProgress();

      expect(progress.phase).toBe("error");
      expect(progress.recovery.suggestedAction).toBe(
        "Open launch diagnostics and use database recovery.",
      );
    }
  });

  it("suggests the matching action for each gate phase", async () => {
    const pairing = await createOrchestrator({
      auth: { required: true, pairingEnabled: true, expiresAt: null },
    }).orchestrator.getProgress();
    const runtimeGate = await createOrchestrator({
      firstRun: { complete: false },
    }).orchestrator.getProgress();
    const cloudBootstrap = await createOrchestrator({
      firstRun: { complete: false, cloudProvisioned: true },
    }).orchestrator.getProgress();
    const failed = await createOrchestrator({
      agentState: "error",
    }).orchestrator.getProgress();

    expect(pairing.recovery.suggestedAction).toBe(
      "Complete pairing in the startup gate.",
    );
    expect(runtimeGate.recovery.suggestedAction).toBe(
      "Choose Cloud, Local, or Remote in first-run runtime setup.",
    );
    expect(cloudBootstrap.recovery.suggestedAction).toBe(
      "Complete cloud bootstrap before entering chat.",
    );
    expect(failed.recovery.suggestedAction).toBe(
      "Open launch diagnostics or retry startup.",
    );
  });
});

describe("LaunchOrchestrator commands via the launch barrel", () => {
  it("forwards tail windows to its injected store", () => {
    const store = new LaunchStore({ now: FIXED_NOW });
    store.recordEvent("one", "static-shell");
    store.recordEvent("two", "static-shell");
    const { orchestrator } = createOrchestrator({ store });

    const windowed = orchestrator.tailEvents({ afterSequence: 1, limit: 1 });
    expect(windowed.events.map((event) => event.name)).toEqual(["two"]);
    expect(windowed.nextSequence).toBe(2);

    expect(
      orchestrator.tailEvents({ limit: 1 }).events.map((event) => event.name),
    ).toEqual(["two"]);
  });

  it("requests then starts agents that never ran", async () => {
    const harness = createOrchestrator({ agentState: "not_started" });

    const progress = await harness.orchestrator.retry();

    expect(harness.agent.start).toHaveBeenCalledTimes(1);
    expect(harness.agent.restart).not.toHaveBeenCalled();
    const tail = harness.orchestrator.tailEvents();
    expect(tail.events[0]).toMatchObject({
      name: "launch.retry.requested",
      phase: "static-shell",
      payload: { state: "not_started" },
    });
    expect(progress.phase).toBe("static-shell");
  });

  it("restarts live or failed agents instead of spawning anew", async () => {
    const running = createOrchestrator({ agentState: "running" });
    await running.orchestrator.retry();
    expect(running.agent.restart).toHaveBeenCalledTimes(1);
    expect(running.agent.start).not.toHaveBeenCalled();

    const errored = createOrchestrator({ agentState: "error" });
    await errored.orchestrator.retry();
    expect(errored.agent.restart).toHaveBeenCalledTimes(1);
    expect(errored.agent.start).not.toHaveBeenCalled();
  });

  it("rejects opening diagnostics when either host dependency is absent", async () => {
    const withoutViews = createOrchestrator({ views: "none" });
    await expect(
      withoutViews.orchestrator.openDiagnosticsView(),
    ).rejects.toThrow("Launch diagnostics dynamic view host is unavailable.");

    const registryOnly = createOrchestrator({ views: "registry-only" });
    await expect(
      registryOnly.orchestrator.openDiagnosticsView(),
    ).rejects.toThrow("Launch diagnostics dynamic view host is unavailable.");
  });

  it("registers the barrel manifest with update access and opens sessions", async () => {
    const harness = createOrchestrator();
    await harness.orchestrator.retry();

    const opened = await harness.orchestrator.openDiagnosticsView();

    expect(opened.sessionId).toBe("dynamic-view-session-seed");
    expect(harness.registry.get(LAUNCH_DIAGNOSTICS_VIEW_ID)).toEqual(
      createLaunchDiagnosticsViewManifest(),
    );

    await expect(harness.orchestrator.openDiagnosticsView()).resolves.toEqual({
      sessionId: "dynamic-view-session-seed",
    });

    const push = harness.canvas.pushes[0];
    expect(push.id).toBe("window-1");
    expect(push.payload).toMatchObject({
      type: "dynamic-view.session.opened",
      viewId: LAUNCH_DIAGNOSTICS_VIEW_ID,
      initialState: {
        snapshot: { phase: "ready" },
        events: [
          {
            sequence: 1,
            name: "launch.retry.requested",
            phase: "static-shell",
            payload: { state: "running" },
          },
          {
            sequence: 2,
            name: "launch.phase.changed",
            phase: "ready",
            payload: { previousPhase: "static-shell", phase: "ready" },
          },
        ],
      },
      metadata: { launch: true },
    });

    const events = harness.orchestrator.tailEvents().events;
    expect(events.at(-1)).toMatchObject({
      name: "launch.diagnostics.opened",
      payload: { sessionId: "dynamic-view-session-seed" },
    });
  });

  it("builds bug reports synchronously with summary, json, and history", async () => {
    const harness = createOrchestrator();
    await harness.orchestrator.retry();

    const result = await harness.orchestrator.createBugReport();

    expect(result).toEqual(harness.bundle);
    expect(harness.createBugReportBundle).toHaveBeenCalledTimes(1);
    const call = harness.createBugReportBundle.mock.calls[0][0];
    expect(call.prefix).toBe("launch-diagnostics");
    expect(call.reportMarkdown).toBe(
      [
        "# Launch Diagnostics",
        "",
        "Phase: ready",
        "Agent state: running",
        "Runtime phase: running",
        "Database: pglite-persistent / ready",
        "Suggested action: none",
        "",
      ].join("\n"),
    );
    expect(call.reportJson.kind).toBe("launch-diagnostics");
    expect(call.reportJson.snapshot).toMatchObject({ phase: "ready" });
    const reportedEvents = call.reportJson.events;
    expect(Array.isArray(reportedEvents)).toBe(true);
    expect(
      (reportedEvents as Array<{ name: string }>).map((event) => event.name),
    ).toEqual(["launch.retry.requested", "launch.phase.changed"]);
    expect(harness.orchestrator.tailEvents().events.at(-1)).toMatchObject({
      name: "launch.bug_report.created",
      payload: { directory: harness.bundle.directory },
    });
  });
});

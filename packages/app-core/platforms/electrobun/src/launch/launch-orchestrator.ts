import type { JsonValue } from "@elizaos/plugin-remote-manifest";
import {
  createUnknownDatabaseSnapshot,
  type DatabaseSnapshot,
} from "../database";
import type { DynamicViewRegistry } from "../dynamic-views/registry";
import type { DynamicViewSessionManager } from "../dynamic-views/session-manager";
import type {
  AuthStatusSnapshot,
  BootProgressSnapshot,
  EmbeddedAgentStatus,
  OnboardingStatusSnapshot,
} from "../rpc-schema";
import {
  createLaunchDiagnosticsViewManifest,
  LAUNCH_DIAGNOSTICS_VIEW_ID,
} from "./launch-dynamic-view";
import { LaunchStore } from "./launch-store";
import type {
  LaunchBugReportBundleInfo,
  LaunchEventsTailParams,
  LaunchEventsTailResult,
  LaunchPhase,
  LaunchSnapshot,
} from "./types";

export interface LaunchDiagnosticsSnapshot {
  state: EmbeddedAgentStatus["state"];
  phase: string;
  updatedAt: string;
  lastError: string | null;
  agentName: string | null;
  port: number | null;
  startedAt: number | null;
  logPath: string;
  statusPath: string;
}

interface SatelliteStatus {
  id: string;
  state: string;
  error: string | null;
  required: boolean;
}

interface LaunchAgentAdapter {
  getStatus(): EmbeddedAgentStatus;
  start(): Promise<EmbeddedAgentStatus>;
  restart(): Promise<EmbeddedAgentStatus>;
}

export interface LaunchOrchestratorOptions {
  agent: LaunchAgentAdapter;
  readBootProgress: () => Promise<BootProgressSnapshot>;
  readAuthStatus: (port: number) => Promise<AuthStatusSnapshot | null>;
  readOnboardingStatus: (
    port: number,
  ) => Promise<OnboardingStatusSnapshot | null>;
  readDiagnostics: () => LaunchDiagnosticsSnapshot;
  readDatabaseStatus?: () => DatabaseSnapshot;
  readDiagnosticLogTail: (maxChars?: number) => string;
  listSatelliteStatuses: () => SatelliteStatus[];
  createBugReportBundle: (options: {
    reportMarkdown: string;
    reportJson: Record<string, JsonValue>;
    prefix?: string;
  }) => Promise<LaunchBugReportBundleInfo> | LaunchBugReportBundleInfo;
  dynamicViewRegistry?: DynamicViewRegistry;
  dynamicViewSessions?: DynamicViewSessionManager;
  store?: LaunchStore;
  now?: () => Date;
}

function apiBase(port: number | null): string | null {
  return port === null ? null : `http://127.0.0.1:${port}`;
}

function requiredGate(
  auth: AuthStatusSnapshot | null,
  onboarding: OnboardingStatusSnapshot | null,
): "runtime" | "bootstrap" | "pairing" | null {
  if (auth?.required === true && auth.pairingEnabled === true) return "pairing";
  if (auth?.bootstrapRequired === true) return "bootstrap";
  if (onboarding?.complete === false) {
    return onboarding.cloudProvisioned === true ? "bootstrap" : "runtime";
  }
  return null;
}

function classifyAgentPhase(agent: EmbeddedAgentStatus): LaunchPhase | null {
  if (agent.state === "error") return "error";
  if (agent.state === "not_started" || agent.state === "stopped") {
    return "static-shell";
  }
  if (agent.state !== "starting") return null;
  return agent.port === null ? "agent-process-starting" : "agent-api-waiting";
}

function classifyAuthPhase(params: {
  auth: AuthStatusSnapshot | null;
  authError: string | null;
}): LaunchPhase | null {
  if (params.auth === null && params.authError === null) return "auth-checking";
  if (params.auth?.required === true && params.auth.pairingEnabled === true) {
    return "pairing-required";
  }
  if (params.auth?.bootstrapRequired === true) {
    return "cloud-bootstrap-required";
  }
  return null;
}

function classifyOnboardingPhase(params: {
  onboarding: OnboardingStatusSnapshot | null;
  onboardingError: string | null;
}): LaunchPhase | null {
  if (params.onboarding === null && params.onboardingError === null) {
    return "onboarding-checking";
  }
  if (params.onboarding?.complete !== false) return null;
  return params.onboarding.cloudProvisioned === true
    ? "cloud-bootstrap-required"
    : "runtime-gate-required";
}

function classifyPhase(params: {
  agent: EmbeddedAgentStatus;
  boot: BootProgressSnapshot | null;
  auth: AuthStatusSnapshot | null;
  authError: string | null;
  onboarding: OnboardingStatusSnapshot | null;
  onboardingError: string | null;
}): LaunchPhase {
  const agentPhase = classifyAgentPhase(params.agent);
  if (agentPhase !== null) return agentPhase;
  if (params.boot?.phase && params.boot.phase !== "running") {
    return "agent-api-ready";
  }
  const authPhase = classifyAuthPhase(params);
  if (authPhase !== null) return authPhase;
  const onboardingPhase = classifyOnboardingPhase(params);
  if (onboardingPhase !== null) return onboardingPhase;
  return "ready";
}

function databaseBlocksLaunch(database: DatabaseSnapshot): boolean {
  return (
    database.status === "migration-failed" ||
    database.status === "corrupt" ||
    database.status === "permission-error" ||
    database.status === "path-error" ||
    database.status === "locked"
  );
}

function satelliteSnapshot(
  statuses: SatelliteStatus[],
): LaunchSnapshot["satellites"] {
  const required = statuses.filter((status) => status.required);
  return {
    seeded: statuses.length > 0,
    requiredStarted:
      required.length === 0 ||
      required.every((status) => status.state === "running"),
    errors: statuses
      .filter((status) => status.error)
      .map((status) => ({
        id: status.id,
        error: status.error ?? "Satellite failed.",
      })),
  };
}

function suggestedAction(snapshot: LaunchSnapshot): string | undefined {
  if (
    snapshot.database.status === "migration-failed" ||
    snapshot.database.status === "corrupt" ||
    snapshot.database.status === "permission-error" ||
    snapshot.database.status === "path-error" ||
    snapshot.database.status === "locked"
  ) {
    return "Open launch diagnostics and use database recovery.";
  }
  if (snapshot.phase === "error")
    return "Open launch diagnostics or retry startup.";
  if (snapshot.phase === "pairing-required")
    return "Complete pairing in the startup gate.";
  if (snapshot.phase === "runtime-gate-required")
    return "Choose Cloud, Local, or Remote in RuntimeGate.";
  if (snapshot.phase === "cloud-bootstrap-required")
    return "Complete cloud bootstrap before entering chat.";
  if (!snapshot.satellites.requiredStarted) {
    return "Runtime can continue while Satellite readiness is inspected.";
  }
  return undefined;
}

function databaseSnapshotJson(
  database: DatabaseSnapshot,
): Record<string, JsonValue> {
  return {
    mode: database.mode,
    status: database.status,
    postgresUrlSet: database.postgresUrlSet,
    databaseUrlMapped: database.databaseUrlMapped,
    pgliteDataDir: database.pgliteDataDir,
    effectiveTarget: database.effectiveTarget,
    migrationStatus: database.migrationStatus
      ? {
          running: database.migrationStatus.running,
          completed: database.migrationStatus.completed,
          failed: database.migrationStatus.failed,
          failedPlugin: database.migrationStatus.failedPlugin ?? null,
          error: database.migrationStatus.error ?? null,
        }
      : null,
    lock: database.lock
      ? {
          held: database.lock.held,
          stale: database.lock.stale ?? null,
          ownerPid: database.lock.ownerPid ?? null,
        }
      : null,
    error: database.error ?? null,
    warnings: database.warnings,
    recoveryActions: database.recoveryActions,
    updatedAt: database.updatedAt,
  };
}

function snapshotJson(snapshot: LaunchSnapshot): Record<string, JsonValue> {
  return {
    phase: snapshot.phase,
    agent: snapshot.agent,
    boot: snapshot.boot,
    database: databaseSnapshotJson(snapshot.database),
    auth: snapshot.auth,
    onboarding: snapshot.onboarding,
    satellites: snapshot.satellites,
    localModel: snapshot.localModel,
    diagnostics: snapshot.diagnostics,
    recovery: snapshot.recovery,
    updatedAt: snapshot.updatedAt,
  };
}

export class LaunchOrchestrator {
  private readonly agent: LaunchAgentAdapter;
  private readonly readBootProgress: () => Promise<BootProgressSnapshot>;
  private readonly readAuthStatus: (
    port: number,
  ) => Promise<AuthStatusSnapshot | null>;
  private readonly readOnboardingStatus: (
    port: number,
  ) => Promise<OnboardingStatusSnapshot | null>;
  private readonly readDiagnostics: () => LaunchDiagnosticsSnapshot;
  private readonly readDatabaseStatus: () => DatabaseSnapshot;
  private readonly readDiagnosticLogTail: (maxChars?: number) => string;
  private readonly listSatelliteStatuses: () => SatelliteStatus[];
  private readonly createBugReportBundle: LaunchOrchestratorOptions["createBugReportBundle"];
  private readonly dynamicViewRegistry: DynamicViewRegistry | null;
  private readonly dynamicViewSessions: DynamicViewSessionManager | null;
  private readonly store: LaunchStore;
  private readonly now: () => Date;

  constructor(options: LaunchOrchestratorOptions) {
    this.agent = options.agent;
    this.readBootProgress = options.readBootProgress;
    this.readAuthStatus = options.readAuthStatus;
    this.readOnboardingStatus = options.readOnboardingStatus;
    this.readDiagnostics = options.readDiagnostics;
    this.readDatabaseStatus =
      options.readDatabaseStatus ?? (() => createUnknownDatabaseSnapshot());
    this.readDiagnosticLogTail = options.readDiagnosticLogTail;
    this.listSatelliteStatuses = options.listSatelliteStatuses;
    this.createBugReportBundle = options.createBugReportBundle;
    this.dynamicViewRegistry = options.dynamicViewRegistry ?? null;
    this.dynamicViewSessions = options.dynamicViewSessions ?? null;
    this.store = options.store ?? new LaunchStore({ now: options.now });
    this.now = options.now ?? (() => new Date());
  }

  async getProgress(): Promise<LaunchSnapshot> {
    const agent = this.agent.getStatus();
    const diagnostics = this.readDiagnostics();
    const database = this.readDatabaseStatus();
    let boot: BootProgressSnapshot | null = null;
    let auth: AuthStatusSnapshot | null = null;
    let authError: string | null = null;
    let onboarding: OnboardingStatusSnapshot | null = null;
    let onboardingError: string | null = null;

    try {
      boot = await this.readBootProgress();
    } catch {
      boot = null;
    }

    const port = agent.port;
    if (port !== null) {
      try {
        auth = await this.readAuthStatus(port);
      } catch (error) {
        authError = error instanceof Error ? error.message : String(error);
      }
      try {
        onboarding = await this.readOnboardingStatus(port);
      } catch (error) {
        onboardingError =
          error instanceof Error ? error.message : String(error);
      }
    }

    const satellites = satelliteSnapshot(this.listSatelliteStatuses());
    const phase = databaseBlocksLaunch(database)
      ? "error"
      : classifyPhase({
          agent,
          boot,
          auth,
          authError,
          onboarding,
          onboardingError,
        });
    const snapshot: LaunchSnapshot = {
      phase,
      agent: {
        state: agent.state,
        port,
        apiBase: apiBase(port),
        startedAt: agent.startedAt,
        error: agent.error ?? diagnostics.lastError ?? null,
      },
      boot: {
        runtimePhase: boot?.phase ?? diagnostics.phase ?? null,
        pluginsLoaded: boot?.pluginsLoaded ?? null,
        pluginsFailed: boot?.pluginsFailed ?? null,
        database: boot?.database ?? null,
      },
      database,
      auth: {
        checked: auth !== null,
        required: auth?.required ?? null,
        pairingEnabled: auth?.pairingEnabled,
        error: authError,
      },
      onboarding: {
        checked: onboarding !== null,
        complete: onboarding?.complete ?? null,
        cloudProvisioned: onboarding?.cloudProvisioned,
        requiredGate: requiredGate(auth, onboarding),
        error: onboardingError,
      },
      satellites,
      localModel: {
        backgroundDownloadQueued: false,
        blocking: false,
      },
      diagnostics: {
        logPath: diagnostics.logPath,
        statusPath: diagnostics.statusPath,
        logTail: this.readDiagnosticLogTail(),
      },
      recovery: {
        canRetry: agent.state !== "starting",
        canOpenLogs: Boolean(diagnostics.logPath),
        canCreateBugReport: true,
      },
      updatedAt: this.now().toISOString(),
    };
    snapshot.recovery.suggestedAction = suggestedAction(snapshot);
    return this.store.update(snapshot);
  }

  tailEvents(params?: LaunchEventsTailParams): LaunchEventsTailResult {
    return this.store.tailEvents(params?.afterSequence, params?.limit);
  }

  async retry(): Promise<LaunchSnapshot> {
    const status = this.agent.getStatus();
    this.store.recordEvent(
      "launch.retry.requested",
      this.store.getSnapshot().phase,
      {
        state: status.state,
      },
    );
    if (status.state === "starting") return this.getProgress();
    if (status.state === "not_started" || status.state === "stopped") {
      await this.agent.start();
    } else {
      await this.agent.restart();
    }
    return this.getProgress();
  }

  async openDiagnosticsView(): Promise<{ sessionId: string }> {
    if (!this.dynamicViewRegistry || !this.dynamicViewSessions) {
      throw new Error("Launch diagnostics dynamic view host is unavailable.");
    }
    this.dynamicViewRegistry.register(createLaunchDiagnosticsViewManifest(), {
      update: true,
    });
    const snapshot = await this.getProgress();
    const tail = this.tailEvents({ limit: 200 });
    const session = await this.dynamicViewSessions.open({
      viewId: LAUNCH_DIAGNOSTICS_VIEW_ID,
      title: "Launch Diagnostics",
      initialState: {
        snapshot: snapshotJson(snapshot),
        events: tail.events.map((event) => ({
          sequence: event.sequence,
          phase: event.phase,
          name: event.name,
          payload: event.payload ?? null,
          timestamp: event.timestamp,
        })),
      },
      metadata: {
        launch: true,
      },
    });
    this.store.recordEvent("launch.diagnostics.opened", snapshot.phase, {
      sessionId: session.sessionId,
    });
    return { sessionId: session.sessionId };
  }

  async createBugReport(): Promise<LaunchBugReportBundleInfo> {
    const snapshot = await this.getProgress();
    const reportMarkdown = [
      "# Launch Diagnostics",
      "",
      `Phase: ${snapshot.phase}`,
      `Agent state: ${snapshot.agent.state}`,
      `Runtime phase: ${snapshot.boot.runtimePhase ?? "unknown"}`,
      `Database: ${snapshot.database.mode} / ${snapshot.database.status}`,
      `Suggested action: ${snapshot.recovery.suggestedAction ?? "none"}`,
      "",
    ].join("\n");
    const result = await this.createBugReportBundle({
      reportMarkdown,
      reportJson: {
        kind: "launch-diagnostics",
        snapshot: snapshotJson(snapshot),
        events: this.tailEvents({ limit: 200 }).events.map((event) => ({
          sequence: event.sequence,
          phase: event.phase,
          name: event.name,
          payload: event.payload ?? null,
          timestamp: event.timestamp,
        })),
      },
      prefix: "launch-diagnostics",
    });
    this.store.recordEvent("launch.bug_report.created", snapshot.phase, {
      directory: result.directory,
    });
    return result;
  }
}

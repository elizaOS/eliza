/** Implements Electrobun desktop types ts behavior for app-core shell integration. */
import type { JsonValue } from "@elizaos/plugin-remote-manifest";
import type { DatabaseSnapshot } from "../database";

export type LaunchPhase =
  | "static-shell"
  | "agent-process-starting"
  | "agent-api-waiting"
  | "agent-api-ready"
  | "auth-checking"
  | "pairing-required"
  | "first-run-checking"
  | "runtime-gate-required"
  | "cloud-bootstrap-required"
  | "remote-seeding"
  | "model-background-queue"
  | "ready"
  | "error";

export type LaunchAgentState =
  | "not_started"
  | "starting"
  | "running"
  | "stopped"
  | "error";

export interface LaunchSnapshot {
  phase: LaunchPhase;
  agent: {
    state: LaunchAgentState;
    port: number | null;
    apiBase: string | null;
    startedAt: number | null;
    error: string | null;
  };
  boot: {
    runtimePhase: string | null;
    pluginsLoaded: number | null;
    pluginsFailed: number | null;
    database: "ok" | "unknown" | "error" | null;
  };
  database: DatabaseSnapshot;
  auth: {
    checked: boolean;
    required: boolean | null;
    pairingEnabled?: boolean;
    error?: string | null;
  };
  firstRun: {
    checked: boolean;
    complete: boolean | null;
    cloudProvisioned?: boolean;
    requiredGate?: "runtime" | "bootstrap" | "pairing" | null;
    error?: string | null;
  };
  remotes: {
    seeded: boolean;
    requiredStarted: boolean;
    errors: Array<{ id: string; error: string }>;
  };
  localModel: {
    backgroundDownloadQueued: boolean;
    blocking: false;
    error?: string | null;
  };
  diagnostics: {
    logPath: string;
    statusPath: string;
    logTail?: string;
  };
  recovery: {
    canRetry: boolean;
    canOpenLogs: boolean;
    canCreateBugReport: boolean;
    suggestedAction?: string;
  };
  updatedAt: string;
}

export interface LaunchEvent {
  sequence: number;
  phase: LaunchPhase;
  name: string;
  payload?: JsonValue;
  timestamp: string;
}

export interface LaunchEventsTailParams {
  afterSequence?: number;
  limit?: number;
}

export interface LaunchEventsTailResult {
  events: LaunchEvent[];
  nextSequence: number;
}

export interface LaunchBugReportBundleInfo {
  directory: string;
  reportMarkdownPath: string;
  reportJsonPath: string;
  startupLogPath: string | null;
  startupStatusPath: string | null;
}

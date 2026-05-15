import * as fs from "node:fs";
import path from "node:path";
import type {
  AppRunAwaySummary,
  AppRunCapabilityAvailability,
  AppRunEvent,
  AppRunHealth,
  AppRunHealthDetails,
  AppRunHealthFacet,
  AppRunHealthState,
  AppRunSummary,
  AppSessionJsonValue,
  AppSessionState,
  AppViewerConfig,
} from "@elizaos/shared";
import { resolveStateDir } from "../config/paths.ts";
import { writeJsonAtomicSync } from "../utils/atomic-json.ts";

const APP_RUN_STORE_VERSION = 2;
const MAX_RECORDED_RUN_EVENTS = 20;

interface AppRunStoreFile {
  version: number;
  updatedAt: string;
  runs: AppRunSummary[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function _defaultStoreFile(): AppRunStoreFile {
  return {
    version: APP_RUN_STORE_VERSION,
    updatedAt: nowIso(),
    runs: [],
  };
}

function normalizeAvailability(value: unknown): AppRunCapabilityAvailability {
  if (value === "available" || value === "unavailable") {
    return value;
  }
  return "unknown";
}

function normalizeHealthState(value: unknown): AppRunHealthState | "unknown" {
  if (value === "healthy" || value === "degraded" || value === "offline") {
    return value;
  }
  return "unknown";
}

function normalizeHealthFacet(
  value: unknown,
  fallbackMessage: string | null,
): AppRunHealthFacet {
  if (isRecord(value)) {
    return {
      state: normalizeHealthState(value.state),
      message:
        typeof value.message === "string" ? value.message : fallbackMessage,
    };
  }
  return {
    state: "unknown",
    message: fallbackMessage,
  };
}

function deriveHealthStateFromStatus(status: string): AppRunHealth["state"] {
  const normalized = status.trim().toLowerCase();

  if (
    normalized === "running" ||
    normalized === "connected" ||
    normalized === "active"
  ) {
    return "healthy";
  }

  if (
    normalized === "stopped" ||
    normalized === "offline" ||
    normalized === "error" ||
    normalized === "failed"
  ) {
    return "offline";
  }

  return "degraded";
}

function deriveRunHealth(status: string, summary: string | null): AppRunHealth {
  return {
    state: deriveHealthStateFromStatus(status),
    message: summary,
  };
}

function normalizeHealth(
  value: unknown,
  status: string,
  summary: string | null,
): AppRunHealth {
  if (isRecord(value)) {
    const normalizedState = normalizeHealthState(value.state);
    return {
      state:
        normalizedState === "unknown"
          ? deriveHealthStateFromStatus(status)
          : normalizedState,
      message: typeof value.message === "string" ? value.message : summary,
    };
  }
  return deriveRunHealth(status, summary);
}

function normalizeViewerConfig(value: unknown): AppViewerConfig | null {
  if (!isRecord(value) || typeof value.url !== "string") {
    return null;
  }
  return {
    url: value.url,
    ...(isRecord(value.embedParams) &&
    Object.values(value.embedParams).every((entry) => typeof entry === "string")
      ? { embedParams: value.embedParams as Record<string, string> }
      : {}),
    ...(typeof value.postMessageAuth === "boolean"
      ? { postMessageAuth: value.postMessageAuth }
      : {}),
    ...(typeof value.sandbox === "string" ? { sandbox: value.sandbox } : {}),
    ...(isRecord(value.authMessage) &&
    typeof value.authMessage.type === "string"
      ? {
          authMessage: {
            type: value.authMessage.type,
            ...(typeof value.authMessage.authToken === "string"
              ? { authToken: value.authMessage.authToken }
              : {}),
            ...(typeof value.authMessage.characterId === "string"
              ? { characterId: value.authMessage.characterId }
              : {}),
            ...(typeof value.authMessage.sessionToken === "string"
              ? { sessionToken: value.authMessage.sessionToken }
              : {}),
            ...(typeof value.authMessage.agentId === "string"
              ? { agentId: value.authMessage.agentId }
              : {}),
            ...(typeof value.authMessage.followEntity === "string"
              ? { followEntity: value.authMessage.followEntity }
              : {}),
          },
        }
      : {}),
  };
}

function normalizeSessionState(value: unknown): AppSessionState | null {
  if (
    !isRecord(value) ||
    typeof value.sessionId !== "string" ||
    typeof value.appName !== "string" ||
    typeof value.mode !== "string" ||
    typeof value.status !== "string"
  ) {
    return null;
  }
  return {
    sessionId: value.sessionId,
    appName: value.appName,
    mode:
      value.mode === "viewer" ||
      value.mode === "spectate-and-steer" ||
      value.mode === "external"
        ? value.mode
        : "external",
    status: value.status,
    ...(typeof value.displayName === "string"
      ? { displayName: value.displayName }
      : {}),
    ...(typeof value.agentId === "string" ? { agentId: value.agentId } : {}),
    ...(typeof value.characterId === "string"
      ? { characterId: value.characterId }
      : {}),
    ...(typeof value.followEntity === "string"
      ? { followEntity: value.followEntity }
      : {}),
    ...(typeof value.canSendCommands === "boolean"
      ? { canSendCommands: value.canSendCommands }
      : {}),
    ...(Array.isArray(value.controls)
      ? {
          controls: value.controls.filter(
            (control): control is "pause" | "resume" =>
              control === "pause" || control === "resume",
          ),
        }
      : {}),
    ...(typeof value.summary === "string" || value.summary === null
      ? { summary: value.summary as string | null }
      : {}),
    ...(typeof value.goalLabel === "string" || value.goalLabel === null
      ? { goalLabel: value.goalLabel as string | null }
      : {}),
    ...(Array.isArray(value.suggestedPrompts)
      ? {
          suggestedPrompts: value.suggestedPrompts.filter(
            (prompt): prompt is string => typeof prompt === "string",
          ),
        }
      : {}),
    ...(isRecord(value.telemetry) || value.telemetry === null
      ? {
          telemetry:
            value.telemetry === null
              ? null
              : (normalizeSessionJsonValue(value.telemetry) as Record<
                  string,
                  AppSessionJsonValue
                >),
        }
      : {}),
  };
}

function normalizeSessionJsonValue(value: unknown): AppSessionJsonValue | null {
  if (value === null) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeSessionJsonValue(entry))
      .filter((entry): entry is AppSessionJsonValue => entry !== null);
  }

  if (isRecord(value)) {
    const normalizedRecord: Record<string, AppSessionJsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      const normalizedEntry = normalizeSessionJsonValue(entry);
      if (normalizedEntry !== null) {
        normalizedRecord[key] = normalizedEntry;
      }
    }
    return normalizedRecord;
  }

  return null;
}

function normalizeRunEvent(value: unknown): AppRunEvent | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.eventId !== "string" ||
    typeof value.kind !== "string" ||
    typeof value.severity !== "string" ||
    typeof value.message !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }

  const normalizedDetails = normalizeSessionJsonValue(value.details);
  return {
    eventId: value.eventId,
    kind:
      value.kind === "launch" ||
      value.kind === "refresh" ||
      value.kind === "attach" ||
      value.kind === "detach" ||
      value.kind === "stop" ||
      value.kind === "status" ||
      value.kind === "summary" ||
      value.kind === "health"
        ? value.kind
        : "status",
    severity:
      value.severity === "info" ||
      value.severity === "warning" ||
      value.severity === "error"
        ? value.severity
        : "info",
    message: value.message,
    createdAt: value.createdAt,
    status: typeof value.status === "string" ? value.status : null,
    details:
      normalizedDetails &&
      !Array.isArray(normalizedDetails) &&
      typeof normalizedDetails === "object"
        ? normalizedDetails
        : null,
  };
}

function normalizeRunEvents(value: unknown): AppRunEvent[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((event) => normalizeRunEvent(event))
    .filter((event): event is AppRunEvent => event !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, MAX_RECORDED_RUN_EVENTS);
}

function normalizeAwaySummary(value: unknown): AppRunAwaySummary | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.generatedAt !== "string" ||
    typeof value.message !== "string" ||
    typeof value.eventCount !== "number"
  ) {
    return null;
  }

  return {
    generatedAt: value.generatedAt,
    message: value.message,
    eventCount: value.eventCount,
    since: typeof value.since === "string" ? value.since : null,
    until: typeof value.until === "string" ? value.until : null,
  };
}

function deriveChatAvailability(
  session: AppSessionState | null,
): AppRunCapabilityAvailability {
  if (!session) return "unknown";
  return session.canSendCommands ? "available" : "unavailable";
}

function deriveControlAvailability(
  session: AppSessionState | null,
): AppRunCapabilityAvailability {
  if (!session) return "unknown";
  return session.canSendCommands || (session.controls?.length ?? 0) > 0
    ? "available"
    : "unavailable";
}

function deriveRunHealthFacetState(
  availability: AppRunCapabilityAvailability,
): AppRunHealthFacet["state"] {
  if (availability === "available") return "healthy";
  if (availability === "unavailable") return "degraded";
  return "unknown";
}

function deriveRunHealthDetails(run: AppRunSummary): AppRunHealthDetails {
  const viewerState: AppRunHealthFacet["state"] = !run.viewer
    ? "unknown"
    : run.viewerAttachment === "attached"
      ? "healthy"
      : run.viewerAttachment === "detached"
        ? "degraded"
        : "offline";
  const authState: AppRunHealthFacet["state"] = run.session
    ? run.viewerAttachment === "attached" || run.viewer == null
      ? "healthy"
      : "degraded"
    : "unknown";

  return {
    checkedAt: run.updatedAt,
    auth: {
      state: authState,
      message: run.session?.summary ?? run.summary,
    },
    runtime: {
      state: run.health.state,
      message: run.health.message,
    },
    viewer: {
      state: viewerState,
      message:
        run.viewerAttachment === "attached"
          ? "Viewer attached."
          : run.viewerAttachment === "detached"
            ? "Viewer detached."
            : "Viewer unavailable.",
    },
    chat: {
      state: deriveRunHealthFacetState(run.chatAvailability),
      message:
        run.chatAvailability === "available"
          ? "Operator chat is available."
          : run.chatAvailability === "unavailable"
            ? "Operator chat is unavailable."
            : "Operator chat availability is unknown.",
    },
    control: {
      state: deriveRunHealthFacetState(run.controlAvailability),
      message:
        run.controlAvailability === "available"
          ? "Control actions are available."
          : run.controlAvailability === "unavailable"
            ? "Control actions are unavailable."
            : "Control availability is unknown.",
    },
    message: run.health.message,
  };
}

function buildAwaySummary(run: AppRunSummary): AppRunAwaySummary {
  const events = run.recentEvents;
  const latestMessages = events.slice(0, 3).map((event) => event.message);
  const message =
    latestMessages.length > 0
      ? latestMessages.join(" ")
      : (run.summary ?? `${run.displayName} is ${run.status}.`);

  return {
    generatedAt: run.updatedAt,
    message,
    eventCount: events.length,
    since: events.at(-1)?.createdAt ?? run.startedAt,
    until: events[0]?.createdAt ?? run.updatedAt,
  };
}

function normalizeRun(input: unknown): AppRunSummary | null {
  if (!isRecord(input)) return null;
  const run = input;
  if (
    typeof run.runId !== "string" ||
    typeof run.appName !== "string" ||
    typeof run.displayName !== "string" ||
    typeof run.pluginName !== "string" ||
    typeof run.launchType !== "string" ||
    typeof run.status !== "string" ||
    typeof run.startedAt !== "string" ||
    typeof run.updatedAt !== "string" ||
    typeof run.viewerAttachment !== "string" ||
    !run.health ||
    typeof run.health !== "object"
  ) {
    return null;
  }

  const runId = run.runId;
  const appName = run.appName;
  const displayName = run.displayName;
  const pluginName = run.pluginName;
  const launchType = run.launchType;
  const startedAt = run.startedAt;
  const updatedAt = run.updatedAt;
  const viewerAttachmentValue = run.viewerAttachment;
  const session = normalizeSessionState(run.session);
  const viewer = normalizeViewerConfig(run.viewer);
  const status =
    typeof run.status === "string"
      ? run.status
      : typeof session?.status === "string"
        ? session.status
        : "offline";
  const summaryValue = run.summary;
  let summary: string | null;
  if (summaryValue === null) {
    summary = null;
  } else if (typeof summaryValue === "string") {
    summary = summaryValue;
  } else if (
    typeof session?.summary === "string" ||
    session?.summary === null
  ) {
    summary = session.summary ?? null;
  } else {
    summary = null;
  }
  const recentEvents = normalizeRunEvents(run.recentEvents);
  const supportsBackground =
    typeof run.supportsBackground === "boolean" ? run.supportsBackground : true;
  const supportsViewerDetach =
    typeof run.supportsViewerDetach === "boolean"
      ? run.supportsViewerDetach
      : supportsBackground;
  const characterId =
    typeof run.characterId === "string"
      ? run.characterId
      : (session?.characterId ?? null);
  const agentId =
    typeof run.agentId === "string" ? run.agentId : (session?.agentId ?? null);
  const chatAvailability =
    typeof run.chatAvailability === "string"
      ? normalizeAvailability(run.chatAvailability)
      : deriveChatAvailability(session);
  const controlAvailability =
    typeof run.controlAvailability === "string"
      ? normalizeAvailability(run.controlAvailability)
      : deriveControlAvailability(session);
  const normalizedHealth = normalizeHealth(run.health, status, summary);
  const baseRun: AppRunSummary = {
    runId,
    appName,
    displayName,
    pluginName,
    launchType,
    launchUrl: typeof run.launchUrl === "string" ? run.launchUrl : null,
    viewer,
    session,
    characterId,
    agentId,
    status,
    summary,
    startedAt,
    updatedAt,
    lastHeartbeatAt:
      typeof run.lastHeartbeatAt === "string"
        ? run.lastHeartbeatAt
        : session
          ? updatedAt
          : null,
    supportsBackground,
    supportsViewerDetach,
    chatAvailability,
    controlAvailability,
    viewerAttachment:
      viewerAttachmentValue === "attached" ||
      viewerAttachmentValue === "detached" ||
      viewerAttachmentValue === "unavailable"
        ? viewerAttachmentValue
        : viewer
          ? "detached"
          : "unavailable",
    recentEvents,
    awaySummary: null,
    health: normalizedHealth,
    healthDetails: {
      checkedAt: updatedAt,
      auth: {
        state: "unknown",
        message: summary,
      },
      runtime: {
        state: normalizedHealth.state,
        message: normalizedHealth.message,
      },
      viewer: {
        state: "unknown",
        message: null,
      },
      chat: {
        state: "unknown",
        message: null,
      },
      control: {
        state: "unknown",
        message: null,
      },
      message: normalizedHealth.message,
    },
  };
  const derivedHealthDetails = deriveRunHealthDetails(baseRun);

  return {
    ...baseRun,
    awaySummary:
      normalizeAwaySummary(run.awaySummary) ?? buildAwaySummary(baseRun),
    healthDetails: isRecord(run.healthDetails)
      ? {
          checkedAt:
            typeof run.healthDetails.checkedAt === "string"
              ? run.healthDetails.checkedAt
              : derivedHealthDetails.checkedAt,
          auth: normalizeHealthFacet(
            run.healthDetails.auth,
            derivedHealthDetails.auth.message,
          ),
          runtime: normalizeHealthFacet(
            run.healthDetails.runtime,
            derivedHealthDetails.runtime.message,
          ),
          viewer: normalizeHealthFacet(
            run.healthDetails.viewer,
            derivedHealthDetails.viewer.message,
          ),
          chat: normalizeHealthFacet(
            run.healthDetails.chat,
            derivedHealthDetails.chat.message,
          ),
          control: normalizeHealthFacet(
            run.healthDetails.control,
            derivedHealthDetails.control.message,
          ),
          message:
            typeof run.healthDetails.message === "string"
              ? run.healthDetails.message
              : derivedHealthDetails.message,
        }
      : derivedHealthDetails,
  };
}

export function resolveAppRunStoreFilePath(
  stateDir: string = resolveStateDir(),
): string {
  return path.join(stateDir, "apps", "runs.v2.json");
}

export function resolveLegacyAppRunStoreFilePath(
  stateDir: string = resolveStateDir(),
): string {
  return path.join(stateDir, "apps", "runs.v1.json");
}

function readAppRunStoreFile(
  filePath: string,
): { version: number; updatedAt: string; runs: unknown[] } | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      version: typeof parsed.version === "number" ? parsed.version : 0,
      updatedAt:
        typeof parsed.updatedAt === "string" ? parsed.updatedAt : nowIso(),
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
    };
  } catch {
    const corruptPath = `${filePath}.corrupt-${Date.now()}.json`;
    if (fs.existsSync(filePath)) {
      fs.renameSync(filePath, corruptPath);
    }
    return null;
  }
}

export function readAppRunStore(
  stateDir: string = resolveStateDir(),
): AppRunSummary[] {
  const currentPath = resolveAppRunStoreFilePath(stateDir);
  const legacyPath = resolveLegacyAppRunStoreFilePath(stateDir);

  const current = readAppRunStoreFile(currentPath);
  if (current) {
    const currentRuns = current.runs
      .map((run) => normalizeRun(run))
      .filter((run): run is AppRunSummary => run !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (current.version >= APP_RUN_STORE_VERSION) {
      return currentRuns;
    }

    writeAppRunStore(currentRuns, stateDir);
    return currentRuns;
  }

  const legacy = readAppRunStoreFile(legacyPath);
  if (!legacy) {
    return [];
  }

  const migratedRuns = legacy.runs
    .map((run) => normalizeRun(run))
    .filter((run): run is AppRunSummary => run !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  writeAppRunStore(migratedRuns, stateDir);
  return migratedRuns;
}

export function writeAppRunStore(
  runs: AppRunSummary[],
  stateDir: string = resolveStateDir(),
): AppRunSummary[] {
  const filePath = resolveAppRunStoreFilePath(stateDir);
  const normalizedRuns = [...runs].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  writeJsonAtomicSync(filePath, {
    version: APP_RUN_STORE_VERSION,
    updatedAt: nowIso(),
    runs: normalizedRuns,
  });
  return normalizedRuns;
}

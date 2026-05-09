import type { AppRunSummary } from "../../api";

const HEARTBEAT_STALE_MS = 2 * 60 * 1000;
const DOWN_STATUS_PATTERNS = [
  "disconnected",
  "failed",
  "error",
  "stale",
  "stopping",
  "stopped",
  "paused",
  "blocked",
  "offline",
  "lost",
  "missing",
  "unavailable",
];
const SESSION_READY_STATUSES = new Set([
  "running",
  "active",
  "connected",
  "ready",
  "playing",
  "live",
  "monitoring",
  "steering",
  "attached",
  "idle",
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isDownSessionStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return DOWN_STATUS_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function isReadySessionStatus(status: string): boolean {
  return SESSION_READY_STATUSES.has(status.trim().toLowerCase());
}

export function getRunAttentionReasons(
  run: AppRunSummary,
  now: number = Date.now(),
): string[] {
  const reasons: string[] = [];
  const heartbeatAt = run.lastHeartbeatAt
    ? new Date(run.lastHeartbeatAt).getTime()
    : null;

  if (run.health.state === "offline") {
    reasons.push("Run is offline");
  } else if (run.health.state === "degraded") {
    reasons.push(run.health.message ?? "Run health is degraded");
  }

  if (run.viewerAttachment === "detached") {
    reasons.push("Viewer is detached");
  } else if (run.viewerAttachment === "unavailable") {
    reasons.push("No viewer surface is available");
  }

  if (!run.viewer?.url && run.viewerAttachment !== "unavailable") {
    reasons.push("Viewer URL is missing");
  }

  if (run.session?.canSendCommands === false) {
    reasons.push("Command bridge is unavailable");
  }

  if (
    isNonEmptyString(run.session?.status) &&
    isDownSessionStatus(run.session.status) &&
    !isReadySessionStatus(run.session.status)
  ) {
    reasons.push(`Session status is ${run.session.status}`);
  }

  if (heartbeatAt === null) {
    reasons.push("No heartbeat recorded");
  } else if (
    Number.isFinite(heartbeatAt) &&
    now - heartbeatAt > HEARTBEAT_STALE_MS
  ) {
    reasons.push("Heartbeat is stale");
  }

  if (!run.supportsBackground && run.viewerAttachment !== "attached") {
    reasons.push("Run may pause when the viewer is detached");
  }

  return Array.from(new Set(reasons));
}

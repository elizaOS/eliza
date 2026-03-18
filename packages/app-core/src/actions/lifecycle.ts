/**
 * Lifecycle action helpers — extracted from AppContext.
 *
 * Provides pure-logic functions for agent lifecycle operations
 * (start, stop, restart, reset) that can be
 * called from any provider implementation.
 */

import type { ElizaClient } from "../api/client";

export type LifecycleAction = "start" | "stop" | "restart" | "reset";

export interface LifecycleMessages {
  progress: string;
  success: string;
  verb: string;
  inProgress: string;
}

export const LIFECYCLE_MESSAGES: Record<LifecycleAction, LifecycleMessages> = {
  start: {
    progress: "Starting agent...",
    success: "Agent started.",
    verb: "start",
    inProgress: "starting",
  },
  stop: {
    progress: "Stopping agent...",
    success: "Agent stopped.",
    verb: "stop",
    inProgress: "stopping",
  },

  restart: {
    progress: "Restarting agent...",
    success: "Agent restarted.",
    verb: "restart",
    inProgress: "restarting",
  },
  reset: {
    progress: "Resetting agent...",
    success: "Agent reset successfully.",
    verb: "reset",
    inProgress: "resetting",
  },
};

export interface LifecycleActionContext {
  client: ElizaClient;
  isBusy: () => boolean;
  setBusy: (busy: boolean) => void;
  setNotice: (message: string, type: string, duration?: number) => void;
}

export async function executeLifecycleAction(
  action: LifecycleAction,
  ctx: LifecycleActionContext,
): Promise<ReturnType<ElizaClient["getStatus"]> | null> {
  if (ctx.isBusy()) {
    ctx.setNotice(
      `Agent action already in progress. Please wait.`,
      "info",
      2800,
    );
    return null;
  }
  ctx.setBusy(true);
  ctx.setNotice(LIFECYCLE_MESSAGES[action].progress, "info", 3000);

  try {
    let result: Awaited<ReturnType<ElizaClient["getStatus"]>>;
    switch (action) {
      case "start":
        result = await ctx.client.startAgent();
        break;
      case "stop":
        result = await ctx.client.stopAgent();
        break;

      case "restart":
        result = await ctx.client.restartAgent();
        break;
      default:
        throw new Error(`Unknown lifecycle action: ${action}`);
    }
    ctx.setNotice(LIFECYCLE_MESSAGES[action].success, "success", 2400);
    return result;
  } catch (err) {
    ctx.setNotice(
      `Failed to ${LIFECYCLE_MESSAGES[action].verb} agent: ${
        err instanceof Error ? err.message : "unknown error"
      }`,
      "error",
      4200,
    );
    return null;
  } finally {
    ctx.setBusy(false);
  }
}

// ── Startup helpers ─────────────────────────────────────────────────

export const AGENT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_BACKEND_STARTUP_TIMEOUT_MS = 60_000;

export function getBackendStartupTimeoutMs(): number {
  try {
    const envVal = (globalThis as Record<string, unknown>)
      .ELIZA_STARTUP_TIMEOUT;
    if (typeof envVal === "number" && envVal > 0) return envVal;
  } catch {
    /* ignore */
  }
  return DEFAULT_BACKEND_STARTUP_TIMEOUT_MS;
}

export interface StartupErrorState {
  reason:
    | "backend-unreachable"
    | "backend-timeout"
    | "agent-timeout"
    | "agent-error";
  phase: "starting-backend" | "initializing-agent";
  message: string;
  detail?: string;
  status?: number;
  path?: string;
}

export function formatStartupErrorDetail(err: unknown): string {
  if (!err) return "";
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export interface ApiLikeError {
  kind: "http" | "timeout" | "network";
  status?: number;
  path?: string;
  message?: string;
}

export function asApiLikeError(err: unknown): ApiLikeError | null {
  if (!err || typeof err !== "object") return null;
  const candidate = err as Record<string, unknown>;
  if (typeof candidate.status === "number") {
    return {
      kind: "http",
      status: candidate.status,
      path: typeof candidate.path === "string" ? candidate.path : undefined,
      message:
        typeof candidate.message === "string" ? candidate.message : undefined,
    };
  }
  if (
    candidate.name === "AbortError" ||
    (typeof candidate.message === "string" &&
      candidate.message.includes("timeout"))
  ) {
    return {
      kind: "timeout",
      message:
        typeof candidate.message === "string" ? candidate.message : undefined,
    };
  }
  return null;
}

export const AGENT_TRANSFER_MIN_PASSWORD_LENGTH = 8;

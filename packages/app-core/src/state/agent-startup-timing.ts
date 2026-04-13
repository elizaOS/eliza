import { isElectrobunRuntime } from "../bridge";
import { AGENT_READY_TIMEOUT_MS } from "./types";

/** Hard cap from first agent-wait loop iteration (first successful getStatus). */
export const AGENT_STARTUP_ABSOLUTE_MAX_MS = 900_000;

/** While the agent stays in `starting`, extend the deadline by this much (sliding). */
export const AGENT_STARTING_SLIDE_MS = 180_000;

/**
 * Initial wait before the first sliding extension applies (avoids instant max deadline).
 */
export function getAgentReadyTimeoutMs(): number {
  if (typeof globalThis.window !== "undefined" && isElectrobunRuntime()) {
    return Math.max(AGENT_READY_TIMEOUT_MS, 300_000);
  }
  return Math.max(AGENT_READY_TIMEOUT_MS, 180_000);
}

export function computeAgentDeadlineExtensions(options: {
  agentWaitStartedAt: number;
  agentDeadlineAt: number;
  state: string | undefined;
  now?: number;
}): number {
  const now = options.now ?? Date.now();
  let next = options.agentDeadlineAt;
  if (options.state !== "starting") {
    return next;
  }
  if (now - options.agentWaitStartedAt < 15_000) {
    return next;
  }
  next = Math.max(next, now + AGENT_STARTING_SLIDE_MS);
  next = Math.min(
    next,
    options.agentWaitStartedAt + AGENT_STARTUP_ABSOLUTE_MAX_MS,
  );
  return next;
}

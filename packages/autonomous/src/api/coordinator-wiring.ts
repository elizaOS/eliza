import type { AgentRuntime } from "@elizaos/core";

/**
 * Minimal subset of ServerState needed for coordinator bridge wiring.
 * Avoids importing the full ServerState interface (which is private to server.ts).
 */
export interface WirableState {
  runtime: AgentRuntime | null;
  broadcastWs?: ((data: Record<string, unknown>) => void) | null;
}

export interface WireCoordinatorOpts<S extends WirableState = WirableState> {
  /** Wire the chat bridge. Returns true on success. */
  wireChatBridge: (state: S) => boolean;
  /** Wire the WebSocket bridge. Returns true on success. */
  wireWsBridge: (state: S) => boolean;
  /** Wire the event-routing bridge. Returns true on success. */
  wireEventRouting: (state: S) => boolean;
  /** Wire the swarm-complete synthesis callback. Returns true on success. */
  wireSwarmSynthesis?: (state: S) => boolean;
  /** Label for log messages (e.g. "boot", "restart"). */
  context: string;
  /** Logger with warn/debug methods. */
  logger: { warn: (msg: string) => void; debug?: (msg: string) => void };
}

export interface WireResult {
  chat: boolean;
  ws: boolean;
  eventRouting: boolean;
  swarmSynthesis: boolean;
}

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 90_000;
const RETRY_DELAY_MS = 500;
const MAX_RETRIES = 5;

/**
 * Wire coordinator bridges using polling-based service discovery.
 *
 * 1. Attempts immediate wiring (coordinator may already be available).
 * 2. If any bridge fails, polls for the SWARM_COORDINATOR service via
 *    `runtime.getService()` (the orchestrator plugin registers it via
 *    direct map insertion, so `getServiceLoadPromise` never resolves).
 * 3. Once the service appears, retries failed bridges up to MAX_RETRIES.
 * 4. On timeout or exhaustion, broadcasts a system-warning WS event.
 *
 * Safe for fire-and-forget (`void wireCoordinatorBridgesWhenReady(...)`).
 */
export async function wireCoordinatorBridgesWhenReady<S extends WirableState>(
  state: S,
  opts: WireCoordinatorOpts<S>,
): Promise<WireResult> {
  const {
    wireChatBridge,
    wireWsBridge,
    wireEventRouting,
    wireSwarmSynthesis,
    context,
    logger,
  } = opts;
  const result: WireResult = {
    chat: false,
    ws: false,
    eventRouting: false,
    swarmSynthesis: false,
  };

  try {
    // 1. Immediate attempt
    result.chat = wireChatBridge(state);
    result.ws = wireWsBridge(state);
    result.eventRouting = wireEventRouting(state);
    result.swarmSynthesis = wireSwarmSynthesis?.(state) ?? false;

    if (result.chat && result.ws && result.eventRouting) {
      logger.debug?.(
        `[milady-api] Coordinator bridges wired immediately (${context})`,
      );
      return result;
    }

    // 2. Poll for SWARM_COORDINATOR service to appear
    const runtime = state.runtime;
    if (!runtime) {
      logger.warn(
        `[milady-api] Coordinator wiring skipped (${context}): no runtime`,
      );
      return result;
    }

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let serviceFound = false;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      const svc = runtime.getService("SWARM_COORDINATOR");
      if (svc) {
        serviceFound = true;
        logger.debug?.(
          `[milady-api] SWARM_COORDINATOR service detected (${context})`,
        );
        break;
      }
    }

    if (!serviceFound) {
      // Service never appeared — log at debug level only. This is normal
      // if the orchestrator plugin is disabled or not configured.
      logger.debug?.(
        `[milady-api] SWARM_COORDINATOR not available after ${POLL_TIMEOUT_MS / 1000}s (${context}) — coding agent features disabled`,
      );
      return result;
    }

    // 3. Service loaded — retry failed bridges
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (!result.chat) result.chat = wireChatBridge(state);
      if (!result.ws) result.ws = wireWsBridge(state);
      if (!result.eventRouting) result.eventRouting = wireEventRouting(state);
      if (!result.swarmSynthesis && wireSwarmSynthesis)
        result.swarmSynthesis = wireSwarmSynthesis(state);

      if (result.chat && result.ws && result.eventRouting) {
        logger.debug?.(
          `[milady-api] Coordinator bridges wired after service load (${context}, attempt ${attempt + 1})`,
        );
        return result;
      }

      // Brief delay before next retry
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }

    // 4. Exhausted retries after service load — this is a real problem
    broadcastWarning(
      state,
      result,
      context,
      "retries exhausted after service load",
      !!wireSwarmSynthesis,
    );
    logger.warn(
      `[milady-api] Coordinator wiring incomplete after ${MAX_RETRIES} retries (${context})`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[milady-api] Coordinator wiring error (${context}): ${message}`,
    );
  }

  return result;
}

function broadcastWarning(
  state: WirableState,
  result: WireResult,
  context: string,
  reason: string,
  hasSwarmSynthesis?: boolean,
): void {
  const missing = [
    !result.chat && "chat",
    !result.ws && "ws",
    !result.eventRouting && "event-routing",
    hasSwarmSynthesis && !result.swarmSynthesis && "swarm-synthesis",
  ]
    .filter(Boolean)
    .join(", ");

  state.broadcastWs?.({
    type: "system-warning",
    message: `Coordinator wiring incomplete (${context}): ${reason}. Missing bridges: ${missing}`,
    ts: Date.now(),
  });
}

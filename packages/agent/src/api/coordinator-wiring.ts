/**
 * Polling-based wiring of the swarm-coordinator bridges into the API server's
 * mutable state. Runs fire-and-forget during boot/restart: attempts to wire the
 * chat, WebSocket, event-routing, and swarm-synthesis bridges immediately, then
 * polls `runtime.getService()` for the coding-agent orchestrator's
 * SWARM_COORDINATOR service to appear and retries the still-unwired bridges.
 * Reports degradation precisely — distinguishing "orchestrator not installed"
 * (debug) from "service registered but never became discoverable / ACP stream
 * never bound" (warn + a `system-warning` WS broadcast) — so a dead coding-agent
 * supervision surface is never silently reported as success.
 */
import {
  type AgentRuntime,
  getSwarmCoordinatorService,
  type ISwarmCoordinatorService,
  SWARM_COORDINATOR_SERVICE_TYPE,
} from "@elizaos/core";

/**
 * Minimal subset of ServerState needed for coordinator bridge wiring.
 * Avoids importing the full ServerState interface (which is private to server.ts).
 */
export interface WirableState {
  runtime: AgentRuntime | null;
  broadcastWs?: ((data: object) => void) | null;
}

export interface WireCoordinatorOpts<S extends WirableState = WirableState> {
  /** Wire the chat bridge. Returns true on success. */
  wireChatBridge: (state: S) => boolean | Promise<boolean>;
  /** Wire the WebSocket bridge. Returns true on success. */
  wireWsBridge: (state: S) => boolean | Promise<boolean>;
  /** Wire the event-routing bridge. Returns true on success. */
  wireEventRouting: (state: S) => boolean | Promise<boolean>;
  /** Wire the swarm-complete synthesis callback. Returns true on success. */
  wireSwarmSynthesis?: (state: S) => boolean | Promise<boolean>;
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
/** After this long the poll slows to POLL_SLOW_INTERVAL_MS and logs once. */
const POLL_SLOW_AFTER_MS = 90_000;
const POLL_SLOW_INTERVAL_MS = 10_000;
const RETRY_DELAY_MS = 500;
const MAX_RETRIES = 5;

function discoverCoordinator(
  runtime: AgentRuntime,
): ISwarmCoordinatorService | null {
  return getSwarmCoordinatorService(runtime);
}

/**
 * Read the coordinator's self-reported ACP bind state, if it exposes one.
 * `bound` means the ACP session-event stream is live and supervision works;
 * `unbound` / `pending` carry an actionable reason. The service object can
 * exist while the stream is dead (bind race on a heavy boot), so "the service
 * is present" is NOT sufficient to conclude coding-agent features work — we
 * probe this to report WHY when they don't.
 */
function readBindState(
  coordinator: ISwarmCoordinatorService | null,
): { status: string; reason: string | null } | null {
  if (!coordinator || typeof coordinator !== "object") return null;
  const bindState = coordinator.acpBindState;
  if (!bindState || typeof bindState !== "object") return null;
  const { status, reason } = bindState as {
    status?: unknown;
    reason?: unknown;
  };
  if (typeof status !== "string") return null;
  return {
    status,
    reason: typeof reason === "string" ? reason : null,
  };
}

/**
 * Wire coordinator bridges using polling-based service discovery.
 *
 * 1. Attempts immediate wiring (coordinator may already be available).
 * 2. If any bridge fails, polls for the coordinator via `runtime.getService()`.
 *    Depending on the installed coding-agent plugin, this is exposed as a
 *    `SWARM_COORDINATOR` service.
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
    result.chat = await wireChatBridge(state);
    result.ws = await wireWsBridge(state);
    result.eventRouting = await wireEventRouting(state);
    result.swarmSynthesis = wireSwarmSynthesis
      ? await wireSwarmSynthesis(state)
      : false;

    if (result.chat && result.ws && result.eventRouting) {
      logger.debug?.(
        `[eliza-api] Coordinator bridges wired immediately (${context})`,
      );
      return result;
    }

    // 2. Poll for SWARM_COORDINATOR service to appear
    const runtime = state.runtime;
    if (!runtime) {
      logger.warn(
        `[eliza-api] Coordinator wiring skipped (${context}): no runtime`,
      );
      return result;
    }

    // No hard deadline: the coordinator ships in a DEFERRED plugin whose
    // resolution starts only after all deferred boot work completes, so its
    // arrival time is unbounded — a heavy boot (deferred vault-hydration alone
    // ran ~94s in one restart) pushes it past any fixed timeout, permanently
    // disabling the bridges until the next restart (which hits the same race).
    // The poll is a cheap service-map lookup; slow it after POLL_SLOW_AFTER_MS
    // and stop only when this wiring call is stale (runtime swapped —
    // onRuntimeSwapped starts a fresh call for the replacement runtime).
    const pollStart = Date.now();
    let slowLogged = false;

    while (state.runtime === runtime) {
      const slow = Date.now() - pollStart >= POLL_SLOW_AFTER_MS;
      if (slow && !slowLogged) {
        slowLogged = true;
        const pluginPresent =
          runtime.hasService?.(SWARM_COORDINATOR_SERVICE_TYPE) ?? false;
        if (pluginPresent) {
          logger.warn(
            `[eliza-api] coordinator service registered but not yet ` +
              `discoverable after ${POLL_SLOW_AFTER_MS / 1000}s (${context}) — ` +
              `still polling; coding-agent features stay disabled until it appears.`,
          );
        } else {
          logger.debug?.(
            `[eliza-api] coordinator not available after ${POLL_SLOW_AFTER_MS / 1000}s (${context}) — ` +
              `still polling (deferred plugin may not have loaded yet).`,
          );
        }
      }
      await new Promise((r) => {
        const timer = setTimeout(
          r,
          slow ? POLL_SLOW_INTERVAL_MS : POLL_INTERVAL_MS,
        );
        timer.unref?.();
      });

      const svc = discoverCoordinator(runtime);
      if (svc) {
        logger.debug?.(`[eliza-api] coordinator service detected (${context})`);
        break;
      }
    }

    if (state.runtime !== runtime) {
      logger.debug?.(
        `[eliza-api] coordinator polling superseded by runtime swap (${context})`,
      );
      return result;
    }

    // Service appeared. But existence alone doesn't mean supervision works: if
    // its ACP session-event stream never bound, callbacks wire but no events
    // ever fire. Surface that explicitly rather than reporting silent success.
    const bindState = readBindState(discoverCoordinator(runtime));
    if (bindState && bindState.status !== "bound") {
      logger.warn(
        `[eliza-api] coordinator present but ACP stream not bound ` +
          `(status=${bindState.status}${
            bindState.reason ? `, reason=${bindState.reason}` : ""
          }) (${context}) — coding-agent supervision DEGRADED. ` +
          `Bridges will wire but events will not flow until the bind ` +
          `completes; the coordinator retries indefinitely.`,
      );
    }

    // 3. Service loaded — retry failed bridges
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (!result.chat) result.chat = await wireChatBridge(state);
      if (!result.ws) result.ws = await wireWsBridge(state);
      if (!result.eventRouting)
        result.eventRouting = await wireEventRouting(state);
      if (!result.swarmSynthesis && wireSwarmSynthesis)
        result.swarmSynthesis = await wireSwarmSynthesis(state);

      if (result.chat && result.ws && result.eventRouting) {
        logger.debug?.(
          `[eliza-api] Coordinator bridges wired after service load (${context}, attempt ${attempt + 1})`,
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
      `[eliza-api] Coordinator wiring missing bridges after ${MAX_RETRIES} retries (${context})`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[eliza-api] Coordinator wiring error (${context}): ${message}`,
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
    message: `Coordinator wiring missing bridges (${context}): ${reason}. Missing bridges: ${missing}`,
    ts: Date.now(),
  });
}

/**
 * Wires the API server's chat, websocket, event-routing, and synthesis bridges
 * after the runtime's registered swarm coordinator finishes starting. Missing
 * optional orchestration is skipped immediately; registered-service failures
 * surface through runtime diagnostics and a websocket warning.
 */

import {
  type AgentRuntime,
  type ISwarmCoordinatorService,
  SWARM_COORDINATOR_SERVICE_TYPE,
} from "@elizaos/core";

/** Minimal subset of server state required by coordinator bridge wiring. */
export interface WirableState {
  runtime: AgentRuntime | null;
  broadcastWs?: ((data: object) => void) | null;
}

export interface WireCoordinatorOpts<S extends WirableState = WirableState> {
  wireChatBridge: (state: S) => boolean | Promise<boolean>;
  wireWsBridge: (state: S) => boolean | Promise<boolean>;
  wireEventRouting: (state: S) => boolean | Promise<boolean>;
  wireSwarmSynthesis?: (state: S) => boolean | Promise<boolean>;
  context: string;
  logger: { warn: (msg: string) => void; debug?: (msg: string) => void };
}

export interface WireResult {
  chat: boolean;
  ws: boolean;
  eventRouting: boolean;
  swarmSynthesis: boolean;
}

type BridgeName = keyof WireResult;

function readBindState(
  coordinator: unknown,
): { status: string; reason: string | null } | null {
  if (!coordinator || typeof coordinator !== "object") return null;
  const bindState = (coordinator as Partial<ISwarmCoordinatorService>)
    .acpBindState;
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

function isFullyWired(
  result: WireResult,
  requireSwarmSynthesis: boolean,
): boolean {
  return (
    result.chat &&
    result.ws &&
    result.eventRouting &&
    (!requireSwarmSynthesis || result.swarmSynthesis)
  );
}

function emptyResult(): WireResult {
  return {
    chat: false,
    ws: false,
    eventRouting: false,
    swarmSynthesis: false,
  };
}

/**
 * Waits for the registered coordinator through the runtime service lifecycle,
 * then runs independent bridge setup concurrently exactly once.
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
  const runtime = state.runtime;
  const result = emptyResult();

  if (!runtime) {
    logger.warn(
      `[eliza-api] Coordinator wiring skipped (${context}): no runtime`,
    );
    return result;
  }
  if (!runtime.hasService(SWARM_COORDINATOR_SERVICE_TYPE)) {
    logger.debug?.(
      `[eliza-api] coordinator is not registered (${context}) — coding agent features disabled`,
    );
    return result;
  }

  let coordinator: unknown;
  try {
    coordinator = await runtime.getServiceLoadPromise(
      SWARM_COORDINATOR_SERVICE_TYPE,
    );
  } catch (error) {
    // error-policy:J1 translate the server boot/restart boundary into both
    // runtime diagnostics and the operator-visible websocket state.
    runtime.reportError("ApiServer.coordinatorStartup", error, { context });
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(
      `[eliza-api] coordinator failed to start (${context}): ${reason}`,
    );
    broadcastWarning(
      state,
      result,
      context,
      `registered coordinator failed to start: ${reason}`,
      Boolean(wireSwarmSynthesis),
    );
    return result;
  }

  const bindState = readBindState(coordinator);
  if (bindState && bindState.status !== "bound") {
    const reason = `ACP stream is ${bindState.status}${
      bindState.reason ? `: ${bindState.reason}` : ""
    }`;
    runtime.reportError("ApiServer.coordinatorContract", new Error(reason), {
      context,
      bindState: bindState.status,
    });
    logger.warn(`[eliza-api] coordinator unavailable (${context}): ${reason}`);
    broadcastWarning(
      state,
      result,
      context,
      reason,
      Boolean(wireSwarmSynthesis),
    );
    return result;
  }

  const bridges: Array<[BridgeName, () => boolean | Promise<boolean>]> = [
    ["chat", () => wireChatBridge(state)],
    ["ws", () => wireWsBridge(state)],
    ["eventRouting", () => wireEventRouting(state)],
  ];
  if (wireSwarmSynthesis) {
    bridges.push(["swarmSynthesis", () => wireSwarmSynthesis(state)]);
  }
  const settled = await Promise.allSettled(
    bridges.map(([, wire]) => Promise.resolve().then(wire)),
  );
  for (const [index, outcome] of settled.entries()) {
    const [name] = bridges[index];
    if (outcome.status === "fulfilled") {
      result[name] = outcome.value;
      continue;
    }
    runtime.reportError("ApiServer.coordinatorBridge", outcome.reason, {
      context,
      bridge: name,
    });
  }

  if (isFullyWired(result, Boolean(wireSwarmSynthesis))) {
    logger.debug?.(`[eliza-api] Coordinator bridges wired (${context})`);
    return result;
  }

  broadcastWarning(
    state,
    result,
    context,
    "bridge setup returned false or failed",
    Boolean(wireSwarmSynthesis),
  );
  logger.warn(
    `[eliza-api] Coordinator wiring incomplete (${context}): ${missingBridges(
      result,
      Boolean(wireSwarmSynthesis),
    ).join(", ")}`,
  );
  return result;
}

function missingBridges(
  result: WireResult,
  hasSwarmSynthesis: boolean,
): string[] {
  return [
    !result.chat && "chat",
    !result.ws && "ws",
    !result.eventRouting && "event-routing",
    hasSwarmSynthesis && !result.swarmSynthesis && "swarm-synthesis",
  ].filter((name): name is string => Boolean(name));
}

function broadcastWarning(
  state: WirableState,
  result: WireResult,
  context: string,
  reason: string,
  hasSwarmSynthesis: boolean,
): void {
  state.broadcastWs?.({
    type: "system-warning",
    message: `Coordinator wiring missing bridges (${context}): ${reason}. Missing bridges: ${missingBridges(
      result,
      hasSwarmSynthesis,
    ).join(", ")}`,
    ts: Date.now(),
  });
}

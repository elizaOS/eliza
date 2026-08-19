/**
 * Dispatches shared-runtime turns through a conversation-scoped coordinator.
 *
 * Production Workers use a Durable Object for ordered cache-local history;
 * callers must supply the namespace and execution context explicitly so a
 * deployment fault cannot fall through to repository-backed execution.
 */

import type { RuntimeDurableObjectNamespace } from "../../../types/cloud-worker-env";
import { InsufficientCreditsError, RateLimitError } from "../../api/errors";
import type {
  MobilePushMessage,
  MobilePushPlatform,
  MobilePushTokenRecord,
} from "../../mobile-push/types";
import { logger } from "../../utils/logger";
import type { BridgeRequest, BridgeResponse } from "../eliza-sandbox-bridge";
import type { SharedRuntimeChannel, SharedTurnMessage } from "./run-shared-agent-turn";
import type { SharedChannelIdentityProfileHint } from "./shared-profile";
import type { SharedRuntimeAgent } from "./shared-runtime-agent";
import type { BridgeExecutionContext } from "./shared-runtime-chat";
import { SharedRuntimeCacheWarmingError, SharedTurnConflictError } from "./shared-runtime-errors";

export interface SharedConversationCoordinatorOptions {
  /** Standard request correlation identity; never accepted from RPC params. */
  traceId?: string;
  namespace: RuntimeDurableObjectNamespace;
  executionCtx: BridgeExecutionContext;
  abortSignal?: AbortSignal;
  /** Personal operations are server-selected and always platform-funded. */
  agentKind?: "sandbox" | "personal";
  /** Authenticated server-only role override; never accepted from RPC params. */
  trustedMessageRole?: "system";
  /** Authenticated raw utterance when RPC text also contains server-composed context. */
  trustedUserUtterance?: string;
  /** Authenticated transport semantics; never accepted from bridge RPC params. */
  channel?: SharedRuntimeChannel;
  /** Authenticated connector display name, never arbitrary profile fields. */
  trustedProfileHint?: SharedChannelIdentityProfileHint;
}

export interface SharedConversationHistoryCoordinatorOptions {
  namespace: RuntimeDurableObjectNamespace;
  /** A newly minted room has no legacy history and can skip Postgres migration. */
  startEmpty?: boolean;
}

export interface SharedConversationLifecycleEvent {
  id: string;
  content: string;
  createdAt: number;
}

export interface SharedMobilePushRegistration {
  platform: MobilePushPlatform;
  token: string;
}

async function coordinateSharedPushOperation<T>(
  agentId: string,
  operation: "push-list" | "push-register" | "push-unregister" | "push-dispatch",
  options: SharedConversationHistoryCoordinatorOptions,
  value?: SharedMobilePushRegistration | { token: string } | { message: MobilePushMessage },
): Promise<T> {
  const namespace = requireHistoryCoordinator(options);
  const response = await coordinatorStub(namespace, agentId, agentId).fetch(
    "https://shared-runtime.internal/mobile-push",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation, agentId, ...(value ?? {}) }),
    },
  );
  await requireCoordinatorResponse(response, `mobile ${operation}`);
  return (await response.json()) as T;
}

export async function coordinateSharedPushList(
  agentId: string,
  options: SharedConversationHistoryCoordinatorOptions,
): Promise<MobilePushTokenRecord[]> {
  const result = await coordinateSharedPushOperation<{ tokens: MobilePushTokenRecord[] }>(
    agentId,
    "push-list",
    options,
  );
  return result.tokens;
}

export async function coordinateSharedPushRegister(
  agentId: string,
  registration: SharedMobilePushRegistration,
  options: SharedConversationHistoryCoordinatorOptions,
): Promise<void> {
  await coordinateSharedPushOperation(agentId, "push-register", options, registration);
}

export async function coordinateSharedPushUnregister(
  agentId: string,
  token: string,
  options: SharedConversationHistoryCoordinatorOptions,
): Promise<boolean> {
  const result = await coordinateSharedPushOperation<{ removed: boolean }>(
    agentId,
    "push-unregister",
    options,
    { token },
  );
  return result.removed;
}

export async function coordinateSharedPushDispatch(
  agentId: string,
  message: MobilePushMessage,
  options: SharedConversationHistoryCoordinatorOptions,
): Promise<void> {
  await coordinateSharedPushOperation(agentId, "push-dispatch", options, { message });
}

export interface SharedCutoverSeal {
  token: string;
  leaseMs: number;
  organizationId: string;
  dedicatedAgentId: string;
}

export interface PersonalProvisionalHistoryConvergence {
  token: string;
  holderId: string;
  sourceAgentId: string;
  targetAgentId: string;
  targetUserId: string;
  targetOrganizationId: string;
  leaseMs: number;
}

export type PreparedPersonalProvisionalHistoryConvergence =
  | { alreadyAliased: true }
  | { alreadyAliased: false; history: SharedTurnMessage[] };

/**
 * Hydrate one conversation object's read-only history and turn-ingress modules.
 * Voice startup uses this under its fixed greeting; no message is created.
 */
export async function coordinateSharedConversationPrewarm(
  agentId: string,
  roomId: string,
  options: SharedConversationHistoryCoordinatorOptions,
): Promise<void> {
  const namespace = requireHistoryCoordinator(options);
  const response = await coordinatorStub(namespace, agentId, roomId).fetch(
    "https://shared-runtime.internal/prewarm",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operation: "prewarm",
        agentId,
        roomId,
        startEmpty: options.startEmpty === true,
      }),
    },
  );
  await requireCoordinatorResponse(response, "conversation prewarm");
  // The Durable Object releases its per-room queue when the response body is
  // consumed. Drain this tiny acknowledgement before the first real turn.
  await response.arrayBuffer();
}

/** Persist one idempotent lifecycle marker without dispatching or billing a model turn. */
export async function coordinateSharedLifecycleEvent(
  agentId: string,
  roomId: string,
  event: SharedConversationLifecycleEvent,
  options: SharedConversationHistoryCoordinatorOptions,
): Promise<void> {
  const namespace = requireHistoryCoordinator(options);
  const response = await coordinatorStub(namespace, agentId, roomId).fetch(
    "https://shared-runtime.internal/lifecycle",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operation: "lifecycle",
        agentId,
        roomId,
        event,
      }),
    },
  );
  await requireCoordinatorResponse(response, "conversation lifecycle");
  await response.arrayBuffer();
}

/**
 * One normalization for the Durable Object instance name. Turn dispatch and
 * history reads MUST agree — a whitespace/empty variant addressing a second
 * object would migrate the same Postgres row twice and serve a frozen copy.
 * Mirrors the room precedence in shared-runtime-chat's `channelId`.
 */
function coordinatorRoom(roomId?: unknown, userId?: unknown): string {
  const room = typeof roomId === "string" && roomId.trim() ? roomId.trim() : undefined;
  const user = typeof userId === "string" && userId.trim() ? userId.trim() : undefined;
  return room ?? user ?? "default";
}

function coordinatorName(agentId: string, rpc: BridgeRequest): string {
  return `${agentId}:${coordinatorRoom(rpc.params?.roomId, rpc.params?.userId)}`;
}

function coordinatorStub(
  namespace: RuntimeDurableObjectNamespace,
  agentId: string,
  roomId: string,
) {
  return namespace.getByName(`${agentId}:${coordinatorRoom(roomId)}`);
}

function cacheContextUnavailable(): SharedRuntimeCacheWarmingError {
  return new SharedRuntimeCacheWarmingError(
    "Shared runtime cache context is unavailable. Retry shortly.",
  );
}

function requireTurnCoordinator(
  options: SharedConversationCoordinatorOptions,
): RuntimeDurableObjectNamespace {
  if (
    !options?.namespace ||
    typeof options.namespace.getByName !== "function" ||
    !options.executionCtx ||
    typeof options.executionCtx.waitUntil !== "function"
  ) {
    throw cacheContextUnavailable();
  }
  return options.namespace;
}

function requireHistoryCoordinator(
  options: SharedConversationHistoryCoordinatorOptions,
): RuntimeDurableObjectNamespace {
  if (!options?.namespace || typeof options.namespace.getByName !== "function") {
    throw cacheContextUnavailable();
  }
  return options.namespace;
}

async function requireCoordinatorResponse(response: Response, surface: string): Promise<Response> {
  if (response.ok) return response;
  // error-policy:J3 a malformed internal error body remains an explicit typed
  // failure rather than fabricating a successful response.
  const readErrorMessage = async (): Promise<string | null> => {
    const body = (await response
      .clone()
      .json()
      .catch(() => null)) as { error?: unknown } | null;
    return typeof body?.error === "string" ? body.error : null;
  };
  if (response.status === 503) {
    throw new SharedRuntimeCacheWarmingError(
      (await readErrorMessage()) ?? "Shared runtime cache is warming. Retry shortly.",
    );
  }
  // The Durable Object encodes insufficiency as a structured 402 (class
  // identity cannot survive its fetch boundary); rehydrate the typed error so
  // route/stream callers translate it to their canonical 402 instead of a 500.
  if (response.status === 402) {
    throw new InsufficientCreditsError((await readErrorMessage()) ?? "Insufficient credits");
  }
  // A reused clientMessageId with a different payload is a structured 409 from
  // the Durable Object claim boundary; rehydrate the typed error so routes can
  // render the canonical non-retryable conflict instead of a 500.
  if (response.status === 409) {
    const message = await readErrorMessage();
    throw message ? new SharedTurnConflictError(message) : new SharedTurnConflictError();
  }
  if (response.status === 429) {
    const retryAfter = Number.parseInt(response.headers.get("Retry-After") ?? "", 10);
    throw new RateLimitError(
      (await readErrorMessage()) ?? "Organization rate limit exceeded.",
      Number.isFinite(retryAfter) ? retryAfter : undefined,
    );
  }
  throw new Error(`[shared-runtime] ${surface} coordinator failed (${response.status})`);
}

export async function coordinateSharedBridge(
  agent: SharedRuntimeAgent,
  rpc: BridgeRequest,
  options: SharedConversationCoordinatorOptions,
): Promise<BridgeResponse> {
  const namespace = requireTurnCoordinator(options);
  const response = await namespace
    .getByName(coordinatorName(agent.id, rpc))
    .fetch("https://shared-runtime.internal/bridge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operation: options.agentKind === "personal" ? "personal-bridge" : "bridge",
        agent,
        rpc,
        ...(options.traceId ? { traceId: options.traceId } : {}),
        ...(options.trustedMessageRole ? { trustedMessageRole: options.trustedMessageRole } : {}),
        ...(options.trustedUserUtterance
          ? { trustedUserUtterance: options.trustedUserUtterance }
          : {}),
        ...(options.channel ? { channel: options.channel } : {}),
        ...(options.trustedProfileHint ? { trustedProfileHint: options.trustedProfileHint } : {}),
      }),
    });
  await requireCoordinatorResponse(response, "conversation");
  return (await response.json()) as BridgeResponse;
}

export async function coordinateSharedStream(
  agent: SharedRuntimeAgent,
  rpc: BridgeRequest,
  options: SharedConversationCoordinatorOptions,
): Promise<Response> {
  const namespace = requireTurnCoordinator(options);
  const response = await namespace
    .getByName(coordinatorName(agent.id, rpc))
    .fetch("https://shared-runtime.internal/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operation: options.agentKind === "personal" ? "personal-stream" : "stream",
        agent,
        rpc,
        ...(options.traceId ? { traceId: options.traceId } : {}),
        ...(options.trustedMessageRole ? { trustedMessageRole: options.trustedMessageRole } : {}),
        ...(options.trustedUserUtterance
          ? { trustedUserUtterance: options.trustedUserUtterance }
          : {}),
        ...(options.channel ? { channel: options.channel } : {}),
        ...(options.trustedProfileHint ? { trustedProfileHint: options.trustedProfileHint } : {}),
      }),
      ...(options.abortSignal ? { signal: options.abortSignal } : {}),
    });
  return await requireCoordinatorResponse(response, "stream");
}

export interface SharedConversationPurgeResult {
  purged: number;
  failures: number;
}

/**
 * Purge every room Durable Object of a deleted agent (#17006). Rooms share the
 * turn/history naming (`${agentId}:${room}`), so this addresses exactly the
 * objects the turn path wrote. Best-effort by contract: the agent deletion is
 * already committed when this runs, so each room is attempted independently
 * and failures are counted and logged, never thrown.
 */
export async function purgeSharedConversationRooms(
  agentId: string,
  channelIds: string[],
  options: SharedConversationHistoryCoordinatorOptions,
): Promise<SharedConversationPurgeResult> {
  const namespace = requireHistoryCoordinator(options);
  let purged = 0;
  let failures = 0;
  for (const channelId of channelIds) {
    try {
      const response = await coordinatorStub(namespace, agentId, channelId).fetch(
        "https://shared-runtime.internal/delete",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operation: "delete", agentId }),
        },
      );
      if (!response.ok) {
        failures += 1;
        logger.warn("[shared-runtime] Conversation object purge returned an error", {
          agentId,
          channelId,
          status: response.status,
        });
        continue;
      }
      purged += 1;
    } catch (error) {
      // error-policy:J6 the agent row is already deleted; one room's failed
      // purge is teardown-only, logged with its room, and must not stop the
      // remaining rooms or fail the deletion that triggered it.
      failures += 1;
      logger.warn("[shared-runtime] Conversation object purge failed", {
        agentId,
        channelId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { purged, failures };
}

export async function coordinateSharedHistory(
  agentId: string,
  roomId: string,
  options: SharedConversationHistoryCoordinatorOptions,
): Promise<SharedTurnMessage[]> {
  const namespace = requireHistoryCoordinator(options);
  const response = await coordinatorStub(namespace, agentId, roomId).fetch(
    "https://shared-runtime.internal/history",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "history", agentId, roomId }),
    },
  );
  await requireCoordinatorResponse(response, "conversation history");
  const body = (await response.json()) as { history: SharedTurnMessage[] };
  return body.history;
}

/**
 * Queue behind any in-flight Shared turn, seal admission for later turns, and
 * return the exact authoritative snapshot covered by that seal. The bounded
 * lease prevents a crashed cutover request from stranding Shared forever.
 */
export async function coordinateSharedCutoverSeal(
  agentId: string,
  roomId: string,
  seal: SharedCutoverSeal,
  options: SharedConversationHistoryCoordinatorOptions,
): Promise<SharedTurnMessage[]> {
  const namespace = requireHistoryCoordinator(options);
  const response = await coordinatorStub(namespace, agentId, roomId).fetch(
    "https://shared-runtime.internal/cutover-seal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operation: "cutover-seal",
        agentId,
        roomId,
        token: seal.token,
        leaseMs: seal.leaseMs,
        organizationId: seal.organizationId,
        dedicatedAgentId: seal.dedicatedAgentId,
      }),
    },
  );
  await requireCoordinatorResponse(response, "personal cutover seal");
  const body = (await response.json()) as { history: SharedTurnMessage[] };
  return body.history;
}

async function coordinateSharedCutoverTransition(
  agentId: string,
  roomId: string,
  token: string,
  operation: "cutover-release" | "cutover-commit",
  options: SharedConversationHistoryCoordinatorOptions,
): Promise<void> {
  const namespace = requireHistoryCoordinator(options);
  const response = await coordinatorStub(namespace, agentId, roomId).fetch(
    `https://shared-runtime.internal/${operation}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation, token }),
    },
  );
  await requireCoordinatorResponse(response, `personal ${operation}`);
}

/** Release a failed cutover's exact lease so Shared resumes immediately. */
export async function coordinateSharedCutoverRelease(
  agentId: string,
  roomId: string,
  token: string,
  options: SharedConversationHistoryCoordinatorOptions,
): Promise<void> {
  await coordinateSharedCutoverTransition(agentId, roomId, token, "cutover-release", options);
}

/** Permanently close Shared admission after the Dedicated marker commits. */
export async function coordinateSharedCutoverCommit(
  agentId: string,
  roomId: string,
  token: string,
  options: SharedConversationHistoryCoordinatorOptions,
): Promise<void> {
  await coordinateSharedCutoverTransition(agentId, roomId, token, "cutover-commit", options);
}

/**
 * Reserves the target against Dedicated cutover, then seals the source and
 * captures its complete transcript. The caller commits the account transaction
 * before passing this snapshot to the commit step, so a rejected account merge
 * cannot contaminate the target.
 */
export async function preparePersonalProvisionalHistoryConvergence(
  plan: PersonalProvisionalHistoryConvergence,
  options: SharedConversationHistoryCoordinatorOptions,
): Promise<PreparedPersonalProvisionalHistoryConvergence> {
  const namespace = requireHistoryCoordinator(options);
  try {
    const reserved = await coordinatorStub(namespace, plan.targetAgentId, plan.targetAgentId).fetch(
      "https://shared-runtime.internal/provisional-convergence-reserve",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "provisional-convergence-reserve",
          agentId: plan.targetAgentId,
          token: plan.token,
          holderId: plan.holderId,
          leaseMs: plan.leaseMs,
        }),
      },
    );
    await requireCoordinatorResponse(reserved, "provisional convergence reservation");
    await reserved.arrayBuffer();

    const sealed = await coordinatorStub(namespace, plan.sourceAgentId, plan.sourceAgentId).fetch(
      "https://shared-runtime.internal/provisional-convergence-seal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "provisional-convergence-seal",
          agentId: plan.sourceAgentId,
          token: plan.token,
          holderId: plan.holderId,
          targetAgentId: plan.targetAgentId,
          targetUserId: plan.targetUserId,
          targetOrganizationId: plan.targetOrganizationId,
          leaseMs: plan.leaseMs,
        }),
      },
    );
    await requireCoordinatorResponse(sealed, "provisional convergence seal");
    const sealedBody = (await sealed.json()) as {
      alreadyAliased?: boolean;
      history?: SharedTurnMessage[];
    };
    if (sealedBody.alreadyAliased) return { alreadyAliased: true };
    if (!Array.isArray(sealedBody.history)) {
      throw new Error("Provisional convergence seal returned no history snapshot");
    }
    return { alreadyAliased: false, history: sealedBody.history };
  } catch (error) {
    // error-policy:J6 a failed prepare releases only this attempt's holder;
    // the original coordinator failure remains the observable result.
    try {
      await releasePersonalProvisionalHistoryConvergence(plan, options);
    } catch (releaseError) {
      // error-policy:J6 the prepare failure remains primary; both bounded
      // leases self-expire, and this breadcrumb makes delayed recovery visible.
      logger.warn("[shared-runtime] Failed to release provisional convergence leases", {
        sourceAgentId: plan.sourceAgentId,
        token: plan.token,
        error: releaseError instanceof Error ? releaseError.message : String(releaseError),
      });
    }
    throw error;
  }
}

/** Imports the sealed transcript once, then installs the durable source-room alias. */
export async function commitPersonalProvisionalHistoryConvergence(
  plan: PersonalProvisionalHistoryConvergence,
  prepared: PreparedPersonalProvisionalHistoryConvergence,
  options: SharedConversationHistoryCoordinatorOptions,
): Promise<void> {
  const namespace = requireHistoryCoordinator(options);
  if (!prepared.alreadyAliased) {
    const imported = await coordinatorStub(namespace, plan.targetAgentId, plan.targetAgentId).fetch(
      "https://shared-runtime.internal/provisional-convergence-import",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "provisional-convergence-import",
          agentId: plan.targetAgentId,
          token: plan.token,
          holderId: plan.holderId,
          history: prepared.history,
        }),
      },
    );
    await requireCoordinatorResponse(imported, "provisional convergence import");
    await imported.arrayBuffer();
  }
  const response = await coordinatorStub(namespace, plan.sourceAgentId, plan.sourceAgentId).fetch(
    "https://shared-runtime.internal/provisional-convergence-alias",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operation: "provisional-convergence-alias",
        token: plan.token,
        targetAgentId: plan.targetAgentId,
        targetUserId: plan.targetUserId,
        targetOrganizationId: plan.targetOrganizationId,
      }),
    },
  );
  await requireCoordinatorResponse(response, "provisional convergence alias");
  await response.arrayBuffer();
  await releasePersonalProvisionalHistoryConvergence(plan, options);
}

/** Releases this attempt's source seal and target reservation. */
export async function releasePersonalProvisionalHistoryConvergence(
  plan: Pick<
    PersonalProvisionalHistoryConvergence,
    "token" | "holderId" | "sourceAgentId" | "targetAgentId"
  >,
  options: SharedConversationHistoryCoordinatorOptions,
): Promise<void> {
  const namespace = requireHistoryCoordinator(options);
  const responses = await Promise.all(
    [plan.sourceAgentId, plan.targetAgentId].map(
      async (agentId) =>
        await coordinatorStub(namespace, agentId, agentId).fetch(
          "https://shared-runtime.internal/provisional-convergence-release",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              operation: "provisional-convergence-release",
              token: plan.token,
              holderId: plan.holderId,
            }),
          },
        ),
    ),
  );
  for (const response of responses) {
    await requireCoordinatorResponse(response, "provisional convergence release");
    await response.arrayBuffer();
  }
}

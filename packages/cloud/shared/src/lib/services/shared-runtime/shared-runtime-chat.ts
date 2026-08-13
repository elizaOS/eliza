/**
 * Cache-only shared-tier chat execution for Cloudflare Workers.
 *
 * Resolved agent scope and conversation-local storage are injected by the
 * route coordinator. The response path reads only cached character, history,
 * and balance state; metering and database mirrors run under waitUntil.
 */

import crypto from "node:crypto";
import type { UserCharacter } from "../../../db/repositories/characters";
import {
  InsufficientCreditsError as InsufficientCreditsApiError,
  RateLimitError,
} from "../../api/errors";
import { cache } from "../../cache/client";
import { InMemoryLRUCache } from "../../cache/in-memory-lru-cache";
import { CacheTTL } from "../../cache/keys";
import { enforceOrgRateLimit, OrgRateLimitCacheNotReadyError } from "../../middleware/rate-limit";
import { getProviderFromModel } from "../../pricing";
import { logger } from "../../utils/logger";
import { settleOffResponsePath } from "../../utils/settle-off-response-path";
import {
  type AIUsage,
  type BillingContext,
  billUsage,
  estimateInputTokens,
  InsufficientCreditsError,
  recordUsageAnalytics,
} from "../ai-billing";
import { aiBillingRecordsService } from "../ai-billing-records";
import { chatSseFrame } from "../chat-sse-frames";
import type { CreditReconciliationResult, CreditReservation } from "../credits";
import type { BridgeRequest, BridgeResponse } from "../eliza-sandbox-bridge";
import { isInferenceAdmissionDispatchMarkError } from "../inference-admission-gate";
import {
  getInferenceAdmissionSnapshotCacheOnly,
  InferenceAdmissionSnapshotCacheWarmingError,
  inferenceRateLimitConfig,
} from "../inference-admission-snapshot";
import type { InferenceAdmissionSnapshot } from "../inference-auth-cache";
import { InferenceBalanceCacheWarmingError } from "../inference-billing-fast-path";
import {
  isKnownPreDispatchProviderConfigurationError,
  isKnownUnacceptedProviderError,
} from "../inference-provider-outcome";
import { admitOrganizationInference } from "../organization-inference-admission";
import {
  type RunSharedAgentTurnResult,
  resolveSharedAgentTurnModel,
  runSharedAgentTurn,
  runSharedAgentTurnStream,
  type SharedAgentCharacter,
  type SharedAgentTurnUsage,
  type SharedTurnMessage,
} from "./run-shared-agent-turn";
import { projectSharedAgentCharacter } from "./shared-agent-character";
import {
  capabilityWallActionResult,
  resolveSharedCapabilityWall,
  type SharedCapabilityWall,
} from "./shared-capability-wall";
import { navIntentActionResult, type SharedNavIntent } from "./shared-nav-intent";
import type { SharedRuntimeAgent } from "./shared-runtime-agent";
import { SharedRuntimeCacheWarmingError, SharedTurnConflictError } from "./shared-runtime-errors";
import { MAX_HISTORY_MESSAGES } from "./shared-runtime-history-policy";
import {
  executeMeteredSharedWebSearch,
  resolveSharedWebSearchQuery,
  type SharedWebSearchContext,
  SharedWebSearchRateLimitError,
  webSearchActionResult,
} from "./shared-web-search";

export { MAX_HISTORY_MESSAGES } from "./shared-runtime-history-policy";

const BRIDGE_INSUFFICIENT_CREDITS_CODE = -32002;
const linkedCharacterMemoryCache = new InMemoryLRUCache<UserCharacter>(256, 60_000);

export type BridgeExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

function turnActionResults(turn: {
  navIntent?: SharedNavIntent;
  capabilityWall?: SharedCapabilityWall;
  webSearch?: SharedWebSearchContext;
}): unknown[] | undefined {
  if (turn.capabilityWall) {
    return [capabilityWallActionResult(turn.capabilityWall)];
  }
  if (turn.navIntent) return [navIntentActionResult(turn.navIntent)];
  if (turn.webSearch) return [webSearchActionResult(turn.webSearch)];
  return undefined;
}

function isDeterministicFreeTurn(turn: {
  navIntent?: SharedNavIntent;
  capabilityWall?: SharedCapabilityWall;
}): boolean {
  return Boolean(turn.navIntent || turn.capabilityWall);
}

async function searchContextForTurn(
  agent: SharedRuntimeAgent,
  text: string,
  executionCtx: BridgeExecutionContext | undefined,
): Promise<SharedWebSearchContext | undefined> {
  if (resolveSharedCapabilityWall(text)) return undefined;
  const query = resolveSharedWebSearchQuery(text);
  if (!query) return undefined;
  try {
    return await executeMeteredSharedWebSearch({
      organizationId: agent.organization_id,
      query,
      executionCtx,
    });
  } catch (error) {
    if (error instanceof OrgRateLimitCacheNotReadyError) {
      throw new SharedRuntimeCacheWarmingError(
        "Shared web search meter is warming. Retry shortly.",
      );
    }
    if (error instanceof SharedWebSearchRateLimitError) {
      throw new RateLimitError(error.message, error.retryAfterSeconds);
    }
    throw error;
  }
}

export interface SharedRuntimeHistoryStore {
  load(agentId: string, channelId: string): Promise<SharedTurnMessage[]>;
  merge(
    agentId: string,
    channelId: string,
    messages: SharedTurnMessage[],
  ): Promise<SharedTurnMessage[]>;
}

/** Terminal result of a landed shared turn, durably replayable by claim key. */
export interface SharedTurnTerminalResult {
  text: string;
  messageId: string;
  userMessageId: string;
  agentName: string;
  channelId: string;
  model: string;
  degraded: boolean;
  runtime: "shared";
  transport: "shared-runtime";
  actionResults?: unknown[];
}

export type SharedTurnClaimDecision =
  | { state: "claimed" }
  | { state: "replay"; result: SharedTurnTerminalResult }
  | { state: "conflict" };

/**
 * Durable per-conversation claim ledger for client-keyed turns (#18045). The
 * conversation coordinator owns the storage and fully serializes turns, so
 * `claim` runs before any admission/dispatch and `complete` runs before the
 * terminal response leaves the coordinator — a same-key retry replays the
 * stored result instead of admitting, dispatching, or billing a second turn.
 */
export interface SharedTurnClaimStore {
  /**
   * Claim `key` for a payload. "claimed" also re-claims a pending record with
   * a matching hash: the coordinator serializes turns, so a pending claim
   * means the prior execution failed before landing — re-execution is the
   * correct recovery, and its deterministic billing identities (see
   * `admitTurn`) keep the charge idempotent.
   */
  claim(key: string, payloadHash: string): Promise<SharedTurnClaimDecision>;
  /** Durably record the terminal result; later same-key claims replay it. */
  complete(key: string, result: SharedTurnTerminalResult): Promise<void>;
}

export interface SharedRuntimeChatOptions {
  abortSignal?: AbortSignal;
  executionCtx?: BridgeExecutionContext;
  historyStore?: SharedRuntimeHistoryStore;
  turnClaims?: SharedTurnClaimStore;
  /** Who funds provider work. Personal Shared chat is platform-funded. */
  funding?: "organization-credits" | "platform";
}

export {
  SharedRuntimeCacheWarmingError,
  SharedTurnConflictError,
} from "./shared-runtime-errors";

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function stableUuid(raw: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
    return raw;
  }
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Client-supplied idempotency key for a shared turn (#18045). When present it
 * becomes the bridge RPC id (so `turnMessageIds` derives the SAME user and
 * assistant message ids on a retry) AND the coordinator's durable claim key: a
 * retried submission replays the stored terminal result without a second
 * admission, provider dispatch, or charge, and a reused key with different
 * text is rejected. Untrusted input: accept only a non-empty string of a
 * sane length; anything else means "no key" and the caller generates a fresh id
 * (a lost de-dupe, never a broken turn).
 */
export function sharedTurnClientMessageId(body: unknown): string | undefined {
  // error-policy:J3 untrusted request body — an absent/oversized/non-string key
  // yields an explicit undefined, never a fabricated identity.
  if (!body || typeof body !== "object") return undefined;
  const raw = (body as { clientMessageId?: unknown }).clientMessageId;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128) return undefined;
  return trimmed;
}

/** Content identity for conflict detection: same key + different text is rejected. */
function sharedTurnPayloadHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * Run the durable claim boundary for a client-keyed turn. Returns the stored
 * terminal result when this exact submission already landed (the caller
 * replays it without admitting, dispatching, or billing), `undefined` when the
 * turn is freshly claimed, and throws on a payload conflict.
 */
async function claimSharedTurn(
  claims: SharedTurnClaimStore,
  claimKey: string,
  text: string,
): Promise<SharedTurnTerminalResult | undefined> {
  const decision = await claims.claim(claimKey, sharedTurnPayloadHash(text));
  if (decision.state === "conflict") throw new SharedTurnConflictError();
  return decision.state === "replay" ? decision.result : undefined;
}

function rpcTurnIdentity(rpc: BridgeRequest): string {
  if (typeof rpc.id === "string" || typeof rpc.id === "number") {
    return String(rpc.id);
  }
  return crypto.randomUUID();
}

function turnMessageIds(
  agentId: string,
  roomId: string,
  rpc: BridgeRequest,
): {
  user: string;
  assistant: string;
} {
  const turn = rpcTurnIdentity(rpc);
  return {
    user: stableUuid(`shared-runtime:${agentId}:${roomId}:${turn}:user`),
    assistant: stableUuid(`shared-runtime:${agentId}:${roomId}:${turn}:assistant`),
  };
}

function channelId(agentId: string, params: Record<string, unknown>): string {
  const room = stringValue(params.roomId) ?? stringValue(params.userId) ?? "default";
  return stableUuid(`cloud-bridge-channel:${agentId}:${room}`);
}

function isTurn(value: unknown): value is SharedTurnMessage {
  const candidate = record(value);
  return (
    (candidate?.role === "user" || candidate?.role === "assistant") &&
    typeof candidate.content === "string" &&
    candidate.content.trim().length > 0
  );
}

async function loadHistory(
  agentId: string,
  roomId: string,
  store?: SharedRuntimeHistoryStore,
): Promise<SharedTurnMessage[]> {
  const history = store
    ? await store.load(agentId, roomId)
    : await import("../../../db/repositories/shared-runtime-history").then(
        ({ sharedRuntimeHistoryRepository }) => sharedRuntimeHistoryRepository.get(agentId, roomId),
      );
  return history.filter(isTurn);
}

async function mergeHistory(
  agentId: string,
  roomId: string,
  messages: SharedTurnMessage[],
  store?: SharedRuntimeHistoryStore,
): Promise<SharedTurnMessage[]> {
  const valid = messages.filter(isTurn);
  if (!valid.length) {
    return await loadHistory(agentId, roomId, store);
  }
  if (store) {
    return await store.merge(agentId, roomId, valid);
  }
  const { sharedRuntimeHistoryRepository } = await import(
    "../../../db/repositories/shared-runtime-history"
  );
  return (await sharedRuntimeHistoryRepository.merge(
    agentId,
    roomId,
    valid,
    MAX_HISTORY_MESSAGES,
  )) as SharedTurnMessage[];
}

async function characterFor(
  agent: SharedRuntimeAgent,
  options: {
    cacheOnly: boolean;
    executionCtx?: BridgeExecutionContext;
  },
): Promise<SharedAgentCharacter> {
  let linked: UserCharacter | null | undefined;
  if (agent.character_id) {
    if (options.cacheOnly) {
      linked = linkedCharacterMemoryCache.get(agent.character_id);
      if (!linked) {
        try {
          linked = await cache.get<UserCharacter>(`character:data:${agent.character_id}`);
          if (linked) linkedCharacterMemoryCache.set(agent.character_id, linked);
        } catch {
          // error-policy:J4 a cache dependency failure cannot fall through to
          // the linked-character repository on an inference request.
          throw new SharedRuntimeCacheWarmingError(
            "Character cache is unavailable. Retry shortly.",
          );
        }
      }
    } else {
      linked = await import("../../../db/repositories/characters").then(
        ({ userCharactersRepository }) =>
          userCharactersRepository.findByIdInOrganization(
            agent.character_id!,
            agent.organization_id,
          ),
      );
    }
  }
  if (options.cacheOnly && agent.character_id && !linked) {
    if (!options.executionCtx) {
      throw new SharedRuntimeCacheWarmingError(
        "Character cache context is unavailable. Retry shortly.",
      );
    }
    const characterId = agent.character_id;
    const hydration = import("../../../db/repositories/characters")
      .then(({ userCharactersRepository }) =>
        userCharactersRepository.findByIdInOrganization(characterId, agent.organization_id),
      )
      .then(async (character) => {
        if (character) {
          linkedCharacterMemoryCache.set(characterId, character);
          await cache.set(`character:data:${characterId}`, character, CacheTTL.agent.characterData);
        }
      })
      .catch((error) => {
        // error-policy:J7 a failed cold fill leaves the next inference
        // fail-closed and retryable; it must not become an unhandled rejection.
        logger.warn("[SharedRuntimeChatService] character hydration failed", {
          agentId: agent.id,
          characterId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    options.executionCtx.waitUntil(hydration);
    throw new SharedRuntimeCacheWarmingError("Character cache is warming. Retry shortly.");
  }
  return projectSharedAgentCharacter(agent, linked);
}

function billingPrompt(
  character: SharedAgentCharacter,
  history: SharedTurnMessage[],
  message: string,
): Array<{ content: string }> {
  return [
    { content: character.system },
    ...(character.bio ?? []).map((content) => ({ content })),
    ...history.map((turn) => ({ content: turn.content })),
    { content: message },
  ].filter((entry) => entry.content.trim());
}

function billingUsage(
  reply: string,
  usage: SharedAgentTurnUsage | undefined,
  estimatedInputTokens: number,
): AIUsage {
  const inputTokens = usage?.inputTokens ?? usage?.promptTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? usage?.completionTokens ?? 0;
  if (inputTokens > 0 || outputTokens > 0 || (usage?.totalTokens ?? 0) > 0) {
    return usage ?? {};
  }
  return {
    inputTokens: estimatedInputTokens,
    outputTokens: estimateInputTokens([{ content: reply }]),
  };
}

interface BillingTurn {
  context: BillingContext & {
    provider: string;
    billingSource: "bitrouter";
    requestId: string;
  };
  idempotencyKey: string;
  estimatedInputTokens: number;
  reservation?: CreditReservation;
  settle(actualCost: number): Promise<CreditReconciliationResult | null>;
  settleUnknown(): Promise<CreditReconciliationResult | null>;
  markProviderDispatched?(): Promise<void>;
}

async function admitTurn(
  agent: SharedRuntimeAgent,
  character: SharedAgentCharacter,
  history: SharedTurnMessage[],
  text: string,
  roomId: string,
  executionCtx?: BridgeExecutionContext,
  turnKey?: string,
  funding: SharedRuntimeChatOptions["funding"] = "organization-credits",
): Promise<BillingTurn | null> {
  const model = resolveSharedAgentTurnModel(character.model);
  if (!model) return null;
  const estimatedInputTokens = estimateInputTokens(billingPrompt(character, history, text));
  // A client-keyed turn gets DETERMINISTIC billing identities: the admission
  // gate keys its pending charge and debit replay on `requestId`, so even a
  // crash-and-retry re-execution of the same claim replays one debit identity
  // instead of opening a second charge (#18045).
  const requestId = turnKey
    ? `shared-runtime-${stableUuid(`shared-turn:${agent.id}:${roomId}:${turnKey}`)}`
    : `shared-runtime-${crypto.randomUUID()}`;
  const idempotencyKey = `shared-runtime:${agent.id}:${roomId}:${turnKey ?? crypto.randomUUID()}`;
  const context = {
    organizationId: agent.organization_id,
    userId: agent.user_id,
    model,
    provider: getProviderFromModel(model),
    billingSource: "bitrouter" as const,
    requestId,
    description: `Shared runtime turn: ${character.name}`,
    metadata: {
      agentId: agent.id,
      channelId: roomId,
      executionTier: agent.execution_tier,
      idempotencyKey,
      runtime: "shared",
    },
  };
  let rateLimited: Response | null;
  let admissionSnapshot: InferenceAdmissionSnapshot | undefined;
  if (executionCtx && funding === "organization-credits") {
    try {
      admissionSnapshot = await getInferenceAdmissionSnapshotCacheOnly(
        agent.organization_id,
        executionCtx,
      );
    } catch (error) {
      // error-policy:J1 a combined policy miss remains a retryable warmup and
      // cannot fall through to synchronous balance or tier reads.
      if (error instanceof InferenceAdmissionSnapshotCacheWarmingError) {
        throw new SharedRuntimeCacheWarmingError(
          "Inference admission cache is warming. Retry shortly.",
        );
      }
      throw error;
    }
  }
  try {
    rateLimited = await enforceOrgRateLimit(agent.organization_id, "completions", {
      cacheOnly: Boolean(executionCtx),
      executionCtx,
      config: inferenceRateLimitConfig(admissionSnapshot, "completions"),
    });
  } catch (error) {
    // error-policy:J1 the shared-runtime boundary keeps policy hydration off
    // the response path and exposes a single retryable cache-warming signal.
    if (error instanceof OrgRateLimitCacheNotReadyError) {
      throw new SharedRuntimeCacheWarmingError(
        "Rate-limit authorization cache is warming. Retry shortly.",
      );
    }
    throw error;
  }
  if (rateLimited) {
    if (rateLimited.status === 429) {
      const retryAfterValue = Number.parseInt(rateLimited.headers.get("Retry-After") ?? "", 10);
      throw new RateLimitError(
        "Organization rate limit exceeded.",
        Number.isFinite(retryAfterValue) ? retryAfterValue : undefined,
      );
    }
    throw new SharedRuntimeCacheWarmingError(
      "Rate-limit authorization is unavailable. Retry shortly.",
    );
  }
  // Account-native Shared is a platform service. It keeps the same abuse
  // limiter and durable turn identity, but never reserves or debits the user's
  // balance; Dedicated remains the explicit paid-compute boundary.
  if (funding === "platform") return null;
  let admission: Awaited<ReturnType<typeof admitOrganizationInference>>;
  try {
    admission = await admitOrganizationInference({
      context,
      estimatedInputTokens,
      estimatedOutputTokens: 500,
      executionCtx,
      admissionSnapshot,
    });
  } catch (error) {
    // error-policy:J1 translate the billing-cache boundary into the shared
    // runtime's retryable cache-warming signal.
    if (error instanceof InferenceBalanceCacheWarmingError) {
      throw new SharedRuntimeCacheWarmingError("Billing authorization is warming. Retry shortly.");
    }
    throw error;
  }
  return {
    context,
    idempotencyKey,
    estimatedInputTokens,
    reservation: admission.reservation,
    settle: admission.settle,
    settleUnknown: admission.settleUnknown,
    markProviderDispatched: admission.markProviderDispatched,
  };
}

async function finishBilling(
  agent: SharedRuntimeAgent,
  billing: BillingTurn,
  reply: string,
  prompt: string,
  usage?: SharedAgentTurnUsage,
): Promise<void> {
  try {
    const result = await billUsage(
      billing.context,
      billingUsage(reply, usage, billing.estimatedInputTokens),
      billing.reservation,
    );
    const reconciliation = await billing.settle(result.totalCost);
    const record = await recordUsageAnalytics(billing.context, result, {
      type: "chat",
      content: reply,
      prompt,
    });
    if (record) {
      await aiBillingRecordsService.record({
        context: billing.context,
        billing: result,
        usageRecord: record,
        idempotencyKey: billing.idempotencyKey,
        reconciliation,
      });
    }
  } catch (error) {
    // error-policy:J1 the reply may already be delivered, so an unavailable
    // meter is not evidence of zero provider work. Preserve the admitted
    // estimate unless an earlier actual-cost settlement already won.
    try {
      await billing.settleUnknown();
    } catch (settleError) {
      // error-policy:J7 a settler that already failed (the deferred settler
      // replays its first settlement promise) must not mask the original
      // billing error below or escape as an unhandled waitUntil rejection.
      logger.warn("[SharedRuntimeChatService] unknown-settle after billing failure also failed", {
        agentId: agent.id,
        error: settleError instanceof Error ? settleError.message : String(settleError),
      });
    }
    logger.error("[SharedRuntimeChatService] billing failed", {
      agentId: agent.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function settleAmbiguousProviderWork(
  agent: SharedRuntimeAgent,
  billing: BillingTurn,
  reason: string,
): Promise<void> {
  try {
    await billing.settleUnknown();
  } catch (error) {
    // error-policy:J7 the original turn/stream failure remains the user-facing
    // boundary; the still-held admission lease preserves the monetary failure
    // for a later keyed retry or reconciliation.
    logger.error("[SharedRuntimeChatService] ambiguous provider settlement failed", {
      agentId: agent.id,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function settleAmbiguousProviderWorkOffPath(
  agent: SharedRuntimeAgent,
  billing: BillingTurn | null,
  executionCtx: BridgeExecutionContext | undefined,
  reason: string,
): Promise<void> {
  if (!billing) return Promise.resolve();
  return settleOffResponsePath(executionCtx, () =>
    settleAmbiguousProviderWork(agent, billing, reason),
  );
}

function isProvablyZeroProviderFailure(error: unknown): boolean {
  return (
    isInferenceAdmissionDispatchMarkError(error) ||
    isKnownPreDispatchProviderConfigurationError(error) ||
    isKnownUnacceptedProviderError(error)
  );
}

function settleFailedProviderWorkOffPath(
  agent: SharedRuntimeAgent,
  billing: BillingTurn | null,
  executionCtx: BridgeExecutionContext | undefined,
  error: unknown,
  reason: string,
  providerOutputObserved = false,
): Promise<void> {
  if (!billing) return Promise.resolve();
  if (!providerOutputObserved && isProvablyZeroProviderFailure(error)) {
    return settleOffResponsePath(executionCtx, async () => {
      await billing.settle(0);
    });
  }
  return settleAmbiguousProviderWorkOffPath(agent, billing, executionCtx, reason);
}

function sseError(message: string): Response {
  return new Response(chatSseFrame("error", { message }), {
    headers: { "Content-Type": "text/event-stream; charset=utf-8" },
  });
}

export class SharedRuntimeChatService {
  async getHistory(
    agentId: string,
    roomId = agentId,
    store?: SharedRuntimeHistoryStore,
  ): Promise<SharedTurnMessage[]> {
    return await loadHistory(agentId, channelId(agentId, { roomId }), store);
  }

  async getCharacter(
    agent: SharedRuntimeAgent,
    executionCtx: BridgeExecutionContext,
  ): Promise<SharedAgentCharacter> {
    return await characterFor(agent, { cacheOnly: true, executionCtx });
  }

  async bridge(
    agent: SharedRuntimeAgent,
    rpc: BridgeRequest,
    options: SharedRuntimeChatOptions = {},
  ): Promise<BridgeResponse> {
    if (rpc.method === "status.get" || rpc.method === "heartbeat") {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          status: "running",
          ready: true,
          agentId: agent.id,
          agentName: agent.agent_name ?? undefined,
          runtime: "shared",
        },
      };
    }
    if (rpc.method !== "message.send") {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32601, message: `Method not found: ${rpc.method}` },
      };
    }
    const params = record(rpc.params) ?? {};
    const text = stringValue(params.text);
    if (!text) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32602, message: "message.send requires params.text" },
      };
    }
    const roomId = channelId(agent.id, params);
    const claimKey = options.turnClaims ? sharedTurnClientMessageId(params) : undefined;
    if (claimKey && options.turnClaims) {
      const replay = await claimSharedTurn(options.turnClaims, claimKey, text);
      if (replay) {
        return {
          jsonrpc: "2.0",
          id: rpc.id,
          result: replay as unknown as Record<string, unknown>,
        };
      }
    }
    const [character, history] = await Promise.all([
      characterFor(agent, {
        cacheOnly: Boolean(options.historyStore),
        executionCtx: options.executionCtx,
      }),
      loadHistory(agent.id, roomId, options.historyStore),
    ]);
    let billing: BillingTurn | null;
    try {
      billing = await admitTurn(
        agent,
        character,
        history,
        text,
        roomId,
        options.executionCtx,
        claimKey,
        options.funding,
      );
    } catch (error) {
      // error-policy:J1 translate the money boundary to the JSON-RPC protocol.
      if (error instanceof InsufficientCreditsError) {
        return {
          jsonrpc: "2.0",
          id: rpc.id,
          error: {
            code: BRIDGE_INSUFFICIENT_CREDITS_CODE,
            message: `Insufficient credits. Required: $${error.required.toFixed(4)}, Available: $${error.available.toFixed(4)}`,
          },
        };
      }
      throw error;
    }
    let webSearch: SharedWebSearchContext | undefined;
    try {
      webSearch = resolveSharedAgentTurnModel(character.model)
        ? await searchContextForTurn(agent, text, options.executionCtx)
        : undefined;
    } catch (error) {
      await billing?.settle(0);
      throw error;
    }

    const messageIds = turnMessageIds(agent.id, roomId, rpc);
    let turn: RunSharedAgentTurnResult;
    try {
      turn = await runSharedAgentTurn({
        character,
        history,
        message: text,
        messageIds,
        onProviderDispatch: billing?.markProviderDispatched,
        webSearch,
      });
    } catch (error) {
      await settleFailedProviderWorkOffPath(
        agent,
        billing,
        options.executionCtx,
        error,
        "bridge provider invocation failed",
      );
      throw error;
    }

    let turnCompleted = false;
    let turnIsProvablyFree = false;
    try {
      turnIsProvablyFree = turn.degraded || isDeterministicFreeTurn(turn);
      const actionResults = turnActionResults(turn);
      const result: SharedTurnTerminalResult = {
        text: turn.reply,
        messageId: messageIds.assistant,
        userMessageId: messageIds.user,
        agentName: character.name,
        channelId: roomId,
        model: turn.model,
        degraded: turn.degraded,
        runtime: "shared",
        transport: "shared-runtime",
        ...(actionResults ? { actionResults } : {}),
      };
      if (turn.degraded) {
        await billing?.settle(0);
      } else {
        await mergeHistory(
          agent.id,
          roomId,
          turn.history.filter(
            (message) => message.id === messageIds.user || message.id === messageIds.assistant,
          ),
          options.historyStore,
        );
        // Claim completion is durable BEFORE the response can leave the
        // coordinator: a response lost in transit replays this exact result on
        // retry instead of re-dispatching. Degraded turns stay pending — they
        // landed nothing, so a retry should attempt a real turn.
        if (claimKey && options.turnClaims) {
          await options.turnClaims.complete(claimKey, result);
        }
        if (isDeterministicFreeTurn(turn)) {
          await billing?.settle(0);
        } else if (billing) {
          await settleOffResponsePath(options.executionCtx, () =>
            finishBilling(agent, billing, turn.reply, text, turn.usage),
          );
        }
      }
      const response: BridgeResponse = {
        jsonrpc: "2.0",
        id: rpc.id,
        result: result as unknown as Record<string, unknown>,
      };
      turnCompleted = true;
      return response;
    } finally {
      if (!turnCompleted) {
        if (turnIsProvablyFree) {
          await billing?.settle(0);
        } else {
          await settleAmbiguousProviderWorkOffPath(
            agent,
            billing,
            options.executionCtx,
            "bridge turn failed after admission",
          );
        }
      }
    }
  }

  async stream(
    agent: SharedRuntimeAgent,
    rpc: BridgeRequest,
    options: SharedRuntimeChatOptions = {},
  ): Promise<Response> {
    const params = record(rpc.params) ?? {};
    const text = stringValue(params.text);
    if (!text) return sseError("message.send requires params.text");
    const roomId = channelId(agent.id, params);
    const claimKey = options.turnClaims ? sharedTurnClientMessageId(params) : undefined;
    if (claimKey && options.turnClaims) {
      const replay = await claimSharedTurn(options.turnClaims, claimKey, text);
      if (replay) {
        return new Response(
          chatSseFrame("chunk", {
            messageId: replay.messageId,
            userMessageId: replay.userMessageId,
            chunk: replay.text,
            text: replay.text,
            fullText: replay.text,
            timestamp: Date.now(),
          }) +
            chatSseFrame("done", {
              messageId: replay.messageId,
              userMessageId: replay.userMessageId,
              text: replay.text,
              fullText: replay.text,
              ...(replay.actionResults ? { actionResults: replay.actionResults } : {}),
            }),
          { headers: { "Content-Type": "text/event-stream; charset=utf-8" } },
        );
      }
    }
    const [character, history] = await Promise.all([
      characterFor(agent, {
        cacheOnly: Boolean(options.historyStore),
        executionCtx: options.executionCtx,
      }),
      loadHistory(agent.id, roomId, options.historyStore),
    ]);
    let billing: BillingTurn | null;
    try {
      billing = await admitTurn(
        agent,
        character,
        history,
        text,
        roomId,
        options.executionCtx,
        claimKey,
        options.funding,
      );
    } catch (error) {
      // error-policy:J1 translate the money boundary to the HTTP stream boundary.
      if (error instanceof InsufficientCreditsError) {
        throw new InsufficientCreditsApiError(
          `Insufficient credits. Required: $${error.required.toFixed(4)}, Available: $${error.available.toFixed(4)}`,
        );
      }
      throw error;
    }
    let webSearch: SharedWebSearchContext | undefined;
    try {
      webSearch = resolveSharedAgentTurnModel(character.model)
        ? await searchContextForTurn(agent, text, options.executionCtx)
        : undefined;
    } catch (error) {
      await billing?.settle(0);
      throw error;
    }
    const messageIds = turnMessageIds(agent.id, roomId, rpc);
    const generationAbort = new AbortController();
    const abortFromRequest = () => {
      generationAbort.abort(options.abortSignal?.reason);
    };
    if (options.abortSignal?.aborted) {
      abortFromRequest();
    } else {
      options.abortSignal?.addEventListener("abort", abortFromRequest, {
        once: true,
      });
    }
    const detachRequestAbort = () =>
      options.abortSignal?.removeEventListener("abort", abortFromRequest);
    let turn: Awaited<ReturnType<typeof runSharedAgentTurnStream>>;
    try {
      turn = await runSharedAgentTurnStream({
        abortSignal: generationAbort.signal,
        character,
        history,
        message: text,
        messageIds,
        onProviderDispatch: billing?.markProviderDispatched,
        webSearch,
      });
    } catch (error) {
      detachRequestAbort();
      await settleFailedProviderWorkOffPath(
        agent,
        billing,
        options.executionCtx,
        error,
        "stream setup failed after admission",
      );
      throw error;
    }
    if (turn.degraded) {
      detachRequestAbort();
      await billing?.settle(0);
      const reply = turn.reply?.trim() ?? "";
      if (!reply) return sseError("Shared runtime is unavailable");
      return new Response(
        chatSseFrame("chunk", {
          messageId: messageIds.assistant,
          userMessageId: messageIds.user,
          chunk: reply,
          text: reply,
          fullText: reply,
          timestamp: Date.now(),
        }) +
          chatSseFrame("done", {
            messageId: messageIds.assistant,
            userMessageId: messageIds.user,
            text: reply,
            fullText: reply,
          }),
        {
          headers: { "Content-Type": "text/event-stream; charset=utf-8" },
        },
      );
    }
    if (!turn.parts) {
      detachRequestAbort();
      await settleAmbiguousProviderWorkOffPath(
        agent,
        billing,
        options.executionCtx,
        "stream returned without a provider body",
      );
      return sseError("Shared runtime stream did not start");
    }

    const encoder = new TextEncoder();
    const makeTurnMessages = (reply: string, interrupted: boolean): SharedTurnMessage[] => {
      const sentAt = Date.now();
      const messages: SharedTurnMessage[] = [
        { id: messageIds.user, role: "user", content: text, createdAt: sentAt },
      ];
      const assistantText = reply.trim();
      if (assistantText) {
        messages.push({
          id: messageIds.assistant,
          role: "assistant",
          content: assistantText,
          createdAt: sentAt + 1,
          interrupted,
        });
      }
      return messages;
    };
    let finalizationPromise: Promise<void> | null = null;
    let finalized = false;
    let streamedReply = "";
    let terminalSettlementStarted = false;
    let consumerCanceled = false;
    const settleInterruptedTurn = async (reason: string): Promise<void> => {
      if (terminalSettlementStarted) return;
      terminalSettlementStarted = true;
      if (isDeterministicFreeTurn(turn)) {
        await billing?.settle(0);
        return;
      }
      await settleAmbiguousProviderWorkOffPath(agent, billing, options.executionCtx, reason);
    };
    const finalizeMessages = (
      reply: string,
      interrupted: boolean,
      afterWrite?: () => Promise<void>,
    ): Promise<void> => {
      if (finalized) return finalizationPromise ?? Promise.resolve();
      if (finalizationPromise) return finalizationPromise;
      finalizationPromise = (async () => {
        await mergeHistory(
          agent.id,
          roomId,
          makeTurnMessages(reply, interrupted),
          options.historyStore,
        );
        await afterWrite?.();
        finalized = true;
      })().catch((error) => {
        finalizationPromise = null;
        throw error;
      });
      return finalizationPromise;
    };
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        let finished = false;
        try {
          for await (const part of turn.parts!) {
            if (part.type === "text-delta") {
              streamedReply += part.text;
              if (consumerCanceled) continue;
              controller.enqueue(
                encoder.encode(
                  chatSseFrame("chunk", {
                    messageId: messageIds.assistant,
                    userMessageId: messageIds.user,
                    chunk: part.text,
                    text: part.text,
                    fullText: streamedReply,
                    timestamp: Date.now(),
                  }),
                ),
              );
              continue;
            }
            if (consumerCanceled) continue;
            finished = true;
            const finalReply = part.text.trim() || streamedReply.trim();
            if (!finalReply) {
              // An empty completion is a failed turn: never fabricate, persist,
              // or bill a placeholder reply (repo policy: throw, never fabricate).
              terminalSettlementStarted = true;
              await settleAmbiguousProviderWorkOffPath(
                agent,
                billing,
                options.executionCtx,
                "provider completed without visible output",
              );
              controller.enqueue(
                encoder.encode(
                  chatSseFrame("error", {
                    message: "Shared runtime stream produced an empty reply",
                  }),
                ),
              );
              continue;
            }
            const actionResults = turnActionResults(turn);
            await finalizeMessages(finalReply, false, async () => {
              // Durable claim completion before the done frame: a lost/dropped
              // terminal frame replays this result on retry instead of
              // re-dispatching the provider. Interrupted turns stay pending.
              if (claimKey && options.turnClaims) {
                await options.turnClaims.complete(claimKey, {
                  text: finalReply,
                  messageId: messageIds.assistant,
                  userMessageId: messageIds.user,
                  agentName: character.name,
                  channelId: roomId,
                  model: turn.model,
                  degraded: false,
                  runtime: "shared",
                  transport: "shared-runtime",
                  ...(actionResults ? { actionResults } : {}),
                });
              }
              if (isDeterministicFreeTurn(turn)) {
                terminalSettlementStarted = true;
                await billing?.settle(0);
              } else if (billing) {
                terminalSettlementStarted = true;
                await settleOffResponsePath(options.executionCtx, () =>
                  finishBilling(agent, billing, finalReply, text, part.usage),
                );
              }
            });
            const done = actionResults
              ? {
                  messageId: messageIds.assistant,
                  userMessageId: messageIds.user,
                  text: finalReply,
                  fullText: finalReply,
                  actionResults,
                }
              : {
                  messageId: messageIds.assistant,
                  userMessageId: messageIds.user,
                  text: finalReply,
                  fullText: finalReply,
                };
            controller.enqueue(encoder.encode(chatSseFrame("done", done)));
          }
          if (!finished) {
            await finalizeMessages(streamedReply, true, () =>
              settleInterruptedTurn("provider stream ended without completion"),
            );
            if (!consumerCanceled) {
              controller.enqueue(
                encoder.encode(
                  chatSseFrame("error", {
                    message: "Shared runtime stream ended without completion",
                  }),
                ),
              );
            }
          }
        } catch (error) {
          // error-policy:J1 partial SSE cannot become an HTTP error.
          await finalizeMessages(streamedReply, true, async () => {
            if (!terminalSettlementStarted) {
              terminalSettlementStarted = true;
              await settleFailedProviderWorkOffPath(
                agent,
                billing,
                options.executionCtx,
                error,
                "provider stream failed after dispatch",
                streamedReply.length > 0,
              );
            }
          });
          logger.warn("[SharedRuntimeChatService] stream failed", {
            agentId: agent.id,
            error: error instanceof Error ? error.message : String(error),
          });
          if (!consumerCanceled) {
            controller.enqueue(
              encoder.encode(chatSseFrame("error", { message: "Shared runtime stream failed" })),
            );
          }
        } finally {
          detachRequestAbort();
          if (!consumerCanceled) {
            controller.close();
          }
        }
      },
      cancel: async (reason) => {
        consumerCanceled = true;
        const persistence = finalizeMessages(streamedReply, true, () =>
          settleInterruptedTurn("consumer canceled stream"),
        );
        generationAbort.abort(reason);
        const providerCancellation = turn.cancel?.(reason) ?? Promise.resolve();
        const [providerResult, persistenceResult] = await Promise.allSettled([
          providerCancellation,
          persistence,
        ]);
        if (persistenceResult.status === "rejected") {
          throw persistenceResult.reason;
        }
        if (providerResult.status === "rejected") {
          throw providerResult.reason;
        }
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  }
}

export const sharedRuntimeChatService = new SharedRuntimeChatService();

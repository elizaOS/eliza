/**
 * Cache-only shared-tier chat execution for Cloudflare Workers.
 *
 * Resolved agent scope and conversation-local storage are injected by the
 * route coordinator. The response path reads only cached character, history,
 * and balance state; metering and database mirrors run under waitUntil.
 */

import crypto from "node:crypto";
import type { AgentSandbox } from "../../../db/repositories/agent-sandboxes";
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
import { navIntentActionResult } from "./shared-nav-intent";
import { SharedRuntimeCacheWarmingError } from "./shared-runtime-errors";
import { MAX_HISTORY_MESSAGES } from "./shared-runtime-history-policy";

export { MAX_HISTORY_MESSAGES } from "./shared-runtime-history-policy";

const BRIDGE_INSUFFICIENT_CREDITS_CODE = -32002;
const linkedCharacterMemoryCache = new InMemoryLRUCache<UserCharacter>(256, 60_000);

export type BridgeExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

export interface SharedRuntimeHistoryStore {
  load(agentId: string, channelId: string): Promise<SharedTurnMessage[]>;
  merge(
    agentId: string,
    channelId: string,
    messages: SharedTurnMessage[],
  ): Promise<SharedTurnMessage[]>;
}

export interface SharedRuntimeChatOptions {
  abortSignal?: AbortSignal;
  executionCtx?: BridgeExecutionContext;
  historyStore?: SharedRuntimeHistoryStore;
}

export { SharedRuntimeCacheWarmingError } from "./shared-runtime-errors";

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
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
  agent: AgentSandbox,
  options: {
    cacheOnly: boolean;
    executionCtx?: BridgeExecutionContext;
  },
): Promise<SharedAgentCharacter> {
  const config = record(agent.agent_config) ?? {};
  const configuredCharacter = record(config.character) ?? config;
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
  if (linked && linked.organization_id !== agent.organization_id) {
    throw new Error("[shared-runtime] linked character organization mismatch");
  }
  const settings = record(linked?.settings);
  const name =
    stringValue(linked?.name) ??
    stringValue(configuredCharacter.name) ??
    stringValue(config.name) ??
    agent.agent_name ??
    "Eliza agent";
  const system =
    stringValue(linked?.system) ??
    stringValue(configuredCharacter.system) ??
    stringValue(config.system) ??
    stringValue(configuredCharacter.prompt) ??
    stringValue(config.prompt) ??
    `You are ${name}, a helpful assistant.`;
  const bio = [
    ...stringList(linked?.bio),
    ...stringList(configuredCharacter.bio),
    ...stringList(config.bio),
  ];
  const model =
    stringValue(settings?.model) ??
    stringValue(configuredCharacter.model) ??
    stringValue(config.model);
  return {
    name,
    system,
    ...(bio.length ? { bio } : {}),
    ...(model ? { model } : {}),
  };
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
  agent: AgentSandbox,
  character: SharedAgentCharacter,
  history: SharedTurnMessage[],
  text: string,
  roomId: string,
  executionCtx?: BridgeExecutionContext,
): Promise<BillingTurn | null> {
  const model = resolveSharedAgentTurnModel(character.model);
  if (!model) return null;
  const estimatedInputTokens = estimateInputTokens(billingPrompt(character, history, text));
  const requestId = `shared-runtime-${crypto.randomUUID()}`;
  const idempotencyKey = `shared-runtime:${agent.id}:${roomId}:${crypto.randomUUID()}`;
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
  if (executionCtx) {
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
  agent: AgentSandbox,
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
  agent: AgentSandbox,
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
  agent: AgentSandbox,
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
  agent: AgentSandbox,
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
    agent: AgentSandbox,
    executionCtx: BridgeExecutionContext,
  ): Promise<SharedAgentCharacter> {
    return await characterFor(agent, { cacheOnly: true, executionCtx });
  }

  async bridge(
    agent: AgentSandbox,
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
    const [character, history] = await Promise.all([
      characterFor(agent, {
        cacheOnly: Boolean(options.historyStore),
        executionCtx: options.executionCtx,
      }),
      loadHistory(agent.id, roomId, options.historyStore),
    ]);
    let billing: BillingTurn | null;
    try {
      billing = await admitTurn(agent, character, history, text, roomId, options.executionCtx);
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

    const messageIds = turnMessageIds(agent.id, roomId, rpc);
    let turn: RunSharedAgentTurnResult;
    try {
      turn = await runSharedAgentTurn({
        character,
        history,
        message: text,
        messageIds,
        onProviderDispatch: billing?.markProviderDispatched,
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
      turnIsProvablyFree = turn.degraded || Boolean(turn.navIntent);
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
        if (turn.navIntent) {
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
        result: {
          text: turn.reply,
          messageId: messageIds.assistant,
          userMessageId: messageIds.user,
          agentName: character.name,
          channelId: roomId,
          model: turn.model,
          degraded: turn.degraded,
          runtime: "shared",
          transport: "shared-runtime",
          ...(turn.navIntent ? { actionResults: [navIntentActionResult(turn.navIntent)] } : {}),
        },
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
    agent: AgentSandbox,
    rpc: BridgeRequest,
    options: SharedRuntimeChatOptions = {},
  ): Promise<Response> {
    const params = record(rpc.params) ?? {};
    const text = stringValue(params.text);
    if (!text) return sseError("message.send requires params.text");
    const roomId = channelId(agent.id, params);
    const [character, history] = await Promise.all([
      characterFor(agent, {
        cacheOnly: Boolean(options.historyStore),
        executionCtx: options.executionCtx,
      }),
      loadHistory(agent.id, roomId, options.historyStore),
    ]);
    let billing: BillingTurn | null;
    try {
      billing = await admitTurn(agent, character, history, text, roomId, options.executionCtx);
    } catch (error) {
      // error-policy:J1 translate the money boundary to the HTTP stream boundary.
      if (error instanceof InsufficientCreditsError) {
        throw new InsufficientCreditsApiError(
          `Insufficient credits. Required: $${error.required.toFixed(4)}, Available: $${error.available.toFixed(4)}`,
        );
      }
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
      if (turn.navIntent) {
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
            await finalizeMessages(finalReply, false, async () => {
              if (turn.navIntent) {
                terminalSettlementStarted = true;
                await billing?.settle(0);
              } else if (billing) {
                terminalSettlementStarted = true;
                await settleOffResponsePath(options.executionCtx, () =>
                  finishBilling(agent, billing, finalReply, text, part.usage),
                );
              }
            });
            const done = turn.navIntent
              ? {
                  messageId: messageIds.assistant,
                  userMessageId: messageIds.user,
                  text: finalReply,
                  fullText: finalReply,
                  actionResults: [navIntentActionResult(turn.navIntent)],
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

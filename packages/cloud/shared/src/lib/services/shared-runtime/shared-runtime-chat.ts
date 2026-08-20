/**
 * Cache-only shared-tier chat execution for Cloudflare Workers.
 *
 * Resolved agent scope and conversation-local storage are injected by the
 * route coordinator. The response path reads only cached character, history,
 * and balance state; metering and database mirrors run under waitUntil.
 */

import crypto from "node:crypto";
import { ChannelType, ElizaError, MESSAGE_SOURCE_CLIENT_CHAT } from "@elizaos/core/edge";
import { parseSharedReminderDelivery } from "@elizaos/plugin-scheduling/edge";
import type { UserCharacter } from "../../../db/repositories/characters";
import { sharedTurnTracesRepository } from "../../../db/repositories/shared-turn-traces";
import {
  InsufficientCreditsError as InsufficientCreditsApiError,
  RateLimitError,
} from "../../api/errors";
import { cache } from "../../cache/client";
import { InMemoryLRUCache } from "../../cache/in-memory-lru-cache";
import { CacheTTL } from "../../cache/keys";
import { enforceOrgRateLimit, OrgRateLimitCacheNotReadyError } from "../../middleware/rate-limit";
import { getProviderFromModel } from "../../pricing";
import { getCloudAwareEnv, getCloudBinding } from "../../runtime/cloud-bindings";
import type { PublicObjectBindings } from "../../storage/r2-public-object";
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
import { DEFAULT_IMAGE_MODEL_ID } from "../ai-pricing-definitions";
import { chatSseFrame } from "../chat-sse-frames";
import type { CreditReconciliationResult, CreditReservation } from "../credits";
import type { BridgeRequest, BridgeResponse } from "../eliza-sandbox-bridge";
import {
  executeImageGeneration,
  imageProviderKeysFromCloudEnvironment,
  isImageGenerationConfigured,
} from "../image-generation";
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
import { isCanonicalPersonalSharedAgent } from "./personal-shared-identity";
import {
  type RunSharedAgentTurnInput,
  type RunSharedAgentTurnResult,
  resolveSharedAgentTurnModel,
  runSharedAgentTurn,
  runSharedAgentTurnStream,
  type SharedAgentCharacter,
  type SharedAgentTurnUsage,
  type SharedMediaGenerationPort,
  type SharedTurnMessage,
} from "./run-shared-agent-turn";
import { projectSharedAgentCharacter } from "./shared-agent-character";
import { capabilityWallActionResult } from "./shared-capability-wall";
import {
  buildSharedFactsContext,
  extractSharedTurnFacts,
  SHARED_FACTS_CONTEXT_MAX_FACTS,
  SHARED_FACTS_EXTRACTION_TIMEOUT_MS,
  sharedFactsEnabled,
} from "./shared-facts";
import { createSharedMemoryStore, type SharedMemoryStore } from "./shared-memory-store";
import {
  buildSharedRecallContext,
  embedTextsViaSidecar,
  embedTextViaSidecar,
  SHARED_RECALL_DEFAULT_TOP_K,
  SHARED_RECALL_EMBEDDING_MODEL,
} from "./shared-recall";
import type { SharedRuntimeAgent } from "./shared-runtime-agent";
import { SharedRuntimeCacheWarmingError, SharedTurnConflictError } from "./shared-runtime-errors";
import { MAX_HISTORY_MESSAGES } from "./shared-runtime-history-policy";
import { normalizeSharedRuntimeRoom } from "./shared-runtime-room-identity";
import {
  replayedSharedProviderTiming,
  type SharedProviderTimingReceipt,
  type SharedRuntimeTimingReceipt,
} from "./shared-runtime-timing";
import { createSharedScheduledTaskRunner } from "./shared-scheduling";
import { createSharedTodoStore, sharedTodoStorageScope } from "./shared-todos";
import { sharedTurnClientMessageId } from "./shared-turn-client-message-id";
import {
  buildTurnSummary,
  recordSharedTurnTrace,
  type SharedTurnSummaryResult,
} from "./shared-turn-trace-recorder";

export { MAX_HISTORY_MESSAGES } from "./shared-runtime-history-policy";
export { sharedTurnClientMessageId } from "./shared-turn-client-message-id";

const BRIDGE_INSUFFICIENT_CREDITS_CODE = -32002;
const PROVIDER_CANCELLATION_OBSERVE_MS = 5_000;
const PERSONAL_SHARED_RATE_LIMIT = { windowMs: 60_000, maxRequests: 60 } as const;
const linkedCharacterMemoryCache = new InMemoryLRUCache<UserCharacter>(256, 60_000);

function elapsedTurnMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}

function withTurnTimingHeaders(response: Response, timings: Record<string, number>): Response {
  const entries = Object.entries(timings).filter(([, duration]) => Number.isFinite(duration));
  if (entries.length === 0) return response;
  const headers = new Headers(response.headers);
  const existing = headers.get("Server-Timing");
  const current = entries.map(([phase, duration]) => `${phase};dur=${duration}`).join(", ");
  headers.set("Server-Timing", existing ? `${existing}, ${current}` : current);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export type BridgeExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

export interface SharedRuntimeHistoryStore {
  load(agentId: string, channelId: string, queryText?: string): Promise<SharedTurnMessage[]>;
  merge(
    agentId: string,
    channelId: string,
    messages: SharedTurnMessage[],
  ): Promise<SharedTurnMessage[]>;
}

/**
 * P5 sampled turn trace, recorded strictly off the response path. The recorder
 * self-gates on SHARED_TURN_TRACES_ENABLED + deterministic trace-id sampling
 * and never throws, so this adds zero turn latency and zero failure surface.
 */
function recordTurnTraceOffPath(
  executionCtx: BridgeExecutionContext | undefined,
  agent: SharedRuntimeAgent,
  channelId: string,
  traceId: string,
  startedAt: number,
  result: SharedTurnSummaryResult,
  terminalTiming?: SharedRuntimeTimingReceipt,
): void {
  void settleOffResponsePath(executionCtx, async () => {
    const summary = buildTurnSummary({
      result,
      organizationId: agent.organization_id,
      userId: agent.user_id,
      agentId: agent.id,
      channelId,
      traceId,
      startedAt,
      completedAt: Date.now(),
    });
    await recordSharedTurnTrace(
      { insertTrace: (row) => sharedTurnTracesRepository.insertTrace(row) },
      {
        ...summary,
        ...(terminalTiming ? { terminalTiming } : {}),
      },
    );
  });
}

/** Persist error/abort receipts through the same durable sampled trace row. */
function recordFailedTurnTraceOffPath(
  executionCtx: BridgeExecutionContext | undefined,
  agent: SharedRuntimeAgent,
  channelId: string,
  model: string,
  startedAt: number,
  terminalTiming: SharedRuntimeTimingReceipt | undefined,
): void {
  if (!terminalTiming) return;
  void settleOffResponsePath(executionCtx, async () => {
    const completedAt = Date.now();
    await recordSharedTurnTrace(
      { insertTrace: (row) => sharedTurnTracesRepository.insertTrace(row) },
      {
        organizationId: agent.organization_id,
        userId: agent.user_id,
        agentId: agent.id,
        channelId,
        traceId: terminalTiming.traceId,
        startedAt,
        // The bounded runtime offset can be null when the measurement is
        // unavailable or rejected. The trace row still has an honest wall
        // clock duration instead of fabricating a healthy zero-millisecond
        // failure.
        latencyMs: Math.max(0, Math.round(completedAt - startedAt)),
        model,
        finishReason: terminalTiming.outcome === "aborted" ? "aborted" : "error",
        stages: [{ name: "runtime" }],
        terminalTiming,
      },
    );
  });
}

function turnActionResults(
  turn: Pick<
    RunSharedAgentTurnResult,
    "actionResults" | "capabilityWall" | "blockedSecondaryCapabilities"
  >,
  context: { agentId: string; originalIntent: string; clientMessageId?: string },
): unknown[] | undefined {
  const results: unknown[] = [...(turn.actionResults ?? [])];
  if (turn.capabilityWall) {
    results.push(capabilityWallActionResult(turn.capabilityWall, context));
  }
  for (const wall of turn.blockedSecondaryCapabilities ?? []) {
    results.push(capabilityWallActionResult(wall, context));
  }
  return results.length ? results : undefined;
}

function isProviderFreeTurn(
  turn: Pick<RunSharedAgentTurnResult, "capabilityWall" | "model">,
): boolean {
  // Capability refusals now run through the agent model so they stay in
  // character. Retain compatibility for replayed legacy wall-only turns.
  return Boolean(turn.capabilityWall && turn.model === "capability-wall");
}

/** Terminal result of a landed shared turn, durably replayable by claim key. */
export interface SharedTurnTerminalResult {
  text: string;
  responded?: boolean;
  messageId: string;
  userMessageId: string;
  agentName: string;
  channelId: string;
  model: string;
  degraded: boolean;
  runtime: "shared";
  transport: "shared-runtime";
  actionResults?: unknown[];
  timing?: SharedProviderTimingReceipt;
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
  /** Standard request trace propagated through the conversation coordinator. */
  traceId?: string;
  abortSignal?: AbortSignal;
  executionCtx?: BridgeExecutionContext;
  historyStore?: SharedRuntimeHistoryStore;
  turnClaims?: SharedTurnClaimStore;
  /** Personal Shared keeps abuse limits but never debits account credits. */
  funding?: "organization-credits" | "platform";
  /** Server-authenticated lifecycle prompt; never derived from bridge params. */
  trustedMessageRole?: "system";
  /** Server-authenticated epoch-ms ceiling applied before admission and model use. */
  trustedHistoryCutoffAt?: number;
  /** Server-authenticated control input is modeled but omitted from durable user history. */
  transientInput?: true;
  /** Server-authenticated raw utterance when the model message includes connector context. */
  trustedUserUtterance?: string;
  /** Server-resolved transport semantics; untrusted RPC params never populate this. */
  channel?: NonNullable<RunSharedAgentTurnInput["execution"]>["channel"];
  mobilePushDispatch?: NonNullable<
    NonNullable<RunSharedAgentTurnInput["execution"]>["mobilePush"]
  >["dispatch"];
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

function trustedReminderDelivery(params: Record<string, unknown>) {
  return parseSharedReminderDelivery(params.trustedDelivery);
}

function imageDimensionsFromMediaSize(size: string | undefined): {
  width?: number;
  height?: number;
} {
  const match = size?.trim().match(/^(\d{3,4})x(\d{3,4})$/u);
  if (!match) return {};
  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  if (width < 128 || width > 4096 || height < 128 || height > 4096) return {};
  return { width, height };
}

function personalSharedImagePort(
  agent: SharedRuntimeAgent,
  roomId: string,
  turnKey: string | undefined,
  executionCtx: BridgeExecutionContext | undefined,
): SharedMediaGenerationPort | undefined {
  const blob = getCloudBinding<PublicObjectBindings["BLOB"]>("BLOB");
  const providerKeys = imageProviderKeysFromCloudEnvironment();
  if (!blob) return undefined;
  const cloudEnv = getCloudAwareEnv();
  const bindings: PublicObjectBindings = {
    BLOB: blob,
    ...(cloudEnv.R2_PUBLIC_HOST ? { R2_PUBLIC_HOST: cloudEnv.R2_PUBLIC_HOST } : {}),
  };
  if (!isImageGenerationConfigured(DEFAULT_IMAGE_MODEL_ID, bindings, providerKeys)) {
    return undefined;
  }

  const turnIdentity = turnKey ?? crypto.randomUUID();
  let actionOrdinal = 0;
  return {
    canGenerateMedia: ({ mediaType }) => mediaType === "image",
    generateMedia: async (request) => {
      if (request.mediaType !== "image") {
        throw new Error("Personal Shared media generation supports images only");
      }
      const ordinal = actionOrdinal;
      actionOrdinal += 1;
      let admissionSnapshot: InferenceAdmissionSnapshot | undefined;
      if (executionCtx) {
        try {
          admissionSnapshot = await getInferenceAdmissionSnapshotCacheOnly(
            agent.organization_id,
            executionCtx,
          );
        } catch (error) {
          // error-policy:J1 translate the cache-only admission boundary into
          // the Shared runtime's single retryable warming signal.
          if (error instanceof InferenceAdmissionSnapshotCacheWarmingError) {
            throw new SharedRuntimeCacheWarmingError(
              "Image billing authorization is warming. Retry shortly.",
            );
          }
          throw error;
        }
      }
      let rateLimited: Response | null;
      try {
        rateLimited = await enforceOrgRateLimit(agent.organization_id, "strict", {
          cacheOnly: Boolean(executionCtx),
          executionCtx,
          config: inferenceRateLimitConfig(admissionSnapshot, "strict"),
        });
      } catch (error) {
        // error-policy:J1 translate the cache-only rate-limit boundary into
        // the Shared runtime's single retryable warming signal.
        if (error instanceof OrgRateLimitCacheNotReadyError) {
          throw new SharedRuntimeCacheWarmingError(
            "Image rate-limit authorization is warming. Retry shortly.",
          );
        }
        throw error;
      }
      if (rateLimited) {
        if (rateLimited.status === 429) {
          const retryAfter = Number.parseInt(rateLimited.headers.get("Retry-After") ?? "", 10);
          throw new RateLimitError(
            "Image generation rate limit exceeded.",
            Number.isFinite(retryAfter) ? retryAfter : undefined,
          );
        }
        throw new SharedRuntimeCacheWarmingError(
          "Image rate-limit authorization is unavailable. Retry shortly.",
        );
      }

      const outcome = await executeImageGeneration({
        input: {
          prompt: request.prompt,
          model: DEFAULT_IMAGE_MODEL_ID,
          numImages: 1,
          aspectRatio: request.aspectRatio,
          stylePreset: request.style,
          sourceImage: request.imageUrl,
          ...imageDimensionsFromMediaSize(request.size),
        },
        actor: {
          organizationId: agent.organization_id,
          userId: agent.user_id,
          apiKeyId: null,
        },
        identity: {
          requestId: `shared-image:${stableUuid(`${agent.id}:${roomId}:${turnIdentity}:${ordinal}`)}`,
          source: "personal-shared",
          description: `Personal Shared image generation: ${agent.id}`,
          metadata: {
            agentId: agent.id,
            channelId: roomId,
            actionOrdinal: ordinal,
            runtime: "shared",
          },
        },
        bindings,
        providerKeys,
        admit: async ({ context, cost }) => ({
          kind: "organization" as const,
          admission: await admitOrganizationInference({
            context,
            apiKeyId: null,
            estimatedInputTokens: 0,
            estimatedOutputTokens: 0,
            flatCost: cost,
            executionCtx,
            admissionSnapshot,
          }),
        }),
      });
      const image = outcome.images[0];
      if (!image) throw new Error("Canonical Cloud image generation returned no artifact");
      return {
        mediaType: "image",
        url: image.url,
        imageUrl: image.url,
        mimeType: image.mimeType,
        provider: outcome.provider,
      };
    },
  };
}

function sharedElizaRuntimeExecution(
  agent: SharedRuntimeAgent,
  roomId: string,
  turnKey: string | undefined,
  params: Record<string, unknown>,
  funding: SharedRuntimeChatOptions["funding"],
  executionCtx: BridgeExecutionContext | undefined,
  mobilePushDispatch?: SharedRuntimeChatOptions["mobilePushDispatch"],
  channel?: NonNullable<RunSharedAgentTurnInput["execution"]>["channel"],
): NonNullable<RunSharedAgentTurnInput["execution"]> {
  const personalShared = funding === "platform" && isCanonicalPersonalSharedAgent(agent);
  const runtimeChannel = channel ?? {
    type: ChannelType.DM,
    source: personalShared ? MESSAGE_SOURCE_CLIENT_CHAT : "shared-runtime",
  };
  const reminderDelivery = personalShared ? trustedReminderDelivery(params) : undefined;
  const media = personalShared
    ? personalSharedImagePort(agent, roomId, turnKey, executionCtx)
    : undefined;
  return {
    agentKey: agent.id,
    roomKey: roomId,
    channel: runtimeChannel,
    // Personal funding is selected by the server-owned coordinator only after
    // account/tenant resolution; RPC params cannot grant this attestation.
    ...(personalShared ? { authenticatedPersonalSharedUser: true as const } : {}),
    todos: {
      scope: sharedTodoStorageScope({
        sourceAgentId: agent.id,
        ownerId: agent.user_id,
      }),
      store: createSharedTodoStore(),
    },
    ...(reminderDelivery
      ? {
          reminders: {
            delivery: reminderDelivery,
            runner: createSharedScheduledTaskRunner(agent.id, {
              dispatch: async () => {
                throw new Error(
                  "Interactive Shared turns cannot fire reminders; Cloudflare cron owns dispatch",
                );
              },
            }),
          },
        }
      : {}),
    ...(mobilePushDispatch ? { mobilePush: { dispatch: mobilePushDispatch } } : {}),
    ...(media ? { media } : {}),
  };
}

/**
 * Flag-gated durable memory mirror for one turn (P2 edge memory store). Null
 * while `SHARED_MEMORY_TABLES_ENABLED !== "true"`. Tenant scope comes from the
 * server-resolved agent row, so a client can never choose the tenant; storage
 * uuids reuse the Todo scope so memory rows line up with the runtime's
 * projected identities.
 */
function sharedTurnMemoryStore(agent: SharedRuntimeAgent, roomId: string) {
  const embedBase = process.env.LOCAL_EMBEDDINGS_BASE_URL;
  const embed =
    sharedRecallEnabled() && embedBase
      ? {
          embedTexts: (texts: string[]) =>
            embedTextsViaSidecar(embedBase, process.env.LOCAL_EMBEDDINGS_API_KEY, texts),
          model: SHARED_RECALL_EMBEDDING_MODEL,
        }
      : undefined;
  return createSharedMemoryStore(
    {
      organizationId: agent.organization_id,
      userId: agent.user_id,
      agentKey: agent.id,
      roomKey: roomId,
      storage: sharedTodoStorageScope({
        sourceAgentId: agent.id,
        ownerId: agent.user_id,
      }),
    },
    embed,
  );
}

/**
 * P3 rollout gate: semantic recall exists only while this is exactly "true"
 * AND the sidecar base URL is configured. Off (the default) leaves every turn
 * byte-identical to the pre-recall path.
 */
function sharedRecallEnabled(): boolean {
  return (
    process.env.SHARED_RECALL_ENABLED === "true" && Boolean(process.env.LOCAL_EMBEDDINGS_BASE_URL)
  );
}

/**
 * Compose the recall block for one turn, or undefined when recall contributes
 * nothing. Recall is an enhancement: a typed embed/search failure is warned
 * and the turn proceeds without it rather than failing a healthy reply.
 * `hadKeywordHit` is pinned false for the rollout phase — the lexical-salience
 * signal is not yet surfaced from the history store, so flag-on turns pay one
 * sidecar embed each; the short-circuit lands when that signal is plumbed.
 */
async function sharedTurnRecallContext(
  store: SharedMemoryStore | null,
  queryText: string,
  history: SharedTurnMessage[],
): Promise<string | undefined> {
  if (!store || !sharedRecallEnabled()) return undefined;
  const embedBase = process.env.LOCAL_EMBEDDINGS_BASE_URL;
  if (!embedBase) return undefined;
  try {
    const block = await buildSharedRecallContext({
      flagEnabled: true,
      hadKeywordHit: false,
      queryText,
      history,
      embed: (text) => embedTextViaSidecar(embedBase, process.env.LOCAL_EMBEDDINGS_API_KEY, text),
      storeSearch: async (vector) => {
        const hits = await store.searchByEmbedding(vector, SHARED_RECALL_DEFAULT_TOP_K);
        return hits.map((hit) => ({
          id: hit.id,
          role: hit.entity_id === hit.agent_id ? ("assistant" as const) : ("user" as const),
          content:
            typeof (hit.content as { text?: unknown })?.text === "string"
              ? (hit.content as { text: string }).text
              : "",
          createdAt: hit.created_at ? new Date(hit.created_at).getTime() : undefined,
        }));
      },
    });
    return block ?? undefined;
  } catch (error) {
    // error-policy:J4 recall loss degrades to a recall-free turn; the warn is
    // the visible signal and the reply itself stays healthy.
    logger.warn(
      `[shared-runtime-chat] semantic recall unavailable this turn: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

/**
 * P4 knowledge parity: renders the known-facts provider block for one turn, or
 * undefined while the flag is off, the memory store is absent, or the tenant
 * has no facts yet. Facts are an enhancement — a typed read failure degrades
 * to a facts-free turn rather than failing a healthy reply.
 */
async function sharedTurnFactsContext(
  store: SharedMemoryStore | null,
): Promise<string | undefined> {
  if (!store || !sharedFactsEnabled()) return undefined;
  try {
    const facts = await store.listFacts(SHARED_FACTS_CONTEXT_MAX_FACTS);
    return buildSharedFactsContext(facts) ?? undefined;
  } catch (error) {
    // error-policy:J4 knowledge loss degrades to a facts-free turn; the warn is
    // the visible signal and the reply itself stays healthy.
    logger.warn(
      `[shared-runtime-chat] facts context unavailable this turn: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

/** Joins the facts and recall provider blocks into one runtime context block. */
function combinedTurnContext(
  factsContext: string | undefined,
  recallContext: string | undefined,
): string | undefined {
  const parts = [factsContext, recallContext].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.length ? parts.join("\n\n") : undefined;
}

/**
 * P4 post-turn facts extraction, strictly off the response path (same shape as
 * the P5 trace recorder): one small extraction call through the SAME platform
 * model path the turn used, deduped against known facts, written as durable
 * `facts` rows. Runs only for landed user turns while the flag is on; any
 * failure is warned and dropped so knowledge accumulation can never fail or
 * slow a delivered reply.
 */
function extractSharedTurnFactsOffPath(
  executionCtx: BridgeExecutionContext | undefined,
  store: SharedMemoryStore | null,
  character: SharedAgentCharacter,
  userMessage: string,
  assistantReply: string,
): void {
  if (!store || !sharedFactsEnabled()) return;
  const model = resolveSharedAgentTurnModel(character.model);
  if (!model) return;
  void settleOffResponsePath(executionCtx, async () => {
    try {
      const [{ generateText }, { getInteractiveCerebrasLanguageModel }, knownFacts] =
        await Promise.all([
          import("ai"),
          import("../../providers/language-model"),
          store.listFacts(SHARED_FACTS_CONTEXT_MAX_FACTS),
        ]);
      const facts = await extractSharedTurnFacts({
        agentName: character.name,
        userMessage,
        assistantReply,
        knownFacts,
        generate: async (prompt) => {
          const result = await generateText({
            model: getInteractiveCerebrasLanguageModel(model),
            prompt,
            temperature: 0,
            maxOutputTokens: 512,
            maxRetries: 0,
            // A stalled provider request must not pin the waitUntil task open;
            // the deadline surfaces as a distinct AbortError in the J7 warn.
            abortSignal: AbortSignal.timeout(SHARED_FACTS_EXTRACTION_TIMEOUT_MS),
          });
          return result.text;
        },
      });
      if (facts.length) await store.recordFacts(facts);
    } catch (error) {
      // error-policy:J7 knowledge extraction is off-path enrichment; its
      // failure must never surface into the already-delivered turn.
      logger.warn(
        `[shared-runtime-chat] facts extraction failed for this turn: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });
}

function stableUuid(raw: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
    return raw;
  }
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
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

function turnMessageIds(
  agentId: string,
  roomId: string,
  clientMessageId: string | undefined,
): {
  user: string;
  assistant: string;
} {
  // JSON-RPC ids correlate one connection's responses; clients may restart
  // their counters and legitimately reuse `1`. Only the durable client key is
  // a cross-session mutation identity. An unkeyed request therefore receives
  // fresh message ids and accepts the documented loss of retry deduplication
  // instead of colliding with an old Todo ledger entry.
  const turn = clientMessageId ?? crypto.randomUUID();
  return {
    user: stableUuid(`shared-runtime:${agentId}:${roomId}:${turn}:user`),
    assistant: stableUuid(`shared-runtime:${agentId}:${roomId}:${turn}:assistant`),
  };
}

export function sharedRuntimeChannelId(agentId: string, roomId: string): string {
  const room = roomId.trim() || "default";
  return stableUuid(`cloud-bridge-channel:${agentId}:${room}`);
}

export { normalizeSharedRuntimeRoom } from "./shared-runtime-room-identity";

/** Storage-safe runtime room key derived from the coordinator's canonical room label. */
export function sharedRuntimeRoomKey(agentId: string, roomId?: unknown, userId?: unknown): string {
  const room = normalizeSharedRuntimeRoom(roomId, userId);
  return sharedRuntimeChannelId(agentId, room);
}

function isTurn(value: unknown): value is SharedTurnMessage {
  const candidate = record(value);
  return (
    (candidate?.role === "system" ||
      candidate?.role === "user" ||
      candidate?.role === "assistant") &&
    typeof candidate.content === "string" &&
    candidate.content.trim().length > 0
  );
}

async function loadHistory(
  agentId: string,
  roomId: string,
  store?: SharedRuntimeHistoryStore,
  queryText?: string,
): Promise<SharedTurnMessage[]> {
  const history = store
    ? await store.load(agentId, roomId, queryText)
    : await import("../../../db/repositories/shared-runtime-history").then(
        ({ sharedRuntimeHistoryRepository }) => sharedRuntimeHistoryRepository.get(agentId, roomId),
      );
  return history.filter(isTurn);
}

function constrainTrustedLifecycleHistory(
  history: SharedTurnMessage[],
  options: SharedRuntimeChatOptions,
): SharedTurnMessage[] {
  const cutoff = options.trustedHistoryCutoffAt;
  if (cutoff === undefined) return history;
  if (options.trustedMessageRole !== "system" || !Number.isSafeInteger(cutoff) || cutoff <= 0) {
    throw new ElizaError("Shared runtime received an invalid trusted history cutoff", {
      code: "INVALID_TRUSTED_HISTORY_CUTOFF",
      context: { cutoff, trustedMessageRole: options.trustedMessageRole },
      severity: "fatal",
    });
  }
  // A lifecycle opener may consume only messages proven to predate the call.
  // Undated legacy rows cannot satisfy that privacy assertion and fail closed.
  return history.filter(
    (message) =>
      typeof message.createdAt === "number" &&
      Number.isFinite(message.createdAt) &&
      message.createdAt < cutoff,
  );
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
      config:
        funding === "platform"
          ? PERSONAL_SHARED_RATE_LIMIT
          : inferenceRateLimitConfig(admissionSnapshot, "completions"),
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
  // Personal Shared is a platform service: enforce abuse controls above, but
  // keep user credits untouched. Dedicated is the explicit paid-compute line.
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

/**
 * Observe provider teardown without keeping the response-body cancel path open.
 *
 * The Durable Object releases its per-room turn lock only after the response
 * body cancel resolves. Provider reader cancellation is best-effort after the
 * generation AbortSignal has fired and can itself hang in an SDK/transport.
 * Waiting for it here would wedge every later room turn even after interrupted
 * history is durable. Keep the teardown under waitUntil for one bounded
 * observation window while the caller waits only for persistence.
 */
function observeProviderCancellationOffPath(
  agentId: string,
  cancellation: Promise<void>,
  executionCtx: BridgeExecutionContext | undefined,
): void {
  void settleOffResponsePath(executionCtx, async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      cancellation.then(
        () => ({ state: "settled" as const }),
        // error-policy:J6 provider teardown is best-effort after the durable
        // interrupted turn has released the room lock; keep failure observable.
        (error: unknown) => ({ state: "rejected" as const, error }),
      ),
      new Promise<{ state: "timed_out" }>((resolve) => {
        timer = setTimeout(() => resolve({ state: "timed_out" }), PROVIDER_CANCELLATION_OBSERVE_MS);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome.state === "settled") return;
    logger.warn("[SharedRuntimeChatService] provider stream cancellation did not settle cleanly", {
      agentId,
      outcome: outcome.state,
      ...(outcome.state === "rejected"
        ? {
            error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
          }
        : {}),
    });
  });
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
  async recordLifecycleEvent(
    agentId: string,
    roomId: string,
    event: SharedTurnMessage,
    store: SharedRuntimeHistoryStore,
  ): Promise<void> {
    await mergeHistory(agentId, sharedRuntimeRoomKey(agentId, roomId), [event], store);
  }

  async getHistory(
    agentId: string,
    roomId = agentId,
    store?: SharedRuntimeHistoryStore,
  ): Promise<SharedTurnMessage[]> {
    return await loadHistory(agentId, sharedRuntimeRoomKey(agentId, roomId), store);
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
    const roomId = sharedRuntimeRoomKey(agent.id, params.roomId, params.userId);
    const messageRole = options.trustedMessageRole ?? "user";
    const claimKey = options.turnClaims ? sharedTurnClientMessageId(params) : undefined;
    if (claimKey && options.turnClaims) {
      const replay = await claimSharedTurn(options.turnClaims, claimKey, text);
      if (replay) {
        return {
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            ...replay,
            timing: replayedSharedProviderTiming(),
          } as unknown as Record<string, unknown>,
        };
      }
    }
    const [character, loadedHistory] = await Promise.all([
      characterFor(agent, {
        cacheOnly: Boolean(options.historyStore),
        executionCtx: options.executionCtx,
      }),
      loadHistory(agent.id, roomId, options.historyStore, text),
    ]);
    const history = constrainTrustedLifecycleHistory(loadedHistory, options);
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

    const messageIds = turnMessageIds(agent.id, roomId, claimKey);
    const memoryStore = options.transientInput ? null : sharedTurnMemoryStore(agent, roomId);
    const [factsContext, recallBlock] = await Promise.all([
      sharedTurnFactsContext(memoryStore),
      sharedTurnRecallContext(memoryStore, text, history),
    ]);
    const recallContext = combinedTurnContext(factsContext, recallBlock);
    const turnStartedAtEpochMs = Date.now();
    let terminalTiming: SharedRuntimeTimingReceipt | undefined;
    let turn: RunSharedAgentTurnResult;
    try {
      turn = await runSharedAgentTurn({
        character,
        history,
        message: text,
        ...(recallContext ? { recallContext } : {}),
        ...(options.trustedUserUtterance ? { capabilityText: options.trustedUserUtterance } : {}),
        messageRole,
        messageIds,
        ...(claimKey ? { originClientMessageId: claimKey } : {}),
        onProviderDispatch: billing?.markProviderDispatched,
        traceId: options.traceId ?? messageIds.assistant,
        onRuntimeTiming: (receipt) => {
          terminalTiming = receipt;
        },
        ...(memoryStore ? { memory: memoryStore } : {}),
        execution: sharedElizaRuntimeExecution(
          agent,
          roomId,
          claimKey,
          params,
          options.funding,
          options.executionCtx,
          options.mobilePushDispatch,
          options.channel,
        ),
      });
    } catch (error) {
      recordFailedTurnTraceOffPath(
        options.executionCtx,
        agent,
        roomId,
        character.model?.trim() || "shared-runtime",
        turnStartedAtEpochMs,
        terminalTiming,
      );
      await settleFailedProviderWorkOffPath(
        agent,
        billing,
        options.executionCtx,
        error,
        "bridge provider invocation failed",
      );
      throw error;
    }

    recordTurnTraceOffPath(
      options.executionCtx,
      agent,
      roomId,
      options.traceId ?? messageIds.assistant,
      turnStartedAtEpochMs,
      turn,
      terminalTiming,
    );
    if (!turn.degraded && turn.responded !== false && messageRole === "user") {
      extractSharedTurnFactsOffPath(options.executionCtx, memoryStore, character, text, turn.reply);
    }
    let turnCompleted = false;
    let turnIsProvablyFree = false;
    try {
      turnIsProvablyFree = turn.degraded || isProviderFreeTurn(turn);
      const actionResults = turnActionResults(turn, {
        agentId: agent.id,
        originalIntent: text,
        ...(claimKey ? { clientMessageId: claimKey } : {}),
      });
      const result: SharedTurnTerminalResult = {
        text: turn.reply,
        ...(turn.responded === false ? { responded: false } : {}),
        messageId: messageIds.assistant,
        userMessageId: messageIds.user,
        agentName: character.name,
        channelId: roomId,
        model: turn.model,
        degraded: turn.degraded,
        runtime: "shared",
        transport: "shared-runtime",
        ...(actionResults ? { actionResults } : {}),
        ...(turn.timing ? { timing: turn.timing } : {}),
      };
      if (turn.degraded) {
        await billing?.settle(0);
      } else {
        await mergeHistory(
          agent.id,
          roomId,
          turn.history.filter(
            (message) =>
              message.id === messageIds.assistant ||
              (!options.transientInput && message.id === messageIds.user),
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
        if (isProviderFreeTurn(turn)) {
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
    const timings: Record<string, number> = {};
    const params = record(rpc.params) ?? {};
    const text = stringValue(params.text);
    if (!text) return sseError("message.send requires params.text");
    const roomId = sharedRuntimeRoomKey(agent.id, params.roomId, params.userId);
    const messageRole = options.trustedMessageRole ?? "user";
    const claimKey = options.turnClaims ? sharedTurnClientMessageId(params) : undefined;
    if (claimKey && options.turnClaims) {
      const claimStartedAt = performance.now();
      const replay = await claimSharedTurn(options.turnClaims, claimKey, text);
      timings.turn_claim = elapsedTurnMs(claimStartedAt);
      if (replay) {
        return withTurnTimingHeaders(
          new Response(
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
                timing: replayedSharedProviderTiming(),
              }),
            { headers: { "Content-Type": "text/event-stream; charset=utf-8" } },
          ),
          timings,
        );
      }
    }
    const hydrateStartedAt = performance.now();
    const [character, loadedHistory] = await Promise.all([
      characterFor(agent, {
        cacheOnly: Boolean(options.historyStore),
        executionCtx: options.executionCtx,
      }),
      loadHistory(agent.id, roomId, options.historyStore, text),
    ]);
    const history = constrainTrustedLifecycleHistory(loadedHistory, options);
    timings.turn_hydrate = elapsedTurnMs(hydrateStartedAt);
    let billing: BillingTurn | null;
    const admissionStartedAt = performance.now();
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
    timings.turn_admission = elapsedTurnMs(admissionStartedAt);
    const messageIds = turnMessageIds(agent.id, roomId, claimKey);
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
    const streamMemoryStore = options.transientInput ? null : sharedTurnMemoryStore(agent, roomId);
    const [streamFactsContext, streamRecallBlock] = await Promise.all([
      sharedTurnFactsContext(streamMemoryStore),
      sharedTurnRecallContext(streamMemoryStore, text, history),
    ]);
    const streamRecallContext = combinedTurnContext(streamFactsContext, streamRecallBlock);
    const streamTurnStartedAtEpochMs = Date.now();
    let streamTerminalTiming: SharedRuntimeTimingReceipt | undefined;
    const providerSetupStartedAt = performance.now();
    try {
      turn = await runSharedAgentTurnStream({
        abortSignal: generationAbort.signal,
        character,
        history,
        message: text,
        ...(streamRecallContext ? { recallContext: streamRecallContext } : {}),
        ...(options.trustedUserUtterance ? { capabilityText: options.trustedUserUtterance } : {}),
        messageRole,
        messageIds,
        ...(claimKey ? { originClientMessageId: claimKey } : {}),
        onProviderDispatch: billing?.markProviderDispatched,
        traceId: options.traceId ?? messageIds.assistant,
        onRuntimeTiming: (receipt) => {
          streamTerminalTiming = receipt;
        },
        execution: sharedElizaRuntimeExecution(
          agent,
          roomId,
          claimKey,
          params,
          options.funding,
          options.executionCtx,
          options.mobilePushDispatch,
          options.channel,
        ),
      });
    } catch (error) {
      recordFailedTurnTraceOffPath(
        options.executionCtx,
        agent,
        roomId,
        character.model?.trim() || "shared-runtime",
        streamTurnStartedAtEpochMs,
        streamTerminalTiming,
      );
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
    timings.turn_provider_setup = elapsedTurnMs(providerSetupStartedAt);
    if (turn.degraded) {
      detachRequestAbort();
      await billing?.settle(0);
      recordTurnTraceOffPath(
        options.executionCtx,
        agent,
        roomId,
        options.traceId ?? messageIds.assistant,
        streamTurnStartedAtEpochMs,
        turn,
        streamTerminalTiming,
      );
      const reply = turn.reply?.trim() ?? "";
      if (!reply) return sseError("Shared runtime is unavailable");
      return withTurnTimingHeaders(
        new Response(
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
        ),
        timings,
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
      return withTurnTimingHeaders(sseError("Shared runtime stream did not start"), timings);
    }

    const encoder = new TextEncoder();
    const makeTurnMessages = (reply: string, interrupted: boolean): SharedTurnMessage[] => {
      const sentAt = Date.now();
      const messages: SharedTurnMessage[] = options.transientInput
        ? []
        : [{ id: messageIds.user, role: messageRole, content: text, createdAt: sentAt }];
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
      if (isProviderFreeTurn(turn)) {
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
        if (streamMemoryStore && !isProviderFreeTurn(turn)) {
          await streamMemoryStore.recordTurnPair({
            userMessage: text.trim(),
            assistantReply: reply,
            messageIds,
            messageRole,
            interrupted,
            channel: options.channel,
          });
        }
        if (!interrupted && messageRole === "user" && reply.trim()) {
          extractSharedTurnFactsOffPath(
            options.executionCtx,
            streamMemoryStore,
            character,
            text,
            reply,
          );
        }
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
            if (part.responded === false) {
              await finalizeMessages("", false, async () => {
                if (claimKey && options.turnClaims) {
                  await options.turnClaims.complete(claimKey, {
                    text: "",
                    responded: false,
                    messageId: messageIds.assistant,
                    userMessageId: messageIds.user,
                    agentName: character.name,
                    channelId: roomId,
                    model: turn.model,
                    degraded: false,
                    runtime: "shared",
                    transport: "shared-runtime",
                    ...(part.timing ? { timing: part.timing } : {}),
                  });
                }
                terminalSettlementStarted = true;
                if (isProviderFreeTurn(turn)) await billing?.settle(0);
                else if (billing) {
                  await settleOffResponsePath(options.executionCtx, () =>
                    finishBilling(agent, billing, "", text, part.usage),
                  );
                }
              });
              controller.enqueue(
                encoder.encode(
                  chatSseFrame("done", {
                    messageId: messageIds.assistant,
                    userMessageId: messageIds.user,
                    text: "",
                    fullText: "",
                    responded: false,
                    ...(part.timing ? { timing: part.timing } : {}),
                  }),
                ),
              );
              continue;
            }
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
            const actionResults = turnActionResults(
              {
                ...turn,
                ...(part.actionResults?.length ? { actionResults: part.actionResults } : {}),
              },
              {
                agentId: agent.id,
                originalIntent: text,
                ...(claimKey ? { clientMessageId: claimKey } : {}),
              },
            );
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
                  ...(part.timing ? { timing: part.timing } : {}),
                  ...(actionResults ? { actionResults } : {}),
                });
              }
              if (isProviderFreeTurn(turn)) {
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
                  ...(part.timing ? { timing: part.timing } : {}),
                }
              : {
                  messageId: messageIds.assistant,
                  userMessageId: messageIds.user,
                  text: finalReply,
                  fullText: finalReply,
                  ...(part.timing ? { timing: part.timing } : {}),
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
            cause:
              error instanceof Error && error.cause instanceof Error
                ? error.cause.message.slice(0, 240)
                : undefined,
          });
          if (!consumerCanceled) {
            controller.enqueue(
              encoder.encode(chatSseFrame("error", { message: "Shared runtime stream failed" })),
            );
          }
        } finally {
          // Runtime timing is emitted only when the provider iterator reaches
          // its terminal success/error/abort path. Persist it with the turn's
          // one durable trace row and therefore one deterministic sample.
          if (streamTerminalTiming?.outcome === "success") {
            recordTurnTraceOffPath(
              options.executionCtx,
              agent,
              roomId,
              options.traceId ?? messageIds.assistant,
              streamTurnStartedAtEpochMs,
              {
                model: turn.model,
                degraded: turn.degraded,
                ...(turn.actionResults ? { actionResults: turn.actionResults } : {}),
                ...(turn.capabilityWall ? { capabilityWall: turn.capabilityWall } : {}),
              },
              streamTerminalTiming,
            );
          } else {
            recordFailedTurnTraceOffPath(
              options.executionCtx,
              agent,
              roomId,
              turn.model,
              streamTurnStartedAtEpochMs,
              streamTerminalTiming,
            );
          }
          detachRequestAbort();
          if (!consumerCanceled) {
            controller.close();
          }
        }
      },
      cancel: async (reason) => {
        consumerCanceled = true;
        // Snapshot exactly the bytes authorized before cancellation. A provider
        // that ignores abort may still produce late deltas, but they cannot
        // change this interrupted turn or write again after finalization.
        const interruptedReply = streamedReply;
        generationAbort.abort(reason);
        const providerCancellation = Promise.resolve()
          .then(async () => {
            await turn.cancel?.(reason);
          })
          .then(() => undefined);
        observeProviderCancellationOffPath(agent.id, providerCancellation, options.executionCtx);

        // The room may advance only after interrupted history is durable. It
        // must not wait for provider teardown: abort is already signalled and
        // consumerCanceled fences all late output from persistence/delivery.
        await finalizeMessages(interruptedReply, true, () =>
          settleInterruptedTurn("consumer canceled stream"),
        );
      },
    });
    return withTurnTimingHeaders(
      new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
        },
      }),
      timings,
    );
  }
}

export const sharedRuntimeChatService = new SharedRuntimeChatService();

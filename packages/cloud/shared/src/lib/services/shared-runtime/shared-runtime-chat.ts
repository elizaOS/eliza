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
import { InsufficientCreditsError as InsufficientCreditsApiError } from "../../api/errors";
import { cache } from "../../cache/client";
import { CacheTTL } from "../../cache/keys";
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
import type { CreditReconciliationResult } from "../credits";
import type { BridgeRequest, BridgeResponse } from "../eliza-sandbox-bridge";
import { InferenceBalanceCacheWarmingError } from "../inference-billing-fast-path";
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

const MAX_HISTORY_MESSAGES = 40;
const BRIDGE_INSUFFICIENT_CREDITS_CODE = -32002;

export type BridgeExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

export interface SharedRuntimeHistoryStore {
  load(agentId: string, channelId: string): Promise<SharedTurnMessage[]>;
  save(agentId: string, channelId: string, history: SharedTurnMessage[]): Promise<void>;
}

export interface SharedRuntimeChatOptions {
  executionCtx?: BridgeExecutionContext;
  historyStore?: SharedRuntimeHistoryStore;
}

export class SharedRuntimeCacheWarmingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SharedRuntimeCacheWarmingError";
  }
}

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

async function saveHistory(
  agentId: string,
  roomId: string,
  history: SharedTurnMessage[],
  store?: SharedRuntimeHistoryStore,
): Promise<void> {
  const capped = history.slice(-MAX_HISTORY_MESSAGES);
  if (store) {
    await store.save(agentId, roomId, capped);
  } else {
    const { sharedRuntimeHistoryRepository } = await import(
      "../../../db/repositories/shared-runtime-history"
    );
    await sharedRuntimeHistoryRepository.upsert(agentId, roomId, capped);
  }
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
  const linked = agent.character_id
    ? options.cacheOnly
      ? await cache.get<UserCharacter>(`character:data:${agent.character_id}`)
      : await import("../../../db/repositories/characters").then(({ userCharactersRepository }) =>
          userCharactersRepository.findByIdInOrganization(
            agent.character_id!,
            agent.organization_id,
          ),
        )
    : undefined;
  if (options.cacheOnly && agent.character_id && !linked) {
    const characterId = agent.character_id;
    const hydration = import("../../../db/repositories/characters")
      .then(({ userCharactersRepository }) =>
        userCharactersRepository.findByIdInOrganization(characterId, agent.organization_id),
      )
      .then(async (character) => {
        if (character) {
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
    if (options.executionCtx) options.executionCtx.waitUntil(hydration);
    else void hydration;
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
  settle(actualCost: number): Promise<CreditReconciliationResult | null>;
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
      prompt: text,
      runtime: "shared",
    },
  };
  let admission: Awaited<ReturnType<typeof admitOrganizationInference>>;
  try {
    admission = await admitOrganizationInference({
      context,
      estimatedInputTokens,
      estimatedOutputTokens: 500,
      executionCtx,
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
    settle: admission.settle,
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
    // error-policy:J1 the reply may already be delivered. The settler releases
    // pre-meter admission at zero or retries the first observed actual cost.
    await billing.settle(0);
    logger.error("[SharedRuntimeChatService] billing failed", {
      agentId: agent.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function sseError(message: string): Response {
  return new Response(`event: error\ndata: ${JSON.stringify({ message })}\n\n`, {
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

  async getCharacter(agent: AgentSandbox): Promise<SharedAgentCharacter> {
    return await characterFor(agent, { cacheOnly: false });
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

    let turnCompleted = false;
    try {
      const turn: RunSharedAgentTurnResult = await runSharedAgentTurn({
        character,
        history,
        message: text,
      });
      if (turn.degraded) {
        await billing?.settle(0);
      } else {
        await saveHistory(agent.id, roomId, turn.history, options.historyStore);
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
      if (!turnCompleted) await billing?.settle(0);
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
    const turn = await runSharedAgentTurnStream({
      character,
      history,
      message: text,
    });
    if (turn.degraded) {
      await billing?.settle(0);
      return new Response(turn.reply ?? "", {
        headers: { "Content-Type": "text/event-stream; charset=utf-8" },
      });
    }
    if (!turn.parts) {
      await billing?.settle(0);
      return sseError("Shared runtime stream did not start");
    }

    const messageId = crypto.randomUUID();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        let reply = "";
        let finished = false;
        try {
          for await (const part of turn.parts!) {
            if (part.type === "text-delta") {
              reply += part.text;
              controller.enqueue(
                encoder.encode(
                  `event: chunk\ndata: ${JSON.stringify({ messageId, chunk: part.text, text: part.text, fullText: reply, timestamp: Date.now() })}\n\n`,
                ),
              );
              continue;
            }
            finished = true;
            const finalReply = part.text.trim() || reply.trim() || "…";
            const sentAt = Date.now();
            await saveHistory(
              agent.id,
              roomId,
              [
                ...history,
                { role: "user", content: text, createdAt: sentAt },
                {
                  role: "assistant",
                  content: finalReply,
                  createdAt: sentAt + 1,
                },
              ],
              options.historyStore,
            );
            if (turn.navIntent) {
              await billing?.settle(0);
            } else if (billing) {
              await settleOffResponsePath(options.executionCtx, () =>
                finishBilling(agent, billing, finalReply, text, part.usage),
              );
            }
            const done = turn.navIntent
              ? {
                  messageId,
                  text: finalReply,
                  actionResults: [navIntentActionResult(turn.navIntent)],
                }
              : { messageId, text: finalReply };
            controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify(done)}\n\n`));
          }
          if (!finished) {
            await billing?.settle(0);
            controller.enqueue(
              encoder.encode(
                `event: error\ndata: ${JSON.stringify({ message: "Shared runtime stream ended without completion" })}\n\n`,
              ),
            );
          }
        } catch (error) {
          // error-policy:J1 partial SSE cannot become an HTTP error.
          await billing?.settle(0);
          logger.warn("[SharedRuntimeChatService] stream failed", {
            agentId: agent.id,
            error: error instanceof Error ? error.message : String(error),
          });
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({ message: "Shared runtime stream failed" })}\n\n`,
            ),
          );
        } finally {
          controller.close();
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

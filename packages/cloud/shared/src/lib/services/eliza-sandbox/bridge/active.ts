/** Owns the production sandbox JSON-RPC and streaming bridge, including shared-turn history and billing settlement. Dedicated transport and runtime readiness are supplied by the service host so routing and authentication retain their canonical boundary. */

import crypto from "node:crypto";
import { ChannelType } from "@elizaos/core/edge";
import {
  type AgentSandbox,
  agentSandboxesRepository,
} from "../../../../db/repositories/agent-sandboxes";
import { userCharactersRepository } from "../../../../db/repositories/characters";
import { sharedRuntimeHistoryRepository } from "../../../../db/repositories/shared-runtime-history";
import { InsufficientCreditsError as InsufficientCreditsApiError } from "../../../api/errors";
import { createCreditReservationSettler } from "../../../utils/credit-reservation";
import { logger } from "../../../utils/logger";
import { settleOffResponsePath } from "../../../utils/settle-off-response-path";
import {
  type AIUsage,
  type BillingContext,
  billUsage,
  estimateInputTokens,
  InsufficientCreditsError,
  reserveCredits,
} from "../../ai-billing";
import { recordSettledInferenceBilling } from "../../ai-billing-settled";
import { chatSseFrame, normalizeChatSseDonePayload } from "../../chat-sse-frames";
import type { CreditReconciliationResult, CreditReservation } from "../../credits";
import {
  type RunSharedAgentTurnResult,
  resolveSharedAgentTurnModel,
  runSharedAgentTurn,
  runSharedAgentTurnStream,
  type SharedAgentCharacter,
  type SharedAgentTurnUsage,
  type SharedTurnMessage,
} from "../../shared-runtime/run-shared-agent-turn";
import {
  BRIDGE_INSUFFICIENT_CREDITS_CODE,
  BridgeExecutionContext,
  BridgeRequest,
  BridgeResponse,
  BridgeRouteUnavailableError,
  DEFAULT_CENTRAL_SERVER_ID,
  RuntimeAgentListResult,
  RuntimeAgentSummary,
} from "./contracts.js";
import { SandboxTransport } from "./transport.js";

export interface SandboxBridgeHost {
  listRuntimeAgents(
    rec: Pick<
      AgentSandbox,
      | "id"
      | "environment_vars"
      | "bridge_url"
      | "health_url"
      | "node_id"
      | "bridge_port"
      | "web_ui_port"
      | "headscale_ip"
      | "sandbox_id"
    >,
  ): Promise<RuntimeAgentListResult>;
  selectRuntimeAgent(agents: RuntimeAgentSummary[]): RuntimeAgentSummary | undefined;
  isRuntimeAgentReady(agent: RuntimeAgentSummary | undefined): boolean;
  fetchAgentWeb(
    ...args: Parameters<SandboxTransport["fetchAgentWeb"]>
  ): ReturnType<SandboxTransport["fetchAgentWeb"]>;
  fetchAgentApi(
    ...args: Parameters<SandboxTransport["fetchAgentApi"]>
  ): ReturnType<SandboxTransport["fetchAgentApi"]>;
  fetchCanonicalConversationApi(
    ...args: Parameters<SandboxTransport["fetchCanonicalConversationApi"]>
  ): ReturnType<SandboxTransport["fetchCanonicalConversationApi"]>;
  ensureRuntimeAgentStarted(
    rec: Pick<
      AgentSandbox,
      | "id"
      | "agent_name"
      | "agent_config"
      | "environment_vars"
      | "bridge_url"
      | "health_url"
      | "node_id"
      | "bridge_port"
      | "web_ui_port"
      | "headscale_ip"
      | "sandbox_id"
      | "organization_id"
      | "user_id"
    >,
  ): Promise<RuntimeAgentSummary | null>;
}

export class ActiveSandboxBridge {
  constructor(private readonly host: SandboxBridgeHost) {}

  stableBridgeUuid(raw: string): string {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
      return raw;
    }
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(
      17,
      20,
    )}-${hash.slice(20, 32)}`;
  }

  stableBridgeUserId(params: Record<string, unknown>): string {
    const raw =
      typeof params.userId === "string" && params.userId.trim()
        ? params.userId.trim()
        : typeof params.roomId === "string" && params.roomId.trim()
          ? params.roomId.trim()
          : "cloud-user";
    return this.stableBridgeUuid(raw);
  }

  stableBridgeChannelId(agentId: string, params: Record<string, unknown>): string {
    const raw =
      typeof params.roomId === "string" && params.roomId.trim()
        ? params.roomId.trim()
        : typeof params.userId === "string" && params.userId.trim()
          ? params.userId.trim()
          : "default";
    return this.stableBridgeUuid(`cloud-bridge-channel:${agentId}:${raw}`);
  }

  sharedRuntimeStringValue(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  sharedRuntimeStringList(value: unknown): string[] {
    if (typeof value === "string" && value.trim()) return [value.trim()];
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
  }

  isSharedTurnMessage(value: unknown): value is SharedTurnMessage {
    const message = this.nestedBridgeRecord(value);
    return (
      (message?.role === "user" || message?.role === "assistant") &&
      typeof message.content === "string" &&
      message.content.trim().length > 0
    );
  }

  async loadSharedRuntimeHistory(agentId: string, channelId: string): Promise<SharedTurnMessage[]> {
    // Durable source of truth is Postgres (the cache is disabled on the prod
    // Worker, CACHE_ENABLED=false, so it never persisted). See
    // db/schemas/shared-runtime-history.ts.
    const stored = await sharedRuntimeHistoryRepository.get(agentId, channelId);
    return stored.filter((message): message is SharedTurnMessage =>
      this.isSharedTurnMessage(message),
    );
  }

  async saveSharedRuntimeHistory(
    agentId: string,
    channelId: string,
    history: SharedTurnMessage[],
  ): Promise<void> {
    await sharedRuntimeHistoryRepository.merge(agentId, channelId, history);
  }

  sharedRuntimeBillingPrompt(
    character: SharedAgentCharacter,
    history: SharedTurnMessage[],
    message: string,
  ): Array<{ content: string }> {
    return [
      { content: character.system },
      ...(character.bio ?? []).map((content) => ({ content })),
      ...history.map((turn) => ({ content: turn.content })),
      { content: message },
    ].filter((entry) => entry.content.trim().length > 0);
  }

  sharedRuntimeBillingUsage(turn: RunSharedAgentTurnResult, estimatedInputTokens: number): AIUsage {
    return this.sharedRuntimeBillingUsageForReply(turn.reply, turn.usage, estimatedInputTokens);
  }

  sharedRuntimeBillingUsageForReply(
    reply: string,
    usage: SharedAgentTurnUsage | undefined,
    estimatedInputTokens: number,
  ): AIUsage {
    const inputTokens = usage?.inputTokens ?? usage?.promptTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? usage?.completionTokens ?? 0;
    const totalTokens = usage?.totalTokens ?? inputTokens + outputTokens;
    if (inputTokens > 0 || outputTokens > 0 || totalTokens > 0) {
      return usage ?? {};
    }
    return {
      inputTokens: estimatedInputTokens,
      outputTokens: estimateInputTokens([{ content: reply }]),
    };
  }

  async buildSharedRuntimeCharacter(rec: AgentSandbox): Promise<SharedAgentCharacter> {
    const config = this.nestedBridgeRecord(rec.agent_config) ?? {};
    const configCharacter = this.nestedBridgeRecord(config.character) ?? config;
    const linkedCharacter = rec.character_id
      ? await userCharactersRepository.findByIdInOrganization(rec.character_id, rec.organization_id)
      : undefined;
    const linkedSettings = this.nestedBridgeRecord(linkedCharacter?.settings);

    const name =
      this.sharedRuntimeStringValue(linkedCharacter?.name) ??
      this.sharedRuntimeStringValue(configCharacter.name) ??
      this.sharedRuntimeStringValue(config.name) ??
      rec.agent_name ??
      "Eliza agent";
    const system =
      this.sharedRuntimeStringValue(linkedCharacter?.system) ??
      this.sharedRuntimeStringValue(configCharacter.system) ??
      this.sharedRuntimeStringValue(config.system) ??
      this.sharedRuntimeStringValue(configCharacter.prompt) ??
      this.sharedRuntimeStringValue(config.prompt) ??
      `You are ${name}, a helpful assistant.`;
    const bio = [
      ...this.sharedRuntimeStringList(linkedCharacter?.bio),
      ...this.sharedRuntimeStringList(configCharacter.bio),
      ...this.sharedRuntimeStringList(config.bio),
    ];
    const model =
      this.sharedRuntimeStringValue(linkedSettings?.model) ??
      this.sharedRuntimeStringValue(configCharacter.model) ??
      this.sharedRuntimeStringValue(config.model);

    return {
      name,
      system,
      ...(bio.length > 0 ? { bio } : {}),
      ...(model ? { model } : {}),
    };
  }

  async bridgeSharedStatus(rec: AgentSandbox, rpc: BridgeRequest): Promise<BridgeResponse> {
    return {
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        status: "running",
        ready: true,
        agentId: rec.id,
        agentName: rec.agent_name ?? undefined,
        runtime: "shared",
      },
    };
  }

  async bridgeSharedMessageSend(
    rec: AgentSandbox,
    rpc: BridgeRequest,
    executionCtx?: BridgeExecutionContext,
  ): Promise<BridgeResponse> {
    const params = rpc.params && typeof rpc.params === "object" ? rpc.params : {};
    const text = typeof params.text === "string" ? params.text : "";
    if (!text.trim()) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32602, message: "message.send requires params.text" },
      };
    }

    const channelId = this.stableBridgeChannelId(rec.id, params);
    const [character, history] = await Promise.all([
      this.buildSharedRuntimeCharacter(rec),
      this.loadSharedRuntimeHistory(rec.id, channelId),
    ]);
    const billingModel = resolveSharedAgentTurnModel(character.model);
    const estimatedInputTokens = billingModel
      ? estimateInputTokens(this.sharedRuntimeBillingPrompt(character, history, text))
      : 0;
    const idempotencyKey = `shared-runtime:${rec.id}:${channelId}:${crypto.randomUUID()}`;
    const requestId = `shared-runtime-${crypto.randomUUID()}`;
    const billingContext: BillingContext | null = billingModel
      ? {
          organizationId: rec.organization_id,
          userId: rec.user_id,
          model: billingModel,
          requestId,
          description: `Shared runtime turn: ${character.name}`,
          metadata: {
            agentId: rec.id,
            channelId,
            executionTier: rec.execution_tier,
            idempotencyKey,
            prompt: text,
            runtime: "shared",
          },
        }
      : null;
    let reservation: CreditReservation | null = null;
    let settleReservedCredits = createCreditReservationSettler(undefined);
    const settleReservation = async (
      actualCost: number,
    ): Promise<CreditReconciliationResult | null> => settleReservedCredits(actualCost);
    if (billingContext) {
      try {
        reservation = await reserveCredits(billingContext, estimatedInputTokens, 500);
        settleReservedCredits = createCreditReservationSettler(reservation);
      } catch (error) {
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
    }
    // #11169-class refund guard: the reserve above is settled on the degraded
    // and billing-failure paths below, but a THROW between here and the settle —
    // runSharedAgentTurn raising, or saveSharedRuntimeHistory hitting a DB blip
    // (it runs OUTSIDE the inner billing try/catch) — would otherwise propagate
    // without ever refunding, stranding the hold and over-charging the org.
    // settleReservation is idempotent (reservationSettled), so refunding here
    // never double-refunds a turn that already settled on a normal path. The
    // deferred billing tail below owns its own settle-or-refund end-to-end, so
    // this catch never races it: by the time the tail is registered, every
    // throw it can produce is contained inside the tail's own try/catch.
    try {
      const turn = await runSharedAgentTurn({
        character,
        history,
        message: text,
        capabilityText: text,
        execution: {
          agentKey: rec.id,
          roomKey: channelId,
          channel: { type: ChannelType.DM, source: "shared-runtime" },
        },
      });
      if (turn.degraded) {
        // A failed/degraded turn isn't persisted or billed — just refund the hold.
        await settleReservation(0);
      } else {
        await this.saveSharedRuntimeHistory(rec.id, channelId, turn.history);
        if (billingContext) {
          // The reply is final once the turn ran and history persisted, but the
          // billing tail (billUsage → settleReservation → analytics → audit) is
          // ~1.7s of cross-region Worker→DB RTT. On a Worker, defer it via
          // executionCtx.waitUntil so it completes off the response path;
          // without an executionCtx (tests, non-Worker callers) it runs inline,
          // exactly as before. The deferred task ALWAYS settles the hold:
          // success settles at billing.totalCost, any failure refunds via the
          // idempotent settleReservation(0), and a refund throw is contained
          // and logged (never an unhandled waitUntil rejection) — the #11169
          // sweep-credit-reservations cron backstops a hold stranded by a
          // dropped waitUntil or a failed refund.
          await settleOffResponsePath(executionCtx, async () => {
            try {
              const billing = await billUsage(
                billingContext,
                this.sharedRuntimeBillingUsage(turn, estimatedInputTokens),
                reservation
                  ? {
                      ...reservation,
                      reconcile: async (actualCost) =>
                        (await settleReservation(actualCost)) ?? undefined,
                    }
                  : undefined,
              );
              const settlement = await settleReservation(billing.totalCost);
              await recordSettledInferenceBilling({
                context: billingContext,
                billing,
                reconciliation: settlement,
                idempotencyKey,
                analytics: { type: "chat", content: turn.reply, prompt: text },
              }).catch((error) => {
                // error-policy:J7 the reply is already delivered; the failed ledger
                // write is logged with the idempotency key so it can be replayed.
                logger.error("[shared-runtime] AI billing audit record failed", {
                  error: error instanceof Error ? error.message : String(error),
                  agentId: rec.id,
                  idempotencyKey,
                });
              });
            } catch (error) {
              // error-policy:J1 deferred-settlement boundary — the response may
              // already be gone, so the refund is the handling: settle(0) is
              // idempotent, and a refund failure is logged for the cron sweep.
              try {
                await settleReservation(0);
              } catch (refundError) {
                logger.error(
                  "[shared-runtime] deferred billing refund failed; sweep-credit-reservations will reclaim the hold",
                  {
                    error: refundError instanceof Error ? refundError.message : String(refundError),
                    agentId: rec.id,
                  },
                );
              }
              logger.error("[shared-runtime] billing failed", {
                error: error instanceof Error ? error.message : String(error),
                agentId: rec.id,
              });
            }
          });
        }
      }

      return {
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          text: turn.reply,
          agentName: character.name,
          channelId,
          model: turn.model,
          degraded: turn.degraded,
          runtime: "shared",
          transport: "shared-runtime",
        },
      };
    } catch (settleError) {
      // Refund the upfront hold on any post-reserve failure, then rethrow.
      await settleReservation(0);
      throw settleError;
    }
  }

  async bridgeSharedMessageStream(
    rec: AgentSandbox,
    rpc: BridgeRequest,
    executionCtx?: BridgeExecutionContext,
  ): Promise<Response> {
    const params = rpc.params && typeof rpc.params === "object" ? rpc.params : {};
    const text = typeof params.text === "string" ? params.text : "";
    if (!text.trim()) {
      return this.createBridgeSseErrorResponse("message.send requires params.text");
    }

    const channelId = this.stableBridgeChannelId(rec.id, params);
    const [character, history] = await Promise.all([
      this.buildSharedRuntimeCharacter(rec),
      this.loadSharedRuntimeHistory(rec.id, channelId),
    ]);
    const billingModel = resolveSharedAgentTurnModel(character.model);
    const estimatedInputTokens = billingModel
      ? estimateInputTokens(this.sharedRuntimeBillingPrompt(character, history, text))
      : 0;
    const idempotencyKey = `shared-runtime:${rec.id}:${channelId}:${crypto.randomUUID()}`;
    const requestId = `shared-runtime-${crypto.randomUUID()}`;
    const billingContext: BillingContext | null = billingModel
      ? {
          organizationId: rec.organization_id,
          userId: rec.user_id,
          model: billingModel,
          requestId,
          description: `Shared runtime turn: ${character.name}`,
          metadata: {
            agentId: rec.id,
            channelId,
            executionTier: rec.execution_tier,
            idempotencyKey,
            prompt: text,
            runtime: "shared",
          },
        }
      : null;
    let reservation: CreditReservation | null = null;
    let settleReservedCredits = createCreditReservationSettler(undefined);
    const settleReservation = async (
      actualCost: number,
    ): Promise<CreditReconciliationResult | null> => settleReservedCredits(actualCost);
    if (billingContext) {
      try {
        reservation = await reserveCredits(billingContext, estimatedInputTokens, 500);
        settleReservedCredits = createCreditReservationSettler(reservation);
      } catch (error) {
        // error-policy:J1 boundary translation — no SSE bytes exist before credit
        // reservation, so the HTTP route can still return the canonical 402.
        if (error instanceof InsufficientCreditsError) {
          throw new InsufficientCreditsApiError(
            `Insufficient credits. Required: $${error.required.toFixed(4)}, Available: $${error.available.toFixed(4)}`,
          );
        }
        throw error;
      }
    }

    try {
      const turn = await runSharedAgentTurnStream({
        character,
        history,
        message: text,
        capabilityText: text,
        execution: {
          agentKey: rec.id,
          roomKey: channelId,
          channel: { type: ChannelType.DM, source: "shared-runtime" },
        },
      });
      if (turn.degraded) {
        await settleReservation(0);
        return this.createBridgeSseTextResponse(turn.reply ?? "");
      }
      const parts = turn.parts;
      if (!parts) {
        await settleReservation(0);
        return this.createBridgeSseErrorResponse("Shared runtime stream did not start");
      }

      const messageId = crypto.randomUUID();
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start: async (controller) => {
          let reply = "";
          let finished = false;
          // Once the billing tail is registered it owns settlement end-to-end
          // (success settles at totalCost, failure refunds). The stream catch
          // below must then leave the reservation alone: a client cancel makes
          // the `done` enqueue throw AFTER registration, and racing a
          // settle(0) against the deferred tail's settle(totalCost) would turn
          // a fully-delivered, persisted reply into an unbilled one depending
          // on which write lands first.
          let billingTailOwnsSettlement = false;
          try {
            for await (const part of parts) {
              if (part.type === "text-delta") {
                reply += part.text;
                controller.enqueue(
                  encoder.encode(
                    chatSseFrame("chunk", {
                      messageId,
                      chunk: part.text,
                      text: part.text,
                      fullText: reply,
                      timestamp: Date.now(),
                    }),
                  ),
                );
                continue;
              }

              finished = true;
              const finalReply = part.text.trim() || reply.trim() || "…";
              const sentAt = Date.now();
              const nextHistory: SharedTurnMessage[] = [
                ...history,
                { role: "user", content: text.trim(), createdAt: sentAt },
                {
                  role: "assistant",
                  content: finalReply,
                  createdAt: sentAt + 1,
                  ...(turn.internalGrounding ? { grounding: turn.internalGrounding } : {}),
                },
              ];
              await this.saveSharedRuntimeHistory(rec.id, channelId, nextHistory);
              if (billingContext) {
                // The reply is final once the last token arrived and history
                // persisted, but the billing tail (billUsage → settleReservation
                // → analytics → audit) is ~4 serial cross-region Worker→DB
                // round-trips (~1.5-2s) that previously ran INLINE before the
                // `done` SSE frame — the exact firstText≈1.4s / done≈4s gap
                // measured on staging. Same deferral the non-stream send got
                // (#8759 / settleOffResponsePath): on a Worker the tail runs via
                // executionCtx.waitUntil OFF the `done` path; without an
                // executionCtx (tests, non-Worker callers) it runs inline,
                // exactly as before. The deferred task ALWAYS settles the hold:
                // success settles at billing.totalCost, any failure refunds via
                // the idempotent settleReservation(0), and a refund throw is
                // contained and logged (never an unhandled waitUntil rejection)
                // — the #11169 sweep-credit-reservations cron backstops a hold
                // stranded by a dropped waitUntil or a failed refund.
                billingTailOwnsSettlement = true;
                await settleOffResponsePath(executionCtx, async () => {
                  try {
                    const billing = await billUsage(
                      billingContext,
                      this.sharedRuntimeBillingUsageForReply(
                        finalReply,
                        part.usage,
                        estimatedInputTokens,
                      ),
                      reservation
                        ? {
                            ...reservation,
                            reconcile: async (actualCost) =>
                              (await settleReservation(actualCost)) ?? undefined,
                          }
                        : undefined,
                    );
                    const settlement = await settleReservation(billing.totalCost);
                    await recordSettledInferenceBilling({
                      context: billingContext,
                      billing,
                      reconciliation: settlement,
                      idempotencyKey,
                      analytics: { type: "chat", content: finalReply, prompt: text },
                    }).catch((error) => {
                      // error-policy:J7 the reply is already delivered; the failed ledger
                      // write is logged with the idempotency key so it can be replayed.
                      logger.error("[shared-runtime] AI billing audit record failed", {
                        error: error instanceof Error ? error.message : String(error),
                        agentId: rec.id,
                        idempotencyKey,
                      });
                    });
                  } catch (error) {
                    // error-policy:J1 deferred-settlement boundary — the `done`
                    // frame may already be flushed, so the refund is the
                    // handling: settle(0) is idempotent, and a refund failure is
                    // logged for the cron sweep.
                    try {
                      await settleReservation(0);
                    } catch (refundError) {
                      logger.error(
                        "[shared-runtime] deferred billing refund failed; sweep-credit-reservations will reclaim the hold",
                        {
                          error:
                            refundError instanceof Error
                              ? refundError.message
                              : String(refundError),
                          agentId: rec.id,
                        },
                      );
                    }
                    logger.error("[shared-runtime] billing failed", {
                      error: error instanceof Error ? error.message : String(error),
                      agentId: rec.id,
                    });
                  }
                });
              }
              const doneData = { messageId, text: finalReply, fullText: finalReply };
              controller.enqueue(encoder.encode(chatSseFrame("done", doneData)));
            }
            if (!finished) {
              await settleReservation(0);
              controller.enqueue(
                encoder.encode(
                  chatSseFrame("error", {
                    message: "Shared runtime stream ended without completion",
                  }),
                ),
              );
            }
          } catch (error) {
            // error-policy:J1 stream boundary translation — partial SSE streams
            // cannot become HTTP errors, so emit a terminal error frame. The
            // refund only runs while the reservation is still this scope's to
            // settle — once the billing tail is registered it owns the hold.
            if (!billingTailOwnsSettlement) {
              await settleReservation(0);
            }
            logger.warn("[shared-runtime] stream failed", {
              error: error instanceof Error ? error.message : String(error),
              agentId: rec.id,
            });
            controller.enqueue(
              encoder.encode(chatSseFrame("error", { message: "Shared runtime stream failed" })),
            );
          } finally {
            controller.close();
          }
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
        },
      });
    } catch (error) {
      // error-policy:J2 context is added by runSharedAgentTurnStream; the bridge
      // boundary only owns releasing the reservation before rethrowing.
      await settleReservation(0);
      throw error;
    }
  }

  /**
   * Read the persisted turn history for a shared-runtime agent's room, keyed by
   * the SAME stable channel id the bridge `message.send` path writes under — so
   * the REST conversation adapter (cloud-api `.../agents/:id/api/*`) returns the
   * exact transcript the bridge produced. `roomId` defaults to the agent id (the
   * canonical single-conversation channel the adapter uses).
   */
  async getSharedConversationHistory(
    agentId: string,
    roomId?: string,
  ): Promise<SharedTurnMessage[]> {
    const channelId = this.stableBridgeChannelId(agentId, {
      roomId: roomId ?? agentId,
    });
    return this.loadSharedRuntimeHistory(agentId, channelId);
  }

  /**
   * Resolve the effective character (name/system/bio/model) for a shared-runtime
   * agent — the SAME `SharedAgentCharacter` the bridge `message.send` turn uses,
   * so the REST `GET .../api/character` adapter returns exactly what the agent
   * answers as. Returns `null` when no running shared sandbox matches the org;
   * a pending Dedicated agent must wait for its container and cannot borrow the
   * Shared runtime.
   */
  async getSharedRuntimeCharacter(
    agentId: string,
    orgId: string,
  ): Promise<SharedAgentCharacter | null> {
    const rec = await agentSandboxesRepository.findRunningSandbox(agentId, orgId);
    if (rec && rec.execution_tier === "shared") {
      return this.buildSharedRuntimeCharacter(rec);
    }
    return null;
  }

  // Bridge

  async bridge(
    agentId: string,
    orgId: string,
    rpc: BridgeRequest,
    executionCtx?: BridgeExecutionContext,
  ): Promise<BridgeResponse> {
    const rec = await agentSandboxesRepository.findRunningSandbox(agentId, orgId);
    if (!rec) {
      logger.warn("[agent-sandbox] Bridge call to non-running sandbox", {
        agentId,
        method: rpc.method,
      });
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32000, message: "Sandbox is not running" },
      };
    }

    try {
      if (rec.execution_tier === "shared") {
        if (rpc.method === "status.get" || rpc.method === "heartbeat") {
          return await this.bridgeSharedStatus(rec, rpc);
        }
        if (rpc.method === "message.send") {
          return await this.bridgeSharedMessageSend(rec, rpc, executionCtx);
        }
        return {
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32601, message: `Method not found: ${rpc.method}` },
        };
      }

      if (!rec.bridge_url) {
        logger.warn("[agent-sandbox] Bridge call to running sandbox without bridge URL", {
          agentId,
          method: rpc.method,
        });
        return {
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32000, message: "Sandbox is not running" },
        };
      }

      if (rpc.method === "status.get" || rpc.method === "heartbeat") {
        return await this.bridgeStatus(rec, rpc);
      }
      if (rpc.method === "message.send") {
        return await this.bridgeMessageSend(rec, rpc);
      }

      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32601, message: `Method not found: ${rpc.method}` },
      };
    } catch {
      logger.warn("[agent-sandbox] Bridge request failed", {
        agentId,
        method: rpc.method,
        failureClass: "sandbox_bridge_failed",
      });
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32000, message: "Sandbox bridge is unreachable" },
      };
    }
  }

  async bridgeStatus(rec: AgentSandbox, rpc: BridgeRequest): Promise<BridgeResponse> {
    const runtimeAgents = await this.host.listRuntimeAgents(rec);
    if (runtimeAgents.supported) {
      const agent = this.host.selectRuntimeAgent(runtimeAgents.agents);
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          status: agent?.status ?? (agent ? "running" : "starting"),
          ready: this.host.isRuntimeAgentReady(agent),
          agentId: rec.id,
          runtimeAgentId: agent?.id,
          agentName: agent?.name,
        },
      };
    }

    const rootRes = await this.host.fetchAgentWeb(rec, "/", {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });
    if (!rootRes.ok) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: {
          code: -32000,
          message: `Bridge returned HTTP ${rootRes.status}`,
        },
      };
    }

    return {
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        status: "running",
        ready: true,
        agentId: rec.id,
        runtime: "web",
        chat: true,
      },
    };
  }

  async bridgeMessageSend(rec: AgentSandbox, rpc: BridgeRequest): Promise<BridgeResponse> {
    const params =
      rpc.params && typeof rpc.params === "object" ? (rpc.params as Record<string, unknown>) : {};
    const text = typeof params.text === "string" ? params.text : "";
    if (!text.trim()) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32602, message: "message.send requires params.text" },
      };
    }

    const canonicalConversationId =
      typeof params.conversationId === "string" && params.conversationId.trim()
        ? params.conversationId.trim()
        : null;
    if (canonicalConversationId) {
      // Cutover connectors name the imported conversation explicitly. Do not
      // fall through to a newly-created REST conversation or another bridge
      // surface: either this exact history accepts the turn, or delivery fails
      // closed and the provider retries the same clientMessageId.
      return await this.bridgeConversationMessageSend(rec, rpc, params, canonicalConversationId);
    }

    const attempts = [
      // Try the cloud-agent image's native /bridge JSON-RPC first. This is
      // the canonical surface served by packages/app-core/deploy/cloud-agent-shared.ts.
      // It returns 200 with {result:{text}} on success, 500 with
      // {error:{message}} on runtime failures (e.g. no LLM key). When an
      // image doesn't expose /bridge (public ghcr.io/elizaos/eliza compatibility
      // image) it 404s and we fall through to the REST attempts below.
      () => this.bridgeNativeJsonRpcSend(rec, rpc, params),
      () => this.bridgeConversationMessageSend(rec, rpc, params),
      () => this.bridgeOpenAiChatCompletionSend(rec, rpc, params),
      () => this.bridgeCentralChannelMessageSend(rec, rpc, params),
    ];
    let lastResponse: BridgeResponse | null = null;

    for (const attempt of attempts) {
      try {
        const response = await attempt();
        if (this.bridgeResponseHasText(response)) {
          return response;
        }
        lastResponse = response;
      } catch (error) {
        if (error instanceof BridgeRouteUnavailableError) {
          continue;
        }
        throw error;
      }
    }

    if (lastResponse?.error) {
      return lastResponse;
    }
    const fallbackText = this.buildBridgeNoReplyFallbackText(params);
    if (fallbackText) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          text: fallbackText,
          fallback: true,
          reason: "agent_no_reply",
          transport: "fallback",
        },
      };
    }
    return {
      jsonrpc: "2.0",
      id: rpc.id,
      error: {
        code: -32000,
        message: "Bridge message produced an empty response",
      },
    };
  }

  // Deliberately text-only: a runtime-side canned failure reply (result carries
  // `failureKind`, e.g. "provider issue" / credits-depleted text from
  // packages/agent chat routes) still short-circuits the ladder. Production
  // consumers (agent-gateway connectors, provisioning jobs, the REST adapters)
  // surface that designed failure text to end users; falling through would
  // replace it with the fabricated generic fallback and add up to ~50s of
  // central-channel polling per failed turn. Strict callers (the e2e chat
  // scripts) reject on the propagated `failureKind` instead (#15616).
  bridgeResponseHasText(response: BridgeResponse): boolean {
    return typeof response.result?.text === "string" && response.result.text.trim().length > 0;
  }

  /**
   * The agent runtime's conversation route answers HTTP 200 with canned text
   * plus a `failureKind` discriminator when the model path is dead (provider
   * issue, rate limit, credit exhaustion, no provider). Surface it so callers
   * can tell a genuine model reply from a canned failure (#15616).
   */
  extractBridgeFailureKind(body: Record<string, unknown>): string | undefined {
    return typeof body.failureKind === "string" && body.failureKind.trim()
      ? body.failureKind.trim()
      : undefined;
  }

  /**
   * Native JSON-RPC POST to the cloud-agent image's `/bridge` endpoint.
   * Source: packages/app-core/deploy/cloud-agent-shared.ts (the handler this
   * proxies to). Returns the agent's reply unchanged on 200, propagates
   * runtime errors as JSON-RPC error envelopes on 500, throws
   * BridgeRouteUnavailableError on 404 so callers fall through to legacy
   * REST endpoints (the public ghcr.io/elizaos/eliza image doesn't expose
   * /bridge).
   */
  async bridgeNativeJsonRpcSend(
    rec: AgentSandbox,
    rpc: BridgeRequest,
    _params: Record<string, unknown>,
  ): Promise<BridgeResponse> {
    if (!rec.bridge_url) {
      throw new BridgeRouteUnavailableError("Sandbox has no bridge_url", 0);
    }
    const res = await this.host.fetchAgentApi(rec, "/bridge", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id ?? null,
        method: "message.send",
        params: rpc.params ?? {},
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 404) {
      throw new BridgeRouteUnavailableError(
        "Cloud-agent /bridge route not present (legacy image?)",
        res.status,
      );
    }
    // Parse envelope; cloud-agent returns valid JSON-RPC on both 200 and 500.
    const body = (await res.json().catch((error) => {
      logger.warn("[agent-sandbox] Failed to parse native bridge JSON-RPC body", {
        agentId: rec.id,
        status: res.status,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    })) as {
      jsonrpc?: string;
      id?: unknown;
      result?: { text?: string };
      error?: { code?: number; message?: string };
    } | null;
    if (!body || body.jsonrpc !== "2.0") {
      throw new BridgeRouteUnavailableError(
        `Cloud-agent /bridge returned non-JSON-RPC body (status ${res.status})`,
        res.status,
      );
    }
    return {
      jsonrpc: "2.0",
      id: rpc.id,
      ...(body.result
        ? {
            result: {
              ...(body.result as Record<string, unknown>),
              transport: "native-jsonrpc",
            } as BridgeResponse["result"],
          }
        : {}),
      ...(body.error ? { error: body.error as BridgeResponse["error"] } : {}),
    };
  }

  async bridgeConversationMessageSend(
    rec: AgentSandbox,
    rpc: BridgeRequest,
    params: Record<string, unknown>,
    canonicalConversationId?: string,
  ): Promise<BridgeResponse> {
    const conversationId =
      canonicalConversationId ?? (await this.createBridgeConversation(rec, params));
    const path = `/api/conversations/${encodeURIComponent(conversationId)}/messages`;
    const init = {
      method: "POST",
      body: JSON.stringify(this.buildBridgeConversationMessageBody(params)),
      signal: AbortSignal.timeout(60_000),
    } satisfies RequestInit;
    const res = canonicalConversationId
      ? await this.host.fetchCanonicalConversationApi(rec, path, init, params.canonicalBridgeBase)
      : await this.host.fetchAgentApi(rec, path, init);
    if (!res.ok) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32000, message: `Bridge returned HTTP ${res.status}` },
      };
    }

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const failureKind = this.extractBridgeFailureKind(body);
    return {
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        text: this.extractBridgeMessageText(body) ?? "",
        agentName: typeof body.agentName === "string" ? body.agentName : undefined,
        conversationId,
        transport: "conversation-rest",
        ...(failureKind ? { failureKind } : {}),
      },
    };
  }

  async bridgeCentralChannelMessageSend(
    rec: AgentSandbox,
    rpc: BridgeRequest,
    params: Record<string, unknown>,
  ): Promise<BridgeResponse> {
    const runtimeAgent = (await this.host.ensureRuntimeAgentStarted(rec)) ?? undefined;
    if (!runtimeAgent?.id) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32000, message: "Runtime agent is not ready" },
      };
    }

    const channelId = this.stableBridgeChannelId(runtimeAgent.id, params);
    const res = await this.host.fetchAgentApi(
      rec,
      `/api/messaging/central-channels/${encodeURIComponent(channelId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify(this.buildBridgeCentralChannelMessageBody(params, runtimeAgent.id)),
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (res.status === 404) {
      throw new BridgeRouteUnavailableError(
        "Central channel messaging API is unavailable",
        res.status,
      );
    }
    if (!res.ok) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32000, message: `Bridge returned HTTP ${res.status}` },
      };
    }

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const data = this.nestedBridgeRecord(body.data) ?? {};
    const agentText = await this.waitForBridgeCentralChannelAgentReply(
      rec,
      channelId,
      runtimeAgent.id,
    );
    return {
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        text: agentText ?? "",
        accepted: true,
        runtimeAgentId: runtimeAgent.id,
        agentName: runtimeAgent.name,
        channelId,
        transport: "central-channel",
        messageId:
          typeof data.id === "string" ? data.id : typeof body.id === "string" ? body.id : undefined,
      },
    };
  }

  async bridgeOpenAiChatCompletionSend(
    rec: AgentSandbox,
    rpc: BridgeRequest,
    params: Record<string, unknown>,
  ): Promise<BridgeResponse> {
    const { body, status } = await this.requestBridgeOpenAiChatCompletion(rec, params);
    if (status === 404) {
      throw new BridgeRouteUnavailableError("OpenAI chat compatibility API is unavailable", status);
    }
    if (status < 200 || status >= 300) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: {
          code: -32000,
          message: this.extractBridgeErrorMessage(body) ?? `Bridge returned HTTP ${status}`,
        },
      };
    }

    return {
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        text: this.extractOpenAiChatCompletionText(body) ?? "",
        model: typeof body.model === "string" ? body.model : undefined,
        completionId: typeof body.id === "string" ? body.id : undefined,
        transport: "openai-compat",
      },
    };
  }

  async requestBridgeOpenAiChatCompletion(
    rec: AgentSandbox,
    params: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.host.fetchAgentApi(rec, "/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify(this.buildBridgeOpenAiChatBody(params)),
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body };
  }

  buildBridgeOpenAiChatBody(params: Record<string, unknown>): Record<string, unknown> {
    const text = typeof params.text === "string" ? params.text : "";
    const roomId =
      typeof params.roomId === "string" && params.roomId.trim() ? params.roomId.trim() : "default";
    const userId =
      typeof params.userId === "string" && params.userId.trim()
        ? params.userId.trim()
        : this.stableBridgeUserId(params);
    const source =
      typeof params.source === "string" && params.source.trim() ? params.source.trim() : "cloud";

    return {
      model: "eliza",
      messages: [{ role: "user", content: text }],
      user: roomId,
      metadata: {
        conversation_id: roomId,
        user_id: userId,
        source,
        bridgeRoomId: roomId,
      },
    };
  }

  buildBridgeNoReplyFallbackText(params: Record<string, unknown>): string | null {
    const text = typeof params.text === "string" ? params.text.trim() : "";
    if (!text) return null;

    const lower = text.toLowerCase();
    let searchFrom = 0;
    while (searchFrom < lower.length) {
      const start = lower.indexOf("exact word", searchFrom);
      if (start === -1) break;
      searchFrom = start + 1;
      const preceding = start > 0 ? lower.charCodeAt(start - 1) : 0;
      const precededByWord =
        (preceding >= 48 && preceding <= 57) ||
        (preceding >= 97 && preceding <= 122) ||
        preceding === 95;
      if (precededByWord) continue;

      let cursor = start + "exact word".length;
      if (lower.charCodeAt(cursor) === 115) cursor++;
      while (cursor < lower.length && /\s/.test(lower[cursor] ?? "")) cursor++;
      if (lower.charCodeAt(cursor) !== 58) continue;
      cursor++;
      while (cursor < text.length && /\s/.test(text[cursor] ?? "")) cursor++;

      let end = text.length;
      while (end > cursor && /\s/.test(text[end - 1] ?? "")) end--;
      if (cursor < end && (text[cursor] === '"' || text[cursor] === "'")) cursor++;
      if (cursor < end && (text[end - 1] === '"' || text[end - 1] === "'")) end--;
      const exact = text.slice(cursor, end).trim();
      if (exact && !exact.includes("\n") && !exact.includes("\r")) return exact;
    }

    searchFrom = 0;
    while (searchFrom < lower.length) {
      const start = lower.indexOf("reply", searchFrom);
      if (start === -1) break;
      searchFrom = start + 1;
      const preceding = start > 0 ? lower.charCodeAt(start - 1) : 0;
      const precededByWord =
        (preceding >= 48 && preceding <= 57) ||
        (preceding >= 97 && preceding <= 122) ||
        preceding === 95;
      if (precededByWord) continue;

      let cursor = start + "reply".length;
      const whitespaceStart = cursor;
      while (cursor < lower.length && /\s/.test(lower[cursor] ?? "")) cursor++;
      if (cursor === whitespaceStart) continue;
      if (lower.startsWith("briefly", cursor)) {
        cursor += "briefly".length;
        const brieflyWhitespaceStart = cursor;
        while (cursor < lower.length && /\s/.test(lower[cursor] ?? "")) cursor++;
        if (cursor === brieflyWhitespaceStart) continue;
      }
      if (!lower.startsWith("with", cursor)) continue;
      cursor += "with".length;
      const withWhitespaceStart = cursor;
      while (cursor < lower.length && /\s/.test(lower[cursor] ?? "")) cursor++;
      if (cursor === withWhitespaceStart) continue;
      const quote = text[cursor];
      if (quote !== '"' && quote !== "'") continue;
      const singleQuoteClose = text.indexOf("'", cursor + 1);
      const doubleQuoteClose = text.indexOf('"', cursor + 1);
      const close =
        singleQuoteClose === -1
          ? doubleQuoteClose
          : doubleQuoteClose === -1
            ? singleQuoteClose
            : Math.min(singleQuoteClose, doubleQuoteClose);
      if (close === -1) continue;
      const reply = text.slice(cursor + 1, close).trim();
      if (reply) return reply;
    }

    return "Agent runtime is online, but no model response was produced before the cloud bridge timeout.";
  }

  async createBridgeConversation(
    rec: AgentSandbox,
    params: Record<string, unknown>,
  ): Promise<string> {
    const source =
      typeof params.source === "string" && params.source.trim() ? params.source : "cloud";
    const roomId =
      typeof params.roomId === "string" && params.roomId.trim() ? params.roomId : "default";
    const res = await this.host.fetchAgentApi(rec, "/api/conversations", {
      method: "POST",
      body: JSON.stringify({
        title: `${source}:${roomId}`.slice(0, 120),
        metadata: { scope: "general" },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      if (res.status === 404) {
        throw new BridgeRouteUnavailableError("Conversation API is unavailable", res.status);
      }
      throw new Error(`Bridge conversation create returned HTTP ${res.status}`);
    }

    const body = (await res.json().catch(() => ({}))) as {
      conversation?: { id?: unknown };
    };
    const conversationId = body.conversation?.id;
    if (typeof conversationId !== "string" || !conversationId.trim()) {
      throw new Error("Bridge conversation create response was missing conversation.id");
    }
    return conversationId;
  }

  buildBridgeConversationMessageBody(params: Record<string, unknown>): Record<string, unknown> {
    const body: Record<string, unknown> = {
      text: typeof params.text === "string" ? params.text : "",
      source:
        typeof params.source === "string" && params.source.trim() ? params.source.trim() : "cloud",
      metadata: {
        ...(params.metadata &&
        typeof params.metadata === "object" &&
        !Array.isArray(params.metadata)
          ? (params.metadata as Record<string, unknown>)
          : {}),
        bridgeRoomId: typeof params.roomId === "string" ? params.roomId : undefined,
        bridgeSender:
          params.sender && typeof params.sender === "object" && !Array.isArray(params.sender)
            ? params.sender
            : undefined,
      },
    };
    if (params.channelType === "GROUP") {
      body.channelType = "GROUP";
    } else {
      body.channelType = "DM";
    }
    if (params.mode === "power") {
      body.conversationMode = "power";
    } else {
      body.conversationMode = "simple";
    }
    if (typeof params.clientMessageId === "string" && params.clientMessageId.trim()) {
      body.clientMessageId = params.clientMessageId.trim();
    }
    return body;
  }

  buildBridgeCentralChannelMessageBody(
    params: Record<string, unknown>,
    runtimeAgentId: string,
  ): Record<string, unknown> {
    const metadata =
      params.metadata && typeof params.metadata === "object" && !Array.isArray(params.metadata)
        ? { ...(params.metadata as Record<string, unknown>) }
        : {};
    const sender =
      params.sender && typeof params.sender === "object" && !Array.isArray(params.sender)
        ? (params.sender as Record<string, unknown>)
        : {};
    const displayName =
      typeof sender.displayName === "string" && sender.displayName.trim()
        ? sender.displayName.trim()
        : typeof sender.name === "string" && sender.name.trim()
          ? sender.name.trim()
          : "Cloud User";

    return {
      author_id: this.stableBridgeUserId(params),
      content: typeof params.text === "string" ? params.text : "",
      server_id: DEFAULT_CENTRAL_SERVER_ID,
      raw_message: {
        text: typeof params.text === "string" ? params.text : "",
        source:
          typeof params.source === "string" && params.source.trim()
            ? params.source.trim()
            : "cloud",
      },
      metadata: {
        ...metadata,
        isDm: true,
        channelType: "DM",
        targetUserId: runtimeAgentId,
        user_display_name: displayName,
        bridgeRoomId: typeof params.roomId === "string" ? params.roomId : undefined,
      },
      source_type:
        typeof params.source === "string" && params.source.trim() ? params.source.trim() : "cloud",
    };
  }

  getBridgeMessages(body: unknown): unknown[] {
    if (Array.isArray(body)) return body;
    if (!body || typeof body !== "object") return [];

    const root = body as Record<string, unknown>;
    const data =
      root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : {};
    const result =
      root.result && typeof root.result === "object"
        ? (root.result as Record<string, unknown>)
        : {};

    for (const candidate of [
      root.messages,
      root.items,
      data.messages,
      data.items,
      result.messages,
      result.items,
    ]) {
      if (Array.isArray(candidate)) return candidate;
    }

    return [];
  }

  normalizeBridgeRole(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    return normalized || null;
  }

  bridgeRoleIsAgent(value: unknown): boolean {
    const role = this.normalizeBridgeRole(value);
    return (
      role === "assistant" ||
      role === "agent" ||
      role === "bot" ||
      role === "ai" ||
      role === "model" ||
      role === "assistant_message" ||
      role === "agent_message"
    );
  }

  bridgeRoleIsUser(value: unknown): boolean {
    const role = this.normalizeBridgeRole(value);
    return (
      role === "user" ||
      role === "human" ||
      role === "client" ||
      role === "owner" ||
      role === "user_message" ||
      role === "client_message"
    );
  }

  bridgeMessageIdMatches(value: unknown, runtimeAgentId?: string): boolean {
    return (
      typeof runtimeAgentId === "string" &&
      runtimeAgentId.length > 0 &&
      typeof value === "string" &&
      value === runtimeAgentId
    );
  }

  nestedBridgeRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  isBridgeAgentMessage(message: Record<string, unknown>, runtimeAgentId?: string): boolean {
    if (message.isAgent === true || message.fromAgent === true || message.isBot === true) {
      return true;
    }
    if (message.isAgent === false || message.fromAgent === false || message.isBot === false) {
      return false;
    }
    const sourceType = this.normalizeBridgeRole(message.sourceType ?? message.source_type);
    if (sourceType === "agent_response") {
      return true;
    }

    for (const key of ["role", "type", "senderType", "senderRole", "authorRole", "messageType"]) {
      const value = message[key];
      if (this.bridgeRoleIsAgent(value)) return true;
      if (this.bridgeRoleIsUser(value)) return false;
    }

    for (const key of ["sender", "author", "from", "entity", "metadata"]) {
      const nested = this.nestedBridgeRecord(message[key]);
      if (!nested) continue;
      if (nested.isAgent === true || nested.fromAgent === true || nested.isBot === true)
        return true;
      if (nested.isAgent === false || nested.fromAgent === false || nested.isBot === false) {
        return false;
      }
      for (const nestedKey of ["role", "type", "senderType", "authorRole"]) {
        const nestedValue = nested[nestedKey];
        if (this.bridgeRoleIsAgent(nestedValue)) return true;
        if (this.bridgeRoleIsUser(nestedValue)) return false;
      }
      for (const nestedIdKey of ["id", "entityId", "agentId", "runtimeAgentId", "senderId"]) {
        if (this.bridgeMessageIdMatches(nested[nestedIdKey], runtimeAgentId)) return true;
      }
    }

    for (const idKey of ["entityId", "agentId", "runtimeAgentId", "senderId", "authorId"]) {
      if (this.bridgeMessageIdMatches(message[idKey], runtimeAgentId)) return true;
    }

    return false;
  }

  extractBridgeTextValue(value: unknown, depth = 0): string | null {
    if (depth > 4) return null;
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed ? trimmed : null;
    }
    if (Array.isArray(value)) {
      const parts = value
        .map((item) => this.extractBridgeTextValue(item, depth + 1))
        .filter((text): text is string => Boolean(text));
      return parts.length > 0 ? parts.join("") : null;
    }

    const record = this.nestedBridgeRecord(value);
    if (!record) return null;

    for (const key of [
      "text",
      "fullText",
      "content",
      "message",
      "body",
      "reply",
      "response",
      "value",
    ]) {
      const text = this.extractBridgeTextValue(record[key], depth + 1);
      if (text) return text;
    }

    for (const key of ["parts", "items", "chunks"]) {
      const text = this.extractBridgeTextValue(record[key], depth + 1);
      if (text) return text;
    }

    return null;
  }

  extractBridgeMessageText(message: Record<string, unknown>): string | null {
    for (const key of ["text", "fullText", "content", "message", "body", "reply", "response"]) {
      const text = this.extractBridgeTextValue(message[key]);
      if (text) return text;
    }
    return null;
  }

  extractBridgeErrorMessage(body: Record<string, unknown>): string | null {
    const error = this.nestedBridgeRecord(body.error);
    if (error) {
      const message = this.extractBridgeTextValue(error.message);
      if (message) return message;
      const text = this.extractBridgeTextValue(error);
      if (text) return text;
    }
    return this.extractBridgeTextValue(body.message) ?? this.extractBridgeTextValue(body);
  }

  extractOpenAiChatCompletionText(body: Record<string, unknown>): string | null {
    const choices = Array.isArray(body.choices) ? body.choices : [];
    for (const choice of choices) {
      const choiceRecord = this.nestedBridgeRecord(choice);
      if (!choiceRecord) continue;
      const message = this.nestedBridgeRecord(choiceRecord.message);
      if (message) {
        const content = this.extractBridgeTextValue(message.content);
        if (content) return content;
      }
      const text = this.extractBridgeTextValue(choiceRecord.text);
      if (text) return text;
    }
    return this.extractBridgeTextValue(body);
  }

  async waitForBridgeCentralChannelAgentReply(
    rec: AgentSandbox,
    channelId: string,
    runtimeAgentId?: string,
  ): Promise<string | null> {
    for (let attempt = 0; attempt < 20; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2_500));
      const res = await this.host.fetchAgentApi(
        rec,
        `/api/messaging/central-channels/${encodeURIComponent(channelId)}/messages?limit=30`,
        {
          method: "GET",
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!res.ok) return null;
      const body = await res.json().catch(() => ({}));
      const messages = this.getBridgeMessages(body);
      for (const message of messages.slice().reverse()) {
        const record = this.nestedBridgeRecord(message);
        if (!record || !this.isBridgeAgentMessage(record, runtimeAgentId)) continue;
        const text = this.extractBridgeMessageText(record);
        if (text) return text;
      }
    }

    return null;
  }

  async bridgeStream(
    agentId: string,
    orgId: string,
    rpc: BridgeRequest,
    executionCtx?: BridgeExecutionContext,
  ): Promise<Response | null> {
    const rec = await agentSandboxesRepository.findRunningSandbox(agentId, orgId);
    if (!rec) {
      logger.warn("[agent-sandbox] Bridge stream to non-running sandbox", {
        agentId,
        method: rpc.method,
      });
      return null;
    }

    const params =
      rpc.params && typeof rpc.params === "object" ? (rpc.params as Record<string, unknown>) : {};
    const fallbackText = this.buildBridgeNoReplyFallbackText(params);

    if (rec.execution_tier === "shared") {
      const response = await this.bridgeSharedMessageStream(rec, rpc, executionCtx);
      return response ?? (fallbackText ? this.createBridgeSseTextResponse(fallbackText) : null);
    }

    if (!rec.bridge_url) {
      logger.warn("[agent-sandbox] Bridge stream to running sandbox without bridge URL", {
        agentId,
        method: rpc.method,
      });
      return null;
    }

    try {
      const conversationId = await this.createBridgeConversation(rec, params);
      const res = await this.host.fetchAgentApi(
        rec,
        `/api/conversations/${encodeURIComponent(conversationId)}/messages/stream`,
        {
          method: "POST",
          body: JSON.stringify(this.buildBridgeConversationMessageBody(params)),
          signal: AbortSignal.timeout(120_000),
        },
      );
      if (res.ok) return this.normalizeBridgeSseResponse(res);
      if (res.status !== 404) {
        logger.warn("[agent-sandbox] Bridge stream conversation request failed", {
          agentId,
          status: res.status,
        });
      }
    } catch (error) {
      if (!(error instanceof BridgeRouteUnavailableError)) {
        logger.warn("[agent-sandbox] Bridge stream conversation request failed", {
          agentId,
          method: rpc.method,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    try {
      return await this.bridgeOpenAiChatCompletionSse(rec, params);
    } catch (error) {
      logger.warn("[agent-sandbox] Bridge stream compatibility request failed", {
        agentId,
        method: rpc.method,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const centralResponse = await this.bridgeCentralChannelMessageSend(rec, rpc, params);
      if (this.bridgeResponseHasText(centralResponse)) {
        return this.createBridgeSseTextResponse(centralResponse.result!.text as string);
      }
      if (centralResponse.error) {
        return this.createBridgeSseErrorResponse(centralResponse.error.message);
      }
      if (fallbackText) {
        return this.createBridgeSseTextResponse(fallbackText);
      }
    } catch (error) {
      logger.warn("[agent-sandbox] Bridge stream central-channel request failed", {
        agentId,
        method: rpc.method,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (fallbackText) {
      return this.createBridgeSseTextResponse(fallbackText);
    }

    return null;
  }

  async bridgeOpenAiChatCompletionSse(
    rec: AgentSandbox,
    params: Record<string, unknown>,
  ): Promise<Response | null> {
    const { body, status } = await this.requestBridgeOpenAiChatCompletion(rec, params);
    if (status === 404) return null;
    if (status < 200 || status >= 300) {
      return this.createBridgeSseErrorResponse(
        this.extractBridgeErrorMessage(body) ?? `Bridge returned HTTP ${status}`,
      );
    }

    const text = this.extractOpenAiChatCompletionText(body);
    if (!text) {
      return null;
    }
    return this.createBridgeSseTextResponse(text);
  }

  createBridgeSseTextResponse(text: string): Response {
    const messageId = crypto.randomUUID();
    const chunk = {
      messageId,
      chunk: text,
      text,
      fullText: text,
      timestamp: Date.now(),
    };
    return new Response(
      chatSseFrame("chunk", chunk) + chatSseFrame("done", { messageId, text, fullText: text }),
      {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
        },
      },
    );
  }

  normalizeBridgeSseResponse(response: Response): Response {
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream") || !response.body) {
      return response;
    }

    const messageId = crypto.randomUUID();
    // Accumulate across frames: a delta-v2 agent (client `streamProtocol` can
    // ride through the bridge to it) ships bare `{type:"token",text}` deltas and
    // resends `fullText` only on a periodic snapshot, so the downstream
    // `fullText`/done text must be rebuilt here, not read off each frame.
    let accumulated = "";
    let pending = "";
    const findEventBreak = (value: string) => {
      const lfBreak = value.indexOf("\n\n");
      const crlfBreak = value.indexOf("\r\n\r\n");
      if (lfBreak === -1 && crlfBreak === -1) return null;
      if (lfBreak === -1) return { index: crlfBreak, length: 4 };
      if (crlfBreak === -1) return { index: lfBreak, length: 2 };
      return lfBreak < crlfBreak ? { index: lfBreak, length: 2 } : { index: crlfBreak, length: 4 };
    };
    const emitFrame = (frame: string, controller: TransformStreamDefaultController<string>) => {
      if (!frame.trim()) return;
      const dataLine = frame.split(/\r?\n/).find((line) => line.startsWith("data:"));
      if (!dataLine) {
        controller.enqueue(`${frame}\n\n`);
        return;
      }
      try {
        const data = JSON.parse(dataLine.slice(5).trimStart());
        if (data?.type === "token") {
          const delta = typeof data.text === "string" ? data.text : "";
          accumulated = typeof data.fullText === "string" ? data.fullText : accumulated + delta;
          controller.enqueue(
            chatSseFrame("chunk", {
              messageId,
              chunk: delta,
              text: delta,
              fullText: accumulated,
              timestamp: Date.now(),
            }),
          );
          return;
        }
        if (data?.type === "done") {
          controller.enqueue(
            chatSseFrame(
              "done",
              normalizeChatSseDonePayload(data, {
                messageId,
                fullText: accumulated,
              }),
            ),
          );
          return;
        }
      } catch {
        // error-policy:J3 untrusted SSE frames are invalid for normalization and pass through unchanged.
      }
      controller.enqueue(`${frame}\n\n`);
    };
    const stream = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(
        new TransformStream<string, string>({
          transform: (chunk, controller) => {
            pending += chunk;
            let eventBreak = findEventBreak(pending);
            while (eventBreak) {
              const frame = pending.slice(0, eventBreak.index);
              pending = pending.slice(eventBreak.index + eventBreak.length);
              emitFrame(frame, controller);
              eventBreak = findEventBreak(pending);
            }
          },
          flush: (controller) => {
            if (pending.trim()) emitFrame(pending, controller);
            pending = "";
          },
        }),
      )
      .pipeThrough(new TextEncoderStream());

    return new Response(stream, {
      status: response.status,
      headers: response.headers,
    });
  }

  createBridgeSseErrorResponse(message: string): Response {
    return new Response(chatSseFrame("error", { message }), {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  }
}

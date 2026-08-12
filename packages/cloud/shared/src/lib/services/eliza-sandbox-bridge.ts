/**
 * Agent Sandbox Bridge — JSON-RPC bridge between the cloud and the agent runtime
 * inside each sandbox. Handles status, message.send, and streaming chat.
 *
 * Extracted from ElizaSandboxService. Composed into it (not standalone) so
 * external consumers keep calling `elizaSandboxService.bridge(...)` /
 * `elizaSandboxService.bridgeStream(...)` unchanged.
 */

import crypto from "node:crypto";
import type { AgentSandbox } from "../../db/repositories/agent-sandboxes";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { logger } from "../utils/logger";
import { chatSseFrame, normalizeChatSseDonePayload } from "./chat-sse-frames";

export interface BridgeRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface BridgeResponse {
  jsonrpc: "2.0";
  id?: string | number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export type RuntimeAgentSummary = {
  id?: string;
  name?: string;
  status?: string;
};

export type RuntimeAgentListResult = {
  supported: boolean;
  agents: RuntimeAgentSummary[];
};

/** Narrow surface ElizaSandboxBridgeService needs from its host service. */
export interface BridgeServiceDeps {
  getAgentApiEndpoint(
    rec: Pick<
      AgentSandbox,
      | "id"
      | "bridge_url"
      | "health_url"
      | "node_id"
      | "bridge_port"
      | "web_ui_port"
      | "headscale_ip"
      | "sandbox_id"
    >,
    path: string,
  ): Promise<string>;
  getAgentJsonHeaders(rec: Pick<AgentSandbox, "id" | "environment_vars">): Record<string, string>;
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
    >,
  ): Promise<RuntimeAgentSummary | null>;
}

const DEFAULT_CENTRAL_SERVER_ID = "00000000-0000-0000-0000-000000000000";

class BridgeRouteUnavailableError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BridgeRouteUnavailableError";
  }
}

/**
 * How long a session-scoped bridge conversation id is trusted before we force a
 * fresh create. A voice session reuses one conversation across turns (stable
 * `roomId`); without a TTL a long-lived process would pin a conversation id that
 * the sandbox may have GC'd or that belongs to a since-restarted agent. 30 min
 * comfortably covers a live voice session while bounding staleness/memory.
 */
const BRIDGE_CONVERSATION_TTL_MS = 30 * 60 * 1000;

type BridgeConversationCacheEntry = {
  conversationId: string;
  createdAt: number;
};

export class ElizaSandboxBridgeService {
  /**
   * Session-scoped conversation reuse. A voice turn used to POST
   * `/api/conversations` on EVERY turn (a serialized round-trip on the
   * first-token critical path) AND started a brand-new conversation each time,
   * losing prior-turn context. We cache the created conversation id keyed by the
   * stable session identity `(agentId, orgId, roomId)`: the first turn creates,
   * subsequent turns reuse (no create round-trip, context preserved). A stale id
   * (sandbox restarted / conversation expired → 404 on the stream POST) evicts
   * the entry and recreates exactly once. Only the streaming voice path uses
   * this cache; one-shot REST callers keep their create-per-call behavior.
   */
  private readonly bridgeConversationCache = new Map<string, BridgeConversationCacheEntry>();

  constructor(private readonly deps: BridgeServiceDeps) {}

  private bridgeConversationCacheKey(
    agentId: string,
    orgId: string,
    params: Record<string, unknown>,
  ): string | null {
    const roomId =
      typeof params.roomId === "string" && params.roomId.trim() ? params.roomId.trim() : null;
    // No stable room => no session to key on; fall back to create-per-call.
    if (!roomId) return null;
    return `${agentId}\u0000${orgId}\u0000${roomId}`;
  }

  /**
   * Return a reusable conversation id for this session, creating (and caching)
   * one only on the first turn or after a forced invalidation. `forceNew` skips
   * and overwrites any cached entry (used for the create-once stale recovery).
   * When there is no stable session key (no roomId) this always creates.
   */
  private async getOrCreateBridgeConversation(
    agentId: string,
    orgId: string,
    rec: AgentSandbox,
    params: Record<string, unknown>,
    options?: { forceNew?: boolean },
  ): Promise<string> {
    const key = this.bridgeConversationCacheKey(agentId, orgId, params);
    if (!key) {
      return this.createBridgeConversation(rec, params);
    }

    if (!options?.forceNew) {
      const cached = this.bridgeConversationCache.get(key);
      if (cached && Date.now() - cached.createdAt < BRIDGE_CONVERSATION_TTL_MS) {
        return cached.conversationId;
      }
      if (cached) {
        // Expired by TTL: drop and recreate below.
        this.bridgeConversationCache.delete(key);
      }
    }

    const conversationId = await this.createBridgeConversation(rec, params);
    this.bridgeConversationCache.set(key, { conversationId, createdAt: Date.now() });
    return conversationId;
  }

  private invalidateBridgeConversation(
    agentId: string,
    orgId: string,
    params: Record<string, unknown>,
  ): void {
    const key = this.bridgeConversationCacheKey(agentId, orgId, params);
    if (key) this.bridgeConversationCache.delete(key);
  }

  async bridge(agentId: string, orgId: string, rpc: BridgeRequest): Promise<BridgeResponse> {
    const rec = await agentSandboxesRepository.findRunningSandbox(agentId, orgId);
    if (!rec?.bridge_url) {
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
    } catch (error) {
      logger.warn("[agent-sandbox] Bridge request failed", {
        agentId,
        method: rpc.method,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32000, message: "Sandbox bridge is unreachable" },
      };
    }
  }

  async bridgeStream(agentId: string, orgId: string, rpc: BridgeRequest): Promise<Response | null> {
    const rec = await agentSandboxesRepository.findRunningSandbox(agentId, orgId);
    if (!rec?.bridge_url) {
      logger.warn("[agent-sandbox] Bridge stream to non-running sandbox", {
        agentId,
        method: rpc.method,
      });
      return null;
    }

    const params =
      rpc.params && typeof rpc.params === "object" ? (rpc.params as Record<string, unknown>) : {};
    const fallbackText = this.buildBridgeNoReplyFallbackText(params);

    try {
      // Reuse this session's conversation across turns; create only on the first
      // turn. A cached id that the sandbox has since dropped answers 404 on the
      // stream POST — evict and recreate exactly once before falling through to
      // the compatibility ladder.
      let forcedFreshConversation = false;
      for (;;) {
        const conversationId = await this.getOrCreateBridgeConversation(
          agentId,
          orgId,
          rec,
          params,
          {
            forceNew: forcedFreshConversation,
          },
        );
        const bridgeEndpoint = await this.deps.getAgentApiEndpoint(
          rec,
          `/api/conversations/${encodeURIComponent(conversationId)}/messages/stream`,
        );
        const res = await fetch(bridgeEndpoint, {
          method: "POST",
          headers: this.deps.getAgentJsonHeaders(rec),
          body: JSON.stringify(this.buildBridgeConversationMessageBody(params)),
          signal: AbortSignal.timeout(120_000),
        });
        if (res.ok) return this.normalizeBridgeSseResponse(res);
        if (res.status === 404) {
          // Stale/expired cached conversation id: evict and retry once with a
          // freshly created conversation. If the retry (or a create-per-call
          // session) still 404s, the route genuinely doesn't exist — stop and
          // fall through to the compatibility ladder below.
          if (!forcedFreshConversation) {
            this.invalidateBridgeConversation(agentId, orgId, params);
            forcedFreshConversation = true;
            continue;
          }
          break;
        }
        logger.warn("[agent-sandbox] Bridge stream conversation request failed", {
          agentId,
          status: res.status,
        });
        break;
      }
    } catch (error) {
      if (!(error instanceof BridgeRouteUnavailableError)) {
        logger.warn("[agent-sandbox] Bridge stream conversation request failed", {
          agentId,
          method: rpc.method,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      // A create failure invalidates any cached id so the next turn retries clean.
      this.invalidateBridgeConversation(agentId, orgId, params);
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

  private stableBridgeUuid(raw: string): string {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
      return raw;
    }
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(
      17,
      20,
    )}-${hash.slice(20, 32)}`;
  }

  private stableBridgeUserId(params: Record<string, unknown>): string {
    const raw =
      typeof params.userId === "string" && params.userId.trim()
        ? params.userId.trim()
        : typeof params.roomId === "string" && params.roomId.trim()
          ? params.roomId.trim()
          : "cloud-user";
    return this.stableBridgeUuid(raw);
  }

  private stableBridgeChannelId(agentId: string, params: Record<string, unknown>): string {
    const raw =
      typeof params.roomId === "string" && params.roomId.trim()
        ? params.roomId.trim()
        : typeof params.userId === "string" && params.userId.trim()
          ? params.userId.trim()
          : "default";
    return this.stableBridgeUuid(`cloud-bridge-channel:${agentId}:${raw}`);
  }

  private async bridgeStatus(rec: AgentSandbox, rpc: BridgeRequest): Promise<BridgeResponse> {
    const runtimeAgents = await this.deps.listRuntimeAgents(rec);
    if (runtimeAgents.supported) {
      const agent = this.deps.selectRuntimeAgent(runtimeAgents.agents);
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          status: agent?.status ?? (agent ? "running" : "starting"),
          ready: this.deps.isRuntimeAgentReady(agent),
          agentId: rec.id,
          runtimeAgentId: agent?.id,
          agentName: agent?.name,
        },
      };
    }

    const rootEndpoint = await this.deps.getAgentApiEndpoint(rec, "/");
    const rootRes = await fetch(rootEndpoint, {
      method: "GET",
      headers: this.deps.getAgentJsonHeaders(rec),
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
      },
    };
  }

  private async bridgeMessageSend(rec: AgentSandbox, rpc: BridgeRequest): Promise<BridgeResponse> {
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

    const attempts = [
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
  private bridgeResponseHasText(response: BridgeResponse): boolean {
    return typeof response.result?.text === "string" && response.result.text.trim().length > 0;
  }

  /**
   * The agent runtime's conversation route answers HTTP 200 with canned text
   * plus a `failureKind` discriminator when the model path is dead (provider
   * issue, rate limit, credit exhaustion, no provider). Surface it so callers
   * can tell a genuine model reply from a canned failure (#15616).
   */
  private extractBridgeFailureKind(body: Record<string, unknown>): string | undefined {
    return typeof body.failureKind === "string" && body.failureKind.trim()
      ? body.failureKind.trim()
      : undefined;
  }

  private async bridgeConversationMessageSend(
    rec: AgentSandbox,
    rpc: BridgeRequest,
    params: Record<string, unknown>,
  ): Promise<BridgeResponse> {
    const conversationId = await this.createBridgeConversation(rec, params);
    const messageEndpoint = await this.deps.getAgentApiEndpoint(
      rec,
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    );
    const res = await fetch(messageEndpoint, {
      method: "POST",
      headers: this.deps.getAgentJsonHeaders(rec),
      body: JSON.stringify(this.buildBridgeConversationMessageBody(params)),
      signal: AbortSignal.timeout(60_000),
    });
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

  private async bridgeCentralChannelMessageSend(
    rec: AgentSandbox,
    rpc: BridgeRequest,
    params: Record<string, unknown>,
  ): Promise<BridgeResponse> {
    const runtimeAgent = (await this.deps.ensureRuntimeAgentStarted(rec)) ?? undefined;
    if (!runtimeAgent?.id) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32000, message: "Runtime agent is not ready" },
      };
    }

    const channelId = this.stableBridgeChannelId(runtimeAgent.id, params);
    const messageEndpoint = await this.deps.getAgentApiEndpoint(
      rec,
      `/api/messaging/central-channels/${encodeURIComponent(channelId)}/messages`,
    );
    const res = await fetch(messageEndpoint, {
      method: "POST",
      headers: this.deps.getAgentJsonHeaders(rec),
      body: JSON.stringify(this.buildBridgeCentralChannelMessageBody(params, runtimeAgent.id)),
      signal: AbortSignal.timeout(60_000),
    });
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

  private async bridgeOpenAiChatCompletionSend(
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

  private async requestBridgeOpenAiChatCompletion(
    rec: AgentSandbox,
    params: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const endpoint = await this.deps.getAgentApiEndpoint(rec, "/v1/chat/completions");
    const res = await fetch(endpoint, {
      method: "POST",
      headers: this.deps.getAgentJsonHeaders(rec),
      body: JSON.stringify(this.buildBridgeOpenAiChatBody(params)),
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body };
  }

  private buildBridgeOpenAiChatBody(params: Record<string, unknown>): Record<string, unknown> {
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

  private buildBridgeNoReplyFallbackText(params: Record<string, unknown>): string | null {
    const text = typeof params.text === "string" ? params.text.trim() : "";
    if (!text) return null;

    const exactWords =
      /\bexact words?\s*:\s*["']?(.+?)["']?\s*$/i.exec(text) ??
      /\breply\s+(?:briefly\s+)?with\s+["']([^"']+)["']/i.exec(text);
    if (exactWords?.[1]?.trim()) {
      return exactWords[1].trim();
    }

    return "Agent runtime is online, but no model response was produced before the cloud bridge timeout.";
  }

  private async createBridgeConversation(
    rec: AgentSandbox,
    params: Record<string, unknown>,
  ): Promise<string> {
    const source =
      typeof params.source === "string" && params.source.trim() ? params.source : "cloud";
    const roomId =
      typeof params.roomId === "string" && params.roomId.trim() ? params.roomId : "default";
    const endpoint = await this.deps.getAgentApiEndpoint(rec, "/api/conversations");
    const res = await fetch(endpoint, {
      method: "POST",
      headers: this.deps.getAgentJsonHeaders(rec),
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

  private buildBridgeConversationMessageBody(
    params: Record<string, unknown>,
  ): Record<string, unknown> {
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
    return body;
  }

  private buildBridgeCentralChannelMessageBody(
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

  private getBridgeMessages(body: unknown): unknown[] {
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

  private normalizeBridgeRole(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    return normalized || null;
  }

  private bridgeRoleIsAgent(value: unknown): boolean {
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

  private bridgeRoleIsUser(value: unknown): boolean {
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

  private bridgeMessageIdMatches(value: unknown, runtimeAgentId?: string): boolean {
    return (
      typeof runtimeAgentId === "string" &&
      runtimeAgentId.length > 0 &&
      typeof value === "string" &&
      value === runtimeAgentId
    );
  }

  private nestedBridgeRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private isBridgeAgentMessage(message: Record<string, unknown>, runtimeAgentId?: string): boolean {
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

  private extractBridgeTextValue(value: unknown, depth = 0): string | null {
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

  private extractBridgeMessageText(message: Record<string, unknown>): string | null {
    for (const key of ["text", "fullText", "content", "message", "body", "reply", "response"]) {
      const text = this.extractBridgeTextValue(message[key]);
      if (text) return text;
    }
    return null;
  }

  private extractBridgeErrorMessage(body: Record<string, unknown>): string | null {
    const error = this.nestedBridgeRecord(body.error);
    if (error) {
      const message = this.extractBridgeTextValue(error.message);
      if (message) return message;
      const text = this.extractBridgeTextValue(error);
      if (text) return text;
    }
    return this.extractBridgeTextValue(body.message) ?? this.extractBridgeTextValue(body);
  }

  private extractOpenAiChatCompletionText(body: Record<string, unknown>): string | null {
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

  private async waitForBridgeCentralChannelAgentReply(
    rec: AgentSandbox,
    channelId: string,
    runtimeAgentId?: string,
  ): Promise<string | null> {
    const endpoint = await this.deps.getAgentApiEndpoint(
      rec,
      `/api/messaging/central-channels/${encodeURIComponent(channelId)}/messages?limit=30`,
    );

    for (let attempt = 0; attempt < 20; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2_500));
      const res = await fetch(endpoint, {
        method: "GET",
        headers: this.deps.getAgentJsonHeaders(rec),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const body = await res.json().catch(() => ({}));
      const messages = this.getBridgeMessages(body);
      for (const message of messages.toReversed()) {
        const record = this.nestedBridgeRecord(message);
        if (!record || !this.isBridgeAgentMessage(record, runtimeAgentId)) continue;
        const text = this.extractBridgeMessageText(record);
        if (text) return text;
      }
    }

    return null;
  }

  private async bridgeOpenAiChatCompletionSse(
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

  private createBridgeSseTextResponse(text: string): Response {
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

  private createBridgeSseErrorResponse(message: string): Response {
    return new Response(chatSseFrame("error", { message }), {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  }
}

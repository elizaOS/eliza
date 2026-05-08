import { randomUUID } from "node:crypto";
import {
  createUniqueUuid,
  EventType,
  type IAgentRuntime,
  type Memory,
  type UUID,
} from "@elizaos/core";
import type { AcpService } from "./acp-service.js";
import type { SessionEventName, SessionInfo } from "./types.js";

const ACPX_ROUTER_SOURCE = "sub_agent";
const SUB_AGENT_ENTITY_NAMESPACE = "acpx:sub-agent";

/**
 * SubAgentRouter takes terminal-significant ACPX session events
 * (`task_complete`, `error`, `blocked`) and posts them as synthetic inbound
 * messages into the runtime so the main agent's normal action layer can
 * decide whether to:
 *   - REPLY to the user,
 *   - SEND_TO_AGENT to push the sub-agent further,
 *   - or both.
 *
 * Routing keys are read from `session.metadata` populated by createTaskAction
 * at spawn time: `roomId`, `worldId`, `userId`, `messageId`, `source`, `label`.
 *
 * Streaming chunks (`agent_message_chunk`, `tool_running`) are intentionally
 * NOT injected — they would refire the planner constantly and burn cache.
 * The provider is the channel for live status; this router is the channel for
 * boundary events that warrant a decision.
 */
export class SubAgentRouter {
  static serviceType = "ACPX_SUB_AGENT_ROUTER";
  static dependencies = ["ACP_SUBPROCESS_SERVICE"];

  capabilityDescription =
    "Routes ACPX sub-agent terminal events back into the runtime as inbound messages so the main agent decides reply-to-user vs reply-to-agent vs both.";

  private readonly runtime: IAgentRuntime;
  private acp: AcpService | null = null;
  private unsubscribe: (() => void) | undefined;
  private readonly delivered = new Set<string>();
  private started = false;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
  }

  static async start(runtime: IAgentRuntime): Promise<SubAgentRouter> {
    const router = new SubAgentRouter(runtime);
    await router.start();
    return router;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const disabled = readSetting(
      this.runtime,
      "ACPX_SUB_AGENT_ROUTER_DISABLED",
    );
    if (disabled === "1" || disabled === "true") {
      this.log("info", "router disabled via ACPX_SUB_AGENT_ROUTER_DISABLED");
      return;
    }
    const acp = this.runtime.getService(
      "ACP_SUBPROCESS_SERVICE",
    ) as AcpService | null;
    if (!acp || typeof acp.onSessionEvent !== "function") {
      this.log("warn", "AcpService unavailable; router idle");
      return;
    }
    this.acp = acp;
    this.unsubscribe = acp.onSessionEvent((sid, event, data) => {
      this.handleEvent(sid, event, data).catch((err) => {
        this.log("error", "router event failed", {
          sessionId: sid,
          event,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
    this.log("info", "router bound to AcpService");
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.acp = null;
    this.started = false;
    this.delivered.clear();
  }

  private async handleEvent(
    sessionId: string,
    event: SessionEventName,
    data: unknown,
  ): Promise<void> {
    if (!shouldInject(event)) return;
    const acp = this.acp;
    if (!acp) return;
    const session = await acp.getSession(sessionId);
    if (!session) return;

    const dedupKey = computeDedupKey(sessionId, event, session, data);
    if (this.delivered.has(dedupKey)) return;
    this.delivered.add(dedupKey);
    pruneDelivered(this.delivered, 256);

    const origin = readOrigin(session);
    if (!origin) {
      this.log(
        "debug",
        "session has no origin metadata; skipping router post",
        {
          sessionId,
          event,
        },
      );
      return;
    }

    const subAgentEntityId = createUniqueUuid(
      this.runtime,
      `${SUB_AGENT_ENTITY_NAMESPACE}:${sessionId}`,
    );
    const text = composeNarration(event, origin.label, session, data);
    const memory: Memory = {
      id: randomUUID() as UUID,
      entityId: subAgentEntityId,
      agentId: this.runtime.agentId,
      roomId: origin.roomId,
      ...(origin.worldId ? { worldId: origin.worldId } : {}),
      content: {
        text,
        source: ACPX_ROUTER_SOURCE,
        ...(origin.parentMessageId
          ? { inReplyTo: origin.parentMessageId }
          : {}),
        metadata: {
          subAgent: true,
          subAgentSessionId: sessionId,
          subAgentLabel: origin.label,
          subAgentEvent: event,
          subAgentStatus: session.status,
          subAgentAgentType: session.agentType,
          ...(origin.userId ? { originUserId: origin.userId } : {}),
          ...(origin.parentMessageId
            ? { originMessageId: origin.parentMessageId }
            : {}),
          ...(origin.source ? { originSource: origin.source } : {}),
        },
      },
      createdAt: Date.now(),
    };

    await this.runtime.createMemory(memory, "messages").catch((err) => {
      this.log("warn", "createMemory for sub-agent post failed", {
        sessionId,
        event,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    if (this.runtime.messageService?.handleMessage) {
      await this.runtime.messageService
        .handleMessage(this.runtime, memory, undefined)
        .catch((err) => {
          this.log("error", "handleMessage for sub-agent post failed", {
            sessionId,
            event,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    } else {
      this.log(
        "warn",
        "runtime.messageService unavailable; falling back to MESSAGE_RECEIVED emit",
        {
          sessionId,
          event,
        },
      );
      await this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
        runtime: this.runtime,
        message: memory,
        source: ACPX_ROUTER_SOURCE,
      });
    }
  }

  private log(
    level: "debug" | "info" | "warn" | "error",
    msg: string,
    data?: unknown,
  ): void {
    const logger = this.runtime.logger;
    const fn = logger?.[level];
    if (typeof fn === "function") {
      fn.call(
        logger,
        { src: "acpx:sub-agent-router", ...(data as object) },
        msg,
      );
    }
  }
}

function shouldInject(event: SessionEventName): boolean {
  return event === "task_complete" || event === "error" || event === "blocked";
}

interface OriginInfo {
  roomId: UUID;
  worldId?: UUID;
  userId?: UUID;
  parentMessageId?: UUID;
  label: string;
  source?: string;
}

function readOrigin(session: SessionInfo): OriginInfo | null {
  const meta = session.metadata as Record<string, unknown> | undefined;
  if (!meta) return null;
  const roomId = pickUuid(meta.roomId);
  if (!roomId) return null;
  return {
    roomId,
    worldId: pickUuid(meta.worldId),
    userId: pickUuid(meta.userId),
    parentMessageId: pickUuid(meta.messageId),
    label: pickLabel(meta) ?? session.name ?? session.id,
    source: typeof meta.source === "string" ? meta.source : undefined,
  };
}

function pickUuid(v: unknown): UUID | undefined {
  if (typeof v !== "string") return undefined;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  )
    return undefined;
  return v as UUID;
}

function pickLabel(meta: Record<string, unknown>): string | undefined {
  if (typeof meta.label === "string" && meta.label.trim()) return meta.label;
  return undefined;
}

function pickPayloadString(data: unknown, key: string): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const v = (data as Record<string, unknown>)[key];
  if (typeof v !== "string" || !v.trim()) return undefined;
  return v;
}

function composeNarration(
  event: SessionEventName,
  label: string,
  session: SessionInfo,
  data: unknown,
): string {
  const header = `[sub-agent: ${label} (${session.agentType}) — ${event}]`;
  if (event === "error") {
    const message =
      pickPayloadString(data, "message") ?? "sub-agent reported an error";
    return `${header}\n${message}`;
  }
  if (event === "blocked") {
    const message =
      pickPayloadString(data, "message") ??
      pickPayloadString(data, "prompt") ??
      "sub-agent is blocked and waiting for input";
    return `${header}\n${message}`;
  }
  const response =
    pickPayloadString(data, "response") ??
    pickPayloadString(data, "finalText") ??
    "sub-agent reports task complete (no captured output).";
  return `${header}\n${response}`;
}

function computeDedupKey(
  sessionId: string,
  event: SessionEventName,
  session: SessionInfo,
  data: unknown,
): string {
  const fingerprint =
    pickPayloadString(data, "response") ??
    pickPayloadString(data, "finalText") ??
    pickPayloadString(data, "message") ??
    "";
  return `${sessionId}|${event}|${session.status}|${shortHash(fingerprint)}`;
}

function shortHash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

function pruneDelivered(set: Set<string>, max: number): void {
  if (set.size <= max) return;
  const it = set.values();
  for (let i = 0; i < set.size - max; i++) {
    const next = it.next();
    if (next.done) break;
    set.delete(next.value);
  }
}

function readSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const get = (runtime as { getSetting?: (k: string) => string | undefined })
    .getSetting;
  if (typeof get === "function") {
    const v = get.call(runtime, key);
    if (typeof v === "string" && v.length > 0) return v;
  }
  const env = process.env[key];
  return typeof env === "string" && env.length > 0 ? env : undefined;
}

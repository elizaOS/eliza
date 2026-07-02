/**
 * Mid-task message forwarding for live sub-agents.
 *
 * When a user posts into a room that has a live sub-agent session bound to it,
 * this handler decides — via {@link decideInterruption} — whether to deliver the
 * message now, queue it until the current turn ends, interrupt the turn, or
 * ignore it (ambient chatter). Extracted from the plugin `init` closure so the
 * decision→action wiring is unit-testable in isolation (see
 * `active-session-forward.test.ts`).
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { AcpService } from "./acp-service.js";
import { decideInterruptionWithModel } from "./interruption-decider.js";
import type { SubAgentInbox } from "./sub-agent-inbox.js";
import { requireTaskAgentAccess } from "./task-policy.js";
import { type SessionInfo, TERMINAL_SESSION_STATUSES } from "./types.js";

// Skip forwarding our own posts back into `acp.sendPrompt` — would echo-loop.
// `entityId === runtime.agentId` is not enough: the router uses a synthetic
// sub-agent UUID, so we also filter by Content.source.
export const INTERNAL_FORWARD_SKIP_SOURCES = new Set([
  "sub_agent",
  "sub_agent_progress",
  "sub_agent_complete",
]);

/**
 * A session is "busy" (not safe to prompt now) whenever it is neither a
 * terminal status nor `ready`. This covers `busy`, `tool_running` (the dominant
 * mid-turn state on the native transport), `running`, `blocked`, and
 * `authenticating` — for all of these `acp.sendPrompt` would throw or be
 * inappropriate, so the message must queue and flush when the session returns
 * to `ready`. Only `ready` is promptable.
 */
export function isSessionBusy(status: string): boolean {
  return status !== "ready" && !TERMINAL_SESSION_STATUSES.has(status);
}

const SRC = "@elizaos/plugin-agent-orchestrator";

/**
 * Build the MESSAGE_RECEIVED handler that forwards mid-task user messages to the
 * live sub-agent bound to the message's room. Bind is on (source, roomId) — no
 * Discord-thread dependency, so plain SMS/WhatsApp follow-ups work too.
 */
export function createActiveSessionForwardHandler(
  runtime: IAgentRuntime,
  subAgentInbox: SubAgentInbox,
): (payload: { message: Memory }) => Promise<void> {
  return async ({ message }) => {
    try {
      if (!message?.entityId || message.entityId === runtime.agentId) return;
      const contentRecord = (message.content ?? {}) as Record<string, unknown>;
      const contentSource =
        typeof contentRecord.source === "string"
          ? contentRecord.source
          : undefined;
      if (contentSource && INTERNAL_FORWARD_SKIP_SOURCES.has(contentSource))
        return;
      // Skip transient status posts (persisted by the progress hook / discord
      // extraMetadata) — both top-level and nested metadata.transient.
      const topMeta = (message.metadata ?? {}) as Record<string, unknown>;
      const nestedMeta = (contentRecord.metadata ?? {}) as Record<
        string,
        unknown
      >;
      if (topMeta.transient === true || nestedMeta.transient === true) return;
      const acp = runtime.getService<AcpService>(AcpService.serviceType);
      if (!acp) return;
      const sessions = await Promise.resolve(acp.listSessions()).catch(
        (err: unknown) => {
          runtime.logger?.warn?.(
            { src: SRC, err: err instanceof Error ? err.message : String(err) },
            "active-session forward listSessions failed",
          );
          return [] as SessionInfo[];
        },
      );
      const boundToRoom = (s: SessionInfo): boolean => {
        if (TERMINAL_SESSION_STATUSES.has(s.status)) return false;
        const meta = s.metadata;
        const roomId =
          typeof meta?.roomId === "string" ? meta.roomId : undefined;
        // threadRoomId matches replies posted inside the per-label thread.
        const threadRoomId =
          typeof meta?.threadRoomId === "string"
            ? meta.threadRoomId
            : undefined;
        return roomId === message.roomId || threadRoomId === message.roomId;
      };
      const active = sessions.find(boundToRoom);
      if (!active) return;
      const text =
        typeof (message.content as { text?: unknown })?.text === "string"
          ? ((message.content as { text: string }).text ?? "").trim()
          : "";
      if (!text) return;
      if (typeof acp.sendPrompt !== "function") return;
      // ACL: forwarding user text mid-flight is functionally identical to the
      // TASKS_SEND_TO_AGENT action — without this any user with channel write
      // access could inject prompts into another user's sub-agent.
      const access = await requireTaskAgentAccess(runtime, message, "interact");
      if (!access.allowed) return;

      const label =
        typeof active.metadata?.label === "string"
          ? active.metadata.label
          : active.name;
      // "Crowded room": more than one live sub-agent bound to this room.
      const multiParty = sessions.filter(boundToRoom).length > 1;
      const busy = isSessionBusy(active.status);
      // What the sub-agent is working on, for the model classifier's relevance
      // judgement — best-effort from session metadata (all optional).
      const meta = (active.metadata ?? {}) as Record<string, unknown>;
      const taskContext = [
        meta.originalTask,
        meta.task,
        meta.goal,
        meta.taskTitle,
      ].find((v): v is string => typeof v === "string" && v.trim().length > 0);
      const decision = await decideInterruptionWithModel(runtime, {
        text,
        agentType: active.agentType,
        sessionBusy: busy,
        multiParty,
        ...(label ? { agentLabel: label } : {}),
        ...(taskContext ? { taskContext } : {}),
      });
      runtime.logger?.debug?.(
        {
          src: SRC,
          sessionId: active.id,
          status: active.status,
          busy,
          multiParty,
          action: decision.action,
          reason: decision.reason,
        },
        "interruption decision",
      );

      // Deliver now (idle path): flush any queued messages, then this one.
      // Requeue on failure (e.g. a racing busy transition) so the user's text
      // is never silently dropped — the flush listener retries it.
      const deliverNow = async (payload: string) => {
        try {
          await acp.sendPrompt(active.id, payload);
        } catch (err) {
          subAgentInbox.enqueue(active.id, payload);
          runtime.logger?.warn?.(
            {
              src: SRC,
              sessionId: active.id,
              err: err instanceof Error ? err.message : String(err),
            },
            "active-session forward failed; requeued for flush",
          );
        }
      };

      switch (decision.action) {
        case "ignore":
          return;
        case "interrupt": {
          if (!busy) {
            // Nothing in flight to cancel — deliver the instruction to the idle
            // agent instead of dropping it.
            const queued = subAgentInbox.drain(active.id);
            await deliverNow(queued ? `${queued}\n${text}` : text);
            return;
          }
          // Cancel the in-flight turn (status → terminal `cancelled`). The
          // planner pipeline runs on this same MESSAGE_RECEIVED and routes the
          // user's redirect; we do not re-deliver to the dead session.
          subAgentInbox.clear(active.id);
          await acp.cancelSession?.(active.id)?.catch?.((err: unknown) =>
            runtime.logger?.warn?.(
              {
                src: SRC,
                sessionId: active.id,
                err: err instanceof Error ? err.message : String(err),
              },
              "interrupt cancel failed",
            ),
          );
          return;
        }
        default: {
          // deliver / queue. Mid-turn → queue for the flush listener; otherwise
          // flush + deliver immediately.
          if (busy) {
            subAgentInbox.enqueue(active.id, text);
            return;
          }
          const queued = subAgentInbox.drain(active.id);
          await deliverNow(queued ? `${queued}\n${text}` : text);
          return;
        }
      }
    } catch (err) {
      runtime.logger?.warn?.(
        { src: SRC, err: err instanceof Error ? err.message : String(err) },
        "active-session forward listener threw",
      );
    }
  };
}

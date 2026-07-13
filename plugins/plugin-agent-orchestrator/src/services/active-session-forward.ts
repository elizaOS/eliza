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
import {
  type IAgentRuntime,
  MESSAGE_SOURCE_SUB_AGENT,
  type Memory,
} from "@elizaos/core";
import { AcpService } from "./acp-service.js";
import { decideInterruptionWithModel } from "./interruption-decider.js";
import { sessionBoundRoomIds } from "./session-room-binding.js";
import type { SubAgentInbox } from "./sub-agent-inbox.js";
import { requireTaskAgentAccess } from "./task-policy.js";
import { type SessionInfo, TERMINAL_SESSION_STATUSES } from "./types.js";

// Skip forwarding our own posts back into `acp.sendPrompt` — would echo-loop.
// `entityId === runtime.agentId` is not enough: the router uses a synthetic
// sub-agent UUID, so we also filter by Content.source.
export const INTERNAL_FORWARD_SKIP_SOURCES = new Set([
  MESSAGE_SOURCE_SUB_AGENT,
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
 * Build the MESSAGE_RECEIVED handler that forwards mid-task user messages to
 * every live sub-agent bound to the message's room. Bind matches any of the
 * session's rooms (task room, origin channel, thread — see
 * {@link sessionBoundRoomIds}) with no Discord-thread dependency, so plain
 * SMS/WhatsApp follow-ups in the origin channel work too.
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
          // error-policy:J4 listSessions unavailable → skip mid-task forward; logged
          runtime.logger?.warn?.(
            { src: SRC, err: err instanceof Error ? err.message : String(err) },
            "active-session forward listSessions failed",
          );
          return [] as SessionInfo[];
        },
      );
      // Binding covers every room the session is conversationally reachable
      // from: with per-task GROUP rooms on by default, `meta.roomId` is the
      // minted task room while the user types in the origin connector channel
      // (`originRoomId`/`sourceRoomId`) — matching only the raw roomId
      // silently dropped every origin-channel follow-up.
      const boundToRoom = (s: SessionInfo): boolean => {
        if (TERMINAL_SESSION_STATUSES.has(s.status)) return false;
        return sessionBoundRoomIds(
          s.metadata as Record<string, unknown> | undefined,
        ).has(message.roomId);
      };
      const bound = sessions.filter(boundToRoom);
      if (bound.length === 0) return;
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

      // "Crowded room": more than one live sub-agent bound to this room.
      const multiParty = bound.length > 1;
      // Every bound live session gets its own interruption decision and its
      // own delivery/queue — a room with several live sub-agents must not
      // quietly forward the user's text to only the first in list order.
      for (const active of bound) {
        const label =
          typeof active.metadata?.label === "string"
            ? active.metadata.label
            : active.name;
        const busy = isSessionBusy(active.status);
        // What the sub-agent is working on, for the model classifier's
        // relevance judgement — best-effort from session metadata (all
        // optional).
        const meta = (active.metadata ?? {}) as Record<string, unknown>;
        const taskContext = [
          meta.originalTask,
          meta.task,
          meta.goal,
          meta.taskTitle,
        ].find(
          (v): v is string => typeof v === "string" && v.trim().length > 0,
        );
        // The message reached this session via its ORIGIN connector channel
        // rather than a room dedicated to the task (task room / thread). The
        // origin channel is shared with the orchestrator planner, so the
        // decider must classify task-relevance there instead of
        // blanket-delivering planner-directed messages into the sub-agent.
        const originMatch =
          message.roomId === meta.originRoomId ||
          message.roomId === meta.sourceRoomId;
        const dedicatedMatch =
          message.roomId === meta.threadRoomId ||
          message.roomId === meta.taskRoomId ||
          // Sessions spawned without a distinct task room bind roomId to the
          // origin channel itself; only then does roomId count as dedicated,
          // preserving the pre-task-rooms delivery behavior.
          (meta.taskRoomId === undefined && message.roomId === meta.roomId);
        const sharedChannel = originMatch && !dedicatedMatch;
        const decision = await decideInterruptionWithModel(runtime, {
          text,
          agentType: active.agentType,
          sessionBusy: busy,
          multiParty,
          sharedChannel,
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
            sharedChannel,
            action: decision.action,
            reason: decision.reason,
          },
          "interruption decision",
        );

        // Deliver now (idle path): flush any queued messages, then this one.
        // Requeue on failure (e.g. a racing busy transition) so the user's
        // text is never silently dropped — the flush listener retries it.
        const deliverNow = async (payload: string) => {
          try {
            await acp.sendPrompt(active.id, payload);
          } catch (err) {
            // error-policy:J4 sendPrompt failed → requeue for flush-listener retry; user text never dropped
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
            continue;
          case "interrupt": {
            if (!busy) {
              // Nothing in flight to cancel — deliver the instruction to the
              // idle agent instead of dropping it.
              const queued = subAgentInbox.drain(active.id);
              await deliverNow(queued ? `${queued}\n${text}` : text);
              continue;
            }
            // Cancel the in-flight turn (status → terminal `cancelled`). The
            // planner pipeline runs on this same MESSAGE_RECEIVED and routes
            // the user's redirect; we do not re-deliver to the dead session.
            subAgentInbox.clear(active.id);
            // error-policy:J6 best-effort session cancel on interrupt; warn only
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
            continue;
          }
          default: {
            // deliver / queue. Mid-turn → queue for the flush listener;
            // otherwise flush + deliver immediately.
            if (busy) {
              subAgentInbox.enqueue(active.id, text);
              continue;
            }
            const queued = subAgentInbox.drain(active.id);
            await deliverNow(queued ? `${queued}\n${text}` : text);
          }
        }
      }
    } catch (err) {
      // error-policy:J1 event-listener boundary; one bad message must not crash the MESSAGE_RECEIVED bus
      runtime.logger?.warn?.(
        { src: SRC, err: err instanceof Error ? err.message : String(err) },
        "active-session forward listener threw",
      );
    }
  };
}

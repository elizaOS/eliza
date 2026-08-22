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
import {
  activateFollowUpOrigin,
  notePendingFollowUpOrigin,
  originMessageIdFor,
} from "./follow-up-origin.js";
import {
  ADMIN_STOP_META_KEY,
  markSessionAdministrativelyStopped,
} from "./admin-stop-marker.js";
import { decideInterruptionWithModel } from "./interruption-decider.js";
import { OrchestratorTaskService } from "./orchestrator-task-service.js";
import type {
  OrchestratorTaskRecord,
  OrchestratorTaskStatus,
} from "./orchestrator-task-types.js";
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

/** Structural view of ORCHESTRATOR_TASK_SERVICE for the forward gate. Looked
 * up per event and typeof-guarded so the forwarder behaves identically (fails
 * OPEN: forward) when the service is absent or its surface drifts. */
type DurableTaskLookup = {
  getTaskForSession?: (
    sessionId: string,
  ) => Promise<OrchestratorTaskRecord | null>;
};

const ORCHESTRATOR_TASK_SERVICE_TYPE = "ORCHESTRATOR_TASK_SERVICE";

/** Task statuses whose sessions must never receive live room forwards. */
const FORWARD_DROP_STATUSES: ReadonlySet<OrchestratorTaskStatus> =
  new Set<OrchestratorTaskStatus>(["archived", "failed"]);

/**
 * Should a live-room user message still be forwarded to this session, given
 * its durable task record? The contamination defect: sessions SURVIVE their
 * task being parked/archived (keepAliveAfterComplete workers sit `ready`), and
 * without this gate an old session absorbed a NEW request and built the wrong
 * artifact under the dead task's label.
 *
 * Rules (fail-open — only a POSITIVE terminal signal drops):
 *  - no record → forward (sessions without durable tasks are legitimate);
 *  - archived flag or archived/failed status → drop;
 *  - done → drop unless the session opted into completed-session follow-ups
 *    (its own `keepAliveAfterComplete` metadata — the deliberate feature);
 *  - waiting_on_user → drop for verify parks: the new stamps (verifyParkedAt /
 *    verifyEscalationNotifiedAt) or, for tasks parked BEFORE the stamps
 *    existed, a persisted `autoVerifyAttempts` counter — both park branches
 *    write that counter before parking, so every pre-stamp verify park
 *    carries it. Question/login parks keep forwarding so the user's answer
 *    still reaches the blocked session;
 *  - open/active/blocked/validating/interrupted → forward.
 */
export function shouldForwardForTask(
  task: OrchestratorTaskRecord | null,
  sessionMeta: Record<string, unknown> | undefined,
): boolean {
  if (!task) return true;
  if (task.archived === true) return false;
  const status = task.status;
  if (FORWARD_DROP_STATUSES.has(status)) return false;
  if (status === "done") {
    return sessionMeta?.keepAliveAfterComplete === true;
  }
  if (status === "waiting_on_user") {
    const meta = task.metadata ?? {};
    // Tradeoff, deliberate: `autoVerifyAttempts >= 1` also matches the narrow
    // case of a login/question park that happens AFTER a failed verify
    // attempt on a row without the new stamps — that user answer is muted
    // too. Accepted: the alternative left every pre-stamp verify-parked
    // session absorbing NEW room messages forever (the live contamination
    // defect), and post-stamp verify parks always carry verifyParkedAt so
    // the ambiguity only spans rows parked before the stamps deployed.
    // Unstamped waiting_on_user WITHOUT any verify signal keeps forwarding —
    // muting it would break every live login/question park.
    const verifyParked = Boolean(
      meta.verifyParkedAt ||
        meta.verifyEscalationNotifiedAt ||
        Number(meta.autoVerifyAttempts) >= 1,
    );
    return !verifyParked;
  }
  return true;
}

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
      // Belt (sync): a session stamped administratively stopped is dead to
      // the room even when the actual ACP stop failed/raced — never forward
      // into it.
      const unstopped = bound.filter((s) => {
        const meta = s.metadata as Record<string, unknown> | undefined;
        const adminStopped =
          typeof meta?.[ADMIN_STOP_META_KEY] === "string" &&
          (meta[ADMIN_STOP_META_KEY] as string).length > 0;
        if (adminStopped) {
          runtime.logger?.debug?.(
            { src: SRC, sessionId: s.id, reason: meta?.[ADMIN_STOP_META_KEY] },
            "active-session forward suppressed: administratively stopped",
          );
        }
        return !adminStopped;
      });
      if (unstopped.length === 0) return;
      // Durable-task gate (async): a session whose task is archived, failed,
      // done (without the deliberate keep-alive follow-up opt-in), or
      // verify-parked must not absorb live room traffic — that contamination
      // built the wrong artifact under a dead task's label. Fail-open at
      // every step: no service, no record, or a lookup error keeps
      // forwarding.
      const taskSvc = runtime.getService(
        ORCHESTRATOR_TASK_SERVICE_TYPE,
      ) as DurableTaskLookup | null;
      const hasTaskLookup = typeof taskSvc?.getTaskForSession === "function";
      const gated: SessionInfo[] = [];
      for (const s of unstopped) {
        if (!hasTaskLookup) {
          gated.push(s);
          continue;
        }
        let task: OrchestratorTaskRecord | null = null;
        let lookupFailed = false;
        try {
          task = (await taskSvc?.getTaskForSession?.(s.id)) ?? null;
        } catch (err) {
          // error-policy:J4 task lookup unavailable degrades to forwarding
          // (today's behavior); the failure is warned so a broken gate is
          // observable instead of silently dropping user messages.
          lookupFailed = true;
          runtime.logger?.warn?.(
            {
              src: SRC,
              sessionId: s.id,
              err: err instanceof Error ? err.message : String(err),
            },
            "active-session forward task lookup failed; forwarding",
          );
        }
        if (
          lookupFailed ||
          shouldForwardForTask(
            task,
            s.metadata as Record<string, unknown> | undefined,
          )
        ) {
          gated.push(s);
        } else {
          runtime.logger?.debug?.(
            {
              src: SRC,
              sessionId: s.id,
              taskId: task?.id,
              taskStatus: task?.status,
            },
            "active-session forward suppressed: task no longer accepts room forwards",
          );
        }
      }
      if (gated.length === 0) return;
      const text =
        typeof (message.content as { text?: unknown })?.text === "string"
          ? ((message.content as { text: string }).text ?? "").trim()
          : "";
      if (!text) return;
      if (typeof acp.sendPrompt !== "function") return;
      const followUpOriginId = originMessageIdFor(message);
      // ACL: forwarding user text mid-flight is functionally identical to the
      // TASKS_SEND_TO_AGENT action — without this any user with channel write
      // access could inject prompts into another user's sub-agent.
      const access = await requireTaskAgentAccess(runtime, message, "interact");
      if (!access.allowed) return;

      // "Crowded room": more than one live sub-agent bound to this room —
      // computed from the POST-gate list so suppressed sessions don't inflate
      // the classifier's crowd signal.
      const multiParty = gated.length > 1;
      // Every bound live session gets its own interruption decision and its
      // own delivery/queue — a room with several live sub-agents must not
      // quietly forward the user's text to only the first in list order.
      for (const active of gated) {
        const label =
          typeof active.metadata?.label === "string"
            ? active.metadata.label
            : active.name;
        // A smithers-driven session's conversation belongs to the workflow
        // executor for the run's whole lifetime: a direct deliverNow prompt
        // races the executor's own turn and killed the workflow mid-build
        // ("status failed" ~10s after a follow-up arrived, live 2026-08-20
        // — bmi / password-generator / yahtzee). Treat it as busy so every
        // relevant follow-up queues; the idle-flush (or the orphan redirect
        // when the session stops at completion) owns delivery.
        const activeMeta = (active.metadata ?? {}) as Record<string, unknown>;
        const smithersRunState = (
          activeMeta.smithersDurableRun as { state?: string } | undefined
        )?.state;
        const busy =
          isSessionBusy(active.status) ||
          smithersRunState === "running" ||
          smithersRunState === "pending";
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
            // The delivered follow-up's completion claims ITS OWN voice slot
            // (see follow-up-origin.ts).
            await activateFollowUpOrigin(acp, active.id, followUpOriginId);
            await acp.sendPrompt(active.id, payload);
          } catch (err) {
            // error-policy:J4 sendPrompt failed → requeue for flush-listener retry; user text never dropped
            await notePendingFollowUpOrigin(acp, active.id, followUpOriginId);
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
            const taskService = runtime.getService?.(
              OrchestratorTaskService.serviceType,
            ) as OrchestratorTaskService | null | undefined;
            if (!busy) {
              // The session is idle, but its TASK may still be in flight
              // (validating / awaiting a verify lap): the stop applies to the
              // task. Prompting the idle child with "actually stop, cancel
              // that build" made it invent deploy scripts for three coaching
              // laps (live 2026-08-22, tetris).
              let taskInterrupted = false;
              if (taskService) {
                try {
                  const owner = await taskService.getTaskForSession(active.id);
                  if (owner) {
                    taskInterrupted = await taskService.interruptTask(
                      owner.id,
                      "user_interrupt",
                    );
                  }
                } catch {
                  // error-policy:J6 best-effort; fall through to delivery.
                }
              }
              if (taskInterrupted) {
                subAgentInbox.clear(active.id);
                await markSessionAdministrativelyStopped(
                  acp,
                  active.id,
                  "user_interrupt",
                ).catch(() => undefined);
                continue;
              }
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
            // Stamp FIRST: the coordinator's stopped/cancelled synthesis and
            // the verify-retry gate read this so a user-initiated interrupt
            // never narrates as a task failure ("stopped before completion")
            // or gets auto-retried.
            await markSessionAdministrativelyStopped(
              acp,
              active.id,
              "user_interrupt",
            ).catch(() => undefined);
            // Cooperative cancel first; the eliza-code ACP server often never
            // confirms `session/cancel`, and giving up there let a cancelled
            // build run to completion and post its result after the user's
            // cancel (live 2026-08-19). An unconfirmed interrupt escalates to
            // a hard stop — that is what the user asked for.
            // The task OWNS the lane plan, respawns, and verify laps: stop
            // it first, or the remaining lanes of a phased build launch right
            // after this session dies (live 2026-08-22, tetris: 3 more lanes
            // ran to verification after "stopping the build now").
            if (taskService) {
              try {
                const owner = await taskService.getTaskForSession(active.id);
                if (owner) {
                  await taskService.interruptTask(owner.id, "user_interrupt");
                }
              } catch (err) {
                // error-policy:J6 best-effort; the session stop below still
                // ends the in-flight work.
                runtime.logger?.warn?.(
                  {
                    src: SRC,
                    sessionId: active.id,
                    err: err instanceof Error ? err.message : String(err),
                  },
                  "interrupt could not mark the owning task interrupted",
                );
              }
            }
            try {
              await acp.cancelSession?.(active.id);
            } catch (err) {
              runtime.logger?.warn?.(
                {
                  src: SRC,
                  sessionId: active.id,
                  err: err instanceof Error ? err.message : String(err),
                },
                "interrupt cancel unconfirmed; escalating to hard stop",
              );
              // error-policy:J6 best-effort teardown; the stop failure is logged
              await acp.stopSession?.(active.id)?.catch?.((stopErr: unknown) =>
                runtime.logger?.warn?.(
                  {
                    src: SRC,
                    sessionId: active.id,
                    err:
                      stopErr instanceof Error
                        ? stopErr.message
                        : String(stopErr),
                  },
                  "interrupt hard stop failed",
                ),
              );
            }
            continue;
          }
          default: {
            // deliver / queue. Mid-turn → queue for the flush listener;
            // otherwise flush + deliver immediately.
            if (busy) {
              await notePendingFollowUpOrigin(acp, active.id, followUpOriginId);
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

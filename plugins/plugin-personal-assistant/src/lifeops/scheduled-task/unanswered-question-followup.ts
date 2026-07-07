/**
 * Unanswered-question follow-up (#14676): the path from an agent question in
 * ordinary chat to an unprompted nudge when the owner never answers.
 *
 * The pending-prompt / no-reply machinery only ever covered ScheduledTask
 * fires; a question the agent asked in a normal REPLY turn evaporated the
 * moment the turn ended. This module closes the loop with the ONE scheduler:
 *
 *  - On `MESSAGE_SENT` (agent outbound replying to an owner message), a cheap
 *    structural candidate check — does the reply END with a question? — seeds
 *    a `kind: "followup"` ScheduledTask with a `once` trigger. Detection is
 *    only candidacy: whether the nudge is actually worth sending is decided
 *    at fire time by the `model_moment_check` gate (the #14677 moment judge),
 *    which sees the open question, the owner's presence/quiet-streak context,
 *    and can send / defer / drop. `quiet_hours` composes before it as the
 *    hard-constraint backstop.
 *  - On `MESSAGE_RECEIVED` (owner speaks in the room), every still-scheduled
 *    question follow-up for that room is dismissed: the owner re-engaged, so
 *    a delayed nudge about the old turn is stale — if the agent still wants
 *    the answer, the live conversation is where it re-asks (and its next
 *    reply re-registers a fresh follow-up if it ends with a question).
 *  - Once FIRED, the existing spine machinery owns the rest: the scheduler
 *    records a pending prompt, `inbound-reply-completion` completes the task
 *    when the owner answers, and the completion timeout lets it go quietly
 *    (kind `followup` has no no-reply ladder — one nudge, never a chase).
 *
 * At most one scheduled question follow-up exists per room: registering a new
 * one dismisses its predecessor (the newest agent question supersedes).
 */

import { hasOwnerAccess } from "@elizaos/agent";
import {
  type IAgentRuntime,
  logger,
  type Memory,
  type MessagePayload,
  type UUID,
} from "@elizaos/core";
import type {
  ScheduledTask,
  ScheduledTaskInput,
} from "@elizaos/plugin-scheduling";
import { getScheduledTaskRunner } from "./service.js";

const LOG_SRC = "lifeops:scheduled-task:unanswered-question-followup";

/** Structural metadata marker for question follow-up tasks. */
export const UNANSWERED_QUESTION_METADATA_KEY = "unansweredQuestionFollowup";

export const UNANSWERED_QUESTION_CREATED_BY =
  "lifeops:unanswered-question-followup";

/**
 * Delay between the unanswered question and the follow-up's scheduled fire.
 * Deliberately generous for chat: long enough that "still typing / reading"
 * silences never trigger it, short enough that the thread is still warm. The
 * fire-time moment judge can defer further; it cannot fire earlier.
 */
export const UNANSWERED_QUESTION_FOLLOWUP_DELAY_MINUTES = 45;

/**
 * After the nudge fires, how long an owner reply still completes the task
 * before the completion timeout lets it go (no retry ladder for `followup`).
 */
const FOLLOWUP_COMPLETION_TIMEOUT_MINUTES = 4 * 60;

const QUESTION_SNIPPET_MAX_LENGTH = 200;

function messageText(message: Memory): string {
  const text = message.content?.text;
  return typeof text === "string" ? text : "";
}

/**
 * Structural candidate detection: the message ENDS with a question sentence.
 * A trailing question is the strongest "awaiting an answer" signal; mid-text
 * questions are usually rhetorical or already resolved by the surrounding
 * prose. Returns the final question sentence (clamped) or null. Whether the
 * question deserves a nudge is NOT decided here — that is the fire-time
 * moment judge's call.
 */
export function extractTrailingQuestion(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length < 4) return null;
  // Allow closing quotes/brackets after the question mark.
  if (!/\?["'’”)\]]*$/.test(trimmed)) return null;
  const lastQuestionMark = trimmed.lastIndexOf("?");
  const preceding = trimmed.slice(0, lastQuestionMark);
  const sentenceStart =
    Math.max(
      preceding.lastIndexOf("."),
      preceding.lastIndexOf("!"),
      preceding.lastIndexOf("?"),
      preceding.lastIndexOf("\n"),
    ) + 1;
  // Keep everything through the end: the anchor regex guarantees only the
  // question mark and its closing quotes/brackets follow `sentenceStart`.
  const question = trimmed.slice(sentenceStart).trim();
  if (question.length < 4) return null;
  if (question.length <= QUESTION_SNIPPET_MAX_LENGTH) return question;
  return `…${question.slice(question.length - QUESTION_SNIPPET_MAX_LENGTH + 1)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Structural check: is this task an unanswered-question follow-up (for `roomId`)? */
export function isUnansweredQuestionFollowupTask(
  task: ScheduledTask,
  roomId?: string,
): boolean {
  if (task.kind !== "followup") return false;
  const metadata = isRecord(task.metadata) ? task.metadata : null;
  if (metadata?.[UNANSWERED_QUESTION_METADATA_KEY] !== true) return false;
  if (roomId === undefined) return true;
  return metadata.pendingPromptRoomId === roomId;
}

type RunnerHandle = ReturnType<typeof getScheduledTaskRunner>;

async function dismissScheduledQuestionFollowups(
  runner: RunnerHandle,
  roomId: string,
  reason: string,
): Promise<string[]> {
  const scheduled = await runner.list({
    kind: "followup",
    status: "scheduled",
  });
  const dismissed: string[] = [];
  for (const task of scheduled) {
    if (!isUnansweredQuestionFollowupTask(task, roomId)) continue;
    await runner.apply(task.taskId, "dismiss", { reason });
    dismissed.push(task.taskId);
  }
  return dismissed;
}

function buildQuestionFollowupTask(args: {
  agentId: string;
  roomId: string;
  messageId: string;
  question: string;
  nowMs: number;
}): ScheduledTaskInput {
  const fireAtIso = new Date(
    args.nowMs + UNANSWERED_QUESTION_FOLLOWUP_DELAY_MINUTES * 60_000,
  ).toISOString();
  return {
    kind: "followup",
    promptInstructions:
      `Earlier you asked the owner: "${args.question}" and they have not answered. ` +
      "Write one gentle, low-pressure follow-up that re-surfaces the question without guilt-tripping. " +
      "One short line; make it easy to answer or wave off.",
    trigger: { kind: "once", atIso: fireAtIso },
    priority: "low",
    shouldFire: {
      compose: "first_deny",
      // Hard constraint first (owner-set quiet hours), then the model moment
      // judge decides send / defer / drop with full owner context (#14677).
      gates: [{ kind: "quiet_hours" }, { kind: "model_moment_check" }],
    },
    completionCheck: {
      kind: "user_replied_within",
      followupAfterMinutes: FOLLOWUP_COMPLETION_TIMEOUT_MINUTES,
    },
    output: { destination: "channel", target: `in_app:${args.roomId}` },
    respectsGlobalPause: true,
    source: "plugin",
    createdBy: UNANSWERED_QUESTION_CREATED_BY,
    ownerVisible: true,
    idempotencyKey: `lifeops:unanswered-question:${args.roomId}:${args.messageId}`,
    metadata: {
      [UNANSWERED_QUESTION_METADATA_KEY]: true,
      pendingPromptRoomId: args.roomId,
      questionMessageId: args.messageId,
      questionSnippet: args.question,
    },
  };
}

export interface QuestionFollowupRegistration {
  taskId: string;
  fireAtIso: string;
  supersededTaskIds: string[];
}

/**
 * Register a follow-up for an agent reply that ends with a question. Returns
 * the registration, or `null` when the message is not a qualifying agent
 * question (not the agent's, no room, no trailing question, or not a reply to
 * an owner message).
 */
export async function registerQuestionFollowupForAgentMessage(
  runtime: IAgentRuntime,
  message: Memory,
  options: { now?: Date } = {},
): Promise<QuestionFollowupRegistration | null> {
  if (message.entityId !== runtime.agentId) return null;
  const roomId = typeof message.roomId === "string" ? message.roomId : null;
  if (!roomId || !message.id) return null;
  const question = extractTrailingQuestion(messageText(message));
  if (!question) return null;

  // Owner scope: only replies to an owner message register a follow-up. The
  // outbound memory itself carries the agent's entity, so ownership is read
  // from the inbound message this reply answers.
  const inReplyTo = message.content?.inReplyTo;
  if (typeof inReplyTo !== "string" || inReplyTo.length === 0) return null;
  const inbound = await runtime.getMemoryById(inReplyTo as UUID);
  if (!inbound || !(await hasOwnerAccess(runtime, inbound))) return null;

  const now = options.now ?? new Date();
  const runner = getScheduledTaskRunner(runtime, {
    agentId: String(runtime.agentId),
  });
  // The newest question supersedes any still-scheduled predecessor: one open
  // question follow-up per room.
  const supersededTaskIds = await dismissScheduledQuestionFollowups(
    runner,
    roomId,
    "superseded_by_newer_agent_question",
  );
  const input = buildQuestionFollowupTask({
    agentId: String(runtime.agentId),
    roomId,
    messageId: String(message.id),
    question,
    nowMs: now.getTime(),
  });
  const task = await runner.schedule(input);
  logger.info(
    {
      src: LOG_SRC,
      agentId: runtime.agentId,
      taskId: task.taskId,
      roomId,
      supersededTaskIds,
    },
    `[UnansweredQuestionFollowup] registered follow-up for open question in room ${roomId}`,
  );
  return {
    taskId: task.taskId,
    fireAtIso:
      input.trigger.kind === "once" ? input.trigger.atIso : now.toISOString(),
    supersededTaskIds,
  };
}

/**
 * Dismiss still-scheduled question follow-ups for a room the owner just spoke
 * in. FIRED follow-ups are deliberately untouched — the reply completes those
 * through `inbound-reply-completion` / `user_replied_within`.
 */
export async function cancelQuestionFollowupsOnOwnerReply(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<string[]> {
  if (message.entityId === runtime.agentId) return [];
  const roomId = typeof message.roomId === "string" ? message.roomId : null;
  if (!roomId) return [];
  if (!(await hasOwnerAccess(runtime, message))) return [];
  const runner = getScheduledTaskRunner(runtime, {
    agentId: String(runtime.agentId),
  });
  const dismissed = await dismissScheduledQuestionFollowups(
    runner,
    roomId,
    "owner_re_engaged",
  );
  if (dismissed.length > 0) {
    logger.info(
      { src: LOG_SRC, agentId: runtime.agentId, roomId, dismissed },
      "[UnansweredQuestionFollowup] owner re-engaged; dismissed scheduled follow-up(s)",
    );
  }
  return dismissed;
}

/**
 * `MESSAGE_SENT` event handler. Boundary catch: an outbound chat reply must
 * never fail because the scheduled-task store or runner host is broken.
 */
export async function handleAgentMessageSentForQuestionFollowup(
  payload: MessagePayload,
): Promise<void> {
  try {
    const runtime = payload.runtime;
    if (!runtime || !payload.message) return;
    await registerQuestionFollowupForAgentMessage(runtime, payload.message);
  } catch (error) {
    // error-policy:J1 boundary translation — event-bus handler edge; the
    // failure is logged and the send pipeline continues.
    logger.warn(
      { src: LOG_SRC, error },
      `[UnansweredQuestionFollowup] follow-up registration failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function handleOwnerMessageForQuestionFollowup(
  payload: MessagePayload,
): Promise<void> {
  const runtime = payload.runtime;
  if (!runtime || !payload.message) return;
  await cancelQuestionFollowupsOnOwnerReply(runtime, payload.message);
}

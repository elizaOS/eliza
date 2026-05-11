/**
 * `threadOps` — response-handler field evaluator owned by app-lifeops.
 *
 * Replaces the old `workThreadResponseHandlerEvaluator` regex-based router
 * (`response-handler-evaluator.ts`). Instead of pattern-matching the user's
 * message, this evaluator contributes a typed schema fragment to the SAME
 * Stage-1 LLM call the response handler is already making. The LLM extracts
 * the thread operations from context — no regex.
 *
 * The abort intent ("stop", "nvm", "actually wait don't do that") lives as
 * one operation type within threadOps. When the LLM emits
 * `{ threadOps: [{ type: "abort", ... }] }`, this evaluator's handler:
 *
 *   1. Calls `runtime.abortTurn(roomId, reason)` synchronously — propagates
 *      through the turn's AbortSignal tree.
 *   2. Returns an `ack-and-stop` preempt — the response handler emits a
 *      short acknowledgement reply and does NOT route to the planner.
 *
 * For all non-abort ops, the handler stages them as a dispatch payload that
 * the existing `lifeops_thread_control` action handler consumes (no need to
 * duplicate the validation / locking / atomic-merge logic).
 */

import { hasOwnerAccess } from "@elizaos/agent";
import type {
  ResponseHandlerFieldEffect,
  ResponseHandlerFieldEvaluator,
  ResponseHandlerFieldHandleContext,
  ResponseHandlerFieldContext,
} from "@elizaos/core";
import { createPendingPromptsStore } from "../pending-prompts/store.js";
import { createWorkThreadStore } from "./store.js";
import type { ThreadSourceRef } from "./types.js";

// ---------------------------------------------------------------------------
// Op shapes — these become the runtime types after parse
// ---------------------------------------------------------------------------

export type ThreadOpType =
  | "create"
  | "steer"
  | "stop"
  | "merge"
  | "attach_source"
  | "schedule_followup"
  | "mark_waiting"
  | "mark_completed"
  | "abort";

export interface ThreadOp {
  type: ThreadOpType;
  workThreadId?: string | null;
  sourceWorkThreadIds?: string[];
  sourceRef?: ThreadSourceRef;
  instruction?: string | null;
  reason?: string | null;
}

// ---------------------------------------------------------------------------
// Description — used verbatim as the LLM's prompt slice
// ---------------------------------------------------------------------------

const THREAD_OPS_DESCRIPTION = `Thread operations to perform on durable work threads owned by this user.

Use when the user wants to:
- start a long-running task → { "type": "create", "instruction": "<what to do>" }
- correct or refocus an ongoing thread → { "type": "steer", "workThreadId": "<id>", "instruction": "<correction>" }
- cancel / stop / abort what the agent is currently doing → { "type": "abort", "workThreadId": "<id, if known>", "reason": "<short why>" }
- pause a thread waiting on input → { "type": "mark_waiting", "workThreadId": "<id>" }
- mark a thread complete → { "type": "mark_completed", "workThreadId": "<id>" }
- combine two threads → { "type": "merge", "workThreadId": "<TARGET id>", "sourceWorkThreadIds": ["<id1>", "<id2>"] }
- attach this room as a source of an existing thread → { "type": "attach_source", "workThreadId": "<id>", "sourceRef": { "connector": "...", "roomId": "...", "canMutate": true } }
- schedule a follow-up → { "type": "schedule_followup", "workThreadId": "<id>", "instruction": "<what to do later>" }

The abort op preempts the rest of this turn — the agent stops in-flight work and emits a short acknowledgement. Use it when the user clearly retracts the current request ("nvm", "stop", "actually don't", "wait don't do that").

Emit an empty array when the user expresses NO thread intent. Do not invent threads — only reference workThreadId values from the active threads listed elsewhere in this prompt.`;

// ---------------------------------------------------------------------------
// JSON schema slice
// ---------------------------------------------------------------------------

const THREAD_OP_TYPE_ENUM = [
  "create",
  "steer",
  "stop",
  "merge",
  "attach_source",
  "schedule_followup",
  "mark_waiting",
  "mark_completed",
  "abort",
];

const THREAD_OPS_SCHEMA = {
  type: "array",
  description:
    "Thread operations for this turn. Empty array when no thread action is needed.",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      type: {
        type: "string",
        enum: THREAD_OP_TYPE_ENUM,
        description:
          "Operation type. 'abort' preempts the turn; all others stage thread mutations for the lifeops_thread_control action.",
      },
      workThreadId: {
        type: ["string", "null"],
        description:
          "Target thread id. Required for steer/stop/merge/attach_source/schedule_followup/mark_*; optional for abort (defaults to current turn) and create.",
      },
      sourceWorkThreadIds: {
        type: "array",
        description:
          "For merge: thread ids being absorbed into workThreadId. Empty for non-merge ops.",
        items: { type: "string" },
      },
      sourceRef: {
        type: ["object", "null"],
        additionalProperties: false,
        properties: {
          connector: { type: "string" },
          channelName: { type: ["string", "null"] },
          channelKind: { type: ["string", "null"] },
          roomId: { type: ["string", "null"] },
          externalThreadId: { type: ["string", "null"] },
          accountId: { type: ["string", "null"] },
          grantId: { type: ["string", "null"] },
          canRead: { type: ["boolean", "null"] },
          canMutate: { type: ["boolean", "null"] },
        },
        required: [
          "connector",
          "channelName",
          "channelKind",
          "roomId",
          "externalThreadId",
          "accountId",
          "grantId",
          "canRead",
          "canMutate",
        ],
        description: "For attach_source: the source ref to attach.",
      },
      instruction: {
        type: ["string", "null"],
        description:
          "What to do (for create/steer/schedule_followup). Brief, action-oriented.",
      },
      reason: {
        type: ["string", "null"],
        description: "Why this op (especially useful for abort and stop).",
      },
    },
    required: [
      "type",
      "workThreadId",
      "sourceWorkThreadIds",
      "sourceRef",
      "instruction",
      "reason",
    ],
  },
} as const;

// ---------------------------------------------------------------------------
// shouldRun — only include this field's prompt slice when relevant
// ---------------------------------------------------------------------------

async function threadOpsShouldRun(
  ctx: ResponseHandlerFieldContext,
): Promise<boolean> {
  // Only owners can mutate threads.
  if (!(await hasOwnerAccess(ctx.runtime, ctx.message))) {
    return false;
  }
  const roomId =
    typeof ctx.message.roomId === "string" ? ctx.message.roomId : null;
  if (!roomId) return false;
  // Cheap signal: any active thread in the room OR a pending prompt.
  // Used purely to decide if the LLM should see the threadOps instructions.
  // The actual decision-making happens in the LLM call.
  const [threads, prompts] = await Promise.all([
    createWorkThreadStore(ctx.runtime).list({
      statuses: ["active", "waiting", "paused"],
      roomId,
      limit: 1,
    }),
    createPendingPromptsStore(ctx.runtime).list(roomId, {
      lookbackMinutes: 60 * 24,
    }),
  ]);
  if (threads.length > 0 || prompts.length > 0) return true;
  // Even with no active threads, if the runtime has an active turn for this
  // room (i.e., a prior handler is still running), the user may want to
  // abort it. Include the field so abort can be extracted.
  return ctx.runtime.turnControllers?.hasActiveTurn?.(roomId) ?? false;
}

// ---------------------------------------------------------------------------
// parse — normalize the LLM's value
// ---------------------------------------------------------------------------

function threadOpsParse(
  value: unknown,
  _ctx: ResponseHandlerFieldContext,
): ThreadOp[] | null {
  if (!Array.isArray(value)) return [];
  const ops: ThreadOp[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const type = String(r.type ?? "").trim();
    if (!THREAD_OP_TYPE_ENUM.includes(type)) continue;
    const op: ThreadOp = {
      type: type as ThreadOpType,
    };
    if (typeof r.workThreadId === "string" && r.workThreadId.length > 0) {
      op.workThreadId = r.workThreadId;
    }
    if (Array.isArray(r.sourceWorkThreadIds)) {
      op.sourceWorkThreadIds = r.sourceWorkThreadIds
        .map((id) => String(id ?? "").trim())
        .filter((id) => id.length > 0);
    }
    if (r.sourceRef && typeof r.sourceRef === "object") {
      const ref = r.sourceRef as Record<string, unknown>;
      if (typeof ref.connector === "string") {
        op.sourceRef = {
          connector: ref.connector,
          channelName:
            typeof ref.channelName === "string" ? ref.channelName : undefined,
          channelKind:
            typeof ref.channelKind === "string" ? ref.channelKind : undefined,
          roomId: typeof ref.roomId === "string" ? ref.roomId : undefined,
          externalThreadId:
            typeof ref.externalThreadId === "string"
              ? ref.externalThreadId
              : undefined,
          accountId:
            typeof ref.accountId === "string" ? ref.accountId : undefined,
          grantId: typeof ref.grantId === "string" ? ref.grantId : undefined,
          canRead: typeof ref.canRead === "boolean" ? ref.canRead : undefined,
          canMutate:
            typeof ref.canMutate === "boolean" ? ref.canMutate : undefined,
        };
      }
    }
    if (typeof r.instruction === "string" && r.instruction.length > 0) {
      op.instruction = r.instruction;
    }
    if (typeof r.reason === "string" && r.reason.length > 0) {
      op.reason = r.reason;
    }
    ops.push(op);
  }
  return ops;
}

// ---------------------------------------------------------------------------
// handle — run the ops
// ---------------------------------------------------------------------------

async function threadOpsHandle(
  ctx: ResponseHandlerFieldHandleContext<ThreadOp[]>,
): Promise<ResponseHandlerFieldEffect | undefined> {
  const ops = ctx.value;
  if (!Array.isArray(ops) || ops.length === 0) return undefined;
  const debug: string[] = [];

  // Abort op runs FIRST and preempts the rest of the turn.
  const abortOp = ops.find((op) => op.type === "abort");
  if (abortOp) {
    const roomId =
      typeof ctx.message.roomId === "string" ? ctx.message.roomId : "";
    const reason =
      typeof abortOp.reason === "string" && abortOp.reason.length > 0
        ? abortOp.reason
        : "user_requested_abort";
    let aborted = false;
    if (roomId && ctx.runtime.turnControllers?.abortTurn) {
      aborted = ctx.runtime.turnControllers.abortTurn(roomId, reason);
    }
    debug.push(
      `abort: room=${roomId || "<none>"} aborted=${aborted ? "yes" : "no"} reason=${reason}`,
    );
    // Stage a short ack reply. The preempt below ensures we skip planner.
    return {
      mutateResult: (result) => {
        if (!result.replyText || result.replyText.length === 0) {
          result.replyText = "Stopped — partial work preserved.";
        }
        result.shouldRespond = "RESPOND";
        // Force a simple direct reply route.
        if (!Array.isArray(result.contexts)) result.contexts = [];
        if (!result.contexts.includes("simple")) {
          result.contexts = [...result.contexts, "simple"];
        }
      },
      preempt: { mode: "ack-and-stop", reason },
      debug,
    };
  }

  // Non-abort ops: stage them on the result for the planner / action layer.
  // The planner will see threadOps in the parsed result and dispatch via the
  // existing lifeops_thread_control action.
  debug.push(
    `staged ${ops.length} thread op(s): ${ops.map((o) => o.type).join(",")}`,
  );

  return {
    mutateResult: (result) => {
      // Ensure we route via planner so lifeops_thread_control can run.
      if (!Array.isArray(result.candidateActionNames)) {
        result.candidateActionNames = [];
      }
      for (const name of ["work_thread", "WORK_THREAD"]) {
        if (!result.candidateActionNames.includes(name)) {
          result.candidateActionNames.push(name);
        }
      }
      if (!Array.isArray(result.contexts)) result.contexts = [];
      for (const ctxName of ["tasks", "messaging", "automation"]) {
        if (!result.contexts.includes(ctxName)) {
          result.contexts.push(ctxName);
        }
      }
      // Drop "simple" if it was set — we need the planner.
      result.contexts = result.contexts.filter((c) => c !== "simple");
    },
    debug,
  };
}

// ---------------------------------------------------------------------------
// Exported evaluator
// ---------------------------------------------------------------------------

export const threadOpsFieldEvaluator: ResponseHandlerFieldEvaluator<ThreadOp[]> =
  {
    name: "threadOps",
    description: THREAD_OPS_DESCRIPTION,
    priority: 30, // Runs before contexts/candidateActions can be finalized.
    schema: THREAD_OPS_SCHEMA,
    shouldRun: threadOpsShouldRun,
    parse: threadOpsParse,
    handle: threadOpsHandle,
  };

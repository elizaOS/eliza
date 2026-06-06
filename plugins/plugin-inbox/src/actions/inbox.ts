import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

import {
  INBOX_ACTIONS,
  INBOX_CONTEXTS,
  INBOX_FAILURE_TEXT_PREFIX,
  type InboxActionName,
} from "../types.ts";

/**
 * INBOX umbrella action — op-based dispatch.
 *
 * MIGRATION STATUS: STUB.
 * Reference implementation: plugins/plugin-lifeops/src/actions/inbox.ts
 *
 * The full implementation will be ported here in a follow-up pass. For now this
 * file exists so the plugin registers cleanly in the workspace and the runtime
 * knows the contract. Each op below has a TODO pointing to the lifeops source
 * it should pull behavior from.
 */
function failure(reason: string, message: string): ActionResult {
  const text = `${INBOX_FAILURE_TEXT_PREFIX} ${reason}: ${message}`;
  return { success: false, text, error: new Error(text) };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

interface InboxActionParameters {
  op?: unknown;
  action?: unknown;
  threadId?: unknown;
  channel?: unknown;
  decision?: unknown;
  rationale?: unknown;
  body?: unknown;
  wakeAt?: unknown;
  reason?: unknown;
}

export const inboxAction: Action = {
  name: "INBOX",
  similes: ["TRIAGE_INBOX", "INBOX_REPLY", "INBOX_SNOOZE", "INBOX_ARCHIVE"],
  description:
    "Unified cross-channel inbox umbrella action. Op-based dispatch: list, triage, reply, snooze, archive, approve. Operates across email, Discord, Telegram, WhatsApp, Slack, X and similar non-SMS channels (Android SMS is handled by plugin-messages).",
  contexts: [...INBOX_CONTEXTS],
  contextGate: { anyOf: [...INBOX_CONTEXTS] },
  parameters: [
    {
      name: "op",
      description: "Which inbox sub-operation to run.",
      required: true,
      schema: { type: "string", enum: [...INBOX_ACTIONS] },
    },
    {
      name: "threadId",
      description:
        "Target thread id (required for triage/reply/snooze/archive/approve).",
      schema: { type: "string" },
    },
    {
      name: "channel",
      description: "Channel the thread lives on.",
      schema: { type: "string" },
    },
    {
      name: "decision",
      description:
        "Triage decision (reply_now/snooze/archive/ignore/needs_approval/follow_up).",
      schema: { type: "string" },
    },
    {
      name: "rationale",
      description:
        "Why the agent chose this decision — surfaced in approval UI.",
      schema: { type: "string" },
    },
    {
      name: "body",
      description: "Reply body (op=reply).",
      schema: { type: "string" },
    },
    {
      name: "wakeAt",
      description:
        "ISO timestamp the snoozed thread should re-surface (op=snooze).",
      schema: { type: "string" },
    },
    {
      name: "reason",
      description: "Free-text rationale (op=snooze/archive).",
      schema: { type: "string" },
    },
  ],
  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    // TODO: port full validation from plugins/plugin-lifeops/src/actions/inbox.ts.
    // For now we accept whenever the planner asks; the handler returns a
    // not-implemented failure so callers see exactly which op is missing.
    return true;
  },
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    options: Record<string, unknown> | undefined,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const params = (options ?? {}) as InboxActionParameters;
    const op = readString(params.op) ?? readString(params.action);
    if (!op) return failure("missing_op", "No op specified.");

    const known = INBOX_ACTIONS as readonly string[];
    if (!known.includes(op)) {
      return failure("unknown_op", `Unsupported op '${op}'.`);
    }

    switch (op as InboxActionName) {
      case "list":
        // TODO: port from plugins/plugin-lifeops/src/inbox/repository.ts +
        // plugins/plugin-lifeops/src/inbox/message-fetcher.ts.
        return failure("not_implemented", "INBOX.list is not migrated yet.");
      case "triage":
        // TODO: port from plugins/plugin-lifeops/src/inbox/triage-classifier.ts
        // and the triage branch in plugins/plugin-lifeops/src/actions/inbox.ts.
        return failure("not_implemented", "INBOX.triage is not migrated yet.");
      case "reply":
        // TODO: port from plugins/plugin-lifeops/src/actions/inbox.ts (reply branch)
        // and plugins/plugin-lifeops/src/inbox/channel-deep-links.ts.
        return failure("not_implemented", "INBOX.reply is not migrated yet.");
      case "snooze":
        // TODO: port from plugins/plugin-lifeops/src/inbox/repository.ts snooze ops.
        return failure("not_implemented", "INBOX.snooze is not migrated yet.");
      case "archive":
        // TODO: port from plugins/plugin-lifeops/src/inbox/repository.ts archive ops.
        return failure("not_implemented", "INBOX.archive is not migrated yet.");
      case "approve":
        // TODO: wire through the same approval pipeline plugin-lifeops uses for
        // needs_approval triage decisions.
        return failure("not_implemented", "INBOX.approve is not migrated yet.");
      default:
        return failure("unknown_op", `Unsupported op '${op}'.`);
    }
  },
  examples: [],
};

export default inboxAction;

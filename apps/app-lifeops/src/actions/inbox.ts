import { hasAdminAccess } from "@elizaos/agent";
import { resolveAdminEntityId } from "@elizaos/agent/actions/send-message";
import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
  UUID,
} from "@elizaos/core";
import { logger, ModelType, parseJSONObjectFromText } from "@elizaos/core";
import { getRecentMessagesData } from "@elizaos/shared/recent-messages-state";
import { loadInboxTriageConfig } from "../inbox/config.js";
import { fetchAllMessages } from "../inbox/message-fetcher.js";
import {
  reflectOnAutoReply,
  reflectOnSendConfirmation,
} from "../inbox/reflection.js";
import { InboxTriageRepository } from "../inbox/repository.js";
import { classifyMessages } from "../inbox/triage-classifier.js";
import type {
  DeferredInboxDraft,
  InboundMessage,
  InboxTriageConfig,
  TriageEntry,
  TriageResult,
} from "../inbox/types.js";
import { createApprovalQueue } from "../lifeops/approval-queue.js";
import type { ApprovalChannel } from "../lifeops/approval-queue.types.js";
import { LifeOpsService } from "../lifeops/service.js";
import { executeApprovedRequest } from "./approval.js";
import { INTERNAL_URL } from "./lifeops-google-helpers.js";
import { looksLikeEmailVenting } from "./non-actionable-request.js";

// ---------------------------------------------------------------------------
// Subaction types & params
// ---------------------------------------------------------------------------

type InboxSubaction = "triage" | "digest" | "respond";

type InboxActionParams = {
  subaction?: InboxSubaction;
  intent?: string;
  /** For respond: who to respond to. */
  target?: string;
  /** For respond: specific triage entry ID. */
  entryId?: string;
  /** For respond: pre-composed message text. */
  messageText?: string;
  /** For respond: confirming a draft. */
  confirmed?: boolean;
};

// ---------------------------------------------------------------------------
// Subaction planning
// ---------------------------------------------------------------------------

type InboxSubactionPlan = {
  subaction: InboxSubaction | null;
  shouldAct: boolean | null;
  response?: string | null;
  target?: string | null;
  entryId?: string | null;
  confirmed?: boolean | null;
};

function inboxRecentConversation(
  state: State | undefined,
  limit = 10,
): string[] {
  const texts: string[] = [];
  for (const item of getRecentMessagesData(state)) {
    const content =
      item.content && typeof item.content === "object"
        ? (item.content as Record<string, unknown>)
        : null;
    const text = typeof content?.text === "string" ? content.text.trim() : "";
    if (text) {
      texts.push(text);
    }
  }
  return texts.slice(-limit);
}

function stringifyInboxDraftContext(draft: DeferredInboxDraft | null): string {
  if (!draft) {
    return "null";
  }
  return JSON.stringify({
    senderName: draft.senderName,
    channelName: draft.channelName,
    source: draft.source,
    draftText: draft.draftText,
    deepLink: draft.deepLink,
  });
}

function buildInboxPolicyAcknowledgement(
  userText: string,
): ActionResult | null {
  const normalized = userText.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (
    /\bgroup chat\b/u.test(normalized) &&
    /\bhandoff\b/u.test(normalized) &&
    /\b(?:relay|relaying|relays|coordination|messy|tangled)\b/u.test(normalized)
  ) {
    return {
      text: "If the relay gets messy, I'll suggest a group-chat handoff with you and the other people involved so we can stop bouncing messages through you.",
      success: true,
      values: {
        success: true,
        policyRecorded: true,
      },
      data: {
        actionName: ACTION_NAME,
        subaction: "respond",
        policyRecorded: true,
        policyType: "group_chat_handoff",
      },
    };
  }

  if (
    /\bbump\b/u.test(normalized) &&
    /\bcontext\b/u.test(normalized) &&
    /\bstart(?:ing)? over\b/u.test(normalized)
  ) {
    return {
      text: "If that thread is still unresolved, I'll bump you again with the existing context attached instead of restarting the explanation from zero.",
      success: true,
      values: {
        success: true,
        policyRecorded: true,
      },
      data: {
        actionName: ACTION_NAME,
        subaction: "respond",
        policyRecorded: true,
        policyType: "contextual_bump",
      },
    };
  }

  return null;
}

async function resolveSubactionPlan(
  runtime: IAgentRuntime,
  params: InboxActionParams,
  messageText: string,
  state: State | undefined,
): Promise<InboxSubactionPlan> {
  const hasExplicitExecutionTarget =
    params.entryId !== undefined ||
    params.target !== undefined ||
    params.messageText !== undefined ||
    params.confirmed !== undefined;

  if (params.subaction && hasExplicitExecutionTarget) {
    return {
      subaction: params.subaction,
      shouldAct: true,
      target: params.target ?? null,
      entryId: params.entryId ?? null,
      confirmed: params.confirmed ?? null,
    };
  }

  if (
    params.confirmed ||
    params.entryId ||
    params.target ||
    params.messageText
  ) {
    return {
      subaction: "respond",
      shouldAct: true,
      target: params.target ?? null,
      entryId: params.entryId ?? null,
      confirmed: params.confirmed ?? null,
    };
  }

  if (typeof runtime.useModel !== "function") {
    return {
      subaction: null,
      shouldAct: false,
      response:
        "Inbox action planning is unavailable right now. Tell me explicitly whether to triage, show a digest, or respond.",
    };
  }

  const intent = params.intent ?? messageText;
  const pendingDraft = latestPendingDraft(state);
  const prompt = [
    "Plan the INBOX action for this request.",
    "The user may speak in any language.",
    "Use the current request plus recent conversation context.",
    "Return ONLY valid JSON with exactly these fields:",
    '{"subaction":"triage"|"digest"|"respond"|null,"shouldAct":true|false,"response":"string|null","target":"string|null","entryId":"string|null","confirmed":true|false|null}',
    "",
    "Choose triage for requests to scan new messages, unread items, or the current inbox.",
    "Choose digest for requests to summarize, brief, recap, review inbox activity, give a daily brief, rank urgent-vs-low items, surface drafts awaiting sign-off, or add a standing requirement to a recurring daily brief.",
    "Choose respond for requests to reply, draft, edit, approve, confirm, send a reply to a message or person, repair a missed call by drafting follow-up, or set up a group-chat handoff.",
    "Standing inbox policies like 'if relaying gets messy, suggest a group chat handoff' or 'if I miss a call, repair that and reschedule' should still choose an inbox subaction instead of shouldAct=false.",
    "If a pending draft exists and the current request clearly refers to sending, revising, or confirming it, choose respond even if the user does not restate the recipient.",
    "Set confirmed=true only when the user clearly approves sending the current pending draft right now.",
    "Set confirmed=false when the user is editing, hesitating, declining, or asking for more changes to the current draft.",
    "Set confirmed=null when there is no pending draft approval decision in the request.",
    "Set shouldAct=false only when the request is too vague to choose triage, digest, or respond safely.",
    "When shouldAct=false, response must ask the minimum clarifying question in the user's language.",
    "For standing inbox policies that should be acknowledged now without triaging a live item, set shouldAct=true, choose the right subaction, and put the user-facing acknowledgement in response.",
    "Extract target when the user identifies a person, channel, or inbox item to respond to.",
    'Example: {"currentRequest":"If direct relaying gets messy here, suggest making a group chat handoff instead.","subaction":"respond","shouldAct":true,"response":"If the relay gets messy, I will suggest moving everyone into a group-chat handoff instead of continuing one-off relays.","target":null,"entryId":null,"confirmed":null}',
    'Example: {"currentRequest":"I missed a call with the Frontier Tower guys today. Need to repair that and reschedule if possible asap.","subaction":"respond","shouldAct":true,"response":null,"target":"Frontier Tower guys","entryId":null,"confirmed":null}',
    "",
    `Planner hint subaction (non-binding): ${JSON.stringify(params.subaction ?? null)}`,
    `Current request: ${JSON.stringify(intent)}`,
    `Pending draft: ${stringifyInboxDraftContext(pendingDraft)}`,
    `Recent conversation: ${JSON.stringify(inboxRecentConversation(state).join("\n"))}`,
  ].join("\n");

  try {
    // biome-ignore lint/correctness/useHookAtTopLevel: runtime.useModel is an elizaOS model API, not a React hook.
    const result = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
    const raw = typeof result === "string" ? result : "";
    const parsed = parseJSONObjectFromText(raw) as Record<
      string,
      unknown
    > | null;
    if (!parsed) {
      return {
        subaction: null,
        shouldAct: false,
        response:
          "I couldn't determine whether you want triage, a digest, or a response. Tell me which inbox action you want.",
      };
    }

    const subaction =
      typeof parsed.subaction === "string" &&
      ["triage", "digest", "respond"].includes(parsed.subaction)
        ? (parsed.subaction as InboxSubaction)
        : (params.subaction ?? null);
    const shouldAct =
      typeof parsed.shouldAct === "boolean" ? parsed.shouldAct : null;
    return {
      subaction,
      shouldAct,
      response:
        typeof parsed.response === "string" && parsed.response.trim().length > 0
          ? parsed.response.trim()
          : null,
      target:
        typeof parsed.target === "string" && parsed.target.trim().length > 0
          ? parsed.target.trim()
          : null,
      entryId:
        typeof parsed.entryId === "string" && parsed.entryId.trim().length > 0
          ? parsed.entryId.trim()
          : null,
      confirmed:
        typeof parsed.confirmed === "boolean" ? parsed.confirmed : null,
    };
  } catch (error) {
    logger.warn(
      {
        src: "action:inbox",
        error: error instanceof Error ? error.message : String(error),
      },
      "[INBOX] failed to plan inbox subaction",
    );
    return {
      subaction: null,
      shouldAct: false,
      response:
        "Inbox action planning failed right now. Tell me explicitly whether to triage, show a digest, or respond.",
    };
  }
}

// ---------------------------------------------------------------------------
// INBOX action
// ---------------------------------------------------------------------------

const ACTION_NAME = "INBOX";

export const inboxAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: [
    "CHECK_INBOX",
    "INBOX_TRIAGE",
    "INBOX_DIGEST",
    "INBOX_RESPOND",
    "TRIAGE_INBOX",
    "SCAN_MESSAGES",
    "CHECK_MESSAGES",
    "DAILY_DIGEST",
    "INBOX_SUMMARY",
    "REPLY_INBOX",
    "RESPOND_TO_MESSAGE",
    "MISSED_CALL_FOLLOWUP",
    "MISSED_CALL_REPAIR",
    "GROUP_CHAT_HANDOFF",
    "CREATE_GROUP_CHAT",
    "ADD_PARTICIPANTS_TO_GROUP_CHAT",
    "GROUP_CHAT_POLICY",
    "MESSY_RELAY_HANDOFF",
    "BUMP_UNANSWERED_DECISION",
    "GET_PENDING_ASSETS",
  ],
  tags: [
    "always-include",
    "daily brief",
    "cross-channel inbox",
    "missed call repair",
    "group chat handoff",
    "bump unanswered decision",
    "pending assets",
    "event asset checklist",
    "unread summary",
  ],
  description:
    "Unified inbox management: triage new messages across all channels, " +
    "generate a daily digest summary, or draft/send a response to a triaged " +
    "item. Use this for executive-assistant daily briefs, urgent-vs-low " +
    "priority inbox ranking, unread summaries, drafts awaiting sign-off, " +
    "missed-call repair follow-up, unanswered-decision bump policies, event asset checklists, and group-chat handoff coordination. " +
    "Standing inbox policies like 'if direct relaying gets messy here, suggest making a group chat handoff instead' should call this action instead of staying in plain chat. " +
    "If the request sets a standing inbox policy or follow-up rule, still call this action on the first turn even when the action needs to acknowledge the policy before a live inbox item exists. " +
    "Examples: 'triage my inbox', 'give me my inbox digest', or 'respond to the messages that need an answer in my inbox'. " +
    "DO NOT use this action when the user is only complaining about email or messages without asking for triage, a digest, or a reply workflow. " +
    "If the request is explicitly Gmail or email-specific, about unread emails, or about drafting or sending a reply to a specific email, use GMAIL_ACTION instead. " +
    "Subactions: triage, digest, respond. Admin/owner only.",
  descriptionCompressed:
    "Unified inbox: triage messages, daily digest, draft/send responses, missed-call repair, and group-chat handoff policies. Admin only.",
  suppressPostActionContinuation: true,

  validate: async (runtime, message) => {
    if (looksLikeEmailVenting(extractText(message))) {
      return false;
    }
    return hasAdminAccess(runtime, message);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options: HandlerOptions | undefined,
  ): Promise<ActionResult> => {
    if (!(await hasAdminAccess(runtime, message))) {
      return {
        text: "Permission denied: only the owner or admin may use inbox actions.",
        success: false,
        values: { success: false, error: "PERMISSION_DENIED" },
        data: { actionName: ACTION_NAME },
      };
    }

    const params = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as InboxActionParams;
    const userText = extractText(message);
    const policyAcknowledgement = buildInboxPolicyAcknowledgement(userText);
    if (
      policyAcknowledgement &&
      (params.subaction === "respond" || params.subaction === undefined) &&
      !params.entryId &&
      !params.target &&
      !params.messageText &&
      params.confirmed !== true
    ) {
      return policyAcknowledgement;
    }
    const subactionPlan = await resolveSubactionPlan(
      runtime,
      params,
      userText,
      state,
    );
    if (!subactionPlan.subaction || subactionPlan.shouldAct !== true) {
      return {
        text:
          subactionPlan.response ??
          "Tell me whether you want me to triage the inbox, show a digest, or respond to someone.",
        success: false,
        values: {
          success: false,
          error: "PLANNER_SHOULDACT_FALSE",
          noop: true,
        },
        data: {
          actionName: ACTION_NAME,
          noop: true,
          error: "PLANNER_SHOULDACT_FALSE",
          suggestedSubaction: subactionPlan.subaction,
        },
      };
    }
    const resolvedParams: InboxActionParams = {
      ...params,
      target: params.target ?? subactionPlan.target ?? undefined,
      entryId: params.entryId ?? subactionPlan.entryId ?? undefined,
      confirmed: params.confirmed ?? subactionPlan.confirmed ?? undefined,
    };

    const hasConcreteRespondTarget =
      resolvedParams.target !== undefined ||
      resolvedParams.entryId !== undefined ||
      resolvedParams.messageText !== undefined ||
      resolvedParams.confirmed !== undefined;
    if (
      typeof subactionPlan.response === "string" &&
      subactionPlan.response.trim().length > 0 &&
      !hasConcreteRespondTarget
    ) {
      return {
        text: subactionPlan.response.trim(),
        success: true,
        values: { success: true, acknowledged: true },
        data: {
          actionName: ACTION_NAME,
          subaction: subactionPlan.subaction,
          acknowledged: true,
        },
      };
    }

    switch (subactionPlan.subaction) {
      case "triage":
        return handleTriage(runtime, message, state, resolvedParams);
      case "digest":
        return handleDigest(runtime, message, state, resolvedParams);
      case "respond":
        return handleRespond(runtime, message, state, resolvedParams);
    }
  },

  parameters: [
    {
      name: "subaction",
      description:
        "Inbox operation to run: triage (scan channels for new messages), " +
        "digest (daily summary), or respond (draft/send a reply).",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["triage", "digest", "respond"],
      },
    },
    {
      name: "intent",
      description:
        'Natural language inbox request. Examples: "check my inbox for new messages", ' +
        '"give me my daily summary", "respond to Alice\'s Discord message".',
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "target",
      description:
        "Who to respond to (for respond subaction). Can be a sender name, " +
        "channel name, or source platform.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "entryId",
      description: "Specific triage entry ID to respond to.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "messageText",
      description: "Pre-composed message text for the response.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "confirmed",
      description:
        "Set to true when the user is confirming a previously drafted response.",
      required: false,
      schema: { type: "boolean" as const },
    },
  ],

  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Triage my inbox" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Triaged 15 new messages: 2 urgent (escalated), 5 need reply, 3 auto-replied, 5 ignored.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Give me my inbox digest" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: '# Daily Inbox Summary — Saturday, April 12, 2026\n\n## Urgent (2)\n- Discord DM from Alice: "Are we meeting tomorrow?"',
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Respond to the messages that need an answer in my inbox",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I found 3 inbox items that need a reply. I'll draft the first response for your review.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "In the daily brief, also tell me which drafts still need my sign-off.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll include any drafts still waiting for your sign-off in the daily inbox brief.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "I missed a call with the Frontier Tower guys today. Need to repair that and reschedule if possible asap.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll draft the repair follow-up and line up the reschedule details so we can send it quickly.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "If direct relaying gets messy here, suggest making a group chat handoff instead.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Understood. If the relay gets tangled, I'll suggest a group-chat handoff instead of letting the thread drift.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "If I still haven't answered about those three events, bump me again with context instead of starting over.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll keep the prior context attached and bump you again about those three events instead of restarting the thread from zero.",
        },
      },
    ],
  ] as ActionExample[][],
};

// ===========================================================================
// Subaction: TRIAGE
// ===========================================================================

async function handleTriage(
  runtime: IAgentRuntime,
  _message: Memory,
  _state: State | undefined,
  _params: InboxActionParams,
): Promise<ActionResult> {
  const config = loadInboxTriageConfig();
  const repo = new InboxTriageRepository(runtime);

  // 1. "since" window: current time minus one hour (the triage interval).
  //    Previous implementation used the most-recent unresolved entry's
  //    createdAt, which could miss messages arriving after that entry.
  const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  // 2. Fetch messages from all channels
  const service = new LifeOpsService(runtime);
  const allMessages = await fetchAllMessages(runtime, {
    sources: config.channels,
    sinceIso,
    limit: 200,
    gmailSource: service,
    xDmSource: service,
  });

  if (allMessages.length === 0) {
    return {
      text: "No new messages to triage.",
      success: true,
      values: { success: true, triaged: 0 },
      data: { actionName: ACTION_NAME, subaction: "triage" },
    };
  }

  // 3. Deduplicate against already-triaged messages
  const newMessages: InboundMessage[] = [];
  for (const msg of allMessages) {
    const existing = await repo.getBySourceMessageId(msg.id);
    if (!existing) {
      newMessages.push(msg);
    }
  }

  if (newMessages.length === 0) {
    return {
      text: "All recent messages have already been triaged.",
      success: true,
      values: {
        success: true,
        triaged: 0,
        skippedDuplicates: allMessages.length,
      },
      data: { actionName: ACTION_NAME, subaction: "triage" },
    };
  }

  let llmResults: TriageResult[];
  try {
    const examples = await repo.getExamples(5);
    llmResults = await classifyMessages(runtime, newMessages, {
      config,
      examples,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Inbox classification failed.";
    return {
      text:
        `Inbox triage paused because message classification failed: ${errorMessage} ` +
        `No messages were auto-classified or auto-replied.`,
      success: false,
      values: {
        success: false,
        triaged: 0,
        error: "TRIAGE_CLASSIFICATION_FAILED",
      },
      data: {
        actionName: ACTION_NAME,
        subaction: "triage",
        interventionRequired: true,
      },
    };
  }

  // Build a Map for O(1) lookup instead of O(n) indexOf per message.
  const llmResultMap = new Map<string, TriageResult>();
  for (let i = 0; i < newMessages.length; i++) {
    const result = llmResults[i];
    const message = newMessages[i];
    if (result && message) {
      llmResultMap.set(message.id, result);
    }
  }

  // 5. Store results
  let countUrgent = 0;
  let countNeedsReply = 0;
  let countAutoReplied = 0;
  let countIgnored = 0;
  let countStored = 0;

  for (const msg of newMessages) {
    const result = llmResultMap.get(msg.id) ?? null;
    if (!result) continue;

    if (result.classification === "ignore") {
      countIgnored++;
      continue;
    }

    // Store the triage entry
    const entry = await repo.storeTriage({
      source: msg.source,
      sourceRoomId: msg.source === "x_dm" ? msg.xConversationId : msg.roomId,
      sourceEntityId: msg.source === "x_dm" ? msg.xParticipantId : msg.entityId,
      sourceMessageId: msg.id,
      channelName: msg.channelName,
      channelType: msg.channelType,
      deepLink: msg.deepLink,
      classification: result.classification,
      urgency: result.urgency,
      confidence: result.confidence,
      snippet: msg.snippet,
      senderName: msg.senderName,
      threadContext: msg.threadMessages,
      triageReasoning: result.reasoning,
      suggestedResponse: result.suggestedResponse,
    });
    countStored++;

    // Track counts
    if (result.classification === "urgent") countUrgent++;
    if (result.classification === "needs_reply") countNeedsReply++;

    // 6. Escalate urgent items
    if (result.classification === "urgent") {
      try {
        const { EscalationService } = await import(
          "@elizaos/agent/services/escalation"
        );
        const linkText = msg.deepLink ? `\n${msg.deepLink}` : "";
        await EscalationService.startEscalation(
          runtime,
          `Urgent message from ${msg.senderName} on ${msg.source}`,
          `[URGENT] ${msg.channelName}: "${msg.snippet}"${linkText}`,
        );
      } catch (err) {
        logger.warn(
          {
            src: "action:inbox",
            error: err instanceof Error ? err.message : String(err),
            messageId: msg.id,
          },
          "[INBOX] escalation failed",
        );
      }
    }

    // 7. Auto-reply check
    if (
      result.classification === "needs_reply" &&
      result.suggestedResponse &&
      config.autoReply?.enabled
    ) {
      const autoReplyResult = await tryAutoReply(
        runtime,
        msg,
        result,
        entry.id,
        config,
        repo,
      );
      if (autoReplyResult) countAutoReplied++;
    }
  }

  // 8. Cleanup old resolved entries
  if (config.retentionDays) {
    const cutoff = new Date(
      Date.now() - config.retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const cleaned = await repo.cleanupOlderThan(cutoff);
    if (cleaned > 0) {
      logger.info(`[INBOX] Cleaned up ${cleaned} old triage entries`);
    }
  }

  const summary = [
    `Triaged ${newMessages.length} new messages:`,
    countUrgent > 0 ? `${countUrgent} urgent (escalated)` : null,
    countNeedsReply > 0 ? `${countNeedsReply} need reply` : null,
    countAutoReplied > 0 ? `${countAutoReplied} auto-replied` : null,
    countIgnored > 0 ? `${countIgnored} ignored` : null,
    `${countStored} stored for review`,
  ]
    .filter(Boolean)
    .join(", ");

  return {
    text: summary,
    success: true,
    values: {
      success: true,
      triaged: newMessages.length,
      urgent: countUrgent,
      needsReply: countNeedsReply,
      autoReplied: countAutoReplied,
      ignored: countIgnored,
    },
    data: { actionName: ACTION_NAME, subaction: "triage" },
  };
}

// ===========================================================================
// Subaction: DIGEST
// ===========================================================================

async function handleDigest(
  runtime: IAgentRuntime,
  message: Memory,
  _state: State | undefined,
  _params: InboxActionParams,
): Promise<ActionResult> {
  const config = loadInboxTriageConfig();
  const repo = new InboxTriageRepository(runtime);

  // 1. Get entries from the last 24 hours
  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const entries = await repo.getRecentForDigest(sinceIso);

  if (entries.length === 0) {
    return {
      text: "No inbox activity in the last 24 hours. All clear.",
      success: true,
      values: { success: true, entryCount: 0 },
      data: { actionName: ACTION_NAME, subaction: "digest" },
    };
  }

  // 2. Group by classification
  const urgent = entries.filter((e) => e.classification === "urgent");
  const needsReply = entries.filter(
    (e) => e.classification === "needs_reply" && !e.resolved,
  );
  const notify = entries.filter((e) => e.classification === "notify");
  const info = entries.filter((e) => e.classification === "info");
  const autoReplied = entries.filter((e) => e.autoReplied);
  const resolved = entries.filter((e) => e.resolved && !e.autoReplied);

  // 3. Build digest
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const lines: string[] = [`# Daily Inbox Summary — ${today}`];
  lines.push(
    `\n${entries.length} messages triaged across ${countSources(entries)} channels.`,
  );

  if (urgent.length > 0) {
    lines.push(`\n## Urgent (${urgent.length})`);
    for (const e of urgent) {
      lines.push(formatEntryLine(e));
    }
  }

  if (needsReply.length > 0) {
    lines.push(`\n## Needs Reply (${needsReply.length})`);
    for (const e of needsReply) {
      lines.push(formatEntryLine(e));
    }
  }

  if (notify.length > 0) {
    lines.push(`\n## Notifications (${notify.length})`);
    for (const e of notify.slice(0, 10)) {
      lines.push(formatEntryLine(e));
    }
    if (notify.length > 10) {
      lines.push(`  ...and ${notify.length - 10} more`);
    }
  }

  if (autoReplied.length > 0) {
    lines.push(`\n## Auto-Replied (${autoReplied.length})`);
    for (const e of autoReplied) {
      const draft = e.draftResponse
        ? ` — replied: "${e.draftResponse.slice(0, 60)}..."`
        : "";
      lines.push(
        `- **${e.channelName}** (${e.source}): "${e.snippet.slice(0, 80)}"${draft}`,
      );
    }
  }

  if (resolved.length > 0) {
    lines.push(`\n## Resolved (${resolved.length})`);
    lines.push(`  ${resolved.length} items were addressed during the day.`);
  }

  if (info.length > 0) {
    lines.push(`\n## Informational (${info.length})`);
    lines.push(`  ${info.length} informational messages were logged.`);
  }

  const digestText = lines.join("\n");

  // 4. Send digest to owner
  const deliveryChannel = config.digestDeliveryChannel ?? "client_chat";
  try {
    const adminEntityId = await resolveAdminEntityId(runtime, message);

    await runtime.sendMessageToTarget(
      {
        source: deliveryChannel,
        entityId: adminEntityId,
      } as Parameters<typeof runtime.sendMessageToTarget>[0],
      {
        text: digestText,
        source: deliveryChannel,
        metadata: { digestType: "inbox_daily" },
      },
    );
  } catch (err) {
    logger.warn(
      {
        src: "action:inbox",
        error: err instanceof Error ? err.message : String(err),
      },
      "[INBOX] failed to deliver digest",
    );
  }

  return {
    text: digestText,
    success: true,
    values: {
      success: true,
      entryCount: entries.length,
      urgent: urgent.length,
      needsReply: needsReply.length,
      autoReplied: autoReplied.length,
    },
    data: { actionName: ACTION_NAME, subaction: "digest" },
  };
}

// ===========================================================================
// Subaction: RESPOND
// ===========================================================================

async function handleRespond(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  params: InboxActionParams,
): Promise<ActionResult> {
  const userText = extractText(message);
  const policyAcknowledgement = buildInboxPolicyAcknowledgement(userText);
  if (
    policyAcknowledgement &&
    !params.entryId &&
    !params.target &&
    !params.messageText &&
    params.confirmed !== true
  ) {
    return policyAcknowledgement;
  }
  const repo = new InboxTriageRepository(runtime);

  // -- Check for pending draft confirmation --------------------------------
  const pendingDraft = latestPendingDraft(state);
  if (pendingDraft && params.confirmed === true) {
    return handleConfirmation(runtime, message, pendingDraft, userText, repo);
  }

  // -- Find the triage entry to respond to ---------------------------------
  let entry: TriageEntry | null = null;

  if (params.entryId) {
    entry = await repo.getById(params.entryId);
  }

  if (!entry && params.target) {
    const unresolved = await repo.getUnresolved({ limit: 50 });
    entry = findBestMatch(unresolved, params.target);
  }

  if (!entry) {
    // If no specific target, grab the most urgent unresolved item
    const unresolved = await repo.getUnresolved({ limit: 5 });
    const needsReply = unresolved.filter(
      (e) =>
        e.classification === "needs_reply" || e.classification === "urgent",
    );
    if (needsReply.length === 0) {
      return {
        text: "No pending inbox items need a reply right now. Use INBOX to triage for new messages.",
        // The respond side effect did not happen — there was nothing to reply
        // to. Report as a structured no-op rather than a success.
        success: false,
        values: {
          success: false,
          error: "NOOP_NOTHING_TO_DO",
          noop: true,
        },
        data: {
          actionName: ACTION_NAME,
          subaction: "respond",
          noop: true,
          error: "NOOP_NOTHING_TO_DO",
        },
      };
    }
    if (needsReply.length === 1) {
      const onlyEntry = needsReply.at(0);
      if (!onlyEntry) {
        return {
          text: "Could not find the inbox item you want to respond to.",
          success: false,
          values: { success: false },
          data: { actionName: ACTION_NAME, subaction: "respond" },
        };
      }
      entry = onlyEntry;
    } else {
      const itemList = needsReply
        .map(
          (e) =>
            `- **${e.channelName}** (${e.source}): "${e.snippet.slice(0, 60)}"`,
        )
        .join("\n");
      return {
        text: `Multiple items need a reply. Which one?\n\n${itemList}\n\nSay "respond to [name/channel]" to pick one.`,
        // The respond side effect did not happen — we need the user to
        // disambiguate which item first. Report as a structured failure so
        // downstream consumers don't treat this as a completed reply.
        success: false,
        values: {
          success: false,
          error: "DISAMBIGUATION_REQUIRED",
          pendingCount: needsReply.length,
        },
        data: {
          actionName: ACTION_NAME,
          subaction: "respond",
          error: "DISAMBIGUATION_REQUIRED",
          pendingCount: needsReply.length,
        },
      };
    }
  }

  if (!entry) {
    return {
      text: "Could not find the inbox item you want to respond to.",
      success: false,
      values: { success: false, error: "NOT_FOUND" },
      data: { actionName: ACTION_NAME, subaction: "respond" },
    };
  }

  // -- Draft a response ----------------------------------------------------
  const draftText = params.messageText
    ? params.messageText
    : await draftResponse(runtime, entry, userText);

  const draft: DeferredInboxDraft = {
    triageEntryId: entry.id,
    source: entry.source,
    targetRoomId:
      entry.source !== "x_dm" && entry.sourceRoomId
        ? (entry.sourceRoomId as UUID)
        : undefined,
    targetEntityId:
      entry.source !== "x_dm" && entry.sourceEntityId
        ? (entry.sourceEntityId as UUID)
        : undefined,
    gmailMessageId:
      entry.source === "gmail"
        ? (entry.sourceMessageId ?? undefined)
        : undefined,
    xConversationId:
      entry.source === "x_dm" ? (entry.sourceRoomId ?? undefined) : undefined,
    xParticipantId:
      entry.source === "x_dm" ? (entry.sourceEntityId ?? undefined) : undefined,
    draftText,
    deepLink: entry.deepLink,
    channelName: entry.channelName,
    senderName: entry.senderName ?? "Unknown",
  };

  const approvalQueue = createApprovalQueue(runtime, {
    agentId: runtime.agentId,
  });
  const approvalRequest = await approvalQueue.enqueue({
    requestedBy: `inbox:${entry.id}`,
    subjectUserId: String(message.entityId ?? runtime.agentId),
    action: draft.source === "gmail" ? "send_email" : "send_message",
    payload:
      draft.source === "gmail" && draft.gmailMessageId
        ? {
            action: "send_email",
            to: [],
            cc: [],
            bcc: [],
            subject: entry.channelName,
            body: draft.draftText,
            threadId: entry.sourceMessageId,
            replyToMessageId: draft.gmailMessageId,
          }
        : {
            action: "send_message",
            recipient:
              draft.source === "x_dm" && draft.xConversationId
                ? `conversation:${draft.xConversationId}`
                : String(
                    draft.targetRoomId ??
                      draft.targetEntityId ??
                      draft.xParticipantId ??
                      "",
                  ),
            body: draft.draftText,
            replyToMessageId: entry.sourceMessageId,
          },
    channel: approvalChannelForInboxSource(entry.source),
    reason: `Reply draft for ${draft.senderName} on ${draft.channelName}`,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  draft.approvalRequestId = approvalRequest.id;

  return {
    text:
      `I'll send this to **${draft.senderName}** on **${draft.channelName}** (${draft.source}):\n\n` +
      `> ${draftText}\n\n` +
      `It's queued for approval. Say **"send it"** or explicitly approve it to dispatch, or tell me what to change.`,
    success: true,
    values: { success: true, awaitingConfirmation: true },
    data: {
      actionName: ACTION_NAME,
      subaction: "respond",
      inboxDraft: draft,
      approvalRequestId: approvalRequest.id,
    },
  };
}

// ===========================================================================
// Shared helpers
// ===========================================================================

// -- Auto-reply (used by triage) -------------------------------------------

async function tryAutoReply(
  runtime: IAgentRuntime,
  msg: InboundMessage,
  result: TriageResult,
  entryId: string,
  config: InboxTriageConfig,
  repo: InboxTriageRepository,
): Promise<boolean> {
  const autoConfig = config.autoReply;
  if (!autoConfig?.enabled) return false;
  const suggestedResponse = result.suggestedResponse;
  if (!suggestedResponse) return false;

  const threshold = autoConfig.confidenceThreshold ?? 0.85;
  if (result.confidence < threshold) return false;

  // Sender whitelist check
  if (autoConfig.senderWhitelist?.length) {
    const senderId = msg.entityId ?? msg.senderName;
    if (
      !autoConfig.senderWhitelist.some(
        (s) => s.toLowerCase() === senderId.toLowerCase(),
      )
    ) {
      return false;
    }
  }

  // Channel whitelist check
  if (autoConfig.channelWhitelist?.length) {
    if (!autoConfig.channelWhitelist.includes(msg.source)) {
      return false;
    }
  }

  // Rate limit check
  const maxPerHour = autoConfig.maxAutoRepliesPerHour ?? 5;
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recentAutoCount = await repo.countAutoRepliesSince(oneHourAgo);
  if (recentAutoCount >= maxPerHour) {
    logger.info("[INBOX] Auto-reply rate limit reached");
    return false;
  }

  // Reflection safety check
  const reflection = await reflectOnAutoReply(runtime, {
    inboundText: msg.text,
    replyText: suggestedResponse,
    source: msg.source,
    senderName: msg.senderName,
  });

  if (!reflection.approved) {
    logger.info(
      `[INBOX] Auto-reply rejected by reflection: ${reflection.reasoning}`,
    );
    return false;
  }

  // Send the auto-reply
  try {
    if (msg.source === "gmail" && msg.gmailMessageId) {
      const { LifeOpsService } = await import("../lifeops/service.js");
      const service = new LifeOpsService(runtime);
      await service.sendGmailReply(INTERNAL_URL, {
        messageId: msg.gmailMessageId,
        bodyText: suggestedResponse,
      });
    } else if (
      msg.source === "x_dm" &&
      (msg.xConversationId || msg.xParticipantId)
    ) {
      const service = new LifeOpsService(runtime);
      if (msg.xConversationId) {
        await service.sendXConversationMessage({
          conversationId: msg.xConversationId,
          text: suggestedResponse,
          confirmSend: true,
          side: "owner",
        });
      } else if (msg.xParticipantId) {
        await service.sendXDirectMessage({
          participantId: msg.xParticipantId,
          text: suggestedResponse,
          confirmSend: true,
          side: "owner",
        });
      }
    } else if (msg.roomId) {
      await runtime.sendMessageToTarget(
        {
          source: msg.source,
          roomId: msg.roomId as Parameters<
            typeof runtime.sendMessageToTarget
          >[0]["roomId"],
        } as Parameters<typeof runtime.sendMessageToTarget>[0],
        { text: suggestedResponse, source: msg.source },
      );
    } else {
      return false;
    }

    await repo.markResolved(entryId, {
      draftResponse: suggestedResponse,
      autoReplied: true,
    });
    logger.info(`[INBOX] Auto-replied to ${msg.senderName} on ${msg.source}`);
    return true;
  } catch (err) {
    logger.warn(
      {
        src: "action:inbox",
        error: err instanceof Error ? err.message : String(err),
        messageId: msg.id,
      },
      "[INBOX] auto-reply send failed",
    );
    return false;
  }
}

// -- Draft generation (used by respond) ------------------------------------

async function draftResponse(
  runtime: IAgentRuntime,
  entry: TriageEntry,
  userHint: string,
): Promise<string> {
  const seed = entry.suggestedResponse ?? "";
  const contextLines = entry.threadContext
    ? entry.threadContext.join("\n")
    : "";

  const prompt = [
    "Draft a brief, natural response to the following message.",
    "Match the tone and formality of the conversation.",
    "",
    `From: ${entry.senderName ?? "Unknown"}`,
    `Channel: ${entry.channelName} (${entry.source})`,
    `Their message: "${entry.snippet}"`,
    contextLines ? `Recent context:\n${contextLines}` : "",
    seed ? `Suggested starting point: "${seed}"` : "",
    userHint ? `Owner's guidance: "${userHint}"` : "",
    "",
    "Write ONLY the response text. Do not include any explanation or metadata.",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    // biome-ignore lint/correctness/useHookAtTopLevel: runtime.useModel is an elizaOS model API, not a React hook.
    const result = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
    const text = typeof result === "string" ? result.trim() : "";
    return (
      text || seed || "Thanks for reaching out. I'll get back to you soon."
    );
  } catch {
    return seed || "Thanks for reaching out. I'll get back to you soon.";
  }
}

// -- Confirmation handling (used by respond) --------------------------------

async function handleConfirmation(
  runtime: IAgentRuntime,
  message: Memory,
  draft: DeferredInboxDraft,
  userText: string,
  repo: InboxTriageRepository,
): Promise<ActionResult> {
  // Reflection safety check
  const reflection = await reflectOnSendConfirmation(runtime, {
    userMessage: userText,
    draftText: draft.draftText,
    channelName: draft.channelName,
    recipientName: draft.senderName,
  });

  if (!reflection.confirmed) {
    return {
      text: `I wasn't sure you confirmed — ${reflection.reasoning}. Please say **"yes, send it"** to confirm.`,
      success: true,
      values: { success: true, awaitingConfirmation: true },
      data: {
        actionName: ACTION_NAME,
        subaction: "respond",
        inboxDraft: draft,
      },
    };
  }

  // Send the message through the original channel
  if (draft.approvalRequestId) {
    try {
      const queue = createApprovalQueue(runtime, { agentId: runtime.agentId });
      const approved = await queue.approve(draft.approvalRequestId, {
        resolvedBy: String(message.entityId ?? runtime.agentId),
        resolutionReason: userText.trim() || "user confirmed inbox draft",
      });
      const executed = await executeApprovedRequest({
        runtime,
        queue,
        request: approved,
      });
      if (!executed.success) {
        return executed;
      }
    } catch (err) {
      return {
        text: `Failed to send message: ${String(err)}`,
        success: false,
        values: { success: false, error: "SEND_FAILED" },
        data: { actionName: ACTION_NAME, subaction: "respond" },
      };
    }
  } else {
    try {
      if (draft.source === "gmail" && draft.gmailMessageId) {
        const { LifeOpsService } = await import("../lifeops/service.js");
        const service = new LifeOpsService(runtime);
        await service.sendGmailReply(INTERNAL_URL, {
          messageId: draft.gmailMessageId,
          bodyText: draft.draftText,
        });
      } else if (
        draft.source === "x_dm" &&
        (draft.xConversationId || draft.xParticipantId)
      ) {
        const service = new LifeOpsService(runtime);
        if (draft.xConversationId) {
          await service.sendXConversationMessage({
            conversationId: draft.xConversationId,
            text: draft.draftText,
            confirmSend: true,
            side: "owner",
          });
        } else if (draft.xParticipantId) {
          await service.sendXDirectMessage({
            participantId: draft.xParticipantId,
            text: draft.draftText,
            confirmSend: true,
            side: "owner",
          });
        }
      } else if (draft.targetRoomId) {
        await runtime.sendMessageToTarget(
          {
            source: draft.source,
            roomId: draft.targetRoomId,
          } as Parameters<typeof runtime.sendMessageToTarget>[0],
          { text: draft.draftText, source: draft.source },
        );
      } else {
        return {
          text: "Cannot send: no target room or message ID available for this channel.",
          success: false,
          values: { success: false, error: "NO_TARGET" },
          data: { actionName: ACTION_NAME, subaction: "respond" },
        };
      }
    } catch (err) {
      return {
        text: `Failed to send message: ${String(err)}`,
        success: false,
        values: { success: false, error: "SEND_FAILED" },
        data: { actionName: ACTION_NAME, subaction: "respond" },
      };
    }
  }

  // Mark resolved and store as example
  await repo.markResolved(draft.triageEntryId, {
    draftResponse: draft.draftText,
  });

  const entry = await repo.getById(draft.triageEntryId);
  if (entry) {
    await repo.storeExample({
      source: entry.source,
      snippet: entry.snippet,
      classification: entry.classification,
      ownerAction: "confirmed",
      contextJson: {
        senderName: entry.senderName,
        channelName: entry.channelName,
        draftResponse: draft.draftText,
      },
    });
  }

  return {
    text: `Message sent to **${draft.senderName}** on **${draft.channelName}**.`,
    success: true,
    values: { success: true, sent: true },
    data: { actionName: ACTION_NAME, subaction: "respond", sent: true },
  };
}

// -- Digest formatters -----------------------------------------------------

function formatEntryLine(entry: TriageEntry): string {
  const resolvedTag = entry.resolved ? " [resolved]" : "";
  const link = entry.deepLink ? `\n  ${entry.deepLink}` : "";
  return (
    `- **${entry.channelName}** (${entry.source}): "${entry.snippet.slice(0, 100)}"${resolvedTag}` +
    link
  );
}

function countSources(entries: TriageEntry[]): number {
  return new Set(entries.map((e) => e.source)).size;
}

// -- State/text helpers ----------------------------------------------------

function latestPendingDraft(
  state: State | undefined,
): DeferredInboxDraft | null {
  if (!state || typeof state !== "object") return null;

  const stateRecord = state as Record<string, unknown>;
  const data =
    stateRecord.data && typeof stateRecord.data === "object"
      ? (stateRecord.data as Record<string, unknown>)
      : undefined;
  const actionResults = Array.isArray(data?.actionResults)
    ? (data.actionResults as Array<{ data?: Record<string, unknown> }>)
    : [];

  // Check action results (newest first)
  for (let i = actionResults.length - 1; i >= 0; i--) {
    const draft = actionResults[i]?.data?.inboxDraft as
      | DeferredInboxDraft
      | undefined;
    if (draft?.triageEntryId && draft?.draftText) {
      return draft;
    }
  }

  // Check recent messages
  const recentMessagesData = getRecentMessagesData(state);
  for (let i = recentMessagesData.length - 1; i >= 0; i--) {
    const item = recentMessagesData[i];
    if (!item) continue;
    const content =
      item.content && typeof item.content === "object"
        ? (item.content as Record<string, unknown>)
        : null;
    if (!content) continue;

    const draft =
      (content.inboxDraft as DeferredInboxDraft | undefined) ??
      ((content.data as Record<string, unknown> | undefined)?.inboxDraft as
        | DeferredInboxDraft
        | undefined);
    if (draft?.triageEntryId && draft?.draftText) {
      return draft;
    }
  }

  return null;
}

function approvalChannelForInboxSource(source: string): ApprovalChannel {
  switch (source) {
    case "gmail":
      return "email";
    case "telegram":
    case "discord":
    case "imessage":
    case "sms":
    case "x_dm":
      return source;
    default:
      return "internal";
  }
}

function findBestMatch(
  entries: TriageEntry[],
  target: string,
): TriageEntry | null {
  const lower = target.toLowerCase();
  // Exact channel name match
  const exact = entries.find((e) => e.channelName.toLowerCase() === lower);
  if (exact) return exact;

  // Sender name match
  const senderMatch = entries.find((e) =>
    e.senderName?.toLowerCase().includes(lower),
  );
  if (senderMatch) return senderMatch;

  // Partial channel name match
  const partial = entries.find((e) =>
    e.channelName.toLowerCase().includes(lower),
  );
  if (partial) return partial;

  // Source match
  const sourceMatch = entries.find((e) => e.source.toLowerCase() === lower);
  if (sourceMatch) return sourceMatch;

  return null;
}

function extractText(message: Memory): string {
  const content = message.content as { text?: unknown } | undefined;
  return typeof content?.text === "string" ? content.text : "";
}

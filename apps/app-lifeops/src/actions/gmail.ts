import {
  extractActionResultsFromState,
  extractRecentMessageEntriesFromState,
  extractStateDataRecords,
  hasContextSignalForKey,
  renderGroundedActionReply,
  summarizeActiveTrajectory,
  summarizeRecentActionHistory,
} from "@elizaos/agent/actions";
import type {
  CreateLifeOpsGmailBatchReplyDraftsRequest,
  CreateLifeOpsGmailReplyDraftRequest,
  LifeOpsGmailBulkOperation,
  LifeOpsGmailBatchReplySendItem,
  ManageLifeOpsGmailMessagesRequest,
  SendLifeOpsGmailBatchReplyRequest,
  SendLifeOpsGmailReplyRequest,
} from "@elizaos/app-lifeops/contracts";
import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  ModelType,
  parseJSONObjectFromText,
  parseKeyValueXml,
} from "@elizaos/core";
import { resolveDefaultTimeZone } from "../lifeops/defaults.js";
import { LifeOpsService, LifeOpsServiceError } from "../lifeops/service.js";
import { recentConversationTexts as collectRecentConversationTexts } from "./life-recent-context.js";
import {
  detailArray,
  detailBoolean,
  detailNumber,
  detailString,
  formatEmailNeedsResponse,
  formatEmailRead,
  formatEmailSearch,
  formatEmailTriage,
  formatGmailBatchReplyDrafts,
  formatGmailRecommendations,
  formatGmailReplyDraft,
  getGoogleCapabilityStatus,
  gmailReadUnavailableMessage,
  gmailSendUnavailableMessage,
  hasLifeOpsAccess,
  INTERNAL_URL,
  messageText,
  toActionData,
} from "./lifeops-google-helpers.js";

type GmailSubaction =
  | "triage"
  | "needs_response"
  | "recommend"
  | "unresponded"
  | "search"
  | "read"
  | "draft_reply"
  | "draft_batch_replies"
  | "manage"
  | "send_reply"
  | "send_batch_replies"
  | "send_message";

type GmailPlanFields = {
  queries: string[];
  messageId?: string;
  messageIds?: string[];
  replyNeededOnly?: boolean;
  operation?: LifeOpsGmailBulkOperation;
  labelIds?: string[];
  confirmDestructive?: boolean;
  olderThanDays?: number;
  confirmed?: boolean;
  holdForApproval?: boolean;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  bodyText?: string;
};

type GmailPlanStepKind =
  | "gmail_subaction"
  | "classify"
  | "propose_action"
  | "request_approval"
  | "audit";

type GmailPlanStepStatus = "pending" | "ready" | "blocked" | "completed";

type GmailPlanStep = Partial<GmailPlanFields> & {
  id: string;
  kind: GmailPlanStepKind;
  subaction?: GmailSubaction;
  goal?: string;
  dependsOn?: string[];
  requiresApproval?: boolean;
  status?: GmailPlanStepStatus;
};

type GmailWorkflowPlan = {
  summary?: string;
  currentStepId?: string;
  lastExecutedStepId?: string;
  nextStepIds?: string[];
  steps: GmailPlanStep[];
};

export type GmailLlmPlan = GmailPlanFields & {
  subaction: GmailSubaction | null;
  response?: string;
  shouldAct?: boolean | null;
  steps?: GmailPlanStep[];
  currentStepId?: string;
  planSummary?: string;
};

type GmailComposeDraftStatus = "pending_clarification" | "sent";

type GmailComposeDraft = {
  subaction: "send_message";
  status: GmailComposeDraftStatus;
  intent?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  bodyText?: string;
  updatedAt?: string;
};

type GmailComposeRecoveryPlan = {
  shouldResume?: boolean;
  cancelled?: boolean;
  response?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  bodyText?: string;
};

type GmailReplyDraftContext = {
  messageId: string;
  bodyText: string;
  subject?: string;
  to?: string[];
  cc?: string[];
};

type GmailMessageTargetContext = {
  messageId: string;
  subject?: string;
  from?: string;
  query?: string;
};

type PendingGmailReplyApproval = {
  messageId: string;
  bodyText: string;
  subject?: string;
  to?: string[];
  cc?: string[];
  approvalTaskId?: string | null;
  createdAt: string;
};

type GmailSearchFeed = Awaited<ReturnType<LifeOpsService["getGmailSearch"]>>;

type GmailTargetResolution =
  | {
      kind: "resolved";
      target: GmailMessageTargetContext;
    }
  | {
      kind: "ambiguous";
      feed: GmailSearchFeed;
      displayQuery: string;
    }
  | {
      kind: "missing";
    };

type GmailActionParams = {
  subaction?: GmailSubaction;
  intent?: string;
  query?: string;
  queries?: string[];
  messageId?: string;
  messageIds?: string[];
  operation?: LifeOpsGmailBulkOperation;
  bodyText?: string;
  confirmed?: boolean;
  details?: Record<string, unknown>;
};

type GmailPlanningContext = {
  recentConversation: string;
  latestReplyDraft: GmailReplyDraftContext | null;
  latestMessageTarget: GmailMessageTargetContext | null;
  activeWorkflowPlan: GmailWorkflowPlan | null;
  currentMessage: string;
  timeZone: string;
  nowIso: string;
  localNow: string;
};

type GmailIntentPlan = GmailPlanFields & {
  subaction: GmailSubaction | null;
  shouldAct?: boolean | null;
  response?: string;
  steps?: GmailPlanStep[];
  currentStepId?: string;
  planSummary?: string;
};

type GmailPayloadPlan = GmailPlanFields;

const GMAIL_CONTEXT_WINDOW = 12;
const ACTION_NAME = "GMAIL_ACTION";
const GMAIL_DETAIL_ALIASES = {
  forceSync: ["forcesync", "force_sync"],
  maxResults: ["maxresults", "max_results"],
  includeSpamTrash: ["includespamtrash", "include_spam_trash"],
  olderThanDays: ["olderthandays", "older_than_days"],
  replyNeededOnly: ["replyneededonly", "reply_needed_only"],
  messageIds: ["messageids", "message_ids"],
  labelIds: ["labelids", "label_ids"],
  confirmDestructive: ["confirmdestructive", "confirm_destructive"],
} as const;

async function collectGmailConversationContext(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
}): Promise<string[]> {
  const recentConversation = await collectRecentConversationTexts({
    runtime: args.runtime,
    message: args.message,
    state: args.state,
    limit: GMAIL_CONTEXT_WINDOW,
  });
  const currentMessage = messageText(args.message).trim();
  const combined = [...recentConversation];
  if (currentMessage.length > 0) {
    combined.push(currentMessage);
  }
  return combined.slice(-GMAIL_CONTEXT_WINDOW);
}

async function buildGmailDraftGenerationContext(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
}): Promise<{
  conversationContext: string[];
  actionHistory: string[];
  trajectorySummary: string | null;
}> {
  const [conversationContext, trajectorySummary] = await Promise.all([
    collectGmailConversationContext(args),
    summarizeActiveTrajectory(args.runtime),
  ]);

  return {
    conversationContext,
    actionHistory: summarizeRecentActionHistory(args.state, 4),
    trajectorySummary,
  };
}

function getPendingGmailReplyCacheKey(roomId: string): string {
  return `lifeops:gmail:pending-reply:${roomId}`;
}

async function readPendingGmailReplyApproval(
  runtime: IAgentRuntime,
  roomId: string,
): Promise<PendingGmailReplyApproval | null> {
  return (
    (await runtime.getCache<PendingGmailReplyApproval>(
      getPendingGmailReplyCacheKey(roomId),
    )) ?? null
  );
}

async function writePendingGmailReplyApproval(
  runtime: IAgentRuntime,
  roomId: string,
  approval: PendingGmailReplyApproval,
): Promise<void> {
  await runtime.setCache(getPendingGmailReplyCacheKey(roomId), approval);
}

async function clearPendingGmailReplyApproval(
  runtime: IAgentRuntime,
  roomId: string,
): Promise<void> {
  await runtime.deleteCache(getPendingGmailReplyCacheKey(roomId));
}

async function enqueueGmailReplyApprovalRequest(args: {
  runtime: IAgentRuntime;
  message: Memory;
  draft: {
    messageId: string;
    bodyText: string;
    subject?: string;
    to?: string[];
    cc?: string[];
  };
}): Promise<string | null> {
  return await args.runtime.createTask({
    name: `GMAIL_REPLY_APPROVAL_${Date.now()}`,
    description: `Approve sending the Gmail reply${args.draft.subject ? ` (${args.draft.subject})` : ""}: ${args.draft.bodyText}`,
    roomId: args.message.roomId,
    entityId: args.message.entityId,
    tags: ["AWAITING_CHOICE", "APPROVAL", ACTION_NAME],
    metadata: {
      options: [
        { name: "confirm", description: "Send the drafted Gmail reply" },
        { name: "cancel", description: "Keep the draft unsent" },
      ],
      approvalRequest: {
        timeoutMs: 24 * 60 * 60 * 1000,
        timeoutDefault: "cancel",
        createdAt: Date.now(),
        isAsync: true,
      },
      actionName: ACTION_NAME,
      channel: "gmail",
      payload: {
        messageId: args.draft.messageId,
        bodyText: args.draft.bodyText,
        subject: args.draft.subject ?? null,
        to: args.draft.to ?? [],
        cc: args.draft.cc ?? [],
      },
    },
  });
}

function normalizeGmailSubaction(value: unknown): GmailSubaction | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "triage":
    case "needs_response":
    case "recommend":
    case "unresponded":
    case "search":
    case "read":
    case "draft_reply":
    case "draft_batch_replies":
    case "manage":
    case "send_reply":
    case "send_batch_replies":
    case "send_message":
      return normalized;
    default:
      return null;
  }
}

function normalizeShouldAct(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return null;
}

function normalizePlannerResponse(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePlannerString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function splitLooseListString(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let angleDepth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];

    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (!inQuotes && char === "<") {
      angleDepth += 1;
      current += char;
      continue;
    }
    if (!inQuotes && char === ">") {
      angleDepth = Math.max(0, angleDepth - 1);
      current += char;
      continue;
    }
    if (!inQuotes && angleDepth === 0 && char === "|" && next === "|") {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        parts.push(trimmed);
      }
      current = "";
      index += 1;
      continue;
    }
    if (
      !inQuotes &&
      angleDepth === 0 &&
      (char === "," || char === ";" || char === "\n")
    ) {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        parts.push(trimmed);
      }
      current = "";
      continue;
    }
    current += char;
  }

  const trimmed = current.trim();
  if (trimmed.length > 0) {
    parts.push(trimmed);
  }
  return parts;
}

function normalizePlannerStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return dedupeQueries(
      value.flatMap((item) =>
        typeof item === "string" ? splitLooseListString(item) : [],
      ),
    );
  }
  if (typeof value === "string") {
    return dedupeQueries(splitLooseListString(value));
  }
  return undefined;
}

function normalizeQueryStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return dedupeQueries(
      value.map((item) => (typeof item === "string" ? item.trim() : "")),
    );
  }
  if (typeof value === "string") {
    return dedupeQueries(value.split(/\s*\|\|\s*/).map((item) => item.trim()));
  }
  return undefined;
}

function buildGmailReplyOnlyFallback(subaction: GmailSubaction | null): string {
  switch (subaction) {
    case "search":
      return "What email do you want me to search for?";
    case "read":
      return "Which email do you want me to read?";
    case "draft_reply":
    case "draft_batch_replies":
      return "Which email do you want me to draft a reply for?";
    case "send_reply":
    case "send_batch_replies":
    case "send_message":
      return "What exactly do you want me to send in Gmail?";
    case "needs_response":
      return "Do you want emails that need a reply, or something else in Gmail?";
    case "recommend":
      return "Do you want Gmail action recommendations for the current inbox or a specific search?";
    case "unresponded":
      return "How far back should I look for sent Gmail threads without replies?";
    case "manage":
      return "Which Gmail messages should I update, and should I archive, mark read, label, trash, or report spam?";
    default:
      return "What do you want to do in Gmail — check inbox, search, manage, read, or draft a reply?";
  }
}

function buildGmailServiceErrorFallback(error: LifeOpsServiceError): string {
  const normalized = normalizeText(error.message);
  if (error.status === 429 || normalized.includes("rate limit")) {
    return "Gmail is rate-limited right now. Try again in a bit.";
  }
  if (
    normalized.includes("multiple gmail messages matched") ||
    (error.status === 409 &&
      normalized.includes("narrow the query") &&
      normalized.includes("message"))
  ) {
    return "I found more than one matching email. Tell me the sender, subject, or message id.";
  }
  if (normalized.includes("not found")) {
    return "I couldn't find that email. Tell me who it was from or what the subject looked like.";
  }
  if (
    normalized.includes("missing") &&
    (normalized.includes("message") || normalized.includes("body"))
  ) {
    return "I still need the exact message or the reply text to finish that Gmail action.";
  }
  return "I couldn't finish that Gmail action yet. Tell me what message you want and what you want me to do with it.";
}

function buildGmailTargetDisambiguationFallback(feed: GmailSearchFeed): string {
  return `${formatEmailSearch(feed)}\nTell me which email you mean by sender, subject, or message id.`;
}

function shouldUseCanonicalGmailReplyFallback(scenario: string): boolean {
  return (
    scenario === "access_denied" ||
    scenario === "gmail_read_unavailable" ||
    scenario === "gmail_send_unavailable"
  );
}

async function renderGmailActionReply(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  intent: string;
  scenario: string;
  fallback: string;
  context?: Record<string, unknown>;
}): Promise<string> {
  const { runtime, message, state, intent, scenario, fallback, context } = args;
  if (shouldUseCanonicalGmailReplyFallback(scenario)) {
    return fallback;
  }
  return renderGroundedActionReply({
    runtime,
    message,
    state,
    intent,
    domain: "gmail",
    scenario,
    fallback,
    context,
    preferCharacterVoice: true,
    additionalRules: [
      "Mirror the user's wording for time windows, urgency, and reply intent when possible.",
      "Preserve all concrete email facts from the context and canonical fallback.",
      "If this is reply-only or a clarification, do not pretend you already searched, drafted, or sent something.",
    ],
  });
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeLookupKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function dedupeQueries(values: Array<string | undefined>): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const query =
      typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
    if (!query) {
      continue;
    }
    const key = query.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    queries.push(query);
  }
  return queries;
}

function normalizeGmailDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!details) {
    return undefined;
  }

  const normalized: Record<string, unknown> = { ...details };
  const aliasMap = new Map<string, string>();
  for (const [canonical, aliases] of Object.entries(GMAIL_DETAIL_ALIASES)) {
    aliasMap.set(normalizeLookupKey(canonical), canonical);
    for (const alias of aliases) {
      aliasMap.set(normalizeLookupKey(alias), canonical);
    }
  }

  for (const [key, value] of Object.entries(details)) {
    const canonical = aliasMap.get(normalizeLookupKey(key));
    if (!canonical) {
      continue;
    }
    if (normalized[canonical] === undefined) {
      normalized[canonical] = value;
    }
  }

  return normalized;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  const normalized = Array.isArray(value)
    ? value.flatMap((item) =>
        typeof item === "string" ? splitLooseListString(item) : [],
      )
    : typeof value === "string"
      ? splitLooseListString(value)
      : [];
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizePlannerGmailOperation(
  value: unknown,
): LifeOpsGmailBulkOperation | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "archive":
    case "trash":
    case "delete":
    case "report_spam":
    case "mark_read":
    case "mark_unread":
    case "apply_label":
    case "remove_label":
      return normalized;
    case "spam":
      return "report_spam";
    default:
      return undefined;
  }
}

function normalizeGmailPlanStepKind(
  value: unknown,
  subaction: GmailSubaction | null,
): GmailPlanStepKind {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    switch (normalized) {
      case "gmail_subaction":
      case "classify":
      case "propose_action":
      case "request_approval":
      case "audit":
        return normalized;
      default:
        break;
    }
  }
  return subaction ? "gmail_subaction" : "propose_action";
}

function normalizeGmailPlanStepStatus(
  value: unknown,
): GmailPlanStepStatus | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "pending":
    case "ready":
    case "blocked":
    case "completed":
      return normalized;
    case "complete":
    case "done":
      return "completed";
    case "waiting":
    case "waiting_approval":
      return "blocked";
    default:
      return undefined;
  }
}

function normalizeGmailPlanStep(
  value: unknown,
  index: number,
): GmailPlanStep | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const subaction = normalizeGmailSubaction(record.subaction);
  const payload = normalizeGmailPayloadPlan(record);
  const id =
    normalizePlannerString(record.id ?? record.stepId) ?? `step_${index + 1}`;
  return {
    id,
    kind: normalizeGmailPlanStepKind(record.kind ?? record.type, subaction),
    subaction: subaction ?? undefined,
    goal: normalizePlannerString(
      record.goal ?? record.description ?? record.purpose,
    ),
    dependsOn: normalizePlannerStringArray(record.dependsOn),
    requiresApproval: normalizeOptionalBoolean(record.requiresApproval),
    status: normalizeGmailPlanStepStatus(record.status),
    ...payload,
  };
}

function normalizeGmailPlanSteps(value: unknown): GmailPlanStep[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const steps = value
    .map((step, index) => normalizeGmailPlanStep(step, index))
    .filter((step): step is GmailPlanStep => step !== null);
  return steps.length > 0 ? steps : undefined;
}

function isExecutableGmailPlanStep(step: GmailPlanStep): boolean {
  return Boolean(
    step.subaction &&
      step.kind === "gmail_subaction" &&
      step.status !== "blocked" &&
      step.status !== "completed",
  );
}

function selectGmailPlanStep(args: {
  steps: GmailPlanStep[] | undefined;
  currentStepId?: string;
}): GmailPlanStep | undefined {
  if (!args.steps || args.steps.length === 0) {
    return undefined;
  }
  const currentStep = args.currentStepId
    ? args.steps.find((step) => step.id === args.currentStepId)
    : undefined;
  if (currentStep && isExecutableGmailPlanStep(currentStep)) {
    return currentStep;
  }
  return args.steps.find(isExecutableGmailPlanStep);
}

function mergeGmailPayloadPlans(
  primary: GmailPayloadPlan,
  fallback: GmailPayloadPlan,
): GmailPayloadPlan {
  return {
    queries: dedupeQueries([...primary.queries, ...fallback.queries]),
    messageId: primary.messageId ?? fallback.messageId,
    messageIds: mergePlannerArray(primary.messageIds, fallback.messageIds),
    replyNeededOnly: primary.replyNeededOnly ?? fallback.replyNeededOnly,
    confirmed: primary.confirmed ?? fallback.confirmed,
    holdForApproval: primary.holdForApproval ?? fallback.holdForApproval,
    operation: primary.operation ?? fallback.operation,
    labelIds: mergePlannerArray(primary.labelIds, fallback.labelIds),
    confirmDestructive:
      primary.confirmDestructive ?? fallback.confirmDestructive,
    olderThanDays: primary.olderThanDays ?? fallback.olderThanDays,
    to: mergePlannerArray(primary.to, fallback.to),
    cc: mergePlannerArray(primary.cc, fallback.cc),
    bcc: mergePlannerArray(primary.bcc, fallback.bcc),
    subject: primary.subject ?? fallback.subject,
    bodyText: primary.bodyText ?? fallback.bodyText,
  };
}

function buildGmailWorkflowPlanSnapshot(args: {
  plan: GmailLlmPlan;
  executedSubaction: GmailSubaction | null;
  success: boolean;
}): GmailWorkflowPlan | undefined {
  if (!args.plan.steps || args.plan.steps.length === 0) {
    return undefined;
  }

  const currentStep =
    selectGmailPlanStep({
      steps: args.plan.steps,
      currentStepId: args.plan.currentStepId,
    }) ??
    args.plan.steps.find(
      (step) =>
        step.subaction === args.executedSubaction &&
        step.status !== "completed",
    );
  const executedStepId = currentStep?.id;
  const steps = args.plan.steps.map((step) =>
    args.success && step.id === executedStepId
      ? { ...step, status: "completed" as const }
      : step,
  );
  const executedIndex = executedStepId
    ? steps.findIndex((step) => step.id === executedStepId)
    : -1;
  const nextSteps =
    executedIndex >= 0
      ? steps.slice(executedIndex + 1)
      : steps.filter((step) => step.status !== "completed");
  const nextStepIds = nextSteps
    .filter((step) => step.status !== "completed")
    .map((step) => step.id);

  return {
    summary: args.plan.planSummary,
    currentStepId: nextStepIds[0],
    lastExecutedStepId: args.success ? executedStepId : undefined,
    nextStepIds,
    steps,
  };
}

function attachGmailWorkflowPlanData(args: {
  data: ActionResult["data"] | undefined;
  plan: GmailLlmPlan;
  executedSubaction: GmailSubaction | null;
  success: boolean;
}): ActionResult["data"] | undefined {
  const gmailPlan = buildGmailWorkflowPlanSnapshot({
    plan: args.plan,
    executedSubaction: args.executedSubaction,
    success: args.success,
  });
  if (!gmailPlan) {
    return args.data;
  }
  const dataRecord =
    args.data && typeof args.data === "object"
      ? (args.data as Record<string, unknown>)
      : {};
  return toActionData({
    ...dataRecord,
    gmailPlan,
  });
}

function coerceGmailComposeDraft(value: unknown): GmailComposeDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.subaction !== "send_message") {
    return null;
  }
  const status =
    record.status === "sent" || record.status === "pending_clarification"
      ? record.status
      : null;
  if (!status) {
    return null;
  }
  return {
    subaction: "send_message",
    status,
    intent: normalizePlannerString(record.intent),
    to: normalizePlannerStringArray(record.to),
    cc: normalizePlannerStringArray(record.cc),
    bcc: normalizePlannerStringArray(record.bcc),
    subject: normalizePlannerString(record.subject),
    bodyText: normalizePlannerString(record.bodyText),
    updatedAt: normalizePlannerString(record.updatedAt),
  };
}

function buildGmailComposeDraft(args: {
  status: GmailComposeDraftStatus;
  intent?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  bodyText?: string;
}): GmailComposeDraft {
  return {
    subaction: "send_message",
    status: args.status,
    intent: args.intent,
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    subject: args.subject,
    bodyText: args.bodyText,
    updatedAt: new Date().toISOString(),
  };
}

function composeDraftFromActionResult(
  result: ActionResult | undefined,
): GmailComposeDraft | null {
  if (!result?.data || typeof result.data !== "object") {
    return null;
  }
  return coerceGmailComposeDraft(
    (result.data as Record<string, unknown>).gmailDraft,
  );
}

function coerceGmailReplyDraftContext(
  value: unknown,
): GmailReplyDraftContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const messageId = normalizePlannerString(record.messageId);
  const bodyText = normalizePlannerString(record.bodyText ?? record.body);
  if (!messageId || !bodyText) {
    return null;
  }
  return {
    messageId,
    bodyText,
    subject: normalizePlannerString(record.subject),
    to: normalizePlannerStringArray(record.to),
    cc: normalizePlannerStringArray(record.cc),
  };
}

function coerceGmailMessageTargetContext(
  value: unknown,
): GmailMessageTargetContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const messageId = normalizePlannerString(record.id ?? record.messageId);
  if (!messageId) {
    return null;
  }
  return {
    messageId,
    subject: normalizePlannerString(record.subject),
    from: normalizePlannerString(record.from),
    query: normalizePlannerString(record.query),
  };
}

function gmailStateDataRecords(
  state: State | undefined,
): Record<string, unknown>[] {
  return extractStateDataRecords(state);
}

function latestGmailReplyDraftContext(
  state: State | undefined,
): GmailReplyDraftContext | null {
  const records = gmailStateDataRecords(state);
  for (const record of records.reverse()) {
    const directDraft =
      coerceGmailReplyDraftContext(record.gmailDraft) ??
      coerceGmailReplyDraftContext(record.draft) ??
      coerceGmailReplyDraftContext(record);
    if (directDraft) {
      return directDraft;
    }
    if (Array.isArray(record.drafts)) {
      for (const candidate of [...record.drafts].reverse()) {
        const draft = coerceGmailReplyDraftContext(candidate);
        if (draft) {
          return draft;
        }
      }
    }
  }
  return null;
}

function latestGmailBatchReplyDraftItems(
  state: State | undefined,
): LifeOpsGmailBatchReplySendItem[] | undefined {
  const records = gmailStateDataRecords(state);
  for (const record of records.reverse()) {
    const drafts = Array.isArray(record.drafts)
      ? record.drafts
          .map((draft) => coerceGmailReplyDraftContext(draft))
          .filter((draft): draft is GmailReplyDraftContext => draft !== null)
      : [];
    if (drafts.length === 0) {
      continue;
    }
    return drafts.map((draft) => ({
      messageId: draft.messageId,
      bodyText: draft.bodyText,
      subject: draft.subject,
      to: draft.to,
      cc: draft.cc,
    }));
  }
  return undefined;
}

function latestGmailMessageTargetContext(
  state: State | undefined,
): GmailMessageTargetContext | null {
  const records = gmailStateDataRecords(state);
  for (const record of records.reverse()) {
    const directTarget =
      coerceGmailMessageTargetContext(record.message) ??
      coerceGmailMessageTargetContext(record.gmailMessage) ??
      coerceGmailMessageTargetContext(record);
    if (directTarget) {
      return directTarget;
    }
    if (Array.isArray(record.messages)) {
      for (const candidate of record.messages) {
        const message = coerceGmailMessageTargetContext(candidate);
        if (message) {
          return {
            ...message,
            query: message.query ?? normalizePlannerString(record.query),
          };
        }
      }
    }
  }
  return null;
}

function coerceGmailWorkflowPlan(value: unknown): GmailWorkflowPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const steps = normalizeGmailPlanSteps(record.steps);
  if (!steps) {
    return null;
  }
  return {
    summary: normalizePlannerString(record.summary ?? record.planSummary),
    currentStepId: normalizePlannerString(record.currentStepId),
    lastExecutedStepId: normalizePlannerString(record.lastExecutedStepId),
    nextStepIds: normalizePlannerStringArray(record.nextStepIds),
    steps,
  };
}

function latestGmailWorkflowPlan(
  state: State | undefined,
): GmailWorkflowPlan | null {
  const records = gmailStateDataRecords(state);
  for (const record of records.reverse()) {
    const plan =
      coerceGmailWorkflowPlan(record.gmailPlan) ??
      coerceGmailWorkflowPlan(record.plan);
    if (plan) {
      return plan;
    }
  }
  return null;
}

function gmailComposeDraftFromMessageEntry(entry: {
  content?: unknown;
}): GmailComposeDraft | null {
  const content =
    entry.content && typeof entry.content === "object"
      ? (entry.content as Record<string, unknown>)
      : null;
  if (!content) {
    return null;
  }
  return (
    coerceGmailComposeDraft(content.gmailDraft) ??
    coerceGmailComposeDraft(
      content.data && typeof content.data === "object"
        ? (content.data as Record<string, unknown>).gmailDraft
        : undefined,
    )
  );
}

function latestGmailComposeDraft(
  state: State | undefined,
  statuses: GmailComposeDraftStatus[],
): GmailComposeDraft | null {
  const drafts: GmailComposeDraft[] = [];

  for (const result of extractActionResultsFromState(state)) {
    const draft = composeDraftFromActionResult(result);
    if (draft) {
      drafts.push(draft);
    }
  }

  for (const entry of extractRecentMessageEntriesFromState(state)) {
    const draft = gmailComposeDraftFromMessageEntry(entry);
    if (draft) {
      drafts.push(draft);
    }
  }

  const allowed = new Set<GmailComposeDraftStatus>(statuses);
  for (const draft of drafts.reverse()) {
    if (allowed.has(draft.status)) {
      return draft;
    }
  }
  return null;
}

function mergePlannerArray(
  primary: string[] | undefined,
  fallback: string[] | undefined,
): string[] | undefined {
  if (primary && primary.length > 0) {
    return primary;
  }
  return fallback && fallback.length > 0 ? fallback : undefined;
}

function mergeComposeDrafts(
  ...drafts: Array<
    Partial<GmailComposeDraft> | GmailComposeRecoveryPlan | undefined
  >
): GmailComposeDraft {
  let to: string[] | undefined;
  let cc: string[] | undefined;
  let bcc: string[] | undefined;
  let subject: string | undefined;
  let bodyText: string | undefined;
  let intent: string | undefined;
  let status: GmailComposeDraftStatus = "pending_clarification";

  for (const draft of drafts) {
    if (!draft) {
      continue;
    }
    to = mergePlannerArray(draft.to, to);
    cc = mergePlannerArray(draft.cc, cc);
    bcc = mergePlannerArray(draft.bcc, bcc);
    subject =
      normalizePlannerString(draft.subject) ?? normalizePlannerString(subject);
    bodyText =
      normalizePlannerString(draft.bodyText) ??
      normalizePlannerString(bodyText);
    if ("intent" in draft) {
      intent =
        normalizePlannerString((draft as Partial<GmailComposeDraft>).intent) ??
        intent;
    }
    if ("status" in draft) {
      const candidate = (draft as Partial<GmailComposeDraft>).status;
      if (candidate === "pending_clarification" || candidate === "sent") {
        status = candidate;
      }
    }
  }

  return buildGmailComposeDraft({
    status,
    intent,
    to,
    cc,
    bcc,
    subject,
    bodyText,
  });
}

async function buildGmailPlanningContext(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
}): Promise<GmailPlanningContext> {
  const recentConversation = (await collectGmailConversationContext(args)).join(
    "\n",
  );
  const currentMessage = messageText(args.message).trim();
  const timeZone = resolveDefaultTimeZone();
  const now = new Date();
  const nowIso = now.toISOString();
  const localNow = new Intl.DateTimeFormat(undefined, {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now);
  return {
    recentConversation,
    latestReplyDraft: latestGmailReplyDraftContext(args.state),
    latestMessageTarget: latestGmailMessageTargetContext(args.state),
    activeWorkflowPlan: latestGmailWorkflowPlan(args.state),
    currentMessage,
    timeZone,
    nowIso,
    localNow,
  };
}

function parseGmailPlannerRecord(
  rawResponse: string,
): Record<string, unknown> | null {
  return (
    parseKeyValueXml<Record<string, unknown>>(rawResponse) ??
    parseJSONObjectFromText(rawResponse)
  );
}

function extractPlannerQueries(
  parsed: Record<string, unknown>,
): Array<string | undefined> {
  const rawQueries: Array<string | undefined> = [];
  if (typeof parsed.queries === "string" && parsed.queries.trim().length > 0) {
    for (const query of parsed.queries.split(/\s*\|\|\s*/)) {
      if (query.trim().length > 0) {
        rawQueries.push(query.trim());
      }
    }
  } else if (Array.isArray(parsed.queries)) {
    for (const value of parsed.queries) {
      if (typeof value === "string") {
        rawQueries.push(value);
      }
    }
  }
  if (typeof parsed.query === "string") rawQueries.push(parsed.query);
  if (typeof parsed.query1 === "string") rawQueries.push(parsed.query1);
  if (typeof parsed.query2 === "string") rawQueries.push(parsed.query2);
  if (typeof parsed.query3 === "string") rawQueries.push(parsed.query3);
  return rawQueries;
}

function normalizeGmailIntentPlan(
  parsed: Record<string, unknown> | null,
): GmailIntentPlan {
  if (!parsed) {
    return { subaction: null, queries: [], shouldAct: null };
  }
  const steps = normalizeGmailPlanSteps(parsed.steps);
  const currentStepId = normalizePlannerString(
    parsed.currentStepId ?? parsed.current_step_id,
  );
  const selectedStep = selectGmailPlanStep({ steps, currentStepId });
  return {
    subaction:
      normalizeGmailSubaction(parsed.subaction) ??
      selectedStep?.subaction ??
      null,
    queries: dedupeQueries(extractPlannerQueries(parsed)),
    shouldAct: normalizeShouldAct(parsed.shouldAct),
    confirmed: normalizeOptionalBoolean(parsed.confirmed),
    holdForApproval: normalizeOptionalBoolean(parsed.holdForApproval),
    messageId:
      typeof parsed.messageId === "string" && parsed.messageId.trim().length > 0
        ? parsed.messageId.trim()
        : undefined,
    messageIds: normalizePlannerStringArray(parsed.messageIds),
    replyNeededOnly: normalizeOptionalBoolean(parsed.replyNeededOnly),
    operation: normalizePlannerGmailOperation(parsed.operation),
    labelIds: normalizePlannerStringArray(parsed.labelIds),
    confirmDestructive: normalizeOptionalBoolean(parsed.confirmDestructive),
    olderThanDays:
      typeof parsed.olderThanDays === "number" ? parsed.olderThanDays : undefined,
    to: normalizePlannerStringArray(parsed.to ?? parsed.recipients),
    cc: normalizePlannerStringArray(parsed.cc),
    bcc: normalizePlannerStringArray(parsed.bcc),
    subject: normalizePlannerString(parsed.subject),
    bodyText: normalizePlannerString(parsed.bodyText ?? parsed.body),
    steps,
    currentStepId: currentStepId ?? selectedStep?.id,
    planSummary: normalizePlannerString(
      parsed.planSummary ?? parsed.summary ?? parsed.plan,
    ),
  };
}

function normalizeGmailPayloadPlan(
  parsed: Record<string, unknown> | null,
): GmailPayloadPlan {
  if (!parsed) {
    return { queries: [] };
  }
  return {
    queries: dedupeQueries(extractPlannerQueries(parsed)),
    messageId: normalizePlannerString(parsed.messageId),
    messageIds: normalizePlannerStringArray(parsed.messageIds),
    replyNeededOnly: normalizeOptionalBoolean(parsed.replyNeededOnly),
    confirmed: normalizeOptionalBoolean(parsed.confirmed),
    holdForApproval: normalizeOptionalBoolean(parsed.holdForApproval),
    operation: normalizePlannerGmailOperation(parsed.operation),
    labelIds: normalizePlannerStringArray(parsed.labelIds),
    confirmDestructive: normalizeOptionalBoolean(parsed.confirmDestructive),
    olderThanDays:
      typeof parsed.olderThanDays === "number" ? parsed.olderThanDays : undefined,
    to: normalizePlannerStringArray(parsed.to ?? parsed.recipients),
    cc: normalizePlannerStringArray(parsed.cc),
    bcc: normalizePlannerStringArray(parsed.bcc),
    subject: normalizePlannerString(parsed.subject),
    bodyText: normalizePlannerString(parsed.bodyText ?? parsed.body),
  };
}

function payloadFromGmailPlanFields(
  fields: Partial<GmailPlanFields>,
): GmailPayloadPlan {
  return {
    queries: fields.queries ?? [],
    messageId: fields.messageId,
    messageIds: fields.messageIds,
    replyNeededOnly: fields.replyNeededOnly,
    confirmed: fields.confirmed,
    holdForApproval: fields.holdForApproval,
    operation: fields.operation,
    labelIds: fields.labelIds,
    confirmDestructive: fields.confirmDestructive,
    olderThanDays: fields.olderThanDays,
    to: fields.to,
    cc: fields.cc,
    bcc: fields.bcc,
    subject: fields.subject,
    bodyText: fields.bodyText,
  };
}

function shouldExtractGmailPayload(subaction: GmailSubaction): boolean {
  return subaction !== "triage" && subaction !== "send_batch_replies";
}

async function runGmailPlanningModel(args: {
  runtime: IAgentRuntime;
  prompt: string;
  modelType: (typeof ModelType)[keyof typeof ModelType];
  failureMessage: string;
}): Promise<Record<string, unknown> | null> {
  if (typeof args.runtime.useModel !== "function") {
    return null;
  }
  try {
    const runModel = args.runtime.useModel.bind(args.runtime);
    const result = await runModel(args.modelType, {
      prompt: args.prompt,
    });
    const rawResponse = typeof result === "string" ? result : "";
    return parseGmailPlannerRecord(rawResponse);
  } catch (error) {
    args.runtime.logger?.warn?.(
      {
        src: "action:gmail",
        error: error instanceof Error ? error.message : String(error),
      },
      args.failureMessage,
    );
    return null;
  }
}

async function resolveGmailIntentPlanWithLlm(args: {
  runtime: IAgentRuntime;
  intent: string;
  context: GmailPlanningContext;
  activeComposeDraft?: GmailComposeDraft | null;
}): Promise<GmailIntentPlan> {
  const { context } = args;
  const prompt = [
    "Create the Gmail execution plan for this request.",
    "The user may speak in any language.",
    "This action can execute only one Gmail subaction in this invocation, but it must still plan the full user-visible workflow.",
    "Set top-level subaction to the first Gmail subaction that should execute now.",
    "Use steps to represent dependent work such as search, read, classify, propose_action, request_approval, execute, and audit.",
    "For multi-step requests, do not collapse directly to a later write/send step before required search/read/classification/approval steps have happened.",
    "Mailbox ownership (OWNER vs AGENT) is selected outside this planner.",
    "If the current request is vague or a follow-up, use recent conversation and any active Gmail workflow plan to recover the target or next step.",
    "When shouldAct=false, provide a short natural-language response that asks only for what is missing.",
    "When shouldAct=false, write that response in the user's language unless they clearly asked to switch languages.",
    "",
    "Return ONLY valid JSON with exactly these fields:",
    '{"subaction":"triage"|"needs_response"|"recommend"|"unresponded"|"search"|"read"|"draft_reply"|"draft_batch_replies"|"manage"|"send_reply"|"send_batch_replies"|"send_message"|null,"shouldAct":true|false,"response":"string|null","planSummary":"string|null","currentStepId":"string|null","steps":[]}',
    "Each step must be an object with id, kind, subaction, goal, status, dependsOn, requiresApproval, and any known Gmail fields.",
    'Allowed step kind values: "gmail_subaction", "classify", "propose_action", "request_approval", "audit".',
    "Only gmail_subaction steps may set subaction. Use null subaction for classify/propose_action/request_approval/audit steps.",
    'Allowed step status values: "pending", "ready", "blocked", "completed". Use ready for the step to execute now.',
    "Gmail fields on steps may include queries, messageId, messageIds, replyNeededOnly, operation, labelIds, confirmDestructive, olderThanDays, to, cc, bcc, subject, bodyText, confirmed, and holdForApproval.",
    "",
    "Subactions and when to use each:",
    "  triage — broad inbox overview only",
    "  needs_response — specifically about emails that need a reply",
    "  recommend — read-only recommended Gmail actions for the current inbox or a search",
    "  unresponded — sent threads where the user is waiting on someone else",
    "  search — search by sender, subject, keyword, label, or time window",
    "  read — read a specific email body",
    "  draft_reply — draft a reply to one email thread",
    "  draft_batch_replies — draft replies to multiple emails",
    "  manage — archive, trash, mark read/unread, spam, or label existing emails",
    "  send_reply — send a confirmed reply to one email thread",
    "  send_batch_replies — send confirmed replies to multiple emails",
    "  send_message — compose or send a brand-new outbound email",
    "Use triage only for broad inbox overviews.",
    "Use search as the first step when the request includes a specific sender, subject, keyword, label, or time filter and later work depends on seeing the matching thread.",
    "Use needs_response only when the user is specifically asking about emails that need a reply.",
    "Use recommend when the user asks what to archive, mark read, label, spam-review, or otherwise clean up without explicitly executing the write.",
    "Use unresponded when the user asks what sent emails are waiting for a reply.",
    "Use manage for inbox-zero operations such as archive, delete, spam, label, or mark read.",
    "Use send_message only for brand-new outbound email, not for replies to an existing thread.",
    "If there is an active compose draft and the user is filling in fields or confirming the send, choose send_message.",
    "",
    "Examples:",
    '  "check my inbox" -> {"subaction":"triage","shouldAct":true,"response":null,"planSummary":"Triage Gmail inbox","currentStepId":"triage","steps":[{"id":"triage","kind":"gmail_subaction","subaction":"triage","goal":"Summarize the inbox","status":"ready","dependsOn":[],"requiresApproval":false}]}',
    '  "did Sarah email me this week" -> {"subaction":"search","shouldAct":true,"response":null,"planSummary":"Search Gmail for Sarah this week","currentStepId":"search_sarah","steps":[{"id":"search_sarah","kind":"gmail_subaction","subaction":"search","goal":"Find matching email threads","status":"ready","queries":["from:sarah newer_than:7d"],"dependsOn":[],"requiresApproval":false}]}',
    '  "search for Sarah, read the thread, tell me if I should reply, draft it for approval, then send if I approve" -> {"subaction":"search","shouldAct":true,"response":null,"planSummary":"Find, read, classify, draft, approve, and send a Sarah reply","currentStepId":"search_sarah","steps":[{"id":"search_sarah","kind":"gmail_subaction","subaction":"search","goal":"Find the Sarah thread","status":"ready","queries":["from:sarah"],"dependsOn":[],"requiresApproval":false},{"id":"read_thread","kind":"gmail_subaction","subaction":"read","goal":"Read the selected thread","status":"pending","dependsOn":["search_sarah"],"requiresApproval":false},{"id":"classify_need","kind":"classify","subaction":null,"goal":"Decide whether the thread needs action","status":"pending","dependsOn":["read_thread"],"requiresApproval":false},{"id":"propose_reply","kind":"propose_action","subaction":null,"goal":"Propose the reply strategy","status":"pending","dependsOn":["classify_need"],"requiresApproval":false},{"id":"draft_reply","kind":"gmail_subaction","subaction":"draft_reply","goal":"Draft the reply","status":"pending","dependsOn":["propose_reply"],"requiresApproval":false},{"id":"approve_send","kind":"request_approval","subaction":null,"goal":"Ask before sending","status":"pending","dependsOn":["draft_reply"],"requiresApproval":true},{"id":"send_reply","kind":"gmail_subaction","subaction":"send_reply","goal":"Send the approved reply","status":"pending","dependsOn":["approve_send"],"requiresApproval":true},{"id":"audit","kind":"audit","subaction":null,"goal":"Report what happened","status":"pending","dependsOn":["send_reply"],"requiresApproval":false}]}',
    '  "send that reply now" with recent draft context -> {"subaction":"send_reply","shouldAct":true,"response":null,"planSummary":"Send the existing Gmail reply draft","currentStepId":"send_reply","steps":[{"id":"send_reply","kind":"gmail_subaction","subaction":"send_reply","goal":"Send the confirmed reply draft","status":"ready","dependsOn":[],"requiresApproval":true,"confirmed":true}]}',
    '  "can you help me with my email?" -> {"subaction":null,"shouldAct":false,"response":"What do you want to do in Gmail — check inbox, search, read, or draft a reply?","planSummary":null,"currentStepId":null,"steps":[]}',
    ...(args.activeComposeDraft
      ? [
          "",
          "Active compose draft:",
          `  ${JSON.stringify({
            to: args.activeComposeDraft.to,
            cc: args.activeComposeDraft.cc,
            bcc: args.activeComposeDraft.bcc,
            subject: args.activeComposeDraft.subject,
            bodyText: args.activeComposeDraft.bodyText,
          })}`,
        ]
      : []),
    ...(context.latestReplyDraft || context.latestMessageTarget
      ? [
          "",
          "Recent reply context:",
          `  ${JSON.stringify({
            latestReplyDraft: context.latestReplyDraft,
            latestMessageTarget: context.latestMessageTarget,
          })}`,
        ]
      : []),
    ...(context.activeWorkflowPlan
      ? [
          "",
          "Active Gmail workflow plan from recent action results:",
          `  ${JSON.stringify(context.activeWorkflowPlan)}`,
        ]
      : []),
    "",
    `Current timezone: ${context.timeZone}`,
    `Current local datetime: ${context.localNow}`,
    `Current ISO datetime: ${context.nowIso}`,
    `Current request: ${JSON.stringify(context.currentMessage)}`,
    `Resolved intent: ${JSON.stringify(args.intent)}`,
    `Recent conversation: ${JSON.stringify(context.recentConversation)}`,
  ].join("\n");

  const parsed = await runGmailPlanningModel({
    runtime: args.runtime,
    prompt,
    modelType: ModelType.TEXT_LARGE,
    failureMessage: "Gmail intent planning model call failed",
  });
  return normalizeGmailIntentPlan(parsed);
}

async function extractGmailPayloadWithLlm(args: {
  runtime: IAgentRuntime;
  intent: string;
  subaction: GmailSubaction;
  currentStep?: GmailPlanStep;
  steps?: GmailPlanStep[];
  context: GmailPlanningContext;
  activeComposeDraft?: GmailComposeDraft | null;
}): Promise<GmailPayloadPlan> {
  const { context, subaction, currentStep } = args;
  const searchLikeSubaction =
    subaction === "needs_response" ||
    subaction === "recommend" ||
    subaction === "unresponded" ||
    subaction === "search" ||
    subaction === "read" ||
    subaction === "draft_reply" ||
    subaction === "draft_batch_replies" ||
    subaction === "manage" ||
    subaction === "send_reply";
  const prompt = [
    `Extract Gmail parameters for the current executable step ${currentStep?.id ?? subaction} (${subaction}).`,
    "The user may speak in any language.",
    "Do not skip ahead to a later workflow step. Only extract the supporting fields for the current executable step.",
    "The larger stepwise plan is provided for dependency context; preserve it conceptually while returning only current-step fields.",
    "",
    "Return ONLY valid JSON with exactly these fields:",
    '{"queries":[],"messageId":null,"messageIds":[],"replyNeededOnly":null,"operation":null,"labelIds":[],"confirmDestructive":null,"olderThanDays":null,"to":[],"cc":[],"bcc":[],"subject":null,"bodyText":null}',
    "",
    searchLikeSubaction
      ? "For this subaction, use queries for sender, subject, keyword, label, and time filters. Use Gmail search syntax even when the user speaks another language."
      : "For this subaction, leave queries, messageId, and replyNeededOnly empty unless the user explicitly provides them.",
    subaction === "search"
      ? "When the user asks who emailed them or whether anyone emailed within a time window, emit at least a time-window Gmail query like newer_than:1d instead of leaving queries empty."
      : "Do not invent sender or time filters that are not supported by the request or recent context.",
    searchLikeSubaction
      ? "If the request already relies on recent context like 'that email' or 'send that reply', leave messageId and queries empty rather than inventing them."
      : "Preserve existing compose-draft fields unless the current user message clearly overrides them.",
    subaction === "needs_response" || subaction === "draft_batch_replies"
      ? "Set replyNeededOnly=true only when the request is specifically about emails that need a reply."
      : "Set replyNeededOnly only when it is genuinely required by the fixed subaction.",
    subaction === "send_message"
      ? "Extract to, cc, bcc, subject, and bodyText for a brand-new outbound email."
      : "Leave to, cc, bcc, subject, and bodyText empty unless they are explicitly part of this fixed subaction.",
    subaction === "manage"
      ? "For operation, use one of archive, trash, delete, report_spam, mark_read, mark_unread, apply_label, remove_label. Set confirmDestructive=true only when the user explicitly confirms trash, spam, or delete right now."
      : "Leave operation, labelIds, and confirmDestructive empty unless the fixed subaction is manage.",
    subaction === "unresponded"
      ? "Extract olderThanDays when the user gives a waiting-age threshold."
      : "Leave olderThanDays empty unless the fixed subaction is unresponded.",
    "",
    "Examples:",
    ...(searchLikeSubaction
      ? [
          '  fixed subaction search, request "who emailed me today" -> {"queries":["newer_than:1d"],"messageId":null,"messageIds":[],"replyNeededOnly":null,"operation":null,"labelIds":[],"confirmDestructive":null,"olderThanDays":null,"to":[],"cc":[],"bcc":[],"subject":null,"bodyText":null}',
          '  fixed subaction search, request "did Sarah email me this week" -> {"queries":["from:sarah newer_than:7d"],"messageId":null,"messageIds":[],"replyNeededOnly":null,"operation":null,"labelIds":[],"confirmDestructive":null,"olderThanDays":null,"to":[],"cc":[],"bcc":[],"subject":null,"bodyText":null}',
          '  fixed subaction needs_response, request "which emails need a reply about venue" -> {"queries":["venue"],"messageId":null,"messageIds":[],"replyNeededOnly":true,"operation":null,"labelIds":[],"confirmDestructive":null,"olderThanDays":null,"to":[],"cc":[],"bcc":[],"subject":null,"bodyText":null}',
          '  fixed subaction read, request "read the latest email from finance" -> {"queries":["from:finance"],"messageId":null,"messageIds":[],"replyNeededOnly":null,"operation":null,"labelIds":[],"confirmDestructive":null,"olderThanDays":null,"to":[],"cc":[],"bcc":[],"subject":null,"bodyText":null}',
          '  fixed subaction manage, request "archive that email" with recent target context -> {"queries":[],"messageId":null,"messageIds":[],"replyNeededOnly":null,"operation":"archive","labelIds":[],"confirmDestructive":null,"olderThanDays":null,"to":[],"cc":[],"bcc":[],"subject":null,"bodyText":null}',
          '  fixed subaction send_reply, request "send that reply now" with recent draft context -> {"queries":[],"messageId":null,"messageIds":[],"replyNeededOnly":null,"operation":null,"labelIds":[],"confirmDestructive":null,"olderThanDays":null,"to":[],"cc":[],"bcc":[],"subject":null,"bodyText":null}',
        ]
      : [
          '  fixed subaction send_message, request "send an email to zo@iqlabs.dev, subject hello, body test" -> {"queries":[],"messageId":null,"messageIds":[],"replyNeededOnly":null,"operation":null,"labelIds":[],"confirmDestructive":null,"olderThanDays":null,"to":["zo@iqlabs.dev"],"cc":[],"bcc":[],"subject":"hello","bodyText":"test"}',
          '  fixed subaction send_message, active draft to=["shaw@gmail.com"], request "send an email like \\"test\\"" -> {"queries":[],"messageId":null,"messageIds":[],"replyNeededOnly":null,"operation":null,"labelIds":[],"confirmDestructive":null,"olderThanDays":null,"to":["shaw@gmail.com"],"cc":[],"bcc":[],"subject":"test","bodyText":"test"}',
        ]),
    ...(args.activeComposeDraft && subaction === "send_message"
      ? [
          "",
          "Active compose draft:",
          `  ${JSON.stringify({
            to: args.activeComposeDraft.to,
            cc: args.activeComposeDraft.cc,
            bcc: args.activeComposeDraft.bcc,
            subject: args.activeComposeDraft.subject,
            bodyText: args.activeComposeDraft.bodyText,
          })}`,
        ]
      : []),
    ...(args.steps && args.steps.length > 0
      ? [
          "",
          "Stepwise Gmail workflow plan:",
          `  ${JSON.stringify(args.steps)}`,
          `Current executable step: ${JSON.stringify(currentStep ?? null)}`,
        ]
      : []),
    ...(context.latestReplyDraft || context.latestMessageTarget
      ? [
          "",
          "Recent reply context:",
          `  ${JSON.stringify({
            latestReplyDraft: context.latestReplyDraft,
            latestMessageTarget: context.latestMessageTarget,
          })}`,
        ]
      : []),
    "",
    `Current timezone: ${context.timeZone}`,
    `Current local datetime: ${context.localNow}`,
    `Current ISO datetime: ${context.nowIso}`,
    `Current request: ${JSON.stringify(context.currentMessage)}`,
    `Resolved intent: ${JSON.stringify(args.intent)}`,
    `Recent conversation: ${JSON.stringify(context.recentConversation)}`,
  ].join("\n");

  const parsed = await runGmailPlanningModel({
    runtime: args.runtime,
    prompt,
    modelType: ModelType.TEXT_LARGE,
    failureMessage: "Gmail parameter extraction model call failed",
  });
  const payload = normalizeGmailPayloadPlan(parsed);
  if (subaction === "needs_response" && payload.replyNeededOnly === undefined) {
    return { ...payload, replyNeededOnly: true };
  }
  return payload;
}

export async function extractGmailPlanWithLlm(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  intent: string,
  activeComposeDraft?: GmailComposeDraft | null,
): Promise<GmailLlmPlan> {
  const context = await buildGmailPlanningContext({
    runtime,
    message,
    state,
  });
  const intentPlan = await resolveGmailIntentPlanWithLlm({
    runtime,
    intent,
    context,
    activeComposeDraft,
  });
  const currentStep = selectGmailPlanStep({
    steps: intentPlan.steps,
    currentStepId: intentPlan.currentStepId,
  });
  const subaction = currentStep?.subaction ?? intentPlan.subaction;
  const intentPayload = payloadFromGmailPlanFields(intentPlan);
  const stepPayload = currentStep
    ? payloadFromGmailPlanFields(currentStep)
    : { queries: [] };
  const plannedPayload = mergeGmailPayloadPlans(intentPayload, stepPayload);
  if (!subaction || intentPlan.shouldAct === false) {
    return {
      subaction,
      queries: [],
      response: intentPlan.response,
      shouldAct: intentPlan.shouldAct,
      steps: intentPlan.steps,
      currentStepId: intentPlan.currentStepId,
      planSummary: intentPlan.planSummary,
    };
  }
  if (!shouldExtractGmailPayload(subaction)) {
    return {
      subaction,
      response: intentPlan.response,
      shouldAct: intentPlan.shouldAct,
      ...plannedPayload,
      steps: intentPlan.steps,
      currentStepId: intentPlan.currentStepId ?? currentStep?.id,
      planSummary: intentPlan.planSummary,
      replyNeededOnly:
        plannedPayload.replyNeededOnly ??
        (subaction === "needs_response" ? true : undefined),
    };
  }
  const payloadPlan = await extractGmailPayloadWithLlm({
    runtime,
    intent,
    subaction,
    currentStep,
    steps: intentPlan.steps,
    context,
    activeComposeDraft,
  });
  const mergedPayload = mergeGmailPayloadPlans(payloadPlan, plannedPayload);
  return {
    subaction,
    shouldAct: intentPlan.shouldAct,
    response: intentPlan.response,
    ...mergedPayload,
    steps: intentPlan.steps,
    currentStepId: intentPlan.currentStepId ?? currentStep?.id,
    planSummary: intentPlan.planSummary,
  };
}

async function recoverSendMessagePlanWithLlm(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  intent: string;
  currentPlan: GmailLlmPlan;
  activeDraft?: GmailComposeDraft | null;
  previousSentDraft?: GmailComposeDraft | null;
}): Promise<GmailComposeRecoveryPlan | null> {
  const {
    runtime,
    message,
    state,
    intent,
    currentPlan,
    activeDraft,
    previousSentDraft,
  } = args;
  if (typeof runtime.useModel !== "function") {
    return null;
  }

  const recentConversation = (
    await collectGmailConversationContext({ runtime, message, state })
  ).join("\n");
  const currentMessage = messageText(message).trim();
  const prompt = [
    "Extract or recover the Gmail compose draft for this conversation.",
    "The user may speak in any language.",
    "This is only for brand-new outbound emails, not replies to an existing thread.",
    "There may be no existing compose draft yet. Start a new draft from the current user message whenever they are trying to send a brand-new email.",
    "Use the current user message as the source of truth for any new or overridden compose fields.",
    "Preserve already-established compose fields unless the current user message clearly overrides them.",
    "If the current user only gives part of the email, keep any extracted fields and leave the rest empty.",
    "Return shouldResume=true whenever the conversation is still actively composing a brand-new outbound email, even if recipient, subject, or body is still missing.",
    "When there is an active pending compose draft, keep its recipient, cc, bcc, subject, and body unless the user changes them.",
    "When the user says something like 'same as the last email', reuse subject/body/cc/bcc from the most recent completed outbound email, but keep the active draft recipient unless the user changes it.",
    "When a recipient is already known and the user gives a single short payload like send an email like 'test', treat that payload as the body text and, if subject is still missing, use the same short payload as the minimal subject.",
    "Keep the subject and body in the user's language unless the user explicitly asks to translate or switch languages.",
    "If the user is only pausing, thinking, or not ready yet, set shouldResume=false and do not invent missing fields.",
    "If the user cancels the email, set cancelled=true and shouldResume=false.",
    "",
    "Return ONLY XML with exactly these tags and nothing else.",
    "Use || between multiple addresses inside to, cc, or bcc.",
    "<shouldResume>true|false</shouldResume>",
    "<cancelled>true|false</cancelled>",
    "<response></response>",
    "<to></to>",
    "<cc></cc>",
    "<bcc></bcc>",
    "<subject></subject>",
    "<bodyText></bodyText>",
    "",
    "Examples:",
    '  current message: "send an email to zo@iqlabs.dev the subject should say hello anon and the body should say how are you doing today?"',
    "  <shouldResume>true</shouldResume><cancelled>false</cancelled><to>zo@iqlabs.dev</to><subject>hello anon</subject><bodyText>how are you doing today?</bodyText>",
    '  current message: "send it to shawmakesmagic@gmail.com this time"',
    "  <shouldResume>true</shouldResume><cancelled>false</cancelled><to>shawmakesmagic@gmail.com</to>",
    '  active draft recipient: ["shawmakesmagic@gmail.com"], current message: "send an email like \\"test\\""',
    "  <shouldResume>true</shouldResume><cancelled>false</cancelled><to>shawmakesmagic@gmail.com</to><subject>test</subject><bodyText>test</bodyText>",
    '  active draft recipient: ["shawmakesmagic@gmail.com"], previous sent subject/body: "Quick test" / "test", current message: "same as the last email"',
    "  <shouldResume>true</shouldResume><cancelled>false</cancelled><to>shawmakesmagic@gmail.com</to><subject>Quick test</subject><bodyText>test</bodyText>",
    '  current message: "enviale un correo a maria@example.com con asunto hola y cuerpo nos vemos manana"',
    "  <shouldResume>true</shouldResume><cancelled>false</cancelled><to>maria@example.com</to><subject>hola</subject><bodyText>nos vemos manana</bodyText>",
    `Current user message: ${JSON.stringify(currentMessage)}`,
    `Resolved intent: ${JSON.stringify(intent)}`,
    `Current Gmail planner draft: ${JSON.stringify({
      to: currentPlan.to,
      cc: currentPlan.cc,
      bcc: currentPlan.bcc,
      subject: currentPlan.subject,
      bodyText: currentPlan.bodyText,
      response: currentPlan.response,
      shouldAct: currentPlan.shouldAct,
      subaction: currentPlan.subaction,
    })}`,
    `Active pending compose draft: ${JSON.stringify(activeDraft ?? null)}`,
    `Most recent completed outbound email draft: ${JSON.stringify(previousSentDraft ?? null)}`,
    `Recent conversation: ${JSON.stringify(recentConversation)}`,
  ].join("\n");

  let rawResponse = "";
  try {
    const runModel = runtime.useModel.bind(runtime);
    const result = await runModel(ModelType.TEXT_LARGE, { prompt });
    rawResponse = typeof result === "string" ? result : "";
  } catch (error) {
    runtime.logger?.warn?.(
      {
        src: "action:gmail",
        error: error instanceof Error ? error.message : String(error),
      },
      "Gmail compose recovery model call failed",
    );
    return null;
  }

  const parsed =
    parseKeyValueXml<Record<string, unknown>>(rawResponse) ??
    parseJSONObjectFromText(rawResponse);
  if (!parsed) {
    return null;
  }

  return {
    shouldResume: normalizeOptionalBoolean(parsed.shouldResume),
    cancelled: normalizeOptionalBoolean(parsed.cancelled),
    response: normalizePlannerResponse(parsed.response),
    to: normalizePlannerStringArray(parsed.to ?? parsed.recipients),
    cc: normalizePlannerStringArray(parsed.cc),
    bcc: normalizePlannerStringArray(parsed.bcc),
    subject: normalizePlannerString(parsed.subject),
    bodyText: normalizePlannerString(parsed.bodyText ?? parsed.body),
  };
}

function resolveGmailSearchQueries(
  explicitQueries: Array<string | undefined>,
  llmPlan?: GmailLlmPlan,
): string[] {
  return dedupeQueries([...explicitQueries, ...(llmPlan?.queries ?? [])]);
}

function buildGmailSearchPlan(args: { queries: string[] }): {
  queries: string[];
  displayQuery: string;
} | null {
  const queries = dedupeQueries(args.queries);
  if (queries.length === 0) {
    return null;
  }
  const displayQuery = queries[0];
  if (!displayQuery) {
    return null;
  }
  return {
    queries,
    displayQuery,
  };
}

async function resolveGmailTargetMessage(args: {
  service: LifeOpsService;
  details: Record<string, unknown> | undefined;
  explicitQueryArray: string[];
  paramsQuery?: string;
  llmPlan: GmailLlmPlan;
}): Promise<GmailTargetResolution> {
  const resolvedQueries = resolveGmailSearchQueries(
    [
      ...args.explicitQueryArray,
      args.paramsQuery,
      detailString(args.details, "query"),
    ],
    args.llmPlan,
  );
  const searchPlan = buildGmailSearchPlan({
    queries: resolvedQueries,
  });
  if (!searchPlan) {
    return { kind: "missing" };
  }

  const requestBase = {
    mode: detailString(args.details, "mode") as
      | "local"
      | "remote"
      | "cloud_managed"
      | undefined,
    side: detailString(args.details, "side") as "owner" | "agent" | undefined,
    grantId: detailString(args.details, "grantId"),
    forceSync: detailBoolean(args.details, "forceSync"),
    maxResults: detailNumber(args.details, "maxResults") ?? 10,
    replyNeededOnly:
      detailBoolean(args.details, "replyNeededOnly") ??
      args.llmPlan.replyNeededOnly ??
      false,
  };

  for (const query of searchPlan.queries) {
    const feed = await args.service.getGmailSearch(INTERNAL_URL, {
      ...requestBase,
      query,
    });
    if (feed.messages.length === 0) {
      continue;
    }
    const displayFeed =
      feed.query === searchPlan.displayQuery
        ? feed
        : {
            ...feed,
            query: searchPlan.displayQuery,
          };
    if (feed.messages.length > 1) {
      return {
        kind: "ambiguous",
        feed: displayFeed,
        displayQuery: searchPlan.displayQuery,
      };
    }
    const message = feed.messages[0];
    return message
      ? {
          kind: "resolved",
          target: {
            messageId: message.id,
            subject: message.subject,
            from: message.from,
            query: searchPlan.displayQuery,
          },
        }
      : { kind: "missing" };
  }

  return { kind: "missing" };
}

function normalizeBatchSendItems(
  details: Record<string, unknown> | undefined,
): LifeOpsGmailBatchReplySendItem[] | undefined {
  const items = detailArray(details, "items");
  if (!items) {
    return undefined;
  }
  const normalized = items
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const record = item as Record<string, unknown>;
      const messageId =
        typeof record.messageId === "string" &&
        record.messageId.trim().length > 0
          ? record.messageId.trim()
          : null;
      const bodyText =
        typeof record.bodyText === "string" && record.bodyText.trim().length > 0
          ? record.bodyText.trim()
          : null;
      if (!messageId || !bodyText) {
        return null;
      }
      const normalized: LifeOpsGmailBatchReplySendItem = {
        messageId,
        bodyText,
        subject:
          typeof record.subject === "string" && record.subject.trim().length > 0
            ? record.subject.trim()
            : undefined,
        to: normalizeStringArray(record.to),
        cc: normalizeStringArray(record.cc),
      };
      return normalized;
    })
    .filter((item): item is LifeOpsGmailBatchReplySendItem => item !== null);
  return normalized.length > 0 ? normalized : undefined;
}

export const gmailAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: [
    "GMAIL",
    "CHECK_EMAIL",
    "EMAIL_TRIAGE",
    "UNREAD_EMAILS",
    "EMAIL_UNREAD",
    "SEARCH_EMAIL",
    "DRAFT_EMAIL_REPLY",
    "SEND_EMAIL_REPLY",
  ],
  description:
    "Gmail-only execution layer through LifeOps. This action touches Gmail and nothing else. " +
    "USE this action ONLY when the request explicitly names Gmail or email " +
    "(e.g. 'triage my Gmail', 'summarize my unread emails', 'search for emails from Sarah', " +
    "'draft a reply to the latest email from finance', 'send the email'). " +
    "Subactions: Gmail-specific triage, recommended actions, true unresponded threads, search by sender/subject/keyword/date/label, " +
    "read message bodies by Gmail ID, draft reply, send reply, and Gmail management. " +
    "DO NOT use for a cross-channel inbox digest / inbox-only daily digest / triage across " +
    "Slack / Discord / SMS / Telegram — route owner inbox work to OWNER_INBOX and the agent's " +
    "own mailbox to AGENT_INBOX. If the user says 'my inbox' without specifying Gmail (e.g. " +
    "'give me my inbox digest', 'triage my inbox'), do not route straight to " +
    "GMAIL_ACTION. GMAIL_ACTION is only correct once the mailbox surface is already narrowed to Gmail under OWNER_INBOX, " +
    "or when the request is about a specific email by sender/subject/body. " +
    "Do NOT use for morning briefs, night briefs, or broad day-start/day-end reviews that happen to mention email. " +
    "DO NOT use for venting ('I hate email') unless the user asks for a concrete Gmail operation. " +
    "DO NOT use for calendar, meetings, scheduling, habits, goals, routines, or reminders. " +
    "Provides the final grounded reply; do not pair with a speculative REPLY.",
  descriptionCompressed:
    "Gmail execution layer under OWNER_INBOX or AGENT_INBOX: triage, recommendations, unresponded threads, search, read, manage, and draft/send replies.",
  suppressPostActionContinuation: true,
  validate: async (runtime, message, state) => {
    if (!(await hasLifeOpsAccess(runtime, message))) return false;
    return hasContextSignalForKey(runtime, message, state, "gmail", {
      contextLimit: GMAIL_CONTEXT_WINDOW,
    });
  },
  handler: async (
    runtime,
    message,
    state,
    options,
    callback?: HandlerCallback,
  ) => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      const fallback =
        "Gmail actions are restricted to the owner, explicitly granted users, and the agent.";
      return {
        success: false,
        text: await renderGmailActionReply({
          runtime,
          message,
          state,
          intent: messageText(message).trim(),
          scenario: "access_denied",
          fallback,
        }),
      };
    }

    const rawParams = (options as HandlerOptions | undefined)?.parameters as
      | GmailActionParams
      | undefined;
    const params = rawParams ?? ({} as GmailActionParams);
    const details = normalizeGmailDetails(params.details);
    const explicitSubaction = normalizeGmailSubaction(params.subaction);
    const intent =
      normalizePlannerString(params.intent) ?? messageText(message).trim();
    const activeComposeDraft = latestGmailComposeDraft(state, [
      "pending_clarification",
    ]);
    const previousSentComposeDraft = latestGmailComposeDraft(state, ["sent"]);
    const llmPlan = await extractGmailPlanWithLlm(
      runtime,
      message,
      state,
      intent,
      activeComposeDraft,
    );
    const pendingReplyApproval = await readPendingGmailReplyApproval(
      runtime,
      message.roomId,
    );
    const latestReplyDraft = latestGmailReplyDraftContext(state);
    const latestMessageTarget = latestGmailMessageTargetContext(state);
    const latestBatchReplyDraftItems = latestGmailBatchReplyDraftItems(state);
    const sendConfirmed =
      normalizeOptionalBoolean(params.confirmed) ??
      detailBoolean(details, "confirmSend") ??
      llmPlan.confirmed ??
      false;
    const holdReplyForApproval =
      detailBoolean(details, "holdForApproval") ??
      (detailBoolean(details, "confirmSend") === false ? true : undefined) ??
      llmPlan.holdForApproval ??
      false;
    const hasStructuredComposeSignal = Boolean(
      params.bodyText ||
        detailString(details, "bodyText") ||
        detailString(details, "subject") ||
        (normalizeStringArray(details?.to)?.length ?? 0) > 0 ||
        (normalizeStringArray(details?.cc)?.length ?? 0) > 0 ||
        (normalizeStringArray(details?.bcc)?.length ?? 0) > 0 ||
        (llmPlan.to?.length ?? 0) > 0 ||
        (llmPlan.cc?.length ?? 0) > 0 ||
        (llmPlan.bcc?.length ?? 0) > 0 ||
        Boolean(llmPlan.subject) ||
        Boolean(llmPlan.bodyText),
    );
    const hasReplyOrBatchTarget = Boolean(
      params.messageId ||
        detailString(details, "messageId") ||
        detailArray(details, "items") ||
        (normalizeStringArray(details?.messageIds)?.length ?? 0) > 0,
    );
    const shouldAttemptComposeRecovery =
      !hasReplyOrBatchTarget &&
      (Boolean(activeComposeDraft || previousSentComposeDraft) ||
        llmPlan.subaction === "send_message" ||
        llmPlan.subaction === null ||
        explicitSubaction === "send_message" ||
        hasStructuredComposeSignal);
    const composeRecoveryPlan = shouldAttemptComposeRecovery
      ? await recoverSendMessagePlanWithLlm({
          runtime,
          message,
          state,
          intent,
          currentPlan: llmPlan,
          activeDraft: activeComposeDraft,
          previousSentDraft: previousSentComposeDraft,
        })
      : null;
    const composeRecoveryActivated = composeRecoveryPlan?.shouldResume === true;
    const resolvedComposeDraft = mergeComposeDrafts(
      previousSentComposeDraft ?? undefined,
      activeComposeDraft ?? undefined,
      {
        subaction: "send_message",
        status: "pending_clarification",
        intent,
        to: llmPlan.to,
        cc: llmPlan.cc,
        bcc: llmPlan.bcc,
        subject: llmPlan.subject,
        bodyText: llmPlan.bodyText,
      },
      composeRecoveryPlan ?? undefined,
    );
    const explicitQueryArray = [
      ...(params.queries ?? []),
      ...(normalizeQueryStringArray(details?.queries) ?? []),
    ];
    const hasExplicitGmailExecutionInput = Boolean(
      explicitSubaction ||
        params.query ||
        explicitQueryArray.length > 0 ||
        params.messageId ||
        (params.messageIds?.length ?? 0) > 0 ||
        params.operation ||
        detailString(details, "messageId") ||
        detailString(details, "operation") ||
        (normalizeStringArray(details?.messageIds)?.length ?? 0) > 0 ||
        params.bodyText ||
        detailString(details, "bodyText") ||
        (normalizeStringArray(details?.to)?.length ?? 0) > 0 ||
        (normalizeStringArray(details?.cc)?.length ?? 0) > 0 ||
        (normalizeStringArray(details?.bcc)?.length ?? 0) > 0 ||
        detailString(details, "subject"),
    );
    let subaction: GmailSubaction | null =
      explicitSubaction ?? llmPlan.subaction;
    const composeRecipients =
      normalizeStringArray(details?.to) ??
      resolvedComposeDraft.to ??
      llmPlan.to ??
      [];
    const hasComposeRecipients = composeRecipients.length > 0;
    const hasComposeContent = Boolean(
      params.bodyText ||
        detailString(details, "bodyText") ||
        resolvedComposeDraft.bodyText ||
        llmPlan.bodyText ||
        detailString(details, "subject") ||
        resolvedComposeDraft.subject ||
        llmPlan.subject,
    );
    if (!explicitSubaction && composeRecoveryActivated) {
      subaction = "send_message";
    }
    if (
      !subaction &&
      !params.messageId &&
      !detailString(details, "messageId") &&
      !detailArray(details, "items") &&
      (hasComposeRecipients || hasStructuredComposeSignal) &&
      hasComposeContent
    ) {
      subaction = "send_message";
    }
    runtime.logger?.debug?.(
      {
        src: "action:gmail",
        subaction,
        rawMessage: messageText(message).slice(0, 200),
        resolvedIntent: intent.slice(0, 200),
        params: {
          subaction: params.subaction,
          query: params.query,
          messageId: params.messageId,
          bodyText: params.bodyText?.slice(0, 100),
        },
        detailKeys: details ? Object.keys(details) : [],
        detailToType: typeof details?.to,
        detailSubject:
          typeof details?.subject === "string" ? details.subject : undefined,
        sendConfirmed,
        holdReplyForApproval,
      },
      "gmail action dispatch",
    );
    const service = new LifeOpsService(runtime);
    const respond = async <
      T extends NonNullable<ActionResult["data"]> | undefined,
    >(payload: {
      success: boolean;
      text: string;
      data?: T;
    }) => {
      const data = attachGmailWorkflowPlanData({
        data: payload.data,
        plan: llmPlan,
        executedSubaction: subaction,
        success: payload.success,
      });
      await callback?.({
        text: payload.text,
        source: "action",
        action: ACTION_NAME,
      });
      return {
        ...payload,
        ...(data ? { data } : {}),
      };
    };
    const renderReply = (
      scenario: string,
      fallback: string,
      context?: Record<string, unknown>,
    ) =>
      renderGmailActionReply({
        runtime,
        message,
        state,
        intent,
        scenario,
        fallback,
        context,
      });

    if (composeRecoveryPlan?.cancelled) {
      return respond({
        success: true,
        text: await renderReply(
          "cancel_send_message",
          composeRecoveryPlan.response ?? "Okay, I won't send that email.",
          {
            composeRecoveryPlan,
            activeComposeDraft,
          },
        ),
        data: {
          noop: true,
        },
      });
    }

    if (
      !subaction &&
      !composeRecoveryActivated &&
      !hasExplicitGmailExecutionInput
    ) {
      const fallback =
        composeRecoveryPlan?.response ??
        llmPlan.response ??
        buildGmailReplyOnlyFallback(llmPlan.subaction);
      return respond({
        success: true,
        text: await renderReply("reply_only", fallback, {
          llmPlan,
          composeRecoveryPlan,
          suggestedSubaction: llmPlan.subaction,
        }),
        data: {
          noop: true,
          ...(llmPlan.subaction
            ? { suggestedSubaction: llmPlan.subaction }
            : {}),
        },
      });
    }

    if (!subaction) {
      const fallback =
        llmPlan.response ??
        composeRecoveryPlan?.response ??
        buildGmailReplyOnlyFallback(llmPlan.subaction);
      return respond({
        success: false,
        text: await renderReply("clarify_gmail_request", fallback, {
          llmPlan,
          composeRecoveryPlan,
        }),
        data: {
          noop: true,
        },
      });
    }

    try {
      const google = await getGoogleCapabilityStatus(service);

      if (
        subaction === "send_reply" ||
        subaction === "send_batch_replies" ||
        subaction === "send_message"
      ) {
        if (!google.hasGmailSend) {
          return respond({
            success: false,
            text: await renderReply(
              "gmail_send_unavailable",
              gmailSendUnavailableMessage(google),
              {
                subaction,
                google,
              },
            ),
          });
        }
      } else if (subaction === "manage") {
        if (!google.hasGmailManage) {
          return respond({
            success: false,
            text: await renderReply(
              "gmail_manage_unavailable",
              "Gmail manage access is not connected. Reconnect Google in LifeOps settings and grant Gmail manage access.",
              {
                subaction,
                google,
              },
            ),
          });
        }
      } else if (!google.hasGmailTriage) {
        return respond({
          success: false,
          text: await renderReply(
            "gmail_read_unavailable",
            gmailReadUnavailableMessage(google),
            {
              subaction,
              google,
            },
          ),
        });
      }

      if (subaction === "triage") {
        const feed = await service.getGmailTriage(INTERNAL_URL, {
          mode: detailString(details, "mode") as
            | "local"
            | "remote"
            | "cloud_managed"
            | undefined,
          side: detailString(details, "side") as "owner" | "agent" | undefined,
          grantId: detailString(details, "grantId"),
          forceSync: detailBoolean(details, "forceSync"),
          maxResults: detailNumber(details, "maxResults") ?? 10,
        });
        const fallback = formatEmailTriage(feed);
        return respond({
          success: true,
          text: await renderReply("triage_results", fallback, {
            summary: feed.summary,
            messages: feed.messages,
          }),
          data: toActionData(feed),
        });
      }

      if (subaction === "needs_response") {
        const feed = await service.getGmailNeedsResponse(INTERNAL_URL, {
          mode: detailString(details, "mode") as
            | "local"
            | "remote"
            | "cloud_managed"
            | undefined,
          side: detailString(details, "side") as "owner" | "agent" | undefined,
          grantId: detailString(details, "grantId"),
          forceSync: detailBoolean(details, "forceSync"),
          maxResults: detailNumber(details, "maxResults") ?? 10,
        });
        const fallback = formatEmailNeedsResponse(feed);
        return respond({
          success: true,
          text: await renderReply("needs_response_results", fallback, {
            summary: feed.summary,
            messages: feed.messages,
          }),
          data: toActionData(feed),
        });
      }

      if (subaction === "recommend") {
        const resolvedQueries = resolveGmailSearchQueries(
          [...explicitQueryArray, params.query, detailString(details, "query")],
          llmPlan,
        );
        const feed = await service.getGmailRecommendations(INTERNAL_URL, {
          mode: detailString(details, "mode") as
            | "local"
            | "remote"
            | "cloud_managed"
            | undefined,
          side: detailString(details, "side") as "owner" | "agent" | undefined,
          grantId: detailString(details, "grantId"),
          forceSync: detailBoolean(details, "forceSync"),
          maxResults: detailNumber(details, "maxResults") ?? 20,
          query: resolvedQueries[0],
          replyNeededOnly:
            detailBoolean(details, "replyNeededOnly") ??
            llmPlan.replyNeededOnly,
          includeSpamTrash: detailBoolean(details, "includeSpamTrash"),
        });
        const fallback = formatGmailRecommendations(feed);
        return respond({
          success: true,
          text: await renderReply("recommendations_results", fallback, {
            summary: feed.summary,
            recommendations: feed.recommendations,
          }),
          data: toActionData(feed),
        });
      }

      if (subaction === "unresponded") {
        const feed = await service.getGmailUnresponded(INTERNAL_URL, {
          mode: detailString(details, "mode") as
            | "local"
            | "remote"
            | "cloud_managed"
            | undefined,
          side: detailString(details, "side") as "owner" | "agent" | undefined,
          grantId: detailString(details, "grantId"),
          maxResults: detailNumber(details, "maxResults") ?? 10,
          olderThanDays:
            detailNumber(details, "olderThanDays") ?? llmPlan.olderThanDays,
        });
        const fallback =
          feed.threads.length === 0
            ? "No unresponded Gmail threads matched that window."
            : feed.threads
                .slice(0, 5)
                .map(
                  (thread, index) =>
                    `${index + 1}. ${thread.subject} (${thread.daysWaiting}d waiting)`,
                )
                .join("\n");
        return respond({
          success: true,
          text: await renderReply("unresponded_results", fallback, {
            summary: feed.summary,
            threads: feed.threads,
          }),
          data: toActionData(feed),
        });
      }

      if (subaction === "search") {
        const resolvedQueries = resolveGmailSearchQueries(
          [...explicitQueryArray, params.query, detailString(details, "query")],
          llmPlan,
        );
        const searchPlan = buildGmailSearchPlan({
          queries: resolvedQueries,
        });
        if (!searchPlan) {
          return respond({
            success: false,
            text: await renderReply(
              "clarify_search_target",
              "I need a sender, subject, keyword, or email search target to run that Gmail search.",
              {
                missing: ["search target"],
              },
            ),
          });
        }
        const requestBase = {
          mode: detailString(details, "mode") as
            | "local"
            | "remote"
            | "cloud_managed"
            | undefined,
          side: detailString(details, "side") as "owner" | "agent" | undefined,
          grantId: detailString(details, "grantId"),
          forceSync: detailBoolean(details, "forceSync"),
          maxResults: detailNumber(details, "maxResults") ?? 10,
          replyNeededOnly:
            detailBoolean(details, "replyNeededOnly") ??
            llmPlan.replyNeededOnly ??
            false,
        };
        let feed = await service.getGmailSearch(INTERNAL_URL, {
          ...requestBase,
          query: searchPlan.queries[0] ?? searchPlan.displayQuery,
        });
        for (const query of searchPlan.queries.slice(1)) {
          if (feed.messages.length > 0) {
            break;
          }
          feed = await service.getGmailSearch(INTERNAL_URL, {
            ...requestBase,
            query,
          });
        }
        const displayFeed =
          feed.query === searchPlan.displayQuery
            ? feed
            : {
                ...feed,
                query: searchPlan.displayQuery,
              };
        const fallback = formatEmailSearch(displayFeed);
        return respond({
          success: true,
          text: await renderReply("search_results", fallback, {
            query: displayFeed.query,
            messages: displayFeed.messages,
          }),
          data: toActionData(displayFeed),
        });
      }

      if (subaction === "read") {
        const messageId =
          params.messageId ??
          detailString(details, "messageId") ??
          llmPlan.messageId ??
          latestMessageTarget?.messageId ??
          latestReplyDraft?.messageId;
        if (messageId) {
          const result = await service.readGmailMessage(INTERNAL_URL, {
            mode: detailString(details, "mode") as
              | "local"
              | "remote"
              | "cloud_managed"
              | undefined,
            side: detailString(details, "side") as
              | "owner"
              | "agent"
              | undefined,
            grantId: detailString(details, "grantId"),
            forceSync: detailBoolean(details, "forceSync"),
            messageId,
          });
          const fallback = formatEmailRead(result);
          return respond({
            success: true,
            text: await renderReply("read_result", fallback, {
              message: result,
            }),
            data: toActionData(result),
          });
        }

        const resolvedTarget = await resolveGmailTargetMessage({
          service,
          details,
          explicitQueryArray,
          paramsQuery: params.query,
          llmPlan,
        });
        if (resolvedTarget.kind === "missing") {
          return respond({
            success: false,
            text: await renderReply(
              "clarify_read_target",
              "I need to know which email to read. Give me a sender, subject, keyword, or specific message id.",
              {
                missing: ["message target"],
              },
            ),
          });
        }
        if (resolvedTarget.kind === "ambiguous") {
          const fallback = buildGmailTargetDisambiguationFallback(
            resolvedTarget.feed,
          );
          return respond({
            success: false,
            text: await renderReply("clarify_read_target", fallback, {
              query: resolvedTarget.displayQuery,
              messages: resolvedTarget.feed.messages,
            }),
          });
        }
        const result = await service.readGmailMessage(INTERNAL_URL, {
          mode: detailString(details, "mode") as
            | "local"
            | "remote"
            | "cloud_managed"
            | undefined,
          side: detailString(details, "side") as "owner" | "agent" | undefined,
          grantId: detailString(details, "grantId"),
          forceSync: detailBoolean(details, "forceSync"),
          messageId: resolvedTarget.target.messageId,
        });
        const displayResult = {
          ...result,
          query: resolvedTarget.target.query ?? result.query,
        };
        const fallback = formatEmailRead(displayResult);
        return respond({
          success: true,
          text: await renderReply("read_result", fallback, {
            message: displayResult,
          }),
          data: toActionData(displayResult),
        });
      }

      if (subaction === "draft_reply") {
        let messageId =
          params.messageId ??
          detailString(details, "messageId") ??
          llmPlan.messageId ??
          latestMessageTarget?.messageId ??
          latestReplyDraft?.messageId;
        if (!messageId) {
          const resolvedTarget = await resolveGmailTargetMessage({
            service,
            details,
            explicitQueryArray,
            paramsQuery: params.query,
            llmPlan,
          });
          if (resolvedTarget.kind === "ambiguous") {
            const fallback = buildGmailTargetDisambiguationFallback(
              resolvedTarget.feed,
            );
            return respond({
              success: false,
              text: await renderReply("clarify_draft_reply_target", fallback, {
                query: resolvedTarget.displayQuery,
                messages: resolvedTarget.feed.messages,
              }),
            });
          }
          messageId =
            resolvedTarget.kind === "resolved"
              ? resolvedTarget.target.messageId
              : undefined;
          if (!messageId) {
            return respond({
              success: false,
              text: await renderReply(
                "clarify_draft_reply_target",
                "Which email do you want me to draft a reply for?",
                {
                  missing: ["message target"],
                  latestMessageTarget,
                  latestReplyDraft,
                },
              ),
            });
          }
        }
        const draftGenerationContext = await buildGmailDraftGenerationContext({
          runtime,
          message,
          state,
        });
        const draft = await service.createGmailReplyDraft(INTERNAL_URL, {
          mode: detailString(details, "mode") as
            | "local"
            | "remote"
            | "cloud_managed"
            | undefined,
          side: detailString(details, "side") as "owner" | "agent" | undefined,
          grantId: detailString(details, "grantId"),
          messageId,
          tone: detailString(details, "tone") as
            | "brief"
            | "neutral"
            | "warm"
            | undefined,
          intent:
            detailString(details, "draftIntent") ??
            detailString(details, "intent") ??
            intent,
          includeQuotedOriginal: detailBoolean(
            details,
            "includeQuotedOriginal",
          ),
          ...draftGenerationContext,
        } satisfies CreateLifeOpsGmailReplyDraftRequest);
        const fallback = formatGmailReplyDraft(draft);
        if (holdReplyForApproval) {
          if (pendingReplyApproval?.approvalTaskId) {
            await runtime.deleteTask(
              pendingReplyApproval.approvalTaskId as never,
            );
          }
          const approvalTaskId = await enqueueGmailReplyApprovalRequest({
            runtime,
            message,
            draft,
          });
          await writePendingGmailReplyApproval(runtime, message.roomId, {
            messageId: draft.messageId,
            bodyText: draft.bodyText,
            subject: draft.subject,
            to: draft.to,
            cc: draft.cc,
            approvalTaskId,
            createdAt: new Date().toISOString(),
          });
          return respond({
            success: true,
            text: await renderReply(
              "draft_reply",
              `${fallback}\n\nI'll hold this Gmail reply until you approve sending it.`,
              {
                draft,
                approvalRequired: true,
              },
            ),
            data: toActionData({
              ...draft,
              gmailDraft: draft,
              pendingApproval: true,
            }),
          });
        }
        if (pendingReplyApproval?.approvalTaskId) {
          await runtime.deleteTask(
            pendingReplyApproval.approvalTaskId as never,
          );
          await clearPendingGmailReplyApproval(runtime, message.roomId);
        }
        return respond({
          success: true,
          text: await renderReply("draft_reply", fallback, {
            draft,
          }),
          data: toActionData({
            ...draft,
            gmailDraft: draft,
            gmailMessage: {
              messageId: draft.messageId,
              subject: draft.subject,
              query: latestMessageTarget?.query,
            },
          }),
        });
      }

      if (subaction === "draft_batch_replies") {
        const batchSearchQueries =
          (normalizeStringArray(details?.messageIds)?.length ?? 0)
            ? []
            : resolveGmailSearchQueries(
                [
                  ...explicitQueryArray,
                  params.query,
                  detailString(details, "query"),
                ],
                llmPlan,
              );
        const draftGenerationContext = await buildGmailDraftGenerationContext({
          runtime,
          message,
          state,
        });
        const request: CreateLifeOpsGmailBatchReplyDraftsRequest = {
          mode: detailString(details, "mode") as
            | "local"
            | "remote"
            | "cloud_managed"
            | undefined,
          side: detailString(details, "side") as "owner" | "agent" | undefined,
          grantId: detailString(details, "grantId"),
          forceSync: detailBoolean(details, "forceSync"),
          maxResults: detailNumber(details, "maxResults") ?? 10,
          query: batchSearchQueries[0],
          messageIds: normalizeStringArray(details?.messageIds),
          tone: detailString(details, "tone") as
            | "brief"
            | "neutral"
            | "warm"
            | undefined,
          intent:
            detailString(details, "draftIntent") ??
            detailString(details, "intent") ??
            intent,
          includeQuotedOriginal: detailBoolean(
            details,
            "includeQuotedOriginal",
          ),
          replyNeededOnly:
            detailBoolean(details, "replyNeededOnly") ??
            llmPlan.replyNeededOnly ??
            false,
          ...draftGenerationContext,
        };
        const batch = await service.createGmailBatchReplyDrafts(
          INTERNAL_URL,
          request,
        );
        const fallback = formatGmailBatchReplyDrafts(batch);
        return respond({
          success: true,
          text: await renderReply("draft_batch_replies", fallback, {
            batch,
          }),
          data: toActionData(batch),
        });
      }

      if (subaction === "manage") {
        const operation =
          params.operation ??
          normalizePlannerGmailOperation(detailString(details, "operation")) ??
          llmPlan.operation;
        const messageIds =
          params.messageIds ??
          normalizeStringArray(details?.messageIds) ??
          llmPlan.messageIds ??
          [
            detailString(details, "messageId") ??
              llmPlan.messageId ??
              latestMessageTarget?.messageId,
          ].filter((value): value is string => Boolean(value));
        const query =
          detailString(details, "query") ??
          params.query ??
          llmPlan.queries[0] ??
          latestMessageTarget?.query;
        if (!operation) {
          return respond({
            success: false,
            text: await renderReply(
              "clarify_manage_operation",
              "Which Gmail operation should I run: archive, trash, spam, mark read, mark unread, apply label, or remove label?",
              {
                missing: ["operation"],
              },
            ),
          });
        }
        if (messageIds.length === 0 && !query) {
          return respond({
            success: false,
            text: await renderReply(
              "clarify_manage_target",
              "Which Gmail messages should I update?",
              {
                missing: ["message target"],
                latestMessageTarget,
              },
            ),
          });
        }
        const destructive =
          operation === "trash" ||
          operation === "delete" ||
          operation === "report_spam";
        const confirmDestructive =
          detailBoolean(details, "confirmDestructive") ??
          llmPlan.confirmDestructive ??
          false;
        if (destructive && !confirmDestructive) {
          return respond({
            success: false,
            text: await renderReply(
              "confirm_manage_destructive",
              `Confirm before I ${operation.replace("_", " ")} Gmail messages.`,
              {
                operation,
                messageIds,
                query,
              },
            ),
            data: {
              gmailManageRequest: {
                operation,
                messageIds,
                query,
                confirmDestructive: false,
              },
              noop: true,
            },
          });
        }
        const result = await service.manageGmailMessages(INTERNAL_URL, {
          mode: detailString(details, "mode") as
            | "local"
            | "remote"
            | "cloud_managed"
            | undefined,
          side: detailString(details, "side") as "owner" | "agent" | undefined,
          grantId: detailString(details, "grantId"),
          operation,
          messageIds: messageIds.length > 0 ? messageIds : undefined,
          query: messageIds.length === 0 ? query : undefined,
          maxResults: detailNumber(details, "maxResults") ?? 10,
          labelIds: normalizeStringArray(details?.labelIds) ?? llmPlan.labelIds,
          confirmDestructive,
        } satisfies ManageLifeOpsGmailMessagesRequest);
        const fallback = `Updated ${result.affectedCount} Gmail message${result.affectedCount === 1 ? "" : "s"}.`;
        return respond({
          success: true,
          text: await renderReply("managed_messages", fallback, {
            result,
          }),
          data: toActionData(result),
        });
      }

      if (subaction === "send_reply") {
        let messageId =
          params.messageId ??
          detailString(details, "messageId") ??
          llmPlan.messageId ??
          pendingReplyApproval?.messageId ??
          latestReplyDraft?.messageId ??
          latestMessageTarget?.messageId;
        if (!messageId) {
          const resolvedTarget = await resolveGmailTargetMessage({
            service,
            details,
            explicitQueryArray,
            paramsQuery: params.query,
            llmPlan,
          });
          if (resolvedTarget.kind === "ambiguous") {
            const fallback = buildGmailTargetDisambiguationFallback(
              resolvedTarget.feed,
            );
            return respond({
              success: false,
              text: await renderReply("clarify_send_reply", fallback, {
                query: resolvedTarget.displayQuery,
                messages: resolvedTarget.feed.messages,
              }),
            });
          }
          messageId =
            resolvedTarget.kind === "resolved"
              ? resolvedTarget.target.messageId
              : undefined;
        }
        const bodyText =
          params.bodyText ??
          detailString(details, "bodyText") ??
          pendingReplyApproval?.bodyText ??
          latestReplyDraft?.bodyText;
        if (pendingReplyApproval && !sendConfirmed) {
          return respond({
            success: true,
            text: await renderReply(
              "clarify_send_reply",
              "The Gmail reply draft is ready. Confirm when you want me to send it.",
              {
                latestReplyDraft: pendingReplyApproval,
              },
            ),
            data: toActionData({
              gmailDraft: {
                messageId: pendingReplyApproval.messageId,
                bodyText: pendingReplyApproval.bodyText,
                subject: pendingReplyApproval.subject,
                to: pendingReplyApproval.to,
                cc: pendingReplyApproval.cc,
              },
              pendingApproval: true,
            }),
          });
        }
        if (!messageId || !bodyText) {
          return respond({
            success: false,
            text: await renderReply(
              "clarify_send_reply",
              "I need both the email you're replying to and the reply text before I can send it.",
              {
                missing: [
                  ...(!messageId ? ["messageId"] : []),
                  ...(!bodyText ? ["bodyText"] : []),
                ],
                latestReplyDraft,
                latestMessageTarget,
              },
            ),
          });
        }
        if (!sendConfirmed) {
          return respond({
            success: false,
            text: await renderReply(
              "confirm_send_reply",
              "Confirm before I send this Gmail reply.",
              {
                messageId,
                bodyText,
                latestReplyDraft,
                latestMessageTarget,
              },
            ),
            data: {
              gmailDraft: {
                messageId,
                bodyText,
                subject:
                  detailString(details, "subject") ?? latestReplyDraft?.subject,
                to: normalizeStringArray(details?.to) ?? latestReplyDraft?.to,
                cc: normalizeStringArray(details?.cc) ?? latestReplyDraft?.cc,
              },
              requiresConfirmation: true,
              noop: true,
            },
          });
        }
        const result = await service.sendGmailReply(INTERNAL_URL, {
          mode: detailString(details, "mode") as
            | "local"
            | "remote"
            | "cloud_managed"
            | undefined,
          side: detailString(details, "side") as "owner" | "agent" | undefined,
          grantId: detailString(details, "grantId"),
          messageId,
          bodyText,
          subject:
            detailString(details, "subject") ??
            pendingReplyApproval?.subject ??
            latestReplyDraft?.subject,
          to:
            normalizeStringArray(details?.to) ??
            pendingReplyApproval?.to ??
            latestReplyDraft?.to,
          cc:
            normalizeStringArray(details?.cc) ??
            pendingReplyApproval?.cc ??
            latestReplyDraft?.cc,
          confirmSend: sendConfirmed,
        } satisfies SendLifeOpsGmailReplyRequest);
        if (pendingReplyApproval?.approvalTaskId) {
          await runtime.deleteTask(
            pendingReplyApproval.approvalTaskId as never,
          );
        }
        await clearPendingGmailReplyApproval(runtime, message.roomId);
        const fallback = "Gmail reply sent.";
        return respond({
          success: true,
          text: await renderReply("sent_reply", fallback, {
            result,
            messageId,
          }),
          data: toActionData(result),
        });
      }

      if (subaction === "send_message") {
        const to =
          normalizeStringArray(details?.to) ??
          resolvedComposeDraft.to ??
          llmPlan.to ??
          [];
        const cc = normalizeStringArray(details?.cc) ?? resolvedComposeDraft.cc;
        const bcc =
          normalizeStringArray(details?.bcc) ?? resolvedComposeDraft.bcc;
        const subject =
          detailString(details, "subject") ?? resolvedComposeDraft.subject;
        const bodyText =
          params.bodyText ??
          detailString(details, "bodyText") ??
          resolvedComposeDraft.bodyText;
        const composeDraft = buildGmailComposeDraft({
          status: "pending_clarification",
          intent,
          to,
          cc,
          bcc,
          subject,
          bodyText,
        });

        if (to.length === 0 || !subject || !bodyText) {
          const missing: string[] = [];
          if (to.length === 0) missing.push("recipient address");
          if (!subject) missing.push("subject");
          if (!bodyText) missing.push("body text");
          const fallback = `I need ${missing.join(", ")} to compose that email.`;
          return respond({
            success: false,
            text: await renderReply("clarify_send_message", fallback, {
              composeDraft,
              missing,
            }),
            data: {
              gmailDraft: composeDraft,
              missing,
              noop: true,
            },
          });
        }
        if (!sendConfirmed) {
          return respond({
            success: false,
            text: await renderReply(
              "confirm_send_message",
              `Draft ready for ${to.join(", ")}. Confirm before I send it.`,
              {
                to,
                cc,
                bcc,
                subject,
                bodyText,
              },
            ),
            data: {
              gmailDraft: composeDraft,
              requiresConfirmation: true,
              noop: true,
            },
          });
        }
        const result = await service.sendGmailMessage(INTERNAL_URL, {
          mode: detailString(details, "mode") as
            | "local"
            | "remote"
            | "cloud_managed"
            | undefined,
          side: detailString(details, "side") as "owner" | "agent" | undefined,
          grantId: detailString(details, "grantId"),
          to,
          cc,
          bcc,
          subject,
          bodyText,
          confirmSend: sendConfirmed,
        });
        const fallback = `sent to ${to.join(", ")}.`;
        return respond({
          success: true,
          text: await renderReply("sent_message", fallback, {
            result,
            to,
            subject,
          }),
          data: toActionData({
            ...result,
            gmailDraft: buildGmailComposeDraft({
              status: "sent",
              intent,
              to,
              cc,
              bcc,
              subject,
              bodyText,
            }),
          }),
        });
      }

      const items =
        normalizeBatchSendItems(details) ?? latestBatchReplyDraftItems;
      if (!items) {
        return respond({
          success: false,
          text: await renderReply(
            "clarify_send_batch_replies",
            "I need the list of replies to send, with each email and its reply text.",
            {
              missing: ["items"],
              latestBatchReplyDraftItems,
            },
          ),
        });
      }
      if (!sendConfirmed) {
        return respond({
          success: false,
          text: await renderReply(
            "confirm_send_batch_replies",
            `Confirm before I send ${items.length} Gmail repl${items.length === 1 ? "y" : "ies"}.`,
            {
              items,
            },
          ),
          data: {
            items,
            requiresConfirmation: true,
            noop: true,
          },
        });
      }
      const result = await service.sendGmailReplies(INTERNAL_URL, {
        mode: detailString(details, "mode") as
          | "local"
          | "remote"
          | "cloud_managed"
          | undefined,
        side: detailString(details, "side") as "owner" | "agent" | undefined,
        grantId: detailString(details, "grantId"),
        confirmSend: sendConfirmed,
        items,
      } satisfies SendLifeOpsGmailBatchReplyRequest);
      const fallback = `Sent ${result.sentCount} Gmail repl${result.sentCount === 1 ? "y" : "ies"}.`;
      return respond({
        success: true,
        text: await renderReply("sent_batch_replies", fallback, {
          result,
        }),
        data: toActionData(result),
      });
    } catch (error) {
      if (error instanceof LifeOpsServiceError) {
        const fallback = buildGmailServiceErrorFallback(error);
        return respond({
          success: false,
          text: await renderReply("service_error", fallback, {
            status: error.status,
            subaction,
          }),
        });
      }
      throw error;
    }
  },
  parameters: [
    {
      name: "subaction",
      description:
        "Gmail operation to run. Use triage, needs_response, recommend, search, read, draft_reply, draft_batch_replies, manage, send_reply, send_batch_replies, or send_message (compose a brand-new outbound email).",
      required: false,
      schema: {
        type: "string" as const,
        enum: [
          "triage",
          "needs_response",
          "recommend",
          "unresponded",
          "search",
          "read",
          "draft_reply",
          "draft_batch_replies",
          "manage",
          "send_reply",
          "send_batch_replies",
          "send_message",
        ],
      },
    },
    {
      name: "intent",
      description:
        'Natural language Gmail request. Examples: "what emails need a reply", "search email for investor", "read the latest email from suran", "draft a reply to message 123".',
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "query",
      description:
        "Search query for Gmail search or batch draft selection. Use Gmail-style query fragments when helpful, such as from:suran, is:unread, newer_than:21d, subject:venue.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "queries",
      description:
        "Optional array of Gmail search queries to try in order when the planner has multiple good variants.",
      required: false,
      schema: { type: "array" as const, items: { type: "string" as const } },
    },
    {
      name: "messageId",
      description:
        "Single Gmail message id for read, draft_reply, or send_reply operations.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "bodyText",
      description: "Reply body for send_reply.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "confirmed",
      description:
        "Set true only when the owner is explicitly approving a pending Gmail send right now.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "details",
      description:
        "Structured Gmail arguments. Supported keys include mode, side, grantId, forceSync, maxResults, query, queries, replyNeededOnly, olderThanDays, operation, labelIds, confirmDestructive, tone, includeQuotedOriginal, messageId, messageIds, draftIntent, subject, to, cc, bodyText, confirmSend, holdForApproval, and items for batch send.",
      required: false,
      schema: { type: "object" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Triage my Gmail inbox." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Inbox triage: 6 unread, 2 important, 3 likely needing a reply.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Summarize my unread emails." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Unread emails: 6. Top items: investor follow-up from Jane Doe, contract update from Legal.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Do I have any emails I need to reply to?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Emails that likely need a reply: 3.\n- **Investor follow-up** from Jane Doe · 2h ago",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Search my email for OneBlade receipts." },
      },
      {
        name: "{{agentName}}",
        content: { text: 'Found 2 emails for "OneBlade receipts".' },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Read the latest email from Suran." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "**Suran follow-up** from Suran Lee · 2d ago\n\nWanted to follow up on the last few weeks.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Draft a reply to the latest email from Sarah saying I'll review it tomorrow.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Drafted reply to Sarah saying you will review it tomorrow.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Draft a reply to message abc123 thanking them and saying next week works.",
        },
      },
      {
        name: "{{agentName}}",
        content: { text: "Drafted reply for **Re: Scheduling**." },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Send a reply to the last email from finance confirming receipt.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Sent the confirmed reply to the latest email from finance.",
        },
      },
    ],
  ] as ActionExample[][],
};

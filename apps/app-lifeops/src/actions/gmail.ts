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
import type {
  CreateLifeOpsGmailBatchReplyDraftsRequest,
  CreateLifeOpsGmailReplyDraftRequest,
  LifeOpsGmailBatchReplySendItem,
  SendLifeOpsGmailBatchReplyRequest,
  SendLifeOpsGmailReplyRequest,
} from "@elizaos/shared/contracts/lifeops";
import { resolveDefaultTimeZone } from "../lifeops/defaults.js";
import { LifeOpsService, LifeOpsServiceError } from "../lifeops/service.js";
import { hasContextSignalForKey } from "@elizaos/agent/actions/context-signal";
import {
  extractActionResultsFromState,
  extractRecentMessageEntriesFromState,
  extractStateDataRecords,
  renderGroundedActionReply,
  summarizeActiveTrajectory,
  summarizeRecentActionHistory,
} from "@elizaos/agent/actions/grounded-action-reply";
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
  formatGmailReplyDraft,
  getGoogleCapabilityStatus,
  gmailReadUnavailableMessage,
  gmailSendUnavailableMessage,
  hasLifeOpsAccess,
  INTERNAL_URL,
  messageText,
  toActionData,
} from "./lifeops-google-helpers.js";
import { looksLikeEmailVenting } from "./non-actionable-request.js";

type GmailSubaction =
  | "triage"
  | "needs_response"
  | "search"
  | "read"
  | "draft_reply"
  | "draft_batch_replies"
  | "send_reply"
  | "send_batch_replies"
  | "send_message";

export type GmailLlmPlan = {
  subaction: GmailSubaction | null;
  queries: string[];
  messageId?: string;
  replyNeededOnly?: boolean;
  response?: string;
  shouldAct?: boolean | null;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  bodyText?: string;
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
  bodyText?: string;
  details?: Record<string, unknown>;
};

const GMAIL_CONTEXT_WINDOW = 12;
const GMAIL_DETAIL_ALIASES = {
  forceSync: ["forcesync", "force_sync"],
  maxResults: ["maxresults", "max_results"],
  replyNeededOnly: ["replyneededonly", "reply_needed_only"],
  messageIds: ["messageids", "message_ids"],
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

function normalizeGmailSubaction(value: unknown): GmailSubaction | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "triage":
    case "needs_response":
    case "search":
    case "read":
    case "draft_reply":
    case "draft_batch_replies":
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
    default:
      return "What do you want to do in Gmail — check inbox, search, read, or draft a reply?";
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

function gmailComposeDraftFromMessageEntry(
  entry: Record<string, unknown>,
): GmailComposeDraft | null {
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

export async function extractGmailPlanWithLlm(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  intent: string,
  activeComposeDraft?: GmailComposeDraft | null,
): Promise<GmailLlmPlan> {
  const recentConversation = (
    await collectGmailConversationContext({ runtime, message, state })
  ).join("\n");
  const latestReplyDraft = latestGmailReplyDraftContext(state);
  const latestMessageTarget = latestGmailMessageTargetContext(state);
  const currentMessage = messageText(message).trim();
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
  const prompt = [
    "Plan the Gmail action for this request.",
    "The user may speak in any language.",
    "Use the current request plus recent conversation context.",
    "If the current request is vague or a follow-up, recover the subject from recent conversation and apply the new constraint from the current request.",
    "You are allowed to decide that the assistant should reply naturally without acting yet.",
    "Set shouldAct=false when the user is vague, only acknowledging, brainstorming, or asking for email help without enough specifics to safely act.",
    "When shouldAct=false, provide a short natural response that asks only for what is missing.",
    "When shouldAct=false, write that response in the user's language unless they clearly asked to switch languages.",
    "For clear reply-workflow commands like 'draft a reply to John's email' or 'send that reply now', still choose the intent-level subaction even if the exact Gmail message id is not known yet. Downstream Gmail logic can clarify the target email.",
    "",
    "Return a JSON object with exactly these fields:",
    "  subaction: one of the allowed subactions below, or null when this should be reply-only/no-op",
    "  shouldAct: boolean",
    "  response: short natural-language reply when shouldAct is false, otherwise empty or null",
    "  queries: array or ||-delimited string of up to 3 Gmail search queries",
    "  messageId: optional Gmail message id",
    "  replyNeededOnly: optional boolean",
    "  to: optional array of recipient email addresses when subaction is send_message",
    "  cc: optional array of cc email addresses when subaction is send_message",
    "  bcc: optional array of bcc email addresses when subaction is send_message",
    "  subject: optional subject line when subaction is send_message",
    "  bodyText: optional email body when subaction is send_message",
    "",
    "Subactions and when to use each:",
    "  triage — general inbox overview, unread count, email summary (e.g. 'check my inbox', 'any new emails')",
    "  needs_response — specifically about emails that need a reply (e.g. 'which emails need a response', 'any reply-needed emails')",
    "  search — find emails by sender, subject, keyword, date, label (e.g. 'emails from John', 'who emailed me today', 'find the invoice email')",
    "  read — read a specific email body by message ID (e.g. 'read that email', 'show me the full message')",
    "  draft_reply — compose a reply to a specific email (e.g. 'draft a reply to John', 'write a response to that email')",
    "  draft_batch_replies — compose replies to multiple emails at once (e.g. 'draft replies to all of those', 'respond to each one')",
    "  send_reply — send a confirmed reply to an email (e.g. 'send that reply', 'email them back now')",
    "  send_batch_replies — send confirmed replies to multiple emails (e.g. 'send all those replies')",
    "  send_message — compose and send a brand-new outbound email (e.g. 'send an email to zo@iqlabs.dev, subject hello, body how are you doing today?')",
    "",
    "For search or read, extract up to 3 short Gmail-compatible queries using Gmail search operators.",
    "For draft_reply, send_reply, and draft_batch_replies, also extract Gmail-compatible queries whenever the target email is described by sender, subject, keyword, or timeframe but no explicit Gmail message id is known.",
    "Return Gmail operators in Gmail syntax even if the user speaks another language, and preserve names, addresses, and subject keywords in their original language or script when useful.",
    "For send_message, preserve the exact recipient addresses and keep the user's intended subject/body wording as close as possible.",
    "When the user writes in another language, still infer the correct Gmail action and keep extracted subject/body wording in that language unless the user asked to translate.",
    "",
    "Gmail search operators — complete reference:",
    "  Sender/recipient: from:name  to:name  cc:name  bcc:name  deliveredto:alias@example.com",
    '  Content: subject:word  "exact phrase"  has:attachment  filename:report.pdf  has:drive  has:document  has:spreadsheet  has:presentation  has:youtube',
    "  Status: is:unread  is:read  is:starred  is:important  is:snoozed",
    "  Location: in:inbox  in:sent  in:draft  in:trash  in:spam  in:anywhere  label:work  category:primary  category:social  category:promotions  category:updates  category:forums",
    "  Date/time: newer_than:7d  older_than:30d  after:2025/01/01  before:2025/12/31",
    "  Size: size:5m  larger:10m  smaller:1m  larger_than:500k  smaller_than:2m",
    "  Special: from:me  list:info@mailinglist.com",
    "  Negation: -from:name  -subject:word  -label:work  -is:unread  (prefix any operator with - to exclude)",
    "  Boolean: {term1 term2} for OR.  Combine operators: from:suran is:unread newer_than:21d",
    "  Proximity: AROUND (not widely supported but available)",
    "",
    "Preserve sender names, email addresses, subject keywords, unread/starred/important status, attachment mentions, and time windows.",
    "Use the current local datetime to convert relative time references like today, yesterday, this week, and this month into Gmail-compatible operators.",
    "Set replyNeededOnly to true only when the request is specifically about emails that need a reply.",
    "",
    "Examples:",
    '  "who emailed me today" → {"subaction":"search","shouldAct":true,"response":null,"queries":["newer_than:1d"]}',
    '  "did suran email me" → {"subaction":"search","shouldAct":true,"response":null,"queries":["from:suran"]}',
    '  "draft a reply to John" → {"subaction":"draft_reply","shouldAct":true,"response":null,"queries":["from:john"]}',
    '  "draft a reply to John\'s email" → {"subaction":"draft_reply","shouldAct":true,"response":null,"queries":["from:john"]}',
    '  "what about unread ones?" with recent context about a Suran email search → {"subaction":"search","shouldAct":true,"response":null,"queries":["from:suran is:unread"]}',
    '  "rewrite that reply to say I\'m in San Francisco, not NYC" with recent context about an existing Suran draft → {"subaction":"draft_reply","shouldAct":true,"response":null}',
    '  "send that reply now" with recent context about an existing drafted reply → {"subaction":"send_reply","shouldAct":true,"response":null}',
    '  "check my inbox" → {"subaction":"triage","shouldAct":true,"response":null}',
    '  "any emails from Sarah about the report" → {"subaction":"search","shouldAct":true,"response":null,"queries":["from:sarah subject:report"]}',
    '  "busca en mi correo si Suran me escribió hoy" → {"subaction":"search","shouldAct":true,"response":null,"queries":["from:suran newer_than:1d"]}',
    '  "envíale un correo a maria@example.com con asunto hola y cuerpo nos vemos mañana" → {"subaction":"send_message","shouldAct":true,"response":null,"queries":[],"to":["maria@example.com"],"subject":"hola","bodyText":"nos vemos mañana"}',
    '  "send an email to zo@iqlabs.dev, subject hello anon, body how are you doing today?" → {"subaction":"send_message","shouldAct":true,"response":null,"queries":[],"to":["zo@iqlabs.dev"],"subject":"hello anon","bodyText":"how are you doing today?"}',
    '  "can you help me with my email?" → {"subaction":null,"shouldAct":false,"response":"What do you want to do in Gmail — check inbox, search, read, or draft a reply?","queries":[]}',
    '  "send an email like \'test\'" with active draft having to=["shaw@gmail.com"] → {"subaction":"send_message","shouldAct":true,"response":null,"queries":[],"to":["shaw@gmail.com"],"subject":"test","bodyText":"test"}',
    ...(activeComposeDraft
      ? [
          "",
          "Active compose draft (fields already established in this conversation):",
          `  ${JSON.stringify({ to: activeComposeDraft.to, cc: activeComposeDraft.cc, bcc: activeComposeDraft.bcc, subject: activeComposeDraft.subject, bodyText: activeComposeDraft.bodyText })}`,
          "If the active compose draft already has a recipient, subject, or body, do NOT ask for those again.",
          "Set shouldAct=true and subaction=send_message when the user provides missing fields, confirms sending, or provides a short payload like 'test' to use as subject and body.",
          "Only set shouldAct=false when genuinely no information is available from conversation context or active draft.",
        ]
      : []),
    ...(latestReplyDraft || latestMessageTarget
      ? [
          "",
          "Recent reply-draft context:",
          `  ${JSON.stringify({
            latestReplyDraft,
            latestMessageTarget,
          })}`,
          "If there is a recent drafted reply or known target email and the user says rewrite, edit, revise, change, update, or 'send that reply', keep working on that same reply workflow even if they do not restate the sender or subject.",
        ]
      : []),
    "",
    "Return ONLY valid JSON. No prose. No markdown. No XML. No <think>.",
    "",
    `Current timezone: ${timeZone}`,
    `Current local datetime: ${localNow}`,
    `Current ISO datetime: ${nowIso}`,
    `Current request: ${JSON.stringify(currentMessage)}`,
    `Resolved intent: ${JSON.stringify(intent)}`,
    `Recent conversation: ${JSON.stringify(recentConversation)}`,
  ].join("\n");

  let rawResponse = "";
  try {
    const result = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
    });
    rawResponse = typeof result === "string" ? result : "";
  } catch (error) {
    runtime.logger?.warn?.(
      {
        src: "action:gmail",
        error: error instanceof Error ? error.message : String(error),
      },
      "Gmail action planning model call failed",
    );
    return {
      subaction: null,
      queries: [],
      shouldAct: null,
    };
  }

  const parsed =
    parseKeyValueXml<Record<string, unknown>>(rawResponse) ??
    parseJSONObjectFromText(rawResponse);
  if (!parsed) {
    return {
      subaction: null,
      queries: [],
      shouldAct: null,
    };
  }

  // Extract queries from multiple possible shapes:
  // - TOON string: "from:john || subject:report" (split on ||)
  // - TOON single: "from:john" (no delimiter)
  // - JSON array: ["from:john", "subject:report"]
  // - Numbered fallbacks: query1, query2, query3
  const rawQueries: Array<string | undefined> = [];
  if (typeof parsed.queries === "string" && parsed.queries.trim().length > 0) {
    // TOON path: split on || delimiter
    for (const q of parsed.queries.split(/\s*\|\|\s*/)) {
      if (q.trim().length > 0) rawQueries.push(q.trim());
    }
  } else if (Array.isArray(parsed.queries)) {
    // JSON path: array of strings
    for (const value of parsed.queries) {
      if (typeof value === "string") rawQueries.push(value);
    }
  }
  if (typeof parsed.query === "string") rawQueries.push(parsed.query);
  if (typeof parsed.query1 === "string") rawQueries.push(parsed.query1);
  if (typeof parsed.query2 === "string") rawQueries.push(parsed.query2);
  if (typeof parsed.query3 === "string") rawQueries.push(parsed.query3);

  return {
    subaction: normalizeGmailSubaction(parsed.subaction),
    queries: dedupeQueries(rawQueries),
    response: normalizePlannerResponse(parsed.response),
    shouldAct: normalizeShouldAct(parsed.shouldAct),
    messageId:
      typeof parsed.messageId === "string" && parsed.messageId.trim().length > 0
        ? parsed.messageId.trim()
        : undefined,
    replyNeededOnly: normalizeOptionalBoolean(parsed.replyNeededOnly),
    to: normalizePlannerStringArray(parsed.to ?? parsed.recipients),
    cc: normalizePlannerStringArray(parsed.cc),
    bcc: normalizePlannerStringArray(parsed.bcc),
    subject: normalizePlannerString(parsed.subject),
    bodyText: normalizePlannerString(parsed.bodyText ?? parsed.body),
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
    const result = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
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

// `suppressPostActionContinuation` is a local feature flag the runtime
// reads via a wider Action shape than the npm `@elizaos/core@alpha`
// dist-tag's exported type — the published type hasn't caught up yet
// so tsc rejects the property when compiled against node_modules on CI
// (local resolves via paths map to the newer eliza/ source and accepts
// it natively).
//
// We used to end this declaration with
// `} satisfies Action & { suppressPostActionContinuation?: boolean }`,
// but `satisfies` keeps the inferred literal type on the `const`. When
// the Docker CI Smoke build walks `packages/agent` with
// `declaration: true`, TypeScript tries to emit a portable `.d.ts`
// and fails with TS2742 because the inferred literal transitively
// references `@bufbuild/protobuf` types that are not in this package's
// direct dependency graph. An explicit type annotation on the binding
// makes `gmailAction` widen to the declared type, so tsc only has to
// emit the (portable) declared shape in the `.d.ts`.
export const gmailAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: "GMAIL_ACTION",
  similes: [
    "GMAIL",
    "GMAIL_INBOX",
    "CHECK_EMAIL",
    "EMAIL_TRIAGE",
    "TRIAGE_GMAIL_INBOX",
    "UNREAD_EMAILS",
    "EMAIL_UNREAD",
    "SEARCH_EMAIL",
    "DRAFT_EMAIL_REPLY",
    "SEND_EMAIL_REPLY",
  ],
  description:
    "Interact with Gmail through LifeOps. " +
    "USE this action for: inbox triage and unread summaries; searching emails by sender, subject, keyword, date, or label; " +
    "reading full email bodies by message ID; checking which emails need a reply; " +
    "drafting reply text for one or more emails; sending confirmed replies; " +
    "requests like 'triage my Gmail inbox', 'summarize my unread emails', 'draft a reply to the latest email from Sarah', or 'send a reply to the last email from finance'. " +
    "If the request explicitly says Gmail, email, unread emails, sender, subject, or reply to a specific email, use GMAIL_ACTION instead of INBOX. " +
    "DO NOT use this action when the user is only venting or making a general observation like 'I hate email' unless they actually ask you to triage, search, read, draft, or send. " +
    "DO NOT use this action for calendar events, meetings, or scheduling — use CALENDAR_ACTION instead. " +
    "DO NOT use this action for personal habits, goals, routines, or reminders — use LIFE instead. " +
    "This action provides the final grounded reply; do not pair it with a speculative REPLY action.",
  descriptionCompressed: "Gmail via LifeOps: inbox triage, search, read, draft/send replies. Not for calendar or habits.",
  suppressPostActionContinuation: true,
  validate: async (runtime, message, state) => {
    if (looksLikeEmailVenting(messageText(message))) {
      return false;
    }
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
    const latestReplyDraft = latestGmailReplyDraftContext(state);
    const latestMessageTarget = latestGmailMessageTargetContext(state);
    const latestBatchReplyDraftItems = latestGmailBatchReplyDraftItems(state);
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
        detailString(details, "messageId") ||
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
      await callback?.({
        text: payload.text,
        source: "action",
        action: "GMAIL_ACTION",
      });
      return payload;
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

      if (subaction === "send_reply") {
        let messageId =
          params.messageId ??
          detailString(details, "messageId") ??
          llmPlan.messageId ??
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
          latestReplyDraft?.bodyText;
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
            detailString(details, "subject") ?? latestReplyDraft?.subject,
          to: normalizeStringArray(details?.to) ?? latestReplyDraft?.to,
          cc: normalizeStringArray(details?.cc) ?? latestReplyDraft?.cc,
          confirmSend: detailBoolean(details, "confirmSend") ?? true,
        } satisfies SendLifeOpsGmailReplyRequest);
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
          confirmSend: detailBoolean(details, "confirmSend") ?? true,
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
      const result = await service.sendGmailReplies(INTERNAL_URL, {
        mode: detailString(details, "mode") as
          | "local"
          | "remote"
          | "cloud_managed"
          | undefined,
        side: detailString(details, "side") as "owner" | "agent" | undefined,
        grantId: detailString(details, "grantId"),
        confirmSend: detailBoolean(details, "confirmSend") ?? true,
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
        "Gmail operation to run. Use triage, needs_response, search, read, draft_reply, draft_batch_replies, send_reply, send_batch_replies, or send_message (compose a brand-new outbound email).",
      required: false,
      schema: {
        type: "string" as const,
        enum: [
          "triage",
          "needs_response",
          "search",
          "read",
          "draft_reply",
          "draft_batch_replies",
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
      name: "details",
      description:
        "Structured Gmail arguments. Supported keys include mode, side, grantId, forceSync, maxResults, query, queries, replyNeededOnly, tone, includeQuotedOriginal, messageId, messageIds, draftIntent, subject, to, cc, bodyText, confirmSend, and items for batch send.",
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
        content: { text: "Drafted reply to Sarah saying you will review it tomorrow." },
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
        content: { text: "Sent the confirmed reply to the latest email from finance." },
      },
    ],
  ] as ActionExample[][],
};

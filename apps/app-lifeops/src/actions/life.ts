import type {
  Action,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { ModelType, parseJSONObjectFromText } from "@elizaos/core";
import { getRecentMessagesData } from "@elizaos/shared/recent-messages-state";
import type {
  CreateLifeOpsDefinitionRequest,
  CreateLifeOpsGoalRequest,
  LifeOpsCadence,
  LifeOpsDailySlot,
  LifeOpsDefinitionRecord,
  LifeOpsDomain,
  LifeOpsGoalRecord,
  LifeOpsReminderIntensity,
  LifeOpsReminderStep,
  LifeOpsWindowPolicy,
  SetLifeOpsReminderPreferenceRequest,
  UpdateLifeOpsDefinitionRequest,
  UpdateLifeOpsGoalRequest,
} from "@elizaos/shared/contracts/lifeops";
import {
  buildNativeAppleReminderMetadata,
  type NativeAppleReminderLikeKind,
} from "../lifeops/apple-reminders.js";
import {
  resolveDefaultTimeZone,
  resolveDefaultWindowPolicy,
} from "../lifeops/defaults.js";
import { LifeOpsService, LifeOpsServiceError } from "../lifeops/service.js";
import {
  addDaysToLocalDate,
  buildUtcDateFromLocalParts,
  getZonedDateParts,
} from "../lifeops/time.js";
import { gmailAction } from "./gmail.js";
import { renderGroundedActionReply } from "@elizaos/agent/actions";
import {
  type ExtractedLifeMissingField,
  type ExtractedLifeOperation,
  extractLifeOperationWithLlm,
} from "./life.extractor.js";
import {
  extractGoalCreatePlanWithLlm,
  extractGoalUpdatePlanWithLlm,
  mergeGoalMetadataWithGrounding,
} from "./life-goal-extractor.js";
import {
  extractReminderIntensityWithLlm,
  extractTaskCreatePlanWithLlm,
} from "./life-param-extractor.js";
import { recentConversationTexts } from "./life-recent-context.js";
import { extractUpdateFieldsWithLlm } from "./life-update-extractor.js";
import {
  calendarReadUnavailableMessage,
  dayRange,
  detailArray,
  detailBoolean,
  detailNumber,
  detailObject,
  detailString,
  formatCalendarFeed,
  formatNextEventContext,
  formatOverviewForQuery,
  getGoogleCapabilityStatus,
  hasLifeOpsAccess,
  INTERNAL_URL,
  messageText,
  toActionData,
  weekRange,
} from "./lifeops-google-helpers.js";
import {
  looksLikeCodingTaskRequest,
  looksLikeGoalAdviceOnly,
  looksLikeRelationshipFollowUpRequest,
} from "./non-actionable-request.js";
import {
  extractExplicitTimeZoneFromText,
  normalizeExplicitTimeZoneToken,
} from "./timezone-normalization.js";

// ── Types ─────────────────────────────────────────────

type LifeOperation = ExtractedLifeOperation;
type ResolvedLifeOperationPlan = {
  confidence: number | null;
  missing: ExtractedLifeMissingField[];
  operation: LifeOperation | null;
  shouldAct: boolean;
};

type LifeAction =
  | "create"
  | "create_goal"
  | "update"
  | "update_goal"
  | "delete"
  | "delete_goal"
  | "complete"
  | "skip"
  | "snooze"
  | "review"
  | "phone"
  | "escalation"
  | "reminder_preference"
  | "calendar"
  | "next_event"
  | "email"
  | "overview";

const ACTION_TO_OPERATION: Record<LifeAction, LifeOperation> = {
  create: "create_definition",
  create_goal: "create_goal",
  update: "update_definition",
  update_goal: "update_goal",
  delete: "delete_definition",
  delete_goal: "delete_goal",
  complete: "complete_occurrence",
  skip: "skip_occurrence",
  snooze: "snooze_occurrence",
  review: "review_goal",
  phone: "capture_phone",
  escalation: "configure_escalation",
  reminder_preference: "set_reminder_preference",
  calendar: "query_calendar_today",
  next_event: "query_calendar_next",
  email: "query_email",
  overview: "query_overview",
};

type LifeParams = {
  action?: LifeAction;
  intent?: string;
  title?: string;
  target?: string;
  details?: Record<string, unknown>;
};

const GENERIC_DERIVED_TITLE_RE =
  /^(?:new\s+)?(?:habit|routine|task|goal|life goal|thing|item|something|anything|stuff|plan|reminder|todo|to do|achieve|achieve a|achieve an)$/i;
/** Maximum age (ms) for a deferred draft before it expires. */
const DRAFT_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
/** Maximum conversation turns before a deferred draft expires. */
const DRAFT_MAX_TURNS = 3;

type DeferredLifeDefinitionDraft = {
  intent: string;
  operation: "create_definition";
  /** Epoch ms when the draft was created. Used for expiry. */
  createdAt?: number;
  request: {
    cadence: LifeOpsCadence;
    description?: string;
    goalRef?: string;
    kind: CreateLifeOpsDefinitionRequest["kind"];
    priority?: number;
    progressionRule?: CreateLifeOpsDefinitionRequest["progressionRule"];
    reminderPlan?: CreateLifeOpsDefinitionRequest["reminderPlan"];
    timezone?: string;
    title: string;
    metadata?: CreateLifeOpsDefinitionRequest["metadata"];
    windowPolicy?: CreateLifeOpsDefinitionRequest["windowPolicy"];
    websiteAccess?: CreateLifeOpsDefinitionRequest["websiteAccess"];
  };
};

function normalizeLifeTimeZoneToken(
  value: string | null | undefined,
): string | null {
  return normalizeExplicitTimeZoneToken(value);
}

function extractLifeTimeZoneFromText(
  value: string | null | undefined,
): string | null {
  return extractExplicitTimeZoneFromText(value);
}

type DeferredLifeGoalDraft = {
  intent: string;
  operation: "create_goal";
  /** Epoch ms when the draft was created. Used for expiry. */
  createdAt?: number;
  request: {
    cadence?: CreateLifeOpsGoalRequest["cadence"];
    description?: string;
    metadata?: CreateLifeOpsGoalRequest["metadata"];
    successCriteria?: CreateLifeOpsGoalRequest["successCriteria"];
    supportStrategy?: CreateLifeOpsGoalRequest["supportStrategy"];
    title: string;
  };
};

type DeferredLifeDraft = DeferredLifeDefinitionDraft | DeferredLifeGoalDraft;
type DeferredLifeDraftReuseMode = "confirm" | "edit";
type DeferredLifeDraftFollowupMode =
  | DeferredLifeDraftReuseMode
  | "cancel"
  | null;

async function resolveLifeOperationPlan(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  intent: string;
  explicitOperation: LifeOperation | undefined;
}): Promise<ResolvedLifeOperationPlan> {
  const { runtime, message, state, intent, explicitOperation } = args;
  if (explicitOperation) {
    return {
      operation: explicitOperation,
      confidence: 1,
      missing: [],
      shouldAct: true,
    };
  }

  const extracted = await extractLifeOperationWithLlm({
    runtime,
    message,
    state,
    intent,
  });
  if (!extracted.shouldAct || !extracted.operation) {
    return {
      operation: extracted.operation,
      confidence: extracted.confidence,
      missing: extracted.missing,
      shouldAct: false,
    };
  }
  return {
    operation: extracted.operation,
    confidence: extracted.confidence,
    missing: extracted.missing,
    shouldAct: true,
  };
}

function shouldForceLifeCreateExecution(args: {
  intent: string;
  missing: ExtractedLifeMissingField[];
  operation: LifeOperation | null;
  details: Record<string, unknown> | undefined;
  title: string | undefined;
}): boolean {
  if (args.operation !== "create_definition") {
    return false;
  }

  const blockingFields = args.missing.filter(
    (field) => field !== "title" && field !== "schedule",
  );
  if (blockingFields.length > 0) {
    return false;
  }

  if (typeof args.title === "string" && args.title.trim().length > 0) {
    return true;
  }

  if (normalizeCadenceDetail(detailObject(args.details, "cadence"))) {
    return true;
  }
  return false;
}

// ── Helpers ───────────────────────────────────────────

function requestedOwnership(domain?: LifeOpsDomain) {
  if (domain === "agent_ops") {
    return { domain: "agent_ops" as const, subjectType: "agent" as const };
  }
  return { domain: "user_lifeops" as const, subjectType: "owner" as const };
}

function normalizeIntentText(value: string): string {
  return normalizeLifeInputText(value).toLowerCase();
}

function normalizeLifeInputText(value: string): string {
  return value
    .replace(/[\u00a0\u1680\u2000-\u200b\u202f\u205f\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTitle(value: string): string {
  return normalizeIntentText(value);
}

function matchByTitle<
  T extends { definition?: { title: string }; goal?: { title: string } },
>(entries: T[], targetTitle: string): T | null {
  const normalized = normalizeTitle(targetTitle);
  return (
    entries.find(
      (e) =>
        normalizeTitle(e.definition?.title ?? e.goal?.title ?? "") ===
        normalized,
    ) ??
    entries.find((e) =>
      normalizeTitle(e.definition?.title ?? e.goal?.title ?? "").includes(
        normalized,
      ),
    ) ??
    null
  );
}

function coerceDeferredLifeDraft(value: unknown): DeferredLifeDraft | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const operation = record.operation;
  const intent = typeof record.intent === "string" ? record.intent.trim() : "";
  const request =
    record.request && typeof record.request === "object"
      ? (record.request as Record<string, unknown>)
      : null;
  const createdAt =
    typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
      ? record.createdAt
      : undefined;

  if (!request || !intent) {
    return null;
  }

  const title = typeof request.title === "string" ? request.title.trim() : "";
  if (!title) {
    return null;
  }

  if (operation === "create_definition") {
    const kind =
      typeof request.kind === "string"
        ? (request.kind as CreateLifeOpsDefinitionRequest["kind"])
        : null;
    const cadence = request.cadence as LifeOpsCadence | undefined;
    if (!kind || !cadence) {
      return null;
    }
    return {
      createdAt,
      intent,
      operation,
      request: {
        cadence,
        description:
          typeof request.description === "string"
            ? request.description
            : undefined,
        goalRef:
          typeof request.goalRef === "string" ? request.goalRef : undefined,
        kind,
        priority:
          typeof request.priority === "number" ? request.priority : undefined,
        progressionRule:
          request.progressionRule as CreateLifeOpsDefinitionRequest["progressionRule"],
        reminderPlan:
          request.reminderPlan as CreateLifeOpsDefinitionRequest["reminderPlan"],
        timezone:
          typeof request.timezone === "string" ? request.timezone : undefined,
        title,
        metadata:
          request.metadata && typeof request.metadata === "object"
            ? (request.metadata as CreateLifeOpsDefinitionRequest["metadata"])
            : undefined,
        windowPolicy:
          request.windowPolicy as CreateLifeOpsDefinitionRequest["windowPolicy"],
        websiteAccess:
          request.websiteAccess as CreateLifeOpsDefinitionRequest["websiteAccess"],
      },
    };
  }

  if (operation === "create_goal") {
    return {
      createdAt,
      intent,
      operation,
      request: {
        cadence: request.cadence as CreateLifeOpsGoalRequest["cadence"],
        description:
          typeof request.description === "string"
            ? request.description
            : undefined,
        metadata:
          request.metadata && typeof request.metadata === "object"
            ? (request.metadata as CreateLifeOpsGoalRequest["metadata"])
            : undefined,
        successCriteria:
          request.successCriteria as CreateLifeOpsGoalRequest["successCriteria"],
        supportStrategy:
          request.supportStrategy as CreateLifeOpsGoalRequest["supportStrategy"],
        title,
      },
    };
  }

  return null;
}

function stateActionResults(state: State | undefined): ActionResult[] {
  if (!state || typeof state !== "object") {
    return [];
  }
  const stateRecord = state as Record<string, unknown>;
  const data =
    stateRecord.data && typeof stateRecord.data === "object"
      ? (stateRecord.data as Record<string, unknown>)
      : undefined;
  const providerResults =
    data?.providers && typeof data.providers === "object"
      ? (data.providers as Record<string, unknown>)
      : undefined;
  const providerActionState =
    providerResults?.ACTION_STATE &&
    typeof providerResults.ACTION_STATE === "object"
      ? (providerResults.ACTION_STATE as Record<string, unknown>)
      : undefined;
  const providerActionStateData =
    providerActionState?.data && typeof providerActionState.data === "object"
      ? (providerActionState.data as Record<string, unknown>)
      : undefined;
  const providerRecentMessages =
    providerResults?.RECENT_MESSAGES &&
    typeof providerResults.RECENT_MESSAGES === "object"
      ? (providerResults.RECENT_MESSAGES as Record<string, unknown>)
      : undefined;
  const providerRecentMessagesData =
    providerRecentMessages?.data &&
    typeof providerRecentMessages.data === "object"
      ? (providerRecentMessages.data as Record<string, unknown>)
      : undefined;

  const candidates = [
    data?.actionResults,
    providerActionStateData?.actionResults,
    providerActionStateData?.recentActionMemories,
    providerRecentMessagesData?.actionResults,
  ].filter(Array.isArray) as unknown[][];

  if (candidates.length === 0) {
    return [];
  }

  return candidates.flatMap((entries) =>
    entries.flatMap((entry): ActionResult[] => {
      if (!entry || typeof entry !== "object") {
        return [];
      }

      if ("content" in entry) {
        const content =
          (entry as { content?: unknown }).content &&
          typeof (entry as { content?: unknown }).content === "object"
            ? ((entry as { content: Record<string, unknown> })
                .content as Record<string, unknown>)
            : null;
        if (!content) {
          return [];
        }

        const contentData =
          content.data && typeof content.data === "object"
            ? ({ ...(content.data as Record<string, unknown>) } as Record<
                string,
                unknown
              >)
            : {};
        if (
          typeof content.actionName === "string" &&
          typeof contentData.actionName !== "string"
        ) {
          contentData.actionName = content.actionName;
        }

        return [
          {
            success: content.actionStatus !== "failed",
            text: typeof content.text === "string" ? content.text : undefined,
            data: contentData as import("@elizaos/core").ProviderDataRecord,
            error:
              typeof content.error === "string" ? content.error : undefined,
          },
        ];
      }

      return [entry as ActionResult];
    }),
  );
}

function stateMessageDrafts(state: State | undefined): DeferredLifeDraft[] {
  if (!state || typeof state !== "object") {
    return [];
  }

  const drafts: DeferredLifeDraft[] = [];
  for (const item of getRecentMessagesData(state)) {
    const content = item.content;
    if (!content || typeof content !== "object") {
      continue;
    }
    const contentRecord = content as Record<string, unknown>;
    const candidate =
      coerceDeferredLifeDraft(contentRecord.lifeDraft) ??
      coerceDeferredLifeDraft(
        contentRecord.data && typeof contentRecord.data === "object"
          ? (contentRecord.data as Record<string, unknown>).lifeDraft
          : undefined,
      );
    if (candidate) {
      drafts.push(candidate);
    }
  }

  return drafts;
}

function stateRecentMessageEntries(
  state: State | undefined,
) : Memory[] {
  if (!state || typeof state !== "object") {
    return [];
  }

  return getRecentMessagesData(state);
}

function isDeferredLifeDraftMessageEntry(
  item: Memory,
): boolean {
  const content =
    item.content && typeof item.content === "object"
      ? (item.content as Record<string, unknown>)
      : null;
  if (!content) {
    return false;
  }
  return Boolean(
    coerceDeferredLifeDraft(content.lifeDraft) ??
      coerceDeferredLifeDraft(
        content.data && typeof content.data === "object"
          ? (content.data as Record<string, unknown>).lifeDraft
          : undefined,
      ),
  );
}

function countTurnsSinceLatestDeferredLifeDraft(
  state: State | undefined,
): number | undefined {
  const entries = stateRecentMessageEntries(state);
  if (entries.length === 0) {
    return undefined;
  }

  let latestDraftIndex = -1;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry && isDeferredLifeDraftMessageEntry(entry)) {
      latestDraftIndex = index;
      break;
    }
  }
  if (latestDraftIndex < 0) {
    return undefined;
  }

  let turns = 0;
  for (const entry of entries.slice(latestDraftIndex + 1)) {
    const content =
      entry.content && typeof entry.content === "object"
        ? (entry.content as Record<string, unknown>)
        : null;
    if (!content || isDeferredLifeDraftMessageEntry(entry)) {
      continue;
    }
    if (typeof content.text === "string" && content.text.trim().length > 0) {
      turns++;
    }
  }
  return turns;
}

function latestDeferredLifeDraft(
  state: State | undefined,
): DeferredLifeDraft | null {
  for (const result of [...stateActionResults(state)].reverse()) {
    const resultData =
      result.data && typeof result.data === "object"
        ? (result.data as Record<string, unknown>)
        : null;
    const completedCreate =
      result.success &&
      resultData &&
      !coerceDeferredLifeDraft(resultData.lifeDraft) &&
      ((resultData.definition && typeof resultData.definition === "object") ||
        (resultData.goal && typeof resultData.goal === "object"));
    if (completedCreate) {
      return null;
    }

    const candidate = coerceDeferredLifeDraft(result.data?.lifeDraft);
    if (candidate) {
      return candidate;
    }
  }

  const messageDrafts = stateMessageDrafts(state);
  return messageDrafts.at(-1) ?? null;
}

function deferredLifeDraftExpiryReason(args: {
  draft: DeferredLifeDraft | null;
  turnsSinceDraft?: number;
}): "age" | "turns" | null {
  if (!args.draft) {
    return null;
  }

  if (args.draft.createdAt) {
    const ageMs = Date.now() - args.draft.createdAt;
    if (ageMs >= DRAFT_EXPIRY_MS) {
      return "age";
    }
  }
  if (
    typeof args.turnsSinceDraft === "number" &&
    args.turnsSinceDraft >= DRAFT_MAX_TURNS
  ) {
    return "turns";
  }
  return null;
}

async function extractDeferredLifeDraftFollowupWithLlm(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  currentText: string;
  draft: DeferredLifeDraft;
}): Promise<DeferredLifeDraftFollowupMode> {
  if (typeof args.runtime.useModel !== "function") {
    return null;
  }

  const recentConversation = await recentConversationTexts({
    runtime: args.runtime,
    message: args.message,
    state: args.state,
    limit: 12,
  });
  const prompt = [
    "Decide how the assistant should interpret the user's follow-up to a previewed LifeOps draft that has not been saved yet.",
    "Use the current message, the draft summary, and recent conversation.",
    "The user may speak in any language.",
    "",
    "Return ONLY valid JSON with exactly this shape:",
    '{"mode":"confirm"|"edit"|"cancel"|"none"}',
    "",
    "Choose confirm when the user clearly approves saving the current draft now.",
    "Choose edit when the user wants to change the draft or continue specifying it before saving.",
    "Choose cancel when the user says not to save it, never mind, not yet, hold off, or equivalent.",
    "Choose none when the follow-up is unrelated or too ambiguous to attach to the draft.",
    "",
    "Previewed draft:",
    stringifyDeferredLifeDraftForPrompt(args.draft),
    "",
    `Current user message: ${JSON.stringify(args.currentText)}`,
    `Recent conversation: ${JSON.stringify(recentConversation.join("\n"))}`,
  ].join("\n");

  try {
    const result = await args.runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
    });
    const raw = typeof result === "string" ? result : "";
    const parsed = parseJSONObjectFromText(raw);
    const mode =
      parsed && typeof parsed.mode === "string"
        ? parsed.mode.trim().toLowerCase()
        : "";
    switch (mode) {
      case "confirm":
      case "edit":
      case "cancel":
        return mode;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function stringifyDeferredLifeDraftForPrompt(draft: DeferredLifeDraft): string {
  if (draft.operation === "create_definition") {
    return JSON.stringify({
      operation: draft.operation,
      title: draft.request.title,
      kind: draft.request.kind,
      cadence: draft.request.cadence,
      timezone: draft.request.timezone ?? null,
      description: draft.request.description ?? null,
    });
  }

  return JSON.stringify({
    operation: draft.operation,
    title: draft.request.title,
    cadence: draft.request.cadence ?? null,
    description: draft.request.description ?? null,
  });
}

function resolveDeferredLifeDraftReuseMode(args: {
  details: Record<string, unknown> | undefined;
  draft: DeferredLifeDraft | null;
  explicitAction: LifeAction | undefined;
  llmMode?: DeferredLifeDraftFollowupMode;
  /** Number of messages since the draft was stored. */
  turnsSinceDraft?: number;
}): DeferredLifeDraftReuseMode | null {
  if (!args.draft) {
    return null;
  }

  if (deferredLifeDraftExpiryReason(args)) {
    return null;
  }

  if (detailBoolean(args.details, "confirmed") === true) {
    return "confirm";
  }

  if (
    args.explicitAction &&
    ACTION_TO_OPERATION[args.explicitAction] !== args.draft.operation
  ) {
    return null;
  }

  if (args.llmMode === "confirm" || args.llmMode === "edit") {
    return args.llmMode;
  }
  return null;
}

async function resolveGoal(
  service: LifeOpsService,
  target: string | undefined,
  domain?: LifeOpsDomain,
): Promise<LifeOpsGoalRecord | null> {
  if (!target) return null;
  const goals = (await service.listGoals()).filter((e) =>
    domain ? e.goal.domain === domain : true,
  );
  return goals.find((e) => e.goal.id === target) ?? matchByTitle(goals, target);
}

async function resolveDefinition(
  service: LifeOpsService,
  target: string | undefined,
  domain?: LifeOpsDomain,
): Promise<LifeOpsDefinitionRecord | null> {
  if (!target) return null;
  const defs = (await service.listDefinitions()).filter((e) =>
    domain ? e.definition.domain === domain : true,
  );
  return (
    defs.find((e) => e.definition.id === target) ?? matchByTitle(defs, target)
  );
}

function tokenizeTitle(value: string): string[] {
  return normalizeTitle(value)
    .split(" ")
    .filter((token) => token.length >= 3);
}

async function resolveDefinitionFromIntent(
  service: LifeOpsService,
  target: string | undefined,
  intent: string,
  domain?: LifeOpsDomain,
): Promise<LifeOpsDefinitionRecord | null> {
  const direct = await resolveDefinition(service, target, domain);
  if (direct) {
    return direct;
  }
  const defs = (await service.listDefinitions()).filter((entry) =>
    domain ? entry.definition.domain === domain : true,
  );
  const intentTokens = new Set(tokenizeTitle(intent));
  let best: LifeOpsDefinitionRecord | null = null;
  let bestScore = 0;
  let tied = false;
  for (const entry of defs) {
    const title = normalizeTitle(entry.definition.title);
    if (title.length > 0 && normalizeTitle(intent).includes(title)) {
      return entry;
    }
    const overlap = tokenizeTitle(entry.definition.title).filter((token) =>
      intentTokens.has(token),
    ).length;
    if (overlap === 0) {
      continue;
    }
    if (overlap > bestScore) {
      best = entry;
      bestScore = overlap;
      tied = false;
      continue;
    }
    if (overlap === bestScore) {
      tied = true;
    }
  }
  return bestScore > 0 && !tied ? best : null;
}

type OccurrenceResult = {
  match:
    | Awaited<
        ReturnType<LifeOpsService["getOverview"]>
      >["owner"]["occurrences"][number]
    | null;
  /** Non-empty only when resolution was ambiguous (2+ substring matches, no exact/prefix winner). */
  ambiguousCandidates: string[];
};

function formatOccurrenceDisambiguationLabel(
  occurrence: Awaited<
    ReturnType<LifeOpsService["getOverview"]>
  >["owner"]["occurrences"][number],
): string {
  const hints: string[] = [];
  if (
    typeof occurrence.windowName === "string" &&
    occurrence.windowName.trim()
  ) {
    hints.push(occurrence.windowName.trim());
  }
  if (occurrence.dueAt) {
    const dueAt = new Date(occurrence.dueAt);
    if (!Number.isNaN(dueAt.getTime())) {
      hints.push(
        dueAt.toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }),
      );
    }
  }
  return hints.length > 0
    ? `${occurrence.title} (${hints.join(", ")})`
    : occurrence.title;
}

function narrowOccurrenceCandidates(
  matches: Awaited<
    ReturnType<LifeOpsService["getOverview"]>
  >["owner"]["occurrences"],
) {
  const actionableMatches = matches.filter(
    (occurrence) =>
      occurrence.state === "visible" || occurrence.state === "snoozed",
  );
  return actionableMatches.length > 0 ? actionableMatches : matches;
}

async function resolveOccurrence(
  service: LifeOpsService,
  target: string | undefined,
  domain?: LifeOpsDomain,
): Promise<OccurrenceResult> {
  if (!target) return { match: null, ambiguousCandidates: [] };
  const overview = await service.getOverview();
  const all = [
    ...overview.owner.occurrences,
    ...overview.agentOps.occurrences,
  ].filter((o) => (domain ? o.domain === domain : true));
  const normalized = normalizeTitle(target);

  // Exact ID match
  const byId = all.find((o) => o.id === target);
  if (byId) return { match: byId, ambiguousCandidates: [] };

  // Exact normalized-title match
  const exactMatches = all.filter(
    (o) => normalizeTitle(o.title) === normalized,
  );
  if (exactMatches.length === 1) {
    return { match: exactMatches.at(0) ?? null, ambiguousCandidates: [] };
  }
  if (exactMatches.length > 1) {
    const narrowedMatches = narrowOccurrenceCandidates(exactMatches);
    if (narrowedMatches.length === 1) {
      return { match: narrowedMatches.at(0) ?? null, ambiguousCandidates: [] };
    }
    return {
      match: null,
      ambiguousCandidates: narrowedMatches.map(
        formatOccurrenceDisambiguationLabel,
      ),
    };
  }

  // Substring matches — disambiguate when multiple
  const substringMatches = all.filter((o) =>
    normalizeTitle(o.title).includes(normalized),
  );
  if (substringMatches.length === 1) {
    return { match: substringMatches.at(0) ?? null, ambiguousCandidates: [] };
  }
  if (substringMatches.length > 1) {
    const narrowedSubstringMatches =
      narrowOccurrenceCandidates(substringMatches);
    if (narrowedSubstringMatches.length === 1) {
      return {
        match: narrowedSubstringMatches.at(0) ?? null,
        ambiguousCandidates: [],
      };
    }
    // Prefer startsWith over generic includes
    const startsWithMatches = narrowedSubstringMatches.filter((o) =>
      normalizeTitle(o.title).startsWith(normalized),
    );
    if (startsWithMatches.length === 1) {
      return { match: startsWithMatches.at(0) ?? null, ambiguousCandidates: [] };
    }
    if (startsWithMatches.length > 1) {
      return {
        match: null,
        ambiguousCandidates: startsWithMatches.map(
          formatOccurrenceDisambiguationLabel,
        ),
      };
    }
    // Still ambiguous — return candidates for the caller to list
    return {
      match: null,
      ambiguousCandidates: narrowedSubstringMatches.map(
        formatOccurrenceDisambiguationLabel,
      ),
    };
  }

  const targetTokens = normalized.split(/\s+/).filter(Boolean);
  if (targetTokens.length > 1) {
    const tokenSetMatches = all.filter((occurrence) => {
      const occurrenceTokens = new Set(
        normalizeTitle(occurrence.title).split(/\s+/).filter(Boolean),
      );
      return targetTokens.every((token) => occurrenceTokens.has(token));
    });
    if (tokenSetMatches.length === 1) {
      return { match: tokenSetMatches.at(0) ?? null, ambiguousCandidates: [] };
    }
    if (tokenSetMatches.length > 1) {
      const narrowedTokenSetMatches =
        narrowOccurrenceCandidates(tokenSetMatches);
      if (narrowedTokenSetMatches.length === 1) {
        return {
          match: narrowedTokenSetMatches.at(0) ?? null,
          ambiguousCandidates: [],
        };
      }
      return {
        match: null,
        ambiguousCandidates: narrowedTokenSetMatches.map(
          formatOccurrenceDisambiguationLabel,
        ),
      };
    }
  }

  return { match: null, ambiguousCandidates: [] };
}

function deriveOccurrenceTargetFromIntent(
  intent: string,
  operation: LifeOperation,
): string | null {
  const normalized = normalizeLifeInputText(intent);
  if (!normalized) {
    return null;
  }

  let candidate = normalized;
  if (operation === "snooze_occurrence") {
    candidate = candidate
      .replace(
        /^(?:please\s+)?(?:snooze|postpone|push\b.*\bback|remind me later about)\s+/i,
        "",
      )
      .replace(/\bfor\s+\d+\s*(?:minutes?|hours?)\b.*$/i, "")
      .replace(/\b(?:until|til)\b.+$/i, "")
      .trim();
  } else if (operation === "skip_occurrence") {
    candidate = candidate
      .replace(/^(?:please\s+)?(?:skip|pass on)\s+/i, "")
      .replace(/\b(?:today|tonight|for now)\b.*$/i, "")
      .trim();
  } else if (operation === "complete_occurrence") {
    candidate = candidate
      .replace(
        /^(?:please\s+)?(?:mark\s+|i(?:'ve| have)?\s+|just\s+)?(?:done|completed|finished|did)\s+/i,
        "",
      )
      .replace(/\b(?:done|complete|completed|finished)\b.*$/i, "")
      .trim();
  }

  return candidate.length > 0 ? candidate : null;
}

async function resolveOccurrenceWithIntentFallback(args: {
  service: LifeOpsService;
  target: string | undefined;
  domain?: LifeOpsDomain;
  intent: string;
  operation: LifeOperation;
}): Promise<OccurrenceResult> {
  const direct = await resolveOccurrence(
    args.service,
    args.target,
    args.domain,
  );
  if (direct.match || direct.ambiguousCandidates.length > 0) {
    return direct;
  }

  const fallbackTarget = deriveOccurrenceTargetFromIntent(
    args.intent,
    args.operation,
  );
  if (
    !fallbackTarget ||
    (args.target &&
      normalizeTitle(fallbackTarget) === normalizeTitle(args.target))
  ) {
    return direct;
  }

  return resolveOccurrence(args.service, fallbackTarget, args.domain);
}

function summarizeCadence(cadence: LifeOpsCadence): string {
  const cadenceWindows = Array.isArray((cadence as { windows?: unknown }).windows)
    ? ((cadence as { windows: string[] }).windows).filter((window) =>
        typeof window === "string" && window.trim().length > 0,
      )
    : [];
  switch (cadence.kind) {
    case "once": {
      const dueAt = new Date(cadence.dueAt);
      if (Number.isNaN(dueAt.getTime())) {
        return "once";
      }
      return `once on ${dueAt.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: resolveDefaultTimeZone(),
      })}`;
    }
    case "daily":
      return cadenceWindows.length > 0
        ? `every day in ${cadenceWindows.join(", ")}`
        : "every day";
    case "times_per_day":
      return cadence.slots
        .map((slot) => slot.label?.trim() || `${slot.minuteOfDay}`)
        .filter(Boolean)
        .join(" and ");
    case "interval":
      return cadenceWindows.length > 0
        ? `every ${cadence.everyMinutes} minutes in ${cadenceWindows.join(", ")}`
        : `every ${cadence.everyMinutes} minutes`;
    case "weekly":
      return `weekly on ${cadence.weekdays
        .map(
          (weekday) =>
            [
              "Sunday",
              "Monday",
              "Tuesday",
              "Wednesday",
              "Thursday",
              "Friday",
              "Saturday",
            ][weekday] ?? String(weekday),
        )
        .join(", ")}`;
  }
}

type LifeReplyScenario =
  | "reply_only"
  | "clarify_create_definition"
  | "clarify_create_goal"
  | "preview_definition"
  | "saved_definition"
  | "preview_goal"
  | "saved_goal"
  | "updated_definition"
  | "updated_goal"
  | "deleted_definition"
  | "deleted_goal"
  | "completed_occurrence"
  | "skipped_occurrence"
  | "snoozed_occurrence"
  | "set_reminder_preference"
  | "captured_phone"
  | "configured_escalation"
  | "overview"
  | "service_error";

function buildRuleBasedLifeReply(args: {
  scenario: LifeReplyScenario;
  intent: string;
  fallback: string;
  context?: Record<string, unknown>;
}): string {
  const context = args.context ?? {};
  const updated =
    context.updated && typeof context.updated === "object"
      ? (context.updated as Record<string, unknown>)
      : null;
  const created =
    context.created && typeof context.created === "object"
      ? (context.created as Record<string, unknown>)
      : null;
  const title =
    (typeof updated?.title === "string" ? updated.title : null) ??
    (typeof created?.title === "string" ? created.title : null) ??
    (typeof context.title === "string" ? context.title : null) ??
    null;
  // Time-phrase nuance ("mornings now", "7pm now", etc.) is rendered by the
  // LLM in renderGroundedActionReply via the additionalRules contract. The
  // rule-based fallback intentionally only carries the title — never tries
  // to parse English-only time phrases out of the intent.

  switch (args.scenario) {
    case "updated_definition":
      if (title) {
        return `${title} is updated.`;
      }
      break;
    case "deleted_definition":
      if (title) {
        return `${title} is off your list.`;
      }
      break;
    case "deleted_goal":
      if (title) {
        return `${title} is off your goals list.`;
      }
      break;
    case "completed_occurrence":
      if (title) {
        return `Marked ${title} done.`;
      }
      break;
    case "skipped_occurrence":
      if (title) {
        return `Okay, skipping ${title} for now.`;
      }
      break;
    case "snoozed_occurrence":
      if (title) {
        return `Okay, I'll bring ${title} back a bit later.`;
      }
      break;
    default:
      break;
  }

  return args.fallback;
}

async function renderLifeActionReply(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  intent: string;
  scenario: LifeReplyScenario;
  fallback: string;
  context?: Record<string, unknown>;
}): Promise<string> {
  const { runtime, message, state, intent, scenario, fallback, context } = args;
  const naturalFallback = buildRuleBasedLifeReply({
    scenario,
    intent,
    fallback,
    context,
  });
  return renderGroundedActionReply({
    runtime,
    message,
    state,
    intent,
    domain: "lifeops",
    scenario,
    fallback: naturalFallback,
    context,
    preferCharacterVoice: true,
    additionalRules: [
      "Mirror the user's phrasing for time and date when possible.",
      "Prefer phrases like tomorrow morning, every night, 7 am, or the user's own wording over robotic schedule language.",
      "Never surface raw ISO timestamps unless the user used raw ISO timestamps.",
      "If this is a preview, make clear it is not saved yet and the user can confirm or change it naturally.",
      "If this is reply-only, do not pretend you saved or changed anything.",
    ],
  });
}

function buildLifeClarificationFallback(args: {
  missing: ExtractedLifeMissingField[];
  operation: LifeOperation | null;
}): string {
  const missing = new Set(args.missing);
  if (args.operation === "create_goal") {
    return "What do you want the goal to be?";
  }
  if (missing.has("title") && missing.has("schedule")) {
    return "What do you want the todo to be, and when should it happen?";
  }
  if (missing.has("title")) {
    return "What do you want it to be?";
  }
  if (missing.has("schedule")) {
    return "When should it happen?";
  }
  return "Tell me a bit more about what you want to set up.";
}

function buildLifeServiceErrorFallback(
  error: LifeOpsServiceError,
  intent: string,
): string {
  const normalized = error.message.toLowerCase();
  if (
    normalized.includes("utc 'z' suffix") ||
    normalized.includes("local datetime without 'z'") ||
    normalized.includes("time didn't parse") ||
    normalized.includes("invalid dueat") ||
    normalized.includes("cadence.dueat")
  ) {
    return `I couldn't pin down the reminder time from "${intent}". Tell me the time again in plain language, like "Friday at 8 pm Pacific."`;
  }
  if (
    normalized.includes("when windowpreset is not provided") ||
    normalized.includes("startat is required")
  ) {
    return "I still need the time for that reminder. Tell me when it should happen.";
  }
  if (error.status === 429 || normalized.includes("rate limit")) {
    return "LifeOps is rate-limited right now. Try again in a bit.";
  }
  return "I couldn't finish that LifeOps change yet. Tell me the task and timing again, and I'll try it a different way.";
}

// ── Calendar/email formatters ─────────────────────────

const DEFAULT_WINDOW_SLOT_TIMES: Record<
  "morning" | "afternoon" | "evening" | "night",
  { minuteOfDay: number; durationMinutes: number; label: string }
> = {
  morning: {
    minuteOfDay: 8 * 60,
    durationMinutes: 45,
    label: "Morning",
  },
  afternoon: {
    minuteOfDay: 13 * 60,
    durationMinutes: 45,
    label: "Afternoon",
  },
  evening: {
    minuteOfDay: 18 * 60,
    durationMinutes: 45,
    label: "Evening",
  },
  night: {
    minuteOfDay: 21 * 60,
    durationMinutes: 45,
    label: "Night",
  },
};

function buildSlotsFromWindows(
  windows: Array<"morning" | "afternoon" | "evening" | "night">,
): LifeOpsDailySlot[] {
  return windows.map((window, index) => {
    const preset = DEFAULT_WINDOW_SLOT_TIMES[window];
    return {
      key:
        windows.indexOf(window) === index ? window : `${window}-${index + 1}`,
      label: preset.label,
      minuteOfDay: preset.minuteOfDay,
      durationMinutes: preset.durationMinutes,
    };
  });
}

function buildDistributedDailySlots(count: number): LifeOpsDailySlot[] {
  const normalizedCount = Math.max(1, Math.min(6, count));
  let minutes: number[];
  switch (normalizedCount) {
    case 1:
      minutes = [9 * 60];
      break;
    case 2:
      minutes = [8 * 60, 21 * 60];
      break;
    case 3:
      minutes = [8 * 60, 13 * 60, 20 * 60];
      break;
    case 4:
      minutes = [8 * 60, 12 * 60, 16 * 60, 20 * 60];
      break;
    case 5:
      minutes = [8 * 60, 11 * 60, 14 * 60, 17 * 60, 20 * 60];
      break;
    default:
      minutes = [8 * 60, 10 * 60, 12 * 60, 14 * 60, 17 * 60, 20 * 60];
      break;
  }
  return minutes.map((minuteOfDay, index) => ({
    key: `slot-${index + 1}`,
    label: `Time ${index + 1}`,
    minuteOfDay,
    durationMinutes: 45,
  }));
}

function inferWindowFromMinuteOfDay(
  minuteOfDay: number,
): "morning" | "afternoon" | "evening" | "night" {
  if (minuteOfDay < 12 * 60) {
    return "morning";
  }
  if (minuteOfDay < 17 * 60) {
    return "afternoon";
  }
  if (minuteOfDay < 21 * 60) {
    return "evening";
  }
  return "night";
}

function buildSingleDailySlot(
  minuteOfDay: number,
  durationMinutes = 45,
): LifeOpsDailySlot {
  return {
    key: `time-${minuteOfDay}`,
    label: formatMinuteOfDayLabel(minuteOfDay),
    minuteOfDay,
    durationMinutes,
  };
}

function addYearsToLocalDate(
  dateOnly: { year: number; month: number; day: number },
  yearDelta: number,
): { year: number; month: number; day: number } {
  const utcDate = new Date(
    Date.UTC(dateOnly.year + yearDelta, dateOnly.month - 1, dateOnly.day, 12),
  );
  return {
    year: utcDate.getUTCFullYear(),
    month: utcDate.getUTCMonth() + 1,
    day: utcDate.getUTCDate(),
  };
}

function buildCustomTimeWindowPolicy(
  minuteOfDay: number,
  timeZone: string,
): LifeOpsWindowPolicy {
  const basePolicy = resolveDefaultWindowPolicy(timeZone);
  return {
    timezone: basePolicy.timezone,
    windows: [
      ...basePolicy.windows,
      {
        name: "custom",
        label: formatMinuteOfDayLabel(minuteOfDay),
        startMinute: minuteOfDay,
        endMinute: Math.min(minuteOfDay + 1, 24 * 60),
      },
    ],
  };
}

function formatMinuteOfDayLabel(minuteOfDay: number): string {
  const hour24 = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const meridiem = hour24 >= 12 ? "pm" : "am";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return minute === 0
    ? `${hour12}${meridiem}`
    : `${hour12}:${String(minute).padStart(2, "0")}${meridiem}`;
}

function parseClockToken(token: string): number | null {
  const normalized = token.trim().toLowerCase();
  if (normalized === "noon") {
    return 12 * 60;
  }
  if (normalized === "midnight") {
    return 0;
  }
  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute >= 60) {
    return null;
  }
  if (hour < 1 || hour > 12) {
    return null;
  }
  const meridiem = match[3];
  const normalizedHour =
    meridiem === "am" ? hour % 12 : hour % 12 === 0 ? 12 : (hour % 12) + 12;
  return normalizedHour * 60 + minute;
}

function parseTimeOfDayToken(token: string): number | null {
  const normalized = normalizeLifeInputText(token).toLowerCase();
  const hhmmMatch = normalized.match(/^(\d{1,2}):(\d{2})$/);
  if (hhmmMatch) {
    const hour = Number(hhmmMatch[1]);
    const minute = Number(hhmmMatch[2]);
    if (
      Number.isFinite(hour) &&
      Number.isFinite(minute) &&
      hour >= 0 &&
      hour <= 23 &&
      minute >= 0 &&
      minute < 60
    ) {
      return hour * 60 + minute;
    }
  }
  return parseClockToken(normalized);
}

function resolveAlarmDayOffset(intent: string): number | null {
  const lower = normalizeLifeInputText(intent).toLowerCase();
  if (/\btomorrow\b/.test(lower)) return 1;
  if (/\b(today|tonight)\b/.test(lower)) return 0;
  return null;
}

function buildOneOffDueAtFromMinuteOfDay(args: {
  intent?: string;
  minuteOfDay: number;
  now?: Date;
  timeZone?: string;
}): string {
  const now = args.now ?? new Date();
  const timeZone = args.timeZone ?? resolveDefaultTimeZone();
  const nowParts = getZonedDateParts(now, timeZone);
  let localDate = {
    year: nowParts.year,
    month: nowParts.month,
    day: nowParts.day,
  };

  const explicitDate =
    typeof args.intent === "string"
      ? parseExplicitLocalDateForLifeRequest(args.intent, timeZone, now)
      : null;
  if (explicitDate) {
    localDate = explicitDate;
  }

  const explicitDayOffset =
    typeof args.intent === "string" ? resolveAlarmDayOffset(args.intent) : null;
  if (explicitDate === null && explicitDayOffset !== null) {
    localDate = addDaysToLocalDate(localDate, explicitDayOffset);
  }

  const buildCandidate = () =>
    buildUtcDateFromLocalParts(timeZone, {
      ...localDate,
      hour: Math.floor(args.minuteOfDay / 60),
      minute: args.minuteOfDay % 60,
      second: 0,
    });

  let candidate = buildCandidate();
  if (candidate.getTime() <= now.getTime()) {
    if (explicitDate && !explicitDate.explicitYear) {
      localDate = addYearsToLocalDate(localDate, 1);
      candidate = buildCandidate();
    } else if (explicitDate === null && explicitDayOffset === null) {
      localDate = addDaysToLocalDate(localDate, 1);
      candidate = buildCandidate();
    }
  }

  return candidate.toISOString();
}

function parseExplicitLocalDateForLifeRequest(
  value: string,
  timeZone: string,
  now = new Date(),
): { year: number; month: number; day: number; explicitYear: boolean } | null {
  const normalized = normalizeLifeInputText(value).toLowerCase();
  const localToday = getZonedDateParts(now, timeZone);
  const monthMap: Record<string, number> = {
    january: 1,
    jan: 1,
    february: 2,
    feb: 2,
    march: 3,
    mar: 3,
    april: 4,
    apr: 4,
    may: 5,
    june: 6,
    jun: 6,
    july: 7,
    jul: 7,
    august: 8,
    aug: 8,
    september: 9,
    sept: 9,
    sep: 9,
    october: 10,
    oct: 10,
    november: 11,
    nov: 11,
    december: 12,
    dec: 12,
  };
  const weekdayMap: Record<string, number> = {
    sunday: 0,
    sun: 0,
    monday: 1,
    mon: 1,
    tuesday: 2,
    tue: 2,
    tues: 2,
    wednesday: 3,
    wed: 3,
    thursday: 4,
    thu: 4,
    thur: 4,
    thurs: 4,
    friday: 5,
    fri: 5,
    saturday: 6,
    sat: 6,
  };

  const isoMatch = normalized.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (isoMatch) {
    return {
      year: Number(isoMatch[1]),
      month: Number(isoMatch[2]),
      day: Number(isoMatch[3]),
      explicitYear: true,
    };
  }

  const monthNameMatch = normalized.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i,
  );
  if (monthNameMatch) {
    const monthToken = monthNameMatch[1];
    if (!monthToken) {
      return null;
    }
    const month = monthMap[monthToken.toLowerCase().replace(/\./g, "")];
    if (month === undefined) {
      return null;
    }
    return {
      year: monthNameMatch[3] ? Number(monthNameMatch[3]) : localToday.year,
      month,
      day: Number(monthNameMatch[2]),
      explicitYear: Boolean(monthNameMatch[3]),
    };
  }

  const numericMatch = normalized.match(
    /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/,
  );
  if (numericMatch) {
    const yearRaw = numericMatch[3];
    const year =
      yearRaw === undefined
        ? localToday.year
        : yearRaw.length === 2
          ? 2000 + Number(yearRaw)
          : Number(yearRaw);
    return {
      year,
      month: Number(numericMatch[1]),
      day: Number(numericMatch[2]),
      explicitYear: Boolean(yearRaw),
    };
  }

  const weekdayMatch = normalized.match(
    /\b(?:(this|next)\s+)?(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)\b/i,
  );
  if (!weekdayMatch) {
    return null;
  }

  const weekdayToken = weekdayMatch[2]?.toLowerCase();
  const targetWeekday = weekdayToken ? weekdayMap[weekdayToken] : undefined;
  if (targetWeekday === undefined) {
    return null;
  }

  const qualifier = weekdayMatch[1]?.toLowerCase() ?? "";
  const currentWeekday = new Date(
    Date.UTC(
      localToday.year,
      Math.max(0, localToday.month - 1),
      localToday.day,
      12,
    ),
  ).getUTCDay();
  let delta = (targetWeekday - currentWeekday + 7) % 7;
  if (qualifier === "next") {
    delta = delta === 0 ? 7 : delta + 7;
  }
  const resolved = addDaysToLocalDate(
    {
      year: localToday.year,
      month: localToday.month,
      day: localToday.day,
    },
    delta,
  );
  return {
    ...resolved,
    explicitYear: false,
  };
}

function mergeMetadataRecords(
  ...records: Array<Record<string, unknown> | undefined>
): Record<string, unknown> | undefined {
  const merged = Object.assign(
    {},
    ...records.filter(
      (record): record is Record<string, unknown> =>
        record != null && Object.keys(record).length > 0,
    ),
  );
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function extractExplicitDailySlots(intent: string): LifeOpsDailySlot[] {
  const tokens = [
    ...intent.matchAll(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)|noon|midnight)\b/gi),
  ]
    .map((match) => match[1])
    .filter((token): token is string => typeof token === "string" && token.length > 0);
  const seen = new Set<number>();
  const slots: LifeOpsDailySlot[] = [];
  for (const [index, token] of tokens.entries()) {
    const minuteOfDay = parseClockToken(token);
    if (minuteOfDay === null || seen.has(minuteOfDay)) {
      continue;
    }
    seen.add(minuteOfDay);
    slots.push({
      key: `clock-${index + 1}`,
      label: token.trim(),
      minuteOfDay,
      durationMinutes: 45,
    });
  }
  return slots.sort((left, right) => left.minuteOfDay - right.minuteOfDay);
}

function normalizeLifeWindows(
  value: unknown,
): Array<"morning" | "afternoon" | "evening" | "night"> {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  const normalized = values.flatMap((entry) => {
    if (typeof entry !== "string") {
      return [];
    }
    const lower = normalizeLifeInputText(entry).toLowerCase();
    if (lower === "morning") return ["morning" as const];
    if (lower === "afternoon") return ["afternoon" as const];
    if (lower === "evening") return ["evening" as const];
    if (lower === "night") return ["night" as const];
    return [];
  });
  return [...new Set(normalized)];
}

function normalizeCadenceDetail(value: unknown): LifeOpsCadence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const cadenceKind =
    typeof record.kind === "string"
      ? normalizeLifeInputText(record.kind).toLowerCase()
      : typeof record.type === "string"
        ? normalizeLifeInputText(record.type).toLowerCase()
        : "";

  if (!cadenceKind) {
    return undefined;
  }

  if (cadenceKind === "once" && typeof record.dueAt === "string") {
    return {
      kind: "once",
      dueAt: record.dueAt,
    };
  }

  if (cadenceKind === "interval") {
    const everyMinutes =
      typeof record.everyMinutes === "number"
        ? record.everyMinutes
        : typeof record.everyMinutes === "string"
          ? Number(record.everyMinutes)
          : typeof record.minutes === "number"
            ? record.minutes
            : typeof record.minutes === "string"
              ? Number(record.minutes)
              : NaN;
    if (Number.isFinite(everyMinutes) && everyMinutes > 0) {
      return {
        kind: "interval",
        everyMinutes,
        windows: normalizeLifeWindows(record.windows),
      };
    }
    return undefined;
  }

  if (cadenceKind === "weekly") {
    const weekdays = Array.isArray(record.weekdays)
      ? record.weekdays
          .map((entry) =>
            typeof entry === "number"
              ? entry
              : typeof entry === "string"
                ? Number(entry)
                : NaN,
          )
          .filter((entry) => Number.isFinite(entry))
      : [];
    if (weekdays.length > 0) {
      return {
        kind: "weekly",
        weekdays,
        windows: normalizeLifeWindows(record.windows),
      };
    }
    return undefined;
  }

  const explicitTimes = Array.isArray(record.times)
    ? record.times
        .map((entry) =>
          typeof entry === "string" ? parseTimeOfDayToken(entry) : null,
        )
        .filter((entry): entry is number => entry !== null)
    : [];
  if (explicitTimes.length > 0) {
    return {
      kind: "times_per_day",
      slots: explicitTimes.map((minuteOfDay, index) => ({
        key: `time-${index + 1}`,
        label: formatMinuteOfDayLabel(minuteOfDay),
        minuteOfDay,
        durationMinutes: 45,
      })),
      visibilityLeadMinutes: 90,
      visibilityLagMinutes: 180,
    };
  }

  if (cadenceKind === "times_per_day") {
    if (Array.isArray(record.slots)) {
      const slots = record.slots
        .map((entry, index) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            return null;
          }
          const slot = entry as Record<string, unknown>;
          const minuteOfDay =
            typeof slot.minuteOfDay === "number"
              ? slot.minuteOfDay
              : typeof slot.minuteOfDay === "string"
                ? Number(slot.minuteOfDay)
                : null;
          if (minuteOfDay === null || !Number.isFinite(minuteOfDay)) {
            return null;
          }
          return {
            key:
              typeof slot.key === "string" && slot.key.trim().length > 0
                ? slot.key
                : `slot-${index + 1}`,
            label:
              typeof slot.label === "string" && slot.label.trim().length > 0
                ? slot.label
                : formatMinuteOfDayLabel(minuteOfDay),
            minuteOfDay,
            durationMinutes:
              typeof slot.durationMinutes === "number" &&
              Number.isFinite(slot.durationMinutes) &&
              slot.durationMinutes > 0
                ? slot.durationMinutes
                : 45,
          } satisfies LifeOpsDailySlot;
        })
        .filter((entry): entry is LifeOpsDailySlot => entry !== null);
      if (slots.length > 0) {
        return {
          kind: "times_per_day",
          slots,
          visibilityLeadMinutes:
            typeof record.visibilityLeadMinutes === "number"
              ? record.visibilityLeadMinutes
              : 90,
          visibilityLagMinutes:
            typeof record.visibilityLagMinutes === "number"
              ? record.visibilityLagMinutes
              : 180,
        };
      }
    }

    const count =
      typeof record.count === "number"
        ? record.count
        : typeof record.count === "string"
          ? Number(record.count)
          : NaN;
    if (Number.isFinite(count) && count > 0) {
      return {
        kind: "times_per_day",
        slots: buildDistributedDailySlots(count),
        visibilityLeadMinutes: 90,
        visibilityLagMinutes: 180,
      };
    }
  }

  if (cadenceKind === "daily") {
    const windows = normalizeLifeWindows(record.windows ?? record.window);
    if (windows.length > 0) {
      return {
        kind: "daily",
        windows,
      };
    }
    return {
      kind: "daily",
      windows: ["morning"],
    };
  }

  return undefined;
}

/**
 * Convert LLM-extracted params into a typed LifeOpsCadence.
 * Returns null when the LLM output is insufficient to construct a
 * valid cadence, letting the caller fall back to regex-derived values.
 */
function buildCadenceFromLlmParams(
  params: import("./life-param-extractor.js").ExtractedTaskParams,
  context?: {
    intent?: string;
    now?: Date;
    timeZone?: string;
  },
): {
  cadence: LifeOpsCadence;
  windowPolicy?: CreateLifeOpsDefinitionRequest["windowPolicy"];
} | null {
  const kind = params.cadenceKind;
  if (!kind) return null;
  const effectiveTimeZone = context?.timeZone;
  const timeOfDayMinute =
    typeof params.timeOfDay === "string"
      ? parseTimeOfDayToken(params.timeOfDay)
      : null;
  const explicitSlots =
    typeof context?.intent === "string"
      ? extractExplicitDailySlots(context.intent)
      : [];
  const slotDuration =
    typeof params.durationMinutes === "number" && params.durationMinutes > 0
      ? params.durationMinutes
      : 45;

  const windows = (params.windows ?? []).filter(
    (w): w is "morning" | "afternoon" | "evening" | "night" =>
      w === "morning" || w === "afternoon" || w === "evening" || w === "night",
  );
  const effectiveWindows =
    windows.length > 0
      ? windows
      : timeOfDayMinute !== null
        ? [inferWindowFromMinuteOfDay(timeOfDayMinute)]
        : ["morning" as const];

  if (kind === "once") {
    if (timeOfDayMinute !== null) {
      return {
        cadence: {
          kind: "once",
          dueAt: buildOneOffDueAtFromMinuteOfDay({
            intent: context?.intent,
            minuteOfDay: timeOfDayMinute,
            now: context?.now,
            timeZone: effectiveTimeZone,
          }),
        },
      };
    }
    return { cadence: { kind: "once", dueAt: new Date().toISOString() } };
  }
  if (kind === "daily") {
    if (explicitSlots.length >= 2) {
      return {
        cadence: {
          kind: "times_per_day",
          slots: explicitSlots.map((slot) => ({
            ...slot,
            durationMinutes: slot.durationMinutes ?? slotDuration,
          })),
          visibilityLeadMinutes: 90,
          visibilityLagMinutes: 180,
        },
      };
    }
    if (timeOfDayMinute !== null) {
      return {
        cadence: {
          kind: "times_per_day",
          slots: [buildSingleDailySlot(timeOfDayMinute, slotDuration)],
          visibilityLeadMinutes: 90,
          visibilityLagMinutes: 180,
        },
      };
    }
    if (effectiveWindows.length >= 2) {
      return {
        cadence: {
          kind: "times_per_day",
          slots: buildSlotsFromWindows(effectiveWindows),
          visibilityLeadMinutes: 90,
          visibilityLagMinutes: 180,
        },
      };
    }
    return { cadence: { kind: "daily", windows: effectiveWindows } };
  }
  if (kind === "weekly") {
    const weekdays = params.weekdays;
    if (!weekdays || weekdays.length === 0) return null;
    if (timeOfDayMinute !== null) {
      return {
        cadence: { kind: "weekly", weekdays, windows: ["custom"] },
        windowPolicy: buildCustomTimeWindowPolicy(
          timeOfDayMinute,
          effectiveTimeZone ?? resolveDefaultTimeZone(),
        ),
      };
    }
    return { cadence: { kind: "weekly", weekdays, windows: effectiveWindows } };
  }
  if (kind === "interval") {
    const everyMinutes = params.everyMinutes;
    if (!everyMinutes || everyMinutes <= 0) return null;
    return {
      cadence: {
        kind: "interval",
        everyMinutes,
        windows: effectiveWindows,
        startMinuteOfDay: timeOfDayMinute ?? undefined,
        durationMinutes:
          typeof params.durationMinutes === "number" &&
          params.durationMinutes > 0
            ? params.durationMinutes
            : undefined,
      },
    };
  }
  if (kind === "times_per_day") {
    if (explicitSlots.length >= 2) {
      return {
        cadence: {
          kind: "times_per_day",
          slots: explicitSlots.map((slot) => ({
            ...slot,
            durationMinutes: slot.durationMinutes ?? slotDuration,
          })),
          visibilityLeadMinutes: 90,
          visibilityLagMinutes: 180,
        },
      };
    }
    if (timeOfDayMinute !== null) {
      return {
        cadence: {
          kind: "times_per_day",
          slots: [buildSingleDailySlot(timeOfDayMinute, slotDuration)],
          visibilityLeadMinutes: 90,
          visibilityLagMinutes: 180,
        },
      };
    }
    const count = params.timesPerDay;
    if (!count || count <= 0) return null;
    return {
      cadence: {
        kind: "times_per_day",
        slots: buildDistributedDailySlots(count).map((slot) => ({
          ...slot,
          durationMinutes: slotDuration,
        })),
        visibilityLeadMinutes: 90,
        visibilityLagMinutes: 180,
      },
    };
  }
  return null;
}

function buildCadenceFromUpdateFields(args: {
  currentCadence: LifeOpsCadence;
  currentWindowPolicy: LifeOpsWindowPolicy;
  update: import("./life-update-extractor.js").ExtractedUpdateFields;
  timeZone: string;
}): {
  cadence: LifeOpsCadence;
  windowPolicy?: UpdateLifeOpsDefinitionRequest["windowPolicy"];
} | null {
  const { currentCadence, currentWindowPolicy, timeZone, update } = args;
  const kind = (update.cadenceKind ??
    currentCadence.kind) as LifeOpsCadence["kind"];
  const requestedWindows = normalizeLifeWindows(update.windows ?? []);
  const timeOfDayMinute =
    typeof update.timeOfDay === "string"
      ? parseTimeOfDayToken(update.timeOfDay)
      : null;

  if (kind === "interval") {
    const everyMinutes =
      update.everyMinutes ??
      (currentCadence.kind === "interval" ? currentCadence.everyMinutes : null);
    if (!everyMinutes || everyMinutes <= 0) {
      return null;
    }
    const windows: Array<"morning" | "afternoon" | "evening" | "night"> =
      requestedWindows.length > 0
        ? requestedWindows
        : currentCadence.kind === "interval" &&
            currentCadence.windows.length > 0
          ? normalizeLifeWindows(currentCadence.windows)
          : timeOfDayMinute !== null
            ? [inferWindowFromMinuteOfDay(timeOfDayMinute)]
            : ["morning"];
    return {
      cadence: {
        kind: "interval",
        everyMinutes,
        windows,
        startMinuteOfDay:
          timeOfDayMinute ??
          (currentCadence.kind === "interval"
            ? currentCadence.startMinuteOfDay
            : undefined),
        maxOccurrencesPerDay:
          currentCadence.kind === "interval"
            ? currentCadence.maxOccurrencesPerDay
            : undefined,
        durationMinutes:
          currentCadence.kind === "interval"
            ? currentCadence.durationMinutes
            : undefined,
        visibilityLeadMinutes:
          currentCadence.kind === "interval"
            ? currentCadence.visibilityLeadMinutes
            : undefined,
        visibilityLagMinutes:
          currentCadence.kind === "interval"
            ? currentCadence.visibilityLagMinutes
            : undefined,
      },
    };
  }

  if (kind === "weekly") {
    const weekdays =
      update.weekdays ??
      (currentCadence.kind === "weekly" ? currentCadence.weekdays : null);
    if (!weekdays || weekdays.length === 0) {
      return null;
    }
    if (timeOfDayMinute !== null) {
      return {
        cadence: {
          kind: "weekly",
          weekdays,
          windows: ["custom"],
          visibilityLeadMinutes:
            currentCadence.kind === "weekly"
              ? currentCadence.visibilityLeadMinutes
              : undefined,
          visibilityLagMinutes:
            currentCadence.kind === "weekly"
              ? currentCadence.visibilityLagMinutes
              : undefined,
        },
        windowPolicy: buildCustomTimeWindowPolicy(timeOfDayMinute, timeZone),
      };
    }
    return {
      cadence: {
        kind: "weekly",
        weekdays,
        windows:
          requestedWindows.length > 0
            ? requestedWindows
            : currentCadence.kind === "weekly" &&
                currentCadence.windows.length > 0
              ? currentCadence.windows
              : ["morning"],
        visibilityLeadMinutes:
          currentCadence.kind === "weekly"
            ? currentCadence.visibilityLeadMinutes
            : undefined,
        visibilityLagMinutes:
          currentCadence.kind === "weekly"
            ? currentCadence.visibilityLagMinutes
            : undefined,
      },
      windowPolicy: currentWindowPolicy.windows.some((window) =>
        (requestedWindows.length > 0
          ? requestedWindows
          : ["morning" as const]
        ).includes(
          window.name as "morning" | "afternoon" | "evening" | "night",
        ),
      )
        ? undefined
        : resolveDefaultWindowPolicy(timeZone),
    };
  }

  if (kind === "daily") {
    if (timeOfDayMinute !== null) {
      return {
        cadence: {
          kind: "times_per_day",
          slots: [buildSingleDailySlot(timeOfDayMinute)],
          visibilityLeadMinutes: 90,
          visibilityLagMinutes: 180,
        },
      };
    }
    return {
      cadence: {
        kind: "daily",
        windows:
          requestedWindows.length > 0
            ? requestedWindows
            : currentCadence.kind === "daily" &&
                currentCadence.windows.length > 0
              ? currentCadence.windows
              : ["morning"],
        visibilityLeadMinutes:
          currentCadence.kind === "daily"
            ? currentCadence.visibilityLeadMinutes
            : undefined,
        visibilityLagMinutes:
          currentCadence.kind === "daily"
            ? currentCadence.visibilityLagMinutes
            : undefined,
      },
    };
  }

  if (kind === "times_per_day") {
    if (timeOfDayMinute !== null) {
      return {
        cadence: {
          kind: "times_per_day",
          slots: [buildSingleDailySlot(timeOfDayMinute)],
          visibilityLeadMinutes: 90,
          visibilityLagMinutes: 180,
        },
      };
    }
    if (requestedWindows.length > 0) {
      return {
        cadence: {
          kind: "times_per_day",
          slots: buildSlotsFromWindows(requestedWindows),
          visibilityLeadMinutes: 90,
          visibilityLagMinutes: 180,
        },
      };
    }
    return currentCadence.kind === "times_per_day"
      ? { cadence: currentCadence }
      : null;
  }

  return currentCadence.kind === "once" ? { cadence: currentCadence } : null;
}

function hasDefinitionUpdateChanges(
  request: UpdateLifeOpsDefinitionRequest,
): boolean {
  return (
    request.title != null ||
    request.cadence != null ||
    request.priority != null ||
    request.description != null ||
    request.windowPolicy != null ||
    request.reminderPlan != null
  );
}

function buildDefaultReminderPlan(
  label: string,
): NonNullable<CreateLifeOpsDefinitionRequest["reminderPlan"]> {
  return {
    steps: [{ channel: "in_app", offsetMinutes: 0, label }],
  };
}

function scoreDefinitionTitleQuality(value: string | null | undefined): number {
  const normalized = normalizeTitle(value ?? "");
  if (!normalized) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = normalized.split(/\s+/).filter(Boolean).length;
  if (/\b\d+\b/.test(normalized)) {
    score += 6;
  }
  if (/[+&]/.test(value ?? "") || /\band\b/.test(normalized)) {
    score += 4;
  }
  if (
    /^(?:do|work out|workout|habit|routine|task|todo|reminder|alarm)\b/.test(
      normalized,
    )
  ) {
    score -= 5;
  }
  if (GENERIC_DERIVED_TITLE_RE.test(normalized)) {
    score -= 6;
  }
  return score;
}

function shouldAdoptPlannerTitle(args: {
  currentTitle: string | null | undefined;
  plannerTitle: string | null | undefined;
}): boolean {
  const plannerTitle = args.plannerTitle?.trim();
  if (!plannerTitle) {
    return false;
  }
  const currentTitle = args.currentTitle?.trim();
  if (!currentTitle) {
    return true;
  }
  if (normalizeTitle(currentTitle) === normalizeTitle(plannerTitle)) {
    return false;
  }
  return (
    scoreDefinitionTitleQuality(plannerTitle) >
    scoreDefinitionTitleQuality(currentTitle)
  );
}

function shouldAdoptPlannerCadence(args: {
  currentCadence: LifeOpsCadence | undefined;
  plannerCadence: LifeOpsCadence;
}): boolean {
  const { currentCadence, plannerCadence } = args;
  if (!currentCadence) {
    return true;
  }
  if (currentCadence.kind === "times_per_day") {
    return (
      (plannerCadence.kind === "times_per_day" &&
        plannerCadence.slots.length >= currentCadence.slots.length) ||
      (plannerCadence.kind === "once" && currentCadence.slots.length === 1)
    );
  }
  if (currentCadence.kind === "weekly") {
    return (
      plannerCadence.kind === "weekly" &&
      plannerCadence.weekdays.length >= currentCadence.weekdays.length &&
      (currentCadence.windows.includes("custom")
        ? plannerCadence.windows.includes("custom")
        : plannerCadence.windows.length >= currentCadence.windows.length)
    );
  }
  if (currentCadence.kind === "interval") {
    return plannerCadence.kind === "interval";
  }
  if (currentCadence.kind === "once") {
    return plannerCadence.kind === "once";
  }
  if (currentCadence.kind === "daily") {
    return (
      plannerCadence.kind === "times_per_day" ||
      (plannerCadence.kind === "daily" &&
        plannerCadence.windows.length >= currentCadence.windows.length)
    );
  }
  return true;
}

function shouldRequireLifeCreateConfirmation(args: {
  confirmed: boolean;
  messageSource: string | undefined;
  requestKind?: NativeAppleReminderLikeKind | null;
  cadence?: LifeOpsCadence;
}): boolean {
  if (args.messageSource === "autonomy") {
    return false;
  }
  if (args.requestKind && args.cadence?.kind === "once") {
    return false;
  }
  return !args.confirmed;
}

function describeReminderIntensity(
  intensity: LifeOpsReminderIntensity,
): string {
  switch (intensity) {
    case "minimal":
      return "minimal";
    case "normal":
      return "normal";
    case "persistent":
      return "persistent";
    case "high_priority_only":
      return "high priority only";
  }
  return "normal";
}

// ── Main action ───────────────────────────────────────

export const lifeAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: "LIFE",
  // CREATE_TASK and COMPLETE_TASK must NOT appear in similes: they are
  // the orchestrator's primary aliases, and the collision routes coding
  // prompts ("fix this bug") here by name match. LifeOps intent is still
  // covered by the todo/habit/goal/reminder similes plus description.
  similes: [
    "MANAGE_LIFEOPS",
    "QUERY_LIFEOPS",
    "CREATE_TODO",
    "ADD_TODO",
    "LIST_TODOS",
    "TODO_LIST",
    "COMPLETE_TODO",
    "CREATE_HABIT",
    "CREATE_GOAL",
    "LIFE_CREATE_DEFINITION",
    "TRACK_HABIT",
    "SET_ALARM",
    "SET_REMINDER",
    "SNOOZE_REMINDER",
    "SET_REMINDER_INTENSITY",
  ],
  description:
    "Manage the user's personal routines, habits, goals, reminders, alarms, and escalation settings through LifeOps. " +
    "USE this action for: creating, editing, or deleting tasks, habits, routines, and goals; " +
    "todo and goal requests like 'add a todo: pick up dry cleaning tomorrow', 'remember to call mom on Sunday', 'what's on my todo list today?', or 'set a goal to save $5,000 by the end of the year'; " +
    "setting one-off alarms or wake-up reminders like 'set an alarm for 7am' or 'wake me up at 7'; " +
    "helping the user actually set up follow-through when they say things like 'help me brush my teeth every day', 'i keep forgetting x', or 'help me actually do it'; " +
    "using LifeOps defaults for common routines when the user gives a natural window instead of an exact clock, like water reminders, stretch breaks, weekday-after-lunch Invisalign checks, twice-weekly shave reminders, or brushing when they wake up and before bed; " +
    "marking items as complete, skipping, or snoozing them; reviewing goal progress; " +
    "setting up phone/SMS escalation channels; adjusting reminder frequency or intensity; " +
    "querying an overview of active LifeOps items. " +
    "These are executable LifeOps items, not profile facts or bio updates. " +
    "ALWAYS use LIFE for dynamic status questions like 'what's still left for today', 'what do i still need to do today', or 'anything else in my LifeOps list', even when the conversation already mentioned tasks, because their status may have changed after a completion, snooze, or reminder. " +
    "Use LIFE for reminder/escalation policies about the owner's own follow-through, such as 'if I still haven't answered about those three events, bump me again with context instead of starting over,' when the request is about reminding the owner rather than modifying the calendar itself. " +
    "Do not fall back to REPLY, UPDATE_ENTITY, or UPDATE_OWNER_PROFILE when the user is asking to create or inspect a todo, habit, goal, reminder, or alarm. " +
    "DO NOT use this action for generic coaching or advice questions like 'any tips on setting better goals?' unless the user is also asking you to create, update, review, or track a concrete goal, task, reminder, or routine. " +
    "DO NOT use this action for person-specific follow-ups like 'remind me to follow up with David next week about the project' — use OWNER_RELATIONSHIP instead. " +
    "DO NOT use this action for Gmail inbox triage, email search, drafting or sending emails — use OWNER_INBOX with channel=gmail instead. " +
    "DO NOT use this action for daily briefs, unread summaries, drafts awaiting sign-off, or cross-channel inbox review — use OWNER_INBOX instead. " +
    "DO NOT use this action for calendar lookups, scheduling meetings, availability, Calendly, or travel itineraries — use OWNER_CALENDAR instead. " +
    "DO NOT use this action for multi-device push ladders or device-wide reminder delivery — use PUBLISH_DEVICE_INTENT instead. " +
    "DO NOT use this action for pre-event asset checklists, document-signing workflows, collecting updated ID copies, or cancellation-fee warning/escalation policies — use OWNER_INBOX, PUBLISH_DEVICE_INTENT, OWNER_CALENDAR, or LIFEOPS_COMPUTER_USE instead. " +
    "DO NOT use this action for browser/portal/file workflows on the owner's machine — use LIFEOPS_COMPUTER_USE instead. " +
    "This action provides the final grounded reply; do not pair it with a speculative REPLY action or fall back to advice-only chat when the user wants real LifeOps follow-through.",
  descriptionCompressed: "LifeOps: manage habits, goals, reminders, alarms, escalation. Create/edit/complete/snooze items. Query active status.",
  suppressPostActionContinuation: true,
  validate: async (runtime, message) => {
    const text = messageText(message);
    if (
      looksLikeGoalAdviceOnly(text) ||
      looksLikeRelationshipFollowUpRequest(text) ||
      // Coding prompts share LifeOps verbs ("make", "create", "add") so
      // the action selector can still pick LIFE. Decline here to let
      // plugin-agent-orchestrator's CREATE_TASK take the route.
      looksLikeCodingTaskRequest(text)
    ) {
      return false;
    }
    return hasLifeOpsAccess(runtime, message);
  },
  handler: async (runtime, message, state, options) => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      const fallback =
        "Life management is restricted to the owner, explicitly granted users, and the agent.";
      return {
        success: false,
        text: await renderLifeActionReply({
          runtime,
          message,
          state,
          intent: normalizeLifeInputText(messageText(message)),
          scenario: "reply_only",
          fallback,
          context: {
            reason: "access_restricted",
          },
        }),
      };
    }

    const rawParams = (options as HandlerOptions | undefined)?.parameters as
      | LifeParams
      | undefined;
    const params = rawParams ?? ({} as LifeParams);
    const currentText = normalizeLifeInputText(messageText(message));
    const details = params.details;
    const deferredDraft = latestDeferredLifeDraft(state);
    const turnsSinceDraft =
      deferredDraft != null
        ? (countTurnsSinceLatestDeferredLifeDraft(state) ?? 0) + 1
        : undefined;
    const deferredDraftFollowupMode = deferredDraft
      ? await extractDeferredLifeDraftFollowupWithLlm({
          runtime,
          message,
          state,
          currentText,
          draft: deferredDraft,
        })
      : null;
    const draftExpiryReason = deferredLifeDraftExpiryReason({
      draft: deferredDraft,
      turnsSinceDraft,
    });
    if (draftExpiryReason && deferredDraftFollowupMode === "confirm") {
      const fallback =
        "That LifeOps draft expired. Please restate it and I'll preview it again.";
      return {
        success: false,
        text: await renderLifeActionReply({
          runtime,
          message,
          state,
          intent: currentText,
          scenario: "reply_only",
          fallback,
          context: {
            reason: "draft_expired",
          },
        }),
      };
    }
    if (deferredDraftFollowupMode === "cancel") {
      const fallback = "Okay, I won't save it yet.";
      return {
        success: true,
        text: await renderLifeActionReply({
          runtime,
          message,
          state,
          intent: currentText,
          scenario: "reply_only",
          fallback,
          context: {
            reason: "draft_cancelled",
            draft: deferredDraft
              ? {
                  operation: deferredDraft.operation,
                  title: deferredDraft.request.title,
                }
              : null,
          },
        }),
        data: {
          actionName: "LIFE",
          noop: true,
        },
      };
    }
    const deferredDraftReuseMode = resolveDeferredLifeDraftReuseMode({
      details,
      draft: deferredDraft,
      explicitAction: params.action,
      llmMode: deferredDraftFollowupMode,
      turnsSinceDraft,
    });
    const reuseDeferredDraft = deferredDraftReuseMode !== null;
    const intent = reuseDeferredDraft
      ? deferredDraftReuseMode === "confirm"
        ? normalizeLifeInputText(deferredDraft?.intent ?? "")
        : normalizeLifeInputText(params.intent?.trim() ?? currentText)
      : normalizeLifeInputText(params.intent?.trim() ?? currentText);
    if (!intent) {
      const fallback = "Tell me what you want me to do.";
      return {
        success: false,
        text: await renderLifeActionReply({
          runtime,
          message,
          state,
          intent: currentText,
          scenario: "reply_only",
          fallback,
          context: {
            reason: "missing_intent",
          },
        }),
      };
    }

    const explicitOperation = params.action
      ? ACTION_TO_OPERATION[params.action]
      : undefined;
    const operationPlan =
      reuseDeferredDraft && deferredDraft
        ? {
            confidence: 1,
            missing: [] as ExtractedLifeMissingField[],
            operation: deferredDraft.operation,
            shouldAct: true,
          }
        : await resolveLifeOperationPlan({
            runtime,
            message,
            state,
            intent,
            explicitOperation,
          });
    const forceCreateExecution = shouldForceLifeCreateExecution({
      intent,
      missing: operationPlan.missing,
      operation: operationPlan.operation,
      details,
      title: params.title,
    });
    if (!operationPlan.shouldAct && !forceCreateExecution) {
      const fallback = buildLifeClarificationFallback({
        missing: operationPlan.missing,
        operation: operationPlan.operation,
      });
      return {
        success: true,
        text: await renderLifeActionReply({
          runtime,
          message,
          state,
          intent,
          scenario:
            operationPlan.operation === "create_goal"
              ? "clarify_create_goal"
              : "clarify_create_definition",
          fallback,
          context: {
            missing: operationPlan.missing,
            operation: operationPlan.operation,
          },
        }),
        data: {
          actionName: "LIFE",
          noop: true,
          suggestedOperation: operationPlan.operation,
        },
      };
    }
    const operation = forceCreateExecution
      ? "create_definition"
      : operationPlan.operation;
    if (!operation) {
      const fallback = "Tell me what LifeOps action you want me to take.";
      return {
        success: true,
        text: await renderLifeActionReply({
          runtime,
          message,
          state,
          intent,
          scenario: "reply_only",
          fallback,
          context: {
            reason: "missing_operation_after_extraction",
          },
        }),
        data: {
          actionName: "LIFE",
          noop: true,
        },
      };
    }
    const service = new LifeOpsService(runtime);
    const domain = detailString(details, "domain") as LifeOpsDomain | undefined;
    const ownership = requestedOwnership(domain);
    const chatText = intent;
    const targetName = params.target ?? params.title;
    const createConfirmed =
      deferredDraftReuseMode === "confirm" ||
      detailBoolean(details, "confirmed") === true;

    try {
      const createDefinition = async () => {
        const deferredDefinitionDraft =
          reuseDeferredDraft && deferredDraft?.operation === "create_definition"
            ? deferredDraft
            : null;
        const editingDeferredDefinitionDraft =
          deferredDraftReuseMode === "edit" &&
          deferredDefinitionDraft?.operation === "create_definition";
        const explicitCadenceDetail = normalizeCadenceDetail(
          detailObject(details, "cadence"),
        );
        const fallbackTitle = deferredDefinitionDraft?.request.title ?? null;
        let title: string | null = editingDeferredDefinitionDraft
          ? (params.title ?? fallbackTitle)
          : (fallbackTitle ?? params.title ?? null);
        const fallbackCadence = deferredDefinitionDraft?.request.cadence;
        let cadence: LifeOpsCadence | undefined = editingDeferredDefinitionDraft
          ? (explicitCadenceDetail ?? fallbackCadence ?? undefined)
          : (fallbackCadence ?? explicitCadenceDetail ?? undefined);
        let windowPolicy:
          | CreateLifeOpsDefinitionRequest["windowPolicy"]
          | undefined = editingDeferredDefinitionDraft
          ? ((detailObject(details, "windowPolicy") as unknown as
              | CreateLifeOpsDefinitionRequest["windowPolicy"]
              | undefined) ?? deferredDefinitionDraft?.request.windowPolicy)
          : (deferredDefinitionDraft?.request.windowPolicy ??
            (detailObject(details, "windowPolicy") as unknown as
              | CreateLifeOpsDefinitionRequest["windowPolicy"]
              | undefined));
        const explicitPriority = detailNumber(details, "priority");
        const explicitDescription = detailString(details, "description");
        const explicitMetadata = detailObject(details, "metadata") as
          | Record<string, unknown>
          | undefined;

        // Track whether cadence/title came from explicit high-confidence
        // sources so the planner only fills genuine gaps.
        const hadExplicitCadence = Boolean(
          (editingDeferredDefinitionDraft
            ? (explicitCadenceDetail ??
              deferredDefinitionDraft?.request.cadence)
            : deferredDefinitionDraft?.request.cadence) ??
            explicitCadenceDetail,
        );
        const hadExplicitTitle = Boolean(
          (editingDeferredDefinitionDraft
            ? params.title
            : deferredDefinitionDraft?.request.title) ?? params.title,
        );

        // ── LLM parameter enhancement (fills gaps) ────────
        // Skip when reusing a confirmed deferred draft — the user already
        // approved those values.
        let llmPlan: Awaited<
          ReturnType<typeof extractTaskCreatePlanWithLlm>
        > | null = null;
        let llmDescription: string | undefined;
        let llmPriority: number | undefined;
        let llmRequestKind: NativeAppleReminderLikeKind | null = null;
        if (!deferredDefinitionDraft || editingDeferredDefinitionDraft) {
          llmPlan = await extractTaskCreatePlanWithLlm({
            runtime,
            intent,
            state: state ?? undefined,
            message: message ?? undefined,
          });
          const shouldHonorPlannerResponse =
            llmPlan?.mode === "respond" &&
            Boolean(llmPlan.response) &&
            !editingDeferredDefinitionDraft &&
            !params.title &&
            !explicitCadenceDetail &&
            !detailString(details, "description") &&
            !detailString(details, "goalId") &&
            !detailString(details, "goalTitle") &&
            !detailString(details, "kind");
          if (shouldHonorPlannerResponse && llmPlan?.response) {
            return {
              success: true as const,
              text: llmPlan.response,
            };
          }
          if (llmPlan) {
            llmRequestKind = llmPlan.requestKind;
            if (
              !hadExplicitTitle &&
              shouldAdoptPlannerTitle({
                currentTitle: title,
                plannerTitle: llmPlan.title,
              })
            ) {
              title = llmPlan.title;
            }
            if (
              (editingDeferredDefinitionDraft || !hadExplicitCadence) &&
              llmPlan.cadenceKind
            ) {
              const llmCadenceTimeZone =
                normalizeLifeTimeZoneToken(
                  detailString(details, "timeZone") ??
                    llmPlan.timeZone ??
                    deferredDefinitionDraft?.request.timezone ??
                    windowPolicy?.timezone,
                ) ?? extractLifeTimeZoneFromText(intent);
              const llmCadence = buildCadenceFromLlmParams(llmPlan, {
                intent,
                timeZone: llmCadenceTimeZone ?? undefined,
              });
              if (
                llmCadence &&
                shouldAdoptPlannerCadence({
                  currentCadence: cadence,
                  plannerCadence: llmCadence.cadence,
                })
              ) {
                cadence = llmCadence.cadence;
                windowPolicy = llmCadence.windowPolicy ?? windowPolicy;
              }
            }
            if (!explicitDescription && llmPlan.description) {
              llmDescription = llmPlan.description;
            }
            if (explicitPriority === undefined && llmPlan.priority) {
              llmPriority = llmPlan.priority;
            }
          }
        }
        const resolvedTimeZone =
          normalizeLifeTimeZoneToken(
            detailString(details, "timeZone") ??
              llmPlan?.timeZone ??
              deferredDefinitionDraft?.request.timezone ??
              windowPolicy?.timezone,
          ) ?? extractLifeTimeZoneFromText(intent);
        const timedRequestKind = llmRequestKind;
        const nativeAppleMetadata =
          timedRequestKind && cadence?.kind === "once"
            ? buildNativeAppleReminderMetadata({
                kind: timedRequestKind,
                source: "llm",
              })
            : undefined;
        const definitionMetadata = editingDeferredDefinitionDraft
          ? mergeMetadataRecords(
              deferredDefinitionDraft?.request.metadata,
              mergeMetadataRecords(explicitMetadata, nativeAppleMetadata),
            )
          : (deferredDefinitionDraft?.request.metadata ??
            mergeMetadataRecords(explicitMetadata, nativeAppleMetadata));

        if (!title) {
          const fallback = "What should I call it?";
          return {
            success: false as const,
            text: await renderLifeActionReply({
              runtime,
              message,
              state,
              intent,
              scenario: "clarify_create_definition",
              fallback,
              context: {
                missing: ["title"],
                operation: "create_definition",
              },
            }),
          };
        }
        if (!cadence) {
          const fallback = "When should it happen?";
          return {
            success: false as const,
            text: await renderLifeActionReply({
              runtime,
              message,
              state,
              intent,
              scenario: "clarify_create_definition",
              fallback,
              context: {
                missing: ["schedule"],
                operation: "create_definition",
              },
            }),
          };
        }
        const kind =
          (editingDeferredDefinitionDraft
            ? (detailString(details, "kind") as
                | CreateLifeOpsDefinitionRequest["kind"]
                | undefined)
            : deferredDefinitionDraft?.request.kind) ??
          (detailString(details, "kind") as
            | CreateLifeOpsDefinitionRequest["kind"]
            | undefined) ??
          "habit";
        const definitionDraft: DeferredLifeDefinitionDraft = {
          intent,
          operation: "create_definition",
          createdAt: editingDeferredDefinitionDraft
            ? Date.now()
            : (deferredDefinitionDraft?.createdAt ?? Date.now()),
          request: {
            cadence,
            description:
              explicitDescription ??
              llmDescription ??
              (editingDeferredDefinitionDraft
                ? deferredDefinitionDraft?.request.description
                : undefined),
            goalRef:
              detailString(details, "goalId") ??
              detailString(details, "goalTitle") ??
              deferredDefinitionDraft?.request.goalRef ??
              undefined,
            kind,
            priority:
              explicitPriority ??
              llmPriority ??
              deferredDefinitionDraft?.request.priority,
            progressionRule:
              (detailObject(
                details,
                "progressionRule",
              ) as CreateLifeOpsDefinitionRequest["progressionRule"]) ??
              deferredDefinitionDraft?.request.progressionRule,
            reminderPlan:
              (detailObject(details, "reminderPlan") as
                | CreateLifeOpsDefinitionRequest["reminderPlan"]
                | undefined) ??
              deferredDefinitionDraft?.request.reminderPlan ??
              buildDefaultReminderPlan(`${title} reminder`),
            timezone:
              extractLifeTimeZoneFromText(intent) ??
              normalizeLifeTimeZoneToken(llmPlan?.timeZone) ??
              normalizeLifeTimeZoneToken(
                resolvedTimeZone ?? deferredDefinitionDraft?.request.timezone,
              ) ??
              resolvedTimeZone ??
              deferredDefinitionDraft?.request.timezone,
            title,
            metadata: definitionMetadata,
            windowPolicy,
            websiteAccess:
              (detailObject(details, "websiteAccess") as unknown as
                | CreateLifeOpsDefinitionRequest["websiteAccess"]
                | undefined) ?? deferredDefinitionDraft?.request.websiteAccess,
          },
        };
        if (
          shouldRequireLifeCreateConfirmation({
            confirmed: createConfirmed,
            messageSource:
              typeof message.content?.source === "string"
                ? message.content.source
                : undefined,
            requestKind: timedRequestKind,
            cadence: definitionDraft.request.cadence,
          })
        ) {
          const fallback = `I can save this as a ${definitionDraft.request.kind} named "${definitionDraft.request.title}" that happens ${summarizeCadence(definitionDraft.request.cadence)}. Confirm and I'll save it, or tell me what to change.`;
          return {
            success: true as const,
            text: await renderLifeActionReply({
              runtime,
              message,
              state,
              intent,
              scenario: "preview_definition",
              fallback,
              context: {
                draft: definitionDraft.request,
                requestKind: timedRequestKind,
              },
            }),
            data: {
              actionName: "LIFE",
              deferred: true,
              lifeDraft: definitionDraft,
              preview: {
                cadence: definitionDraft.request.cadence,
                kind: definitionDraft.request.kind,
                title: definitionDraft.request.title,
              },
            },
          };
        }
        const resolvedGoal = definitionDraft.request.goalRef
          ? await resolveGoal(service, definitionDraft.request.goalRef, domain)
          : null;

        const created = await service.createDefinition({
          ownership,
          kind: definitionDraft.request.kind,
          title: definitionDraft.request.title,
          description: definitionDraft.request.description,
          originalIntent:
            definitionDraft.intent || definitionDraft.request.title,
          cadence: definitionDraft.request.cadence,
          timezone:
            extractLifeTimeZoneFromText(definitionDraft.intent) ??
            normalizeLifeTimeZoneToken(definitionDraft.request.timezone) ??
            definitionDraft.request.timezone,
          priority: definitionDraft.request.priority,
          windowPolicy: definitionDraft.request.windowPolicy,
          progressionRule: definitionDraft.request.progressionRule,
          reminderPlan: definitionDraft.request.reminderPlan,
          metadata: definitionDraft.request.metadata,
          websiteAccess: definitionDraft.request.websiteAccess,
          goalId: resolvedGoal?.goal.id ?? null,
          source: "chat",
        });
        const fallback = `Saved "${created.definition.title}" as ${summarizeCadence(created.definition.cadence)}.`;
        return {
          success: true as const,
          text: await renderLifeActionReply({
            runtime,
            message,
            state,
            intent,
            scenario: "saved_definition",
            fallback,
            context: {
              created: {
                title: created.definition.title,
                cadence: created.definition.cadence,
              },
              requestKind: timedRequestKind,
            },
          }),
          data: toActionData(created),
        };
      };

      // ── Queries ─────────────────────────────────────

      if (
        operation === "query_calendar_today" ||
        operation === "query_calendar_next"
      ) {
        const google = await getGoogleCapabilityStatus(service);
        if (!google.hasCalendarRead) {
          return {
            success: false,
            text: calendarReadUnavailableMessage(google),
          };
        }
        if (operation === "query_calendar_next") {
          const ctx = await service.getNextCalendarEventContext(INTERNAL_URL);
          return {
            success: true,
            text: formatNextEventContext(ctx),
            data: toActionData(ctx),
          };
        }
        // The planner extracts the time window as a structured `when` param
        // ("today" | "tomorrow" | "this_week"), so we never re-parse the
        // free-form `intent` string at runtime. Default to "today" when the
        // caller omits it.
        const whenRaw = detailString(details, "when")?.toLowerCase().trim();
        const when: "today" | "tomorrow" | "this_week" =
          whenRaw === "tomorrow"
            ? "tomorrow"
            : whenRaw === "this_week" || whenRaw === "this week" || whenRaw === "week"
              ? "this_week"
              : "today";
        const range =
          when === "tomorrow"
            ? dayRange(1)
            : when === "this_week"
              ? weekRange()
              : dayRange(0);
        const label =
          when === "tomorrow"
            ? "tomorrow"
            : when === "this_week"
              ? "this week"
              : "today";
        const feed = await service.getCalendarFeed(INTERNAL_URL, {
          timeMin: range.timeMin,
          timeMax: range.timeMax,
        });
        return {
          success: true,
          text: formatCalendarFeed(feed, label),
          data: toActionData(feed),
        };
      }

      if (operation === "query_email") {
        const limit = detailNumber(details, "limit") ?? 10;
        return (
          (await gmailAction.handler?.(runtime, message, state, {
            parameters: {
              subaction: "triage",
              intent,
              details: {
                ...details,
                maxResults: limit,
              },
            },
          } as HandlerOptions)) ?? {
            success: false,
            text: "I couldn't route that Gmail request yet.",
          }
        );
      }

      if (operation === "query_overview") {
        const overview = await service.getOverview();
        const userQuery = messageText(message) || intent || "overview";
        const fallback = formatOverviewForQuery(overview, userQuery);
        return {
          success: true,
          text: await renderLifeActionReply({
            runtime,
            message,
            state,
            intent: userQuery,
            scenario: "overview",
            fallback,
            context: {
              summary: overview.owner.summary,
              occurrenceTitles: overview.owner.occurrences
                .slice(0, 6)
                .map((occurrence) => occurrence.title),
              goalTitles: overview.owner.goals
                .slice(0, 3)
                .map((goal) => goal.title),
            },
          }),
          data: toActionData(overview),
        };
      }

      // ── Mutations ───────────────────────────────────

      if (operation === "create_definition") {
        return await createDefinition();
      }

      if (operation === "create_goal") {
        const deferredGoalDraft =
          reuseDeferredDraft && deferredDraft?.operation === "create_goal"
            ? deferredDraft
            : null;
        const editingDeferredGoalDraft =
          deferredDraftReuseMode === "edit" &&
          deferredGoalDraft?.operation === "create_goal";
        const explicitDescription = detailString(details, "description");
        const explicitCadence = normalizeCadenceDetail(
          detailObject(details, "cadence"),
        ) as CreateLifeOpsGoalRequest["cadence"];
        const explicitSuccessCriteria = detailObject(
          details,
          "successCriteria",
        ) as CreateLifeOpsGoalRequest["successCriteria"] | undefined;
        const explicitSupportStrategy = detailObject(
          details,
          "supportStrategy",
        ) as CreateLifeOpsGoalRequest["supportStrategy"] | undefined;
        const explicitMetadata = detailObject(details, "metadata") as
          | CreateLifeOpsGoalRequest["metadata"]
          | undefined;
        let title: string | null = editingDeferredGoalDraft
          ? (params.title ?? deferredGoalDraft?.request.title ?? null)
          : (deferredGoalDraft?.request.title ?? params.title ?? null);
        let description: string | undefined = editingDeferredGoalDraft
          ? (explicitDescription ?? deferredGoalDraft?.request.description)
          : (deferredGoalDraft?.request.description ?? explicitDescription);
        let cadence = editingDeferredGoalDraft
          ? (explicitCadence ?? deferredGoalDraft?.request.cadence)
          : (deferredGoalDraft?.request.cadence ?? explicitCadence);
        let successCriteria = editingDeferredGoalDraft
          ? (explicitSuccessCriteria ??
            deferredGoalDraft?.request.successCriteria)
          : (deferredGoalDraft?.request.successCriteria ??
            explicitSuccessCriteria);
        let supportStrategy = editingDeferredGoalDraft
          ? (explicitSupportStrategy ??
            deferredGoalDraft?.request.supportStrategy)
          : (deferredGoalDraft?.request.supportStrategy ??
            explicitSupportStrategy);
        let goalMetadata: CreateLifeOpsGoalRequest["metadata"] | undefined =
          editingDeferredGoalDraft
            ? (explicitMetadata ?? deferredGoalDraft?.request.metadata)
            : (deferredGoalDraft?.request.metadata ?? explicitMetadata);
        let evaluationSummary: string | null = null;

        if (!deferredGoalDraft || editingDeferredGoalDraft) {
          const llmPlan = await extractGoalCreatePlanWithLlm({
            runtime,
            intent,
            state: state ?? undefined,
            message: message ?? undefined,
          });
          if (!title && llmPlan.title) {
            title = llmPlan.title;
          }
          if (!description && llmPlan.description) {
            description = llmPlan.description;
          }
          if (!cadence && llmPlan.cadence) {
            cadence = llmPlan.cadence;
          }
          if (!successCriteria && llmPlan.successCriteria) {
            successCriteria = llmPlan.successCriteria;
          }
          if (!supportStrategy && llmPlan.supportStrategy) {
            supportStrategy = llmPlan.supportStrategy;
          }
          evaluationSummary = llmPlan.evaluationSummary;
          if (
            llmPlan.groundingState === "grounded" &&
            llmPlan.successCriteria &&
            title
          ) {
            goalMetadata = mergeGoalMetadataWithGrounding({
              metadata: {
                ...(goalMetadata ?? {}),
                source: "chat",
                originalIntent: intent,
              },
              nowIso: new Date().toISOString(),
              plan: llmPlan,
            });
          }
          if (
            llmPlan.groundingState !== "grounded" ||
            !title ||
            !successCriteria ||
            !supportStrategy
          ) {
            return {
              success: true,
              text:
                llmPlan.response ??
                "What would count as success for that goal, and over what time window?",
              data: {
                actionName: "LIFE",
                noop: true,
                suggestedOperation: "create_goal",
              },
            };
          }
        }

        if (!title)
          return {
            success: false,
            text: await renderLifeActionReply({
              runtime,
              message,
              state,
              intent,
              scenario: "clarify_create_goal",
              fallback: "What are you trying to achieve?",
              context: {
                missing: ["title"],
                operation: "create_goal",
              },
            }),
          };
        const goalDraft: DeferredLifeGoalDraft = deferredGoalDraft ?? {
          intent,
          operation: "create_goal",
          createdAt: Date.now(),
          request: {
            cadence,
            description,
            metadata: goalMetadata,
            successCriteria,
            supportStrategy,
            title,
          },
        };
        if (
          shouldRequireLifeCreateConfirmation({
            confirmed: createConfirmed,
            messageSource:
              typeof message.content?.source === "string"
                ? message.content.source
                : undefined,
          })
        ) {
          const fallback = evaluationSummary
            ? `I can save "${goalDraft.request.title}" as a goal. Success looks like this: ${evaluationSummary} Confirm and I'll save it, or tell me what to change.`
            : `I can save this goal as "${goalDraft.request.title}". Confirm and I'll save it, or tell me what to change.`;
          return {
            success: true,
            text: await renderLifeActionReply({
              runtime,
              message,
              state,
              intent,
              scenario: "preview_goal",
              fallback,
              context: {
                draft: goalDraft.request,
                groundingSummary: evaluationSummary,
              },
            }),
            data: {
              actionName: "LIFE",
              deferred: true,
              lifeDraft: goalDraft,
              preview: {
                title: goalDraft.request.title,
              },
            },
          };
        }
        const created = await service.createGoal({
          ownership,
          title: goalDraft.request.title,
          description: goalDraft.request.description,
          cadence: goalDraft.request.cadence,
          supportStrategy: goalDraft.request.supportStrategy,
          successCriteria: goalDraft.request.successCriteria,
          metadata: {
            ...(goalDraft.request.metadata ?? {}),
            source: "chat",
            originalIntent: goalDraft.intent || goalDraft.request.title,
          },
        });
        const fallback = `Saved goal "${created.goal.title}".`;
        return {
          success: true,
          text: await renderLifeActionReply({
            runtime,
            message,
            state,
            intent,
            scenario: "saved_goal",
            fallback,
            context: {
              created: {
                title: created.goal.title,
                cadence: created.goal.cadence,
              },
            },
          }),
          data: toActionData(created),
        };
      }

      if (operation === "update_definition") {
        const target = await resolveDefinition(service, targetName, domain);
        if (!target)
          return {
            success: false,
            text: "I could not find that item to update.",
          };
        const request: UpdateLifeOpsDefinitionRequest = {
          ownership,
          title:
            params.title !== target.definition.title ? params.title : undefined,
          description: detailString(details, "description"),
          cadence: normalizeCadenceDetail(detailObject(details, "cadence")),
          priority: detailNumber(details, "priority"),
          windowPolicy: detailObject(
            details,
            "windowPolicy",
          ) as unknown as UpdateLifeOpsDefinitionRequest["windowPolicy"],
          reminderPlan: detailObject(
            details,
            "reminderPlan",
          ) as UpdateLifeOpsDefinitionRequest["reminderPlan"],
        };

        // If no explicit changes from structured details, try LLM extraction
        const hasExplicitChanges = hasDefinitionUpdateChanges(request);
        if (!hasExplicitChanges && intent) {
          const llmFields = await extractUpdateFieldsWithLlm({
            runtime,
            intent,
            currentTitle: target.definition.title,
            currentCadenceKind: target.definition.cadence.kind,
            currentWindows:
              target.definition.windowPolicy?.windows?.map((w) => w.name) ?? [],
          });
          if (llmFields) {
            if (llmFields.title) request.title = llmFields.title;
            if (llmFields.priority) request.priority = llmFields.priority;
            if (llmFields.description)
              request.description = llmFields.description;
            if (
              llmFields.cadenceKind ||
              llmFields.windows ||
              llmFields.weekdays ||
              llmFields.everyMinutes ||
              llmFields.timeOfDay
            ) {
              const built = buildCadenceFromUpdateFields({
                currentCadence: target.definition.cadence,
                currentWindowPolicy: target.definition.windowPolicy,
                timeZone: target.definition.timezone,
                update: llmFields,
              });
              if (built) {
                request.cadence = built.cadence;
                request.windowPolicy = built.windowPolicy;
              }
            }
          }
        }

        if (!hasDefinitionUpdateChanges(request)) {
          return {
            success: false,
            text: `Tell me what to change about "${target.definition.title}" and I'll update it.`,
          };
        }

        const updated = await service.updateDefinition(
          target.definition.id,
          request,
        );
        const fallback = `Updated "${updated.definition.title}".`;
        return {
          success: true,
          text: await renderLifeActionReply({
            runtime,
            message,
            state,
            intent,
            scenario: "updated_definition",
            fallback,
            context: {
              previousTitle: target.definition.title,
              updated: {
                title: updated.definition.title,
              },
            },
          }),
          data: toActionData(updated),
        };
      }

      if (operation === "update_goal") {
        const target = await resolveGoal(service, targetName, domain);
        if (!target)
          return {
            success: false,
            text: "I could not find that goal to update.",
          };
        const request: UpdateLifeOpsGoalRequest = {
          ownership,
          title: params.title !== target.goal.title ? params.title : undefined,
          description: detailString(details, "description"),
          cadence: normalizeCadenceDetail(
            detailObject(details, "cadence"),
          ) as unknown as UpdateLifeOpsGoalRequest["cadence"],
          supportStrategy: detailObject(details, "supportStrategy"),
          successCriteria: detailObject(details, "successCriteria"),
        };
        const hasExplicitGoalChanges =
          request.title !== undefined ||
          request.description !== undefined ||
          request.cadence !== undefined ||
          request.supportStrategy !== undefined ||
          request.successCriteria !== undefined;
        if (!hasExplicitGoalChanges) {
          const llmPlan = await extractGoalUpdatePlanWithLlm({
            runtime,
            currentGoal: target.goal,
            intent,
            state: state ?? undefined,
            message: message ?? undefined,
          });
          if (llmPlan.mode === "respond") {
            return {
              success: true,
              text:
                llmPlan.response ??
                `Tell me what to change about "${target.goal.title}" and I'll update it.`,
              data: {
                actionName: "LIFE",
                noop: true,
                suggestedOperation: "update_goal",
              },
            };
          }
          if (llmPlan.title) request.title = llmPlan.title;
          if (llmPlan.description) request.description = llmPlan.description;
          if (llmPlan.cadence) request.cadence = llmPlan.cadence;
          if (llmPlan.supportStrategy)
            request.supportStrategy = llmPlan.supportStrategy;
          if (llmPlan.successCriteria)
            request.successCriteria = llmPlan.successCriteria;
          if (llmPlan.groundingState) {
            request.metadata = mergeGoalMetadataWithGrounding({
              metadata: target.goal.metadata,
              nowIso: new Date().toISOString(),
              plan: {
                cadence: llmPlan.cadence,
                confidence: llmPlan.confidence,
                evaluationSummary: llmPlan.evaluationSummary,
                groundingState: llmPlan.groundingState,
                missingCriticalFields: llmPlan.missingCriticalFields,
                successCriteria:
                  llmPlan.successCriteria ?? target.goal.successCriteria,
                targetDomain: llmPlan.targetDomain,
              },
            });
          }
        }
        if (
          request.title === undefined &&
          request.description === undefined &&
          request.cadence === undefined &&
          request.supportStrategy === undefined &&
          request.successCriteria === undefined &&
          request.metadata === undefined
        ) {
          return {
            success: false,
            text: `Tell me what to change about "${target.goal.title}" and I'll update it.`,
          };
        }
        const updated = await service.updateGoal(target.goal.id, request);
        const fallback = `Updated goal "${updated.goal.title}".`;
        return {
          success: true,
          text: await renderLifeActionReply({
            runtime,
            message,
            state,
            intent,
            scenario: "updated_goal",
            fallback,
            context: {
              previousTitle: target.goal.title,
              updated: {
                title: updated.goal.title,
              },
            },
          }),
          data: toActionData(updated),
        };
      }

      if (operation === "delete_definition") {
        const target = await resolveDefinition(service, targetName, domain);
        if (!target)
          return {
            success: false,
            text: "I could not find that item to delete.",
          };
        await service.deleteDefinition(target.definition.id);
        const fallback = `Deleted "${target.definition.title}" and its occurrences.`;
        return {
          success: true,
          text: await renderLifeActionReply({
            runtime,
            message,
            state,
            intent,
            scenario: "deleted_definition",
            fallback,
            context: {
              deleted: {
                title: target.definition.title,
              },
            },
          }),
        };
      }

      if (operation === "delete_goal") {
        const target = await resolveGoal(service, targetName, domain);
        if (!target)
          return {
            success: false,
            text: "I could not find that goal to delete.",
          };
        await service.deleteGoal(target.goal.id);
        const fallback = `Deleted goal "${target.goal.title}".`;
        return {
          success: true,
          text: await renderLifeActionReply({
            runtime,
            message,
            state,
            intent,
            scenario: "deleted_goal",
            fallback,
            context: {
              deleted: {
                title: target.goal.title,
              },
            },
          }),
        };
      }

      if (operation === "complete_occurrence") {
        const { match: target, ambiguousCandidates } =
          await resolveOccurrenceWithIntentFallback({
            service,
            target: targetName,
            domain,
            intent,
            operation,
          });
        if (!target) {
          if (ambiguousCandidates.length > 0) {
            return {
              success: false,
              text: `Multiple items match — which one?\n${ambiguousCandidates.map((t) => `  - ${t}`).join("\n")}`,
            };
          }
          return {
            success: false,
            text: "I could not find that active item to complete.",
          };
        }
        const completed = await service.completeOccurrence(target.id, {
          note: detailString(details, "note"),
        });
        const fallback = `Marked "${completed.title}" done.`;
        return {
          success: true,
          text: await renderLifeActionReply({
            runtime,
            message,
            state,
            intent,
            scenario: "completed_occurrence",
            fallback,
            context: {
              completed: {
                title: completed.title,
              },
              note: detailString(details, "note"),
            },
          }),
          data: toActionData(completed),
        };
      }

      if (operation === "skip_occurrence") {
        const { match: target, ambiguousCandidates } =
          await resolveOccurrenceWithIntentFallback({
            service,
            target: targetName,
            domain,
            intent,
            operation,
          });
        if (!target) {
          if (ambiguousCandidates.length > 0) {
            return {
              success: false,
              text: `Multiple items match — which one?\n${ambiguousCandidates.map((t) => `  - ${t}`).join("\n")}`,
            };
          }
          return {
            success: false,
            text: "I could not find that active item to skip.",
          };
        }
        const skipped = await service.skipOccurrence(target.id);
        const fallback = `Skipped "${skipped.title}".`;
        return {
          success: true,
          text: await renderLifeActionReply({
            runtime,
            message,
            state,
            intent,
            scenario: "skipped_occurrence",
            fallback,
            context: {
              skipped: {
                title: skipped.title,
              },
            },
          }),
          data: toActionData(skipped),
        };
      }

      if (operation === "snooze_occurrence") {
        const { match: target, ambiguousCandidates } =
          await resolveOccurrenceWithIntentFallback({
            service,
            target: targetName,
            domain,
            intent,
            operation,
          });
        if (!target) {
          if (ambiguousCandidates.length > 0) {
            return {
              success: false,
              text: `Multiple items match — which one?\n${ambiguousCandidates.map((t) => `  - ${t}`).join("\n")}`,
            };
          }
          return {
            success: false,
            text: "I could not find that active item to snooze.",
          };
        }
        const preset = detailString(details, "preset") as
          | "15m"
          | "30m"
          | "1h"
          | "tonight"
          | "tomorrow_morning"
          | undefined;
        const minutes = detailNumber(details, "minutes");
        const snoozed = await service.snoozeOccurrence(target.id, {
          preset,
          minutes,
        });
        const fallback = `Snoozed "${snoozed.title}".`;
        return {
          success: true,
          text: await renderLifeActionReply({
            runtime,
            message,
            state,
            intent,
            scenario: "snoozed_occurrence",
            fallback,
            context: {
              snoozed: {
                title: snoozed.title,
              },
              preset: preset ?? null,
              minutes: minutes ?? null,
            },
          }),
          data: toActionData(snoozed),
        };
      }

      if (operation === "review_goal") {
        const target = await resolveGoal(service, targetName, domain);
        if (!target)
          return {
            success: false,
            text: "I could not find that goal to review.",
          };
        const review = await service.reviewGoal(target.goal.id);
        return {
          success: true,
          text: review.summary.explanation,
          data: toActionData(review),
        };
      }

      if (operation === "set_reminder_preference") {
        const reminderIntensityPlan = await extractReminderIntensityWithLlm({
          runtime,
          intent,
        });
        if (reminderIntensityPlan.intensity === "unknown") {
          return {
            success: false,
            text: "I need to know whether you want reminders minimal, normal, persistent, or high priority only.",
          };
        }
        const intensity = reminderIntensityPlan.intensity;
        const target = await resolveDefinitionFromIntent(
          service,
          targetName,
          intent,
          domain,
        );
        const request: SetLifeOpsReminderPreferenceRequest = {
          intensity,
          definitionId: target?.definition.id ?? null,
          note: chatText || intent,
        };
        const preference = await service.setReminderPreference(request);
        if (target) {
          const fallback =
            intensity === "high_priority_only"
              ? `Reminder intensity for "${target.definition.title}" is now high priority only.`
              : `Reminder intensity for "${target.definition.title}" is now ${describeReminderIntensity(preference.effective.intensity)}.`;
          return {
            success: true,
            text: await renderLifeActionReply({
              runtime,
              message,
              state,
              intent,
              scenario: "set_reminder_preference",
              fallback,
              context: {
                scope: "definition",
                targetTitle: target.definition.title,
                intensity: preference.effective.intensity,
              },
            }),
            data: toActionData(preference),
          };
        }
        const fallback =
          intensity === "high_priority_only"
            ? "Global LifeOps reminders are now high priority only."
            : `Global LifeOps reminders are now ${describeReminderIntensity(preference.effective.intensity)}.`;
        return {
          success: true,
          text: await renderLifeActionReply({
            runtime,
            message,
            state,
            intent,
            scenario: "set_reminder_preference",
            fallback,
            context: {
              scope: "global",
              intensity: preference.effective.intensity,
            },
          }),
          data: toActionData(preference),
        };
      }

      if (operation === "capture_phone") {
        const phoneNumber =
          detailString(details, "phoneNumber") ?? params.title;
        if (!phoneNumber)
          return {
            success: false,
            text: "I need a phone number to set up SMS or voice contact.",
          };
        const allowSms = detailBoolean(details, "allowSms") ?? true;
        const allowVoice = detailBoolean(details, "allowVoice") ?? false;
        const result = await service.capturePhoneConsent({
          phoneNumber,
          consentGiven: true,
          allowSms,
          allowVoice,
          privacyClass: "private",
        });
        const channels: string[] = [];
        if (allowSms) channels.push("SMS");
        if (allowVoice) channels.push("voice calls");
        const fallback = `Phone number ${result.phoneNumber} saved. Enabled for: ${channels.join(" and ") || "reminders"}.`;
        return {
          success: true,
          text: await renderLifeActionReply({
            runtime,
            message,
            state,
            intent,
            scenario: "captured_phone",
            fallback,
            context: {
              phoneNumber: result.phoneNumber,
              channels,
            },
          }),
          data: toActionData(result),
        };
      }

      if (operation === "configure_escalation") {
        const target = await resolveDefinition(service, targetName, domain);
        if (!target)
          return {
            success: false,
            text: "I could not find that item to configure its reminders.",
          };
        const rawSteps =
          detailArray(details, "steps") ??
          detailArray(details, "escalationSteps");
        const steps: LifeOpsReminderStep[] = rawSteps
          ? rawSteps
              .filter(
                (s): s is Record<string, unknown> =>
                  typeof s === "object" && s !== null,
              )
              .map((s) => ({
                channel: String(
                  s.channel ?? "in_app",
                ) as LifeOpsReminderStep["channel"],
                offsetMinutes:
                  typeof s.offsetMinutes === "number" ? s.offsetMinutes : 0,
                label:
                  typeof s.label === "string"
                    ? s.label
                    : String(s.channel ?? "reminder"),
              }))
          : [{ channel: "in_app", offsetMinutes: 0, label: "In-app reminder" }];
        const updated = await service.updateDefinition(target.definition.id, {
          ownership,
          reminderPlan: { steps },
        });
        const summary = steps
          .map((s) => `${s.channel} at +${s.offsetMinutes}m`)
          .join(", ");
        const fallback = `Updated reminder plan for "${updated.definition.title}": ${summary}.`;
        return {
          success: true,
          text: await renderLifeActionReply({
            runtime,
            message,
            state,
            intent,
            scenario: "configured_escalation",
            fallback,
            context: {
              targetTitle: updated.definition.title,
              steps,
            },
          }),
          data: toActionData(updated),
        };
      }

      return {
        success: false,
        text: "I didn't understand that life management request.",
      };
    } catch (err) {
      if (err instanceof LifeOpsServiceError) {
        const fallback = buildLifeServiceErrorFallback(err, intent);
        return {
          success: false,
          text: await renderLifeActionReply({
            runtime,
            message,
            state,
            intent,
            scenario: "service_error",
            fallback,
            context: {
              status: err.status,
              operation,
            },
          }),
        };
      }
      throw err;
    }
  },
  parameters: [
    {
      name: "action",
      description: "What kind of life operation to perform.",
      required: false,
      schema: {
        type: "string" as const,
        enum: [
          "create",
          "create_goal",
          "update",
          "update_goal",
          "delete",
          "delete_goal",
          "complete",
          "skip",
          "snooze",
          "review",
          "phone",
          "escalation",
          "reminder_preference",
          "calendar",
          "next_event",
          "email",
          "overview",
        ],
      },
    },
    {
      name: "intent",
      description:
        'Natural language description of what to do. Examples: "create a daily brushing habit for morning and night", "snooze brushing for 30 minutes", "what\'s on my calendar today".',
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "title",
      description:
        "Name for a new item, or the name of an existing item to act on.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "target",
      description:
        "Name or ID of an existing item when different from title (e.g., when renaming).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "details",
      description:
        "Structured data when needed. May include: cadence (schedule object), kind (task/habit/routine), description, priority, progressionRule, reminderPlan, confirmed (boolean when the user explicitly approves a previewed create), preset (snooze preset like 15m/30m/1h/tonight/tomorrow_morning), minutes (snooze minutes), phoneNumber, allowSms, allowVoice, steps (escalation steps array), goalId, goalTitle, supportStrategy, successCriteria, note, limit, domain (user_lifeops/agent_ops), or reminder preference targeting.",
      required: false,
      schema: { type: "object" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "add a todo: pick up dry cleaning tomorrow",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'I can save "Pick up dry cleaning" for tomorrow. Confirm and I\'ll save it.',
          actions: ["LIFE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "what's on my todo list today?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "You have 2 LifeOps items due today: pick up dry cleaning and call mom.",
          actions: ["LIFE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "set a goal to save $5,000 by the end of the year",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'I can save this goal as "Save $5,000 by the end of the year". Confirm and I\'ll save it, or tell me what to change.',
          actions: ["LIFE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "help me remember to drink water",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'I can set up a "Drink water" habit with a reasonable daytime default cadence. Confirm and I\'ll save it.',
          actions: ["LIFE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "help me remember to stretch during the day",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'I can set up a "Stretch" habit with daytime stretch-break defaults. Confirm and I\'ll save it.',
          actions: ["LIFE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "please remind me about my Invisalign on weekdays after lunch",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I can set up a weekday-after-lunch Invisalign habit. Confirm and I'll save it.",
          actions: ["LIFE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "recuérdame cepillarme los dientes por la mañana y por la noche",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Puedo guardar el hábito "Brush teeth" para la mañana y la noche. Confirma y lo guardo.',
          actions: ["LIFE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "help me brush my teeth at 8 am and 9 pm every day",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'I can set up a habit named "Brush teeth" for 8 am and 9 pm daily. Confirm and I\'ll save it.',
          actions: ["LIFE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Please remind me to shave twice a week.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'I can set up a "Shave" habit with a twice-weekly default cadence. Confirm and I\'ll save it.',
          actions: ["LIFE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "what life ops tasks are still left for today?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "You have 2 LifeOps tasks left for today: call mom and pay rent.",
          actions: ["LIFE"],
        },
      },
      {
        name: "{{name1}}",
        content: {
          text: "anything else in my life ops list i need to get done today?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "You have 1 LifeOps task left for today: pay rent.",
          actions: ["LIFE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "remind me less about brush teeth",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Reminder intensity for "Brush teeth" is now minimal.',
          actions: ["LIFE"],
        },
      },
    ],
  ],
};

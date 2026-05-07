/**
 * LifeOps relationships action — Rolodex management.
 *
 * Subactions: list_contacts, add_contact, log_interaction, add_follow_up,
 * complete_follow_up, follow_up_list, days_since, list_overdue_followups,
 * mark_followup_done, set_followup_threshold.
 */

import type {
  Action,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import {
  LIFEOPS_MESSAGE_CHANNELS,
  type LifeOpsMessageChannel,
} from "@elizaos/shared";
import { LifeOpsService } from "../lifeops/service.js";
import { recentConversationTexts as collectRecentConversationTexts } from "./lib/recent-context.js";
import {
  hasLifeOpsAccess,
  runLifeOpsJsonModel,
} from "./lifeops-google-helpers.js";
import {
  messageText as getMessageText,
  renderLifeOpsActionReply,
} from "./lifeops-grounded-reply.js";

type Subaction =
  | "list_contacts"
  | "add_contact"
  | "log_interaction"
  | "add_follow_up"
  | "complete_follow_up"
  | "follow_up_list"
  | "days_since"
  | "list_overdue_followups"
  | "mark_followup_done"
  | "set_followup_threshold";

type RelationshipParameters = {
  subaction?: Subaction;
  intent?: string;
  name?: string;
  channel?: LifeOpsMessageChannel;
  handle?: string;
  email?: string;
  phone?: string;
  notes?: string;
  relationshipId?: string;
  followUpId?: string;
  reason?: string;
  dueAt?: string;
  thresholdDays?: number | string;
  confirmed?: boolean;
};

function getParams(
  options: HandlerOptions | undefined,
): RelationshipParameters {
  const params = (options as HandlerOptions | undefined)?.parameters as
    | RelationshipParameters
    | undefined;
  return params ?? {};
}

function messageBodyText(message: Memory): string {
  return (message?.content?.text ?? "").toString();
}

function normalizedNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeLookup(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

async function resolveRelationshipIdByName(
  service: LifeOpsService,
  rawName: string,
): Promise<string | null> {
  const needle = normalizeLookup(rawName);
  if (!needle) {
    return null;
  }

  const relationships = await service.listRelationships({ limit: 200 });
  const exactMatch =
    relationships.find(
      (relationship) => normalizeLookup(relationship.name) === needle,
    ) ??
    relationships.find(
      (relationship) =>
        normalizeLookup(relationship.primaryHandle).includes(needle) ||
        normalizeLookup(relationship.email ?? "").includes(needle),
    );
  if (exactMatch) {
    return exactMatch.id;
  }

  return (
    relationships.find((relationship) =>
      normalizeLookup(relationship.name).includes(needle),
    )?.id ?? null
  );
}

async function resolveRelationshipIdFromText(
  service: LifeOpsService,
  rawText: string,
): Promise<string | null> {
  const haystack = normalizeLookup(rawText);
  if (!haystack) {
    return null;
  }

  const relationships = await service.listRelationships({ limit: 200 });
  const fullNameMatch = relationships.find((relationship) =>
    haystack.includes(normalizeLookup(relationship.name)),
  );
  if (fullNameMatch) {
    return fullNameMatch.id;
  }

  const candidateMatches = new Map<string, string>();
  for (const relationship of relationships) {
    const nameTokens = normalizeLookup(relationship.name)
      .split(" ")
      .filter((token) => token.length >= 3);
    const handleTokens = [
      normalizeLookup(relationship.primaryHandle).replace(/^@/, ""),
      normalizeLookup(relationship.email ?? "").split("@")[0] ?? "",
    ].filter((token) => token.length >= 3);

    for (const token of [...nameTokens, ...handleTokens]) {
      const tokenPattern = new RegExp(`\\b${escapeRegExp(token)}\\b`, "i");
      if (tokenPattern.test(rawText)) {
        candidateMatches.set(relationship.id, relationship.id);
        break;
      }
    }
  }

  if (candidateMatches.size === 1) {
    return [...candidateMatches.values()][0] ?? null;
  }

  return null;
}

async function resolveRelationshipId(
  service: LifeOpsService,
  params: Pick<RelationshipParameters, "relationshipId" | "name" | "intent">,
  body?: string,
): Promise<string | null> {
  const explicitRelationshipId = normalizedNonEmpty(params.relationshipId);
  if (explicitRelationshipId) {
    if (UUID_PATTERN.test(explicitRelationshipId)) {
      return explicitRelationshipId;
    }

    const resolvedFromRelationshipId = await resolveRelationshipIdByName(
      service,
      explicitRelationshipId,
    );
    if (resolvedFromRelationshipId) {
      return resolvedFromRelationshipId;
    }
  }

  const name = normalizedNonEmpty(params.name);
  if (!name) {
    for (const candidate of [params.intent, body]) {
      const normalizedCandidate = normalizedNonEmpty(candidate);
      const resolvedFromText = normalizedCandidate
        ? await resolveRelationshipIdFromText(service, normalizedCandidate)
        : null;
      if (resolvedFromText) {
        return resolvedFromText;
      }
    }
    return null;
  }

  const resolvedFromName = await resolveRelationshipIdByName(service, name);
  if (resolvedFromName) {
    return resolvedFromName;
  }

  return resolveRelationshipIdFromText(service, name);
}

function normalizeFollowUpDueAt(rawDueAt: string): string | null {
  const trimmed = rawDueAt.trim();
  if (!trimmed) {
    return null;
  }

  const directMs = Date.parse(trimmed);
  if (Number.isFinite(directMs)) {
    return new Date(directMs).toISOString();
  }

  const normalized = normalizeLookup(trimmed);
  const base = new Date();
  const atDefaultFollowUpTime = (date: Date): string => {
    const copy = new Date(date);
    copy.setHours(9, 0, 0, 0);
    return copy.toISOString();
  };

  if (/\btoday\b/.test(normalized)) {
    return atDefaultFollowUpTime(base);
  }
  if (/\btomorrow\b/.test(normalized)) {
    const tomorrow = new Date(base);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return atDefaultFollowUpTime(tomorrow);
  }
  if (
    /\bnext week\b/.test(normalized) ||
    /\bin a week\b/.test(normalized) ||
    /\ba week from now\b/.test(normalized)
  ) {
    const nextWeek = new Date(base);
    nextWeek.setDate(nextWeek.getDate() + 7);
    return atDefaultFollowUpTime(nextWeek);
  }

  const weekdayMap: Record<string, number> = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };
  const weekdayMatch = normalized.match(
    /\b(?:(next)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/,
  );
  if (weekdayMatch) {
    const qualifier = weekdayMatch[1] ?? "";
    const weekdayToken = weekdayMatch[2] ?? "";
    const targetWeekday = weekdayMap[weekdayToken];
    if (targetWeekday !== undefined) {
      const currentWeekday = base.getDay();
      let delta = (targetWeekday - currentWeekday + 7) % 7;
      if (qualifier === "next") {
        delta = delta === 0 ? 7 : delta + 7;
      } else if (delta === 0) {
        delta = 7;
      }
      const resolved = new Date(base);
      resolved.setDate(resolved.getDate() + delta);
      return atDefaultFollowUpTime(resolved);
    }
  }

  return null;
}

const RELATIONSHIP_SUBACTIONS: readonly Subaction[] = [
  "list_contacts",
  "add_contact",
  "log_interaction",
  "add_follow_up",
  "complete_follow_up",
  "follow_up_list",
  "days_since",
  "list_overdue_followups",
  "mark_followup_done",
  "set_followup_threshold",
];

function normalizeRelationshipSubaction(value: unknown): Subaction | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (RELATIONSHIP_SUBACTIONS as readonly string[]).includes(normalized)
    ? (normalized as Subaction)
    : null;
}

function normalizeShouldAct(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return null;
}

function normalizePlannerResponse(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

type RelationshipLlmPlan = {
  subaction: Subaction | null;
  shouldAct: boolean | null;
  response?: string;
  params?: Partial<RelationshipParameters>;
};

function normalizeMessageChannel(
  value: unknown,
): LifeOpsMessageChannel | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return LIFEOPS_MESSAGE_CHANNELS.includes(normalized as LifeOpsMessageChannel)
    ? (normalized as LifeOpsMessageChannel)
    : undefined;
}

function normalizeStringParam(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return undefined;
  return trimmed;
}

function normalizeNumberParam(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeBooleanParam(value: unknown): boolean | undefined {
  const normalized = normalizeShouldAct(value);
  return normalized === null ? undefined : normalized;
}

function relationshipParamsFromJson(
  parsed: Record<string, unknown>,
): Partial<RelationshipParameters> {
  const params: Partial<RelationshipParameters> = {};
  const channel = normalizeMessageChannel(parsed.channel);
  if (channel) params.channel = channel;

  for (const key of [
    "intent",
    "name",
    "handle",
    "email",
    "phone",
    "notes",
    "relationshipId",
    "followUpId",
    "reason",
    "dueAt",
  ] as const) {
    const value = normalizeStringParam(parsed[key]);
    if (value !== undefined) {
      params[key] = value;
    }
  }

  const thresholdDays = normalizeNumberParam(parsed.thresholdDays);
  if (thresholdDays !== undefined) {
    params.thresholdDays = thresholdDays;
  }

  const confirmed = normalizeBooleanParam(parsed.confirmed);
  if (confirmed !== undefined) {
    params.confirmed = confirmed;
  }

  return params;
}

const DEFAULT_FOLLOWUP_THRESHOLD_DAYS = 30;

type OverdueRelationshipRecord = {
  relationshipId: string;
  name: string;
  lastContactedAt: string;
  thresholdDays: number;
  daysOverdue: number;
};

function parseThresholdDays(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return null;
}

function resolveRelationshipThresholdDays(relationship: {
  metadata: Record<string, unknown>;
}): number {
  return (
    parseThresholdDays(relationship.metadata.followupThresholdDays) ??
    DEFAULT_FOLLOWUP_THRESHOLD_DAYS
  );
}

async function listOverdueRelationships(
  service: LifeOpsService,
  nowMs: number = Date.now(),
): Promise<OverdueRelationshipRecord[]> {
  const overdue: OverdueRelationshipRecord[] = [];
  const relationships = await service.listRelationships({ limit: 200 });

  for (const relationship of relationships) {
    if (!relationship.lastContactedAt) {
      continue;
    }
    const lastContactedMs = new Date(relationship.lastContactedAt).getTime();
    if (!Number.isFinite(lastContactedMs)) {
      continue;
    }
    const thresholdDays = resolveRelationshipThresholdDays(relationship);
    const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000;
    const ageMs = nowMs - lastContactedMs;
    if (ageMs <= thresholdMs) {
      continue;
    }
    overdue.push({
      relationshipId: relationship.id,
      name: relationship.name,
      lastContactedAt: relationship.lastContactedAt,
      thresholdDays,
      daysOverdue: Math.floor((ageMs - thresholdMs) / (24 * 60 * 60 * 1000)),
    });
  }

  overdue.sort((left, right) => right.daysOverdue - left.daysOverdue);
  return overdue;
}

async function resolveRelationshipPlanWithLlm(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  intent: string;
  params: RelationshipParameters;
}): Promise<RelationshipLlmPlan> {
  if (typeof args.runtime.useModel !== "function") {
    return { subaction: null, shouldAct: null };
  }

  const recentConversation = (
    await collectRecentConversationTexts({
      runtime: args.runtime,
      message: args.message,
      state: args.state,
      limit: 6,
    })
  ).join("\n");
  const currentMessage =
    typeof args.message.content?.text === "string"
      ? args.message.content.text
      : "";
  const prompt = [
    "Plan the RELATIONSHIP (Rolodex / follow-up) subaction for this request.",
    "The user may speak in any language.",
    "Return JSON only as a single object with exactly these fields:",
    "subaction: list_contacts, add_contact, log_interaction, add_follow_up, complete_follow_up, follow_up_list, days_since, list_overdue_followups, mark_followup_done, set_followup_threshold, or null",
    "shouldAct: true or false",
    "response: short clarifying question, or null",
    "intent: concise restatement of the user request, or null",
    "name: contact display name, or null",
    "channel: email, telegram, discord, signal, sms, twilio_voice, imessage, whatsapp, or null",
    "handle: primary channel handle/address, or null",
    "email: email address, or null",
    "phone: phone number, or null",
    "notes: interaction/contact notes, or null",
    "relationshipId: explicit relationship id/name, or null",
    "followUpId: explicit follow-up id, or null",
    "reason: follow-up reason, or null",
    "dueAt: due date/time in user wording or ISO, or null",
    "thresholdDays: positive integer cadence threshold, or null",
    "confirmed: true, false, or null",
    'Example: {"subaction":"add_follow_up","shouldAct":true,"response":null,"intent":"follow up with Sam tomorrow","name":"Sam","channel":null,"handle":null,"email":null,"phone":null,"notes":null,"relationshipId":null,"followUpId":null,"reason":"follow up","dueAt":"tomorrow","thresholdDays":null,"confirmed":null}',
    "",
    "Choose list_contacts when the user wants to see, browse, list, or recall who is in the Rolodex.",
    "Choose add_contact when the user wants to remember a new person, store a handle, or add them to the contact list.",
    "Choose log_interaction when the user reports a past conversation, call, meeting, or message they had with a known contact.",
    "Choose add_follow_up when the user wants to schedule a future reminder to reach out to a contact.",
    "Choose complete_follow_up when the user marks an existing follow-up as done or finished.",
    "Choose follow_up_list when the user asks what follow-ups are pending or due.",
    "Choose days_since when the user asks how long it has been since they last talked to or contacted a person.",
    "Choose list_overdue_followups when the user asks who is overdue, who they owe a follow-up to, or who they have not contacted in too long.",
    "Choose mark_followup_done when the user says they already followed up, closed the loop, or wants an overdue follow-up marked done for a contact.",
    "Choose set_followup_threshold when the user wants a durable cadence like every 14 days for a specific contact.",
    "Set shouldAct=false only when the request is too vague to safely choose any of the ten subactions.",
    "When shouldAct=false, response must be a short clarifying question in the user's language.",
    "Extract only values stated or clearly implied by the request or recent conversation. Do not invent ids, handles, dates, or thresholds.",
    "For add_contact, extract name plus channel and handle when present.",
    "For add_follow_up, extract name/relationshipId, reason, and dueAt when present.",
    "For set_followup_threshold, extract name/relationshipId and thresholdDays.",
    "",
    `Current request:\n${currentMessage}`,
    `Resolved intent:\n${args.intent}`,
    `Structured parameters:\n${Object.entries(args.params)
      .map(([key, value]) => `${key}: ${String(value)}`)
      .join("\n")}`,
    `Recent conversation:\n${recentConversation}`,
  ].join("\n");

  const result = await runLifeOpsJsonModel<Record<string, unknown>>({
    runtime: args.runtime,
    prompt,
    actionType: "RELATIONSHIP.plan",
    failureMessage: "Relationship planning model call failed",
    source: "action:relationships",
    modelType: ModelType.TEXT_SMALL,
    purpose: "planner",
  });
  const parsed = result?.parsed;
  if (!parsed) {
    return { subaction: null, shouldAct: null };
  }
  const subaction = normalizeRelationshipSubaction(parsed.subaction);
  return {
    subaction,
    shouldAct: subaction ? true : normalizeShouldAct(parsed.shouldAct),
    response: normalizePlannerResponse(parsed.response),
    params: relationshipParamsFromJson(parsed),
  };
}

function formatRelationshipLine(rel: {
  name: string;
  primaryChannel: string;
  primaryHandle: string;
  lastContactedAt: string | null;
}): string {
  const last = rel.lastContactedAt
    ? ` — last contacted ${rel.lastContactedAt}`
    : " — no contact logged";
  return `- ${rel.name} (${rel.primaryChannel}: ${rel.primaryHandle})${last}`;
}

export const relationshipAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: "RELATIONSHIP",
  similes: [
    "CONTACTS",
    "ROLODEX",
    "FOLLOW_UPS",
    "LOG_INTERACTION",
    "ADD_CONTACT",
    "DAYS_SINCE",
    "OVERDUE_FOLLOWUPS",
    "MARK_FOLLOWUP_DONE",
  ],
  description:
    "Owner-only. Contacts / rolodex / follow-up tracker. The owner's people graph: list/add contacts, log interactions, ask how long since the owner talked to someone, create or complete a follow-up, list overdue follow-ups, tune the overdue threshold.",
  descriptionCompressed:
    "contacts rolodex follow-ups: list_contacts add_contact log_interaction add_follow_up complete_follow_up follow_up_list days_since list_overdue_followups mark_followup_done set_followup_threshold",
  contexts: ["contacts", "tasks", "calendar", "messaging"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state,
    options,
    callback,
  ): Promise<ActionResult> => {
    const intent = getMessageText(message).trim();

    const respond = async <
      T extends NonNullable<ActionResult["data"]> | undefined,
    >(payload: {
      success: boolean;
      scenario: string;
      fallback: string;
      context?: Record<string, unknown>;
      data?: T;
      values?: ActionResult["values"];
    }): Promise<ActionResult> => {
      const text = await renderLifeOpsActionReply({
        runtime,
        message,
        state,
        intent,
        scenario: payload.scenario,
        fallback: payload.fallback,
        context: payload.context,
      });
      await callback?.({
        text,
        source: "action",
        action: "RELATIONSHIP",
      });
      return {
        text,
        success: payload.success,
        ...(payload.values ? { values: payload.values } : {}),
        ...(payload.data ? { data: payload.data } : {}),
      };
    };

    if (!(await hasLifeOpsAccess(runtime, message))) {
      return respond({
        success: false,
        scenario: "access_denied",
        fallback: "Relationship management is restricted to the owner.",
        data: { error: "PERMISSION_DENIED" },
      });
    }

    const rawParams = getParams(options);
    let params = rawParams;
    const body = messageBodyText(message);
    const explicitSubaction = normalizeRelationshipSubaction(params.subaction);
    let subaction: Subaction | null = explicitSubaction;
    if (!subaction) {
      const planIntent = (params.intent ?? body).trim();
      const plan = await resolveRelationshipPlanWithLlm({
        runtime,
        message,
        state,
        intent: planIntent,
        params,
      });
      subaction = plan.subaction;
      params = {
        ...plan.params,
        ...rawParams,
        ...(subaction ? { subaction } : {}),
      };
      if (plan.shouldAct === false || !subaction) {
        const fallback =
          plan.response ??
          "Tell me whether you want to list contacts, add a contact, log an interaction, schedule a follow-up, complete a follow-up, list overdue follow-ups, change a follow-up threshold, or check days since last contact.";
        return respond({
          success: false,
          scenario: "planner_clarification",
          fallback,
          context: { suggestedSubaction: subaction },
          values: {
            success: false,
            error: "PLANNER_SHOULDACT_FALSE",
            noop: true,
            suggestedSubaction: subaction,
          },
          data: {
            noop: true,
            error: "PLANNER_SHOULDACT_FALSE",
            suggestedSubaction: subaction,
          },
        });
      }
    }
    const service = new LifeOpsService(runtime);

    if (subaction === "list_contacts") {
      const contacts = await service.listRelationships({ limit: 50 });
      const fallback =
        contacts.length === 0
          ? "You have no contacts in your Rolodex yet."
          : `You have ${contacts.length} contact${contacts.length === 1 ? "" : "s"}:\n${contacts.map(formatRelationshipLine).join("\n")}`;
      return respond({
        success: true,
        scenario: "relationship_list_contacts",
        fallback,
        context: { contactCount: contacts.length },
        data: { subaction, contacts },
      });
    }

    if (subaction === "add_contact") {
      const name = params.name;
      const channel = params.channel;
      const handle = params.handle;
      if (!name || !channel || !handle) {
        return respond({
          success: false,
          scenario: "relationship_add_missing_fields",
          fallback:
            "To add a contact I need at least a name, a primary channel, and a handle.",
          data: { subaction, error: "MISSING_FIELDS" },
        });
      }
      if (!LIFEOPS_MESSAGE_CHANNELS.includes(channel)) {
        return respond({
          success: false,
          scenario: "relationship_add_invalid_channel",
          fallback: `Unknown channel '${channel}'. Supported: ${LIFEOPS_MESSAGE_CHANNELS.join(", ")}.`,
          context: { channel },
          data: { subaction, error: "INVALID_CHANNEL" },
        });
      }
      const rel = await service.upsertRelationship({
        name,
        primaryChannel: channel,
        primaryHandle: handle,
        email: params.email ?? null,
        phone: params.phone ?? null,
        notes: params.notes ?? "",
        tags: [],
        relationshipType: "contact",
        lastContactedAt: null,
        metadata: {},
      });
      return respond({
        success: true,
        scenario: "relationship_add_contact",
        fallback: `Added ${rel.name} (${rel.primaryChannel}: ${rel.primaryHandle}) to your Rolodex.`,
        context: {
          name: rel.name,
          channel: rel.primaryChannel,
          handle: rel.primaryHandle,
        },
        data: { subaction, relationship: rel },
      });
    }

    if (subaction === "log_interaction") {
      const relationshipId = await resolveRelationshipId(service, params, body);
      if (!relationshipId) {
        return respond({
          success: false,
          scenario: "relationship_log_missing_id",
          fallback: "I need a known contact to log an interaction.",
          data: { subaction, error: "MISSING_RELATIONSHIP_ID" },
        });
      }
      const rel = await service.getRelationship(relationshipId);
      if (!rel) {
        return respond({
          success: false,
          scenario: "relationship_log_not_found",
          fallback: `No contact found with id ${relationshipId}.`,
          context: { relationshipId },
          data: { subaction, error: "NOT_FOUND" },
        });
      }
      const channel = params.channel ?? rel.primaryChannel;
      const interaction = await service.logInteraction({
        relationshipId,
        channel,
        direction: "outbound",
        summary: params.notes ?? params.reason ?? "",
        occurredAt: new Date().toISOString(),
        metadata: {},
      });
      return respond({
        success: true,
        scenario: "relationship_log_interaction",
        fallback: `Logged interaction with ${rel.name} on ${channel}.`,
        context: { name: rel.name, channel },
        data: { subaction, interaction },
      });
    }

    if (subaction === "add_follow_up") {
      const relationshipId = await resolveRelationshipId(service, params, body);
      const dueAtSource = normalizedNonEmpty(params.dueAt) ?? body;
      const dueAt = dueAtSource ? normalizeFollowUpDueAt(dueAtSource) : null;
      const reason = params.reason ?? params.notes ?? "";
      if (!relationshipId || !dueAt) {
        const fallback = !relationshipId
          ? "I need a known contact to schedule a follow-up."
          : "I need a due date or time to schedule a follow-up.";
        // Selection + execution were correct: the user asked to add a
        // follow-up, the action ran, and we're now waiting on the user to
        // disambiguate the contact or supply a due date. Mark as
        // awaiting-confirmation.
        return respond({
          success: false,
          scenario: "relationship_add_followup_missing",
          fallback,
          context: { hasRelationshipId: Boolean(relationshipId) },
          values: { requiresConfirmation: true },
          data: {
            subaction,
            error: "MISSING_FIELDS",
            requiresConfirmation: true,
          },
        });
      }
      const followUp = await service.createFollowUp({
        relationshipId,
        dueAt,
        reason,
        priority: 3,
        draft: null,
        completedAt: null,
        metadata: {},
      });
      return respond({
        success: true,
        scenario: "relationship_add_followup",
        fallback: `Scheduled follow-up for ${dueAt}: ${reason || "(no reason)"}.`,
        context: { dueAt, reason: reason || null },
        data: { subaction, followUp },
      });
    }

    if (subaction === "complete_follow_up") {
      const followUpId = params.followUpId;
      if (!followUpId) {
        return respond({
          success: false,
          scenario: "relationship_complete_followup_missing_id",
          fallback: "I need the followUpId to complete.",
          data: { subaction, error: "MISSING_FOLLOW_UP_ID" },
        });
      }
      await service.completeFollowUp(followUpId);
      return respond({
        success: true,
        scenario: "relationship_complete_followup",
        fallback: `Marked follow-up ${followUpId} as completed.`,
        context: { followUpId },
        data: { subaction, followUpId },
      });
    }

    if (subaction === "follow_up_list") {
      const queue = await service.getDailyFollowUpQueue({ limit: 50 });
      const fallback =
        queue.length === 0
          ? "No follow-ups due today."
          : `You have ${queue.length} follow-up${queue.length === 1 ? "" : "s"} due:\n${queue
              .map((fu) => `- ${fu.dueAt} — ${fu.reason} (id: ${fu.id})`)
              .join("\n")}`;
      return respond({
        success: true,
        scenario: "relationship_followup_list",
        fallback,
        context: { dueCount: queue.length },
        data: { subaction, followUps: queue },
      });
    }

    if (subaction === "days_since") {
      const relationshipId = await resolveRelationshipId(service, params, body);
      if (!relationshipId) {
        return respond({
          success: false,
          scenario: "relationship_days_since_missing_id",
          fallback: "I need a known contact to check last contact.",
          data: { subaction, error: "MISSING_RELATIONSHIP_ID" },
        });
      }
      const rel = await service.getRelationship(relationshipId);
      const days = await service.getDaysSinceContact(relationshipId);
      const fallback =
        days === null
          ? `No contact has been logged with ${rel?.name ?? relationshipId}.`
          : `It has been ${days} day${days === 1 ? "" : "s"} since you contacted ${rel?.name ?? relationshipId}.`;
      return respond({
        success: true,
        scenario: "relationship_days_since",
        fallback,
        context: { name: rel?.name ?? null, days },
        data: { subaction, relationshipId, days },
      });
    }

    if (subaction === "list_overdue_followups") {
      const overdue = await listOverdueRelationships(service);
      const fallback =
        overdue.length === 0
          ? "No overdue follow-ups."
          : `Overdue follow-ups (${overdue.length}):\n${overdue
              .map(
                (entry) =>
                  `- ${entry.name}: last contacted ${entry.lastContactedAt} (+${entry.daysOverdue}d over ${entry.thresholdDays}d threshold)`,
              )
              .join("\n")}`;
      return respond({
        success: true,
        scenario: "relationship_overdue_list",
        fallback,
        context: { overdueCount: overdue.length },
        data: { subaction, overdue },
      });
    }

    if (subaction === "mark_followup_done") {
      const relationshipId = await resolveRelationshipId(service, params, body);
      if (!relationshipId) {
        return respond({
          success: false,
          scenario: "relationship_mark_done_missing_id",
          fallback: "I need a known contact to mark that follow-up done.",
          data: { subaction, error: "MISSING_RELATIONSHIP_ID" },
        });
      }
      const relationship = await service.getRelationship(relationshipId);
      if (!relationship) {
        return respond({
          success: false,
          scenario: "relationship_mark_done_not_found",
          fallback: `No contact found with id ${relationshipId}.`,
          context: { relationshipId },
          data: { subaction, error: "NOT_FOUND" },
        });
      }
      const nowIso = new Date().toISOString();
      await service.upsertRelationship({
        id: relationship.id,
        name: relationship.name,
        primaryChannel: relationship.primaryChannel,
        primaryHandle: relationship.primaryHandle,
        email: relationship.email,
        phone: relationship.phone,
        notes: relationship.notes,
        tags: relationship.tags,
        relationshipType: relationship.relationshipType,
        lastContactedAt: nowIso,
        metadata: {
          ...relationship.metadata,
          lastFollowupNote: params.notes ?? params.reason ?? null,
        },
      });
      const pendingFollowUps = (
        await service.listFollowUps({ status: "pending", limit: 100 })
      ).filter((followUp) => followUp.relationshipId === relationship.id);
      for (const followUp of pendingFollowUps) {
        await service.completeFollowUp(followUp.id);
      }
      const fallback =
        pendingFollowUps.length > 0
          ? `Marked ${relationship.name} as followed up and completed ${pendingFollowUps.length} open follow-up${pendingFollowUps.length === 1 ? "" : "s"}.`
          : `Marked ${relationship.name} as followed up.`;
      return respond({
        success: true,
        scenario: "relationship_mark_done",
        fallback,
        context: {
          name: relationship.name,
          completedCount: pendingFollowUps.length,
        },
        data: {
          subaction,
          relationshipId: relationship.id,
          completedFollowUpIds: pendingFollowUps.map((followUp) => followUp.id),
          lastContactedAt: nowIso,
        },
      });
    }

    if (subaction === "set_followup_threshold") {
      const relationshipId = await resolveRelationshipId(service, params, body);
      const thresholdDays = parseThresholdDays(params.thresholdDays);
      if (!relationshipId || thresholdDays === null) {
        const fallback = !relationshipId
          ? "I need a known contact to change the follow-up threshold."
          : "I need a positive threshold in days.";
        return respond({
          success: false,
          scenario: "relationship_set_threshold_missing",
          fallback,
          context: { hasRelationshipId: Boolean(relationshipId) },
          data: { subaction, error: "MISSING_FIELDS" },
        });
      }
      const relationship = await service.getRelationship(relationshipId);
      if (!relationship) {
        return respond({
          success: false,
          scenario: "relationship_set_threshold_not_found",
          fallback: `No contact found with id ${relationshipId}.`,
          context: { relationshipId },
          data: { subaction, error: "NOT_FOUND" },
        });
      }
      await service.upsertRelationship({
        id: relationship.id,
        name: relationship.name,
        primaryChannel: relationship.primaryChannel,
        primaryHandle: relationship.primaryHandle,
        email: relationship.email,
        phone: relationship.phone,
        notes: relationship.notes,
        tags: relationship.tags,
        relationshipType: relationship.relationshipType,
        lastContactedAt: relationship.lastContactedAt,
        metadata: {
          ...relationship.metadata,
          followupThresholdDays: thresholdDays,
        },
      });
      return respond({
        success: true,
        scenario: "relationship_set_threshold",
        fallback: `Set follow-up threshold for ${relationship.name} to ${thresholdDays} days.`,
        context: { name: relationship.name, thresholdDays },
        data: { subaction, relationshipId: relationship.id, thresholdDays },
      });
    }

    return respond({
      success: false,
      scenario: "relationship_unknown_subaction",
      fallback: `Unknown relationship subaction: ${subaction}.`,
      context: { subaction },
      data: { error: "UNKNOWN_SUBACTION", subaction },
    });
  },
  parameters: [
    {
      name: "subaction",
      description:
        "Which relationship operation to run: list_contacts, add_contact, log_interaction, add_follow_up, complete_follow_up, follow_up_list, days_since, list_overdue_followups, mark_followup_done, or set_followup_threshold.",
      schema: { type: "string" as const },
    },
    {
      name: "intent",
      description:
        "Free-form user intent used to infer subaction when not set.",
      schema: { type: "string" as const },
    },
    {
      name: "name",
      description:
        "Contact display name. When relationshipId is omitted, the handler resolves an existing contact by this name.",
      schema: { type: "string" as const },
    },
    {
      name: "channel",
      description:
        "Primary channel for the contact (email, telegram, discord, signal, sms, twilio_voice, imessage, whatsapp).",
      schema: { type: "string" as const },
    },
    {
      name: "handle",
      description: "Primary handle/address on the chosen channel.",
      schema: { type: "string" as const },
    },
    {
      name: "email",
      description: "Optional email address for the contact.",
      schema: { type: "string" as const },
    },
    {
      name: "phone",
      description: "Optional phone number for the contact.",
      schema: { type: "string" as const },
    },
    {
      name: "notes",
      description: "Free-form notes or interaction summary.",
      schema: { type: "string" as const },
    },
    {
      name: "relationshipId",
      description: "Target relationship id.",
      schema: { type: "string" as const },
    },
    {
      name: "followUpId",
      description: "Target follow-up id.",
      schema: { type: "string" as const },
    },
    {
      name: "reason",
      description: "Reason or purpose for a follow-up.",
      schema: { type: "string" as const },
    },
    {
      name: "dueAt",
      description:
        "Follow-up due time. Accepts natural language like 'tomorrow', 'next week', or 'next Tuesday at 3pm', or an ISO-8601 timestamp.",
      schema: { type: "string" as const },
    },
    {
      name: "thresholdDays",
      description:
        "Durable overdue threshold in days for this contact. Use for cadence rules like every 14 days.",
      schema: { type: "number" as const },
    },
    {
      name: "confirmed",
      description: "Optional explicit confirmation flag.",
      schema: { type: "boolean" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Show me my contacts." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "You have 3 contacts: ...",
          action: "RELATIONSHIP",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Add Alice to my Rolodex, her Telegram handle is @alice.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Added Alice (telegram: @alice) to your Rolodex.",
          action: "RELATIONSHIP",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Log that I spoke with Bob today about the project.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Logged interaction with Bob on telegram.",
          action: "RELATIONSHIP",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Remind me to follow up with Carol next Monday about the contract.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Scheduled follow-up for 2026-04-20T09:00:00Z: the contract.",
          action: "RELATIONSHIP",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "What follow-ups do I have today?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "You have 2 follow-ups due: ...",
          action: "RELATIONSHIP",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "How long has it been since I talked to Dan?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "It has been 14 days since you contacted Dan.",
          action: "RELATIONSHIP",
        },
      },
    ],
  ],
};

/**
 * LifeOps `ENTITY` umbrella action.
 *
 * Canonical subactions (entity / relationship CRUD):
 *   - `add`              add a person/entity to the contacts/Rolodex
 *   - `list`             list known entities
 *   - `set_identity`     observe a (platform, handle) identity for an entity
 *   - `set_relationship` upsert a typed edge between two entities
 *   - `log_interaction`  record an outbound/inbound interaction
 *   - `merge`            merge duplicate entities
 *
 * Follow-up cadence (`add_follow_up`, `complete_follow_up`,
 * `follow_up_list`, `days_since`, `list_overdue_followups`,
 * `mark_followup_done`, `set_followup_threshold`) lives on `SCHEDULED_TASK`.
 * The legacy `RELATIONSHIP` umbrella name is preserved as a simile so the
 * planner does not regress on cached prompts.
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
import { hasLifeOpsAccess } from "../lifeops/access.js";
import { runLifeOpsJsonModel } from "../lifeops/google/format-helpers.js";
import {
  messageText as getMessageText,
  renderLifeOpsActionReply,
} from "../lifeops/voice/grounded-reply.js";
import { LifeOpsRepository } from "../lifeops/repository.js";

type Subaction =
  | "create"
  | "read"
  | "log_interaction"
  | "set_identity"
  | "set_relationship"
  | "merge";

type EntityParameters = {
  subaction?: Subaction;
  /** Alias for `subaction` accepted from the planner's `action` field. */
  action?: Subaction;
  intent?: string;
  name?: string;
  channel?: LifeOpsMessageChannel;
  handle?: string;
  email?: string;
  phone?: string;
  notes?: string;
  relationshipId?: string;
  reason?: string;
  confirmed?: boolean;
  /** Target entity id for set_identity/set_relationship/merge. */
  entityId?: string;
  /** Optional explicit platform when calling set_identity. */
  platform?: string;
  /** Display name shown for an observed identity. */
  displayName?: string;
  /** Edge target id when calling set_relationship. */
  toEntityId?: string;
  /** Edge source id when calling set_relationship. Defaults to "self". */
  fromEntityId?: string;
  /** Edge type label when calling set_relationship (e.g. "manages"). */
  relationshipType?: string;
  /** Source entity ids consumed when calling merge. */
  sourceEntityIds?: string[];
  /** Free-form evidence string for set_identity/set_relationship. */
  evidence?: string;
};

function getParams(options: HandlerOptions | undefined): EntityParameters {
  const params = (options as HandlerOptions | undefined)?.parameters as
    | EntityParameters
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
  params: Pick<EntityParameters, "relationshipId" | "name" | "intent">,
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

const ENTITY_SUBACTIONS: readonly Subaction[] = [
  "create",
  "read",
  "log_interaction",
  "set_identity",
  "set_relationship",
  "merge",
];

/**
 * Map legacy verb names (`add`, `list`) to their canonical replacements so
 * older callers continue to resolve. These aliases live in the dispatcher
 * only; the schema enum exposes the canonical names.
 */
const LEGACY_SUBACTION_ALIASES: Record<string, Subaction> = {
  add: "create",
  list: "read",
};

function normalizeRelationshipSubaction(value: unknown): Subaction | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if ((ENTITY_SUBACTIONS as readonly string[]).includes(normalized)) {
    return normalized as Subaction;
  }
  const aliased = LEGACY_SUBACTION_ALIASES[normalized];
  return aliased ?? null;
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

type EntityLlmPlan = {
  subaction: Subaction | null;
  shouldAct: boolean | null;
  response?: string;
  params?: Partial<EntityParameters>;
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

function normalizeBooleanParam(value: unknown): boolean | undefined {
  const normalized = normalizeShouldAct(value);
  return normalized === null ? undefined : normalized;
}

function entityParamsFromJson(
  parsed: Record<string, unknown>,
): Partial<EntityParameters> {
  const params: Partial<EntityParameters> = {};
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
    "reason",
    "entityId",
    "platform",
    "displayName",
    "toEntityId",
    "fromEntityId",
    "relationshipType",
    "evidence",
  ] as const) {
    const value = normalizeStringParam(parsed[key]);
    if (value !== undefined) {
      params[key] = value;
    }
  }

  const sourceEntityIds = parsed.sourceEntityIds;
  if (Array.isArray(sourceEntityIds)) {
    const filtered = sourceEntityIds
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (filtered.length > 0) {
      params.sourceEntityIds = filtered;
    }
  }

  const confirmed = normalizeBooleanParam(parsed.confirmed);
  if (confirmed !== undefined) {
    params.confirmed = confirmed;
  }

  return params;
}

async function resolveEntityPlanWithLlm(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  intent: string;
  params: EntityParameters;
}): Promise<EntityLlmPlan> {
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
    "Plan the ENTITY (people / relationships) action for this request.",
    "The user may speak in any language.",
    "Return JSON only as a single object with exactly these fields:",
    "action: create, read, log_interaction, set_identity, set_relationship, merge, or null",
    "shouldAct: true or false",
    "response: short clarifying question, or null",
    "intent: concise restatement of the user request, or null",
    "name: contact/entity display name, or null",
    "channel: email, telegram, discord, signal, sms, twilio_voice, imessage, whatsapp, or null",
    "handle: primary channel handle/address, or null",
    "email: email address, or null",
    "phone: phone number, or null",
    "notes: interaction/contact notes, or null",
    "relationshipId: explicit relationship id/name, or null",
    "reason: short reason note, or null",
    "confirmed: true, false, or null",
    "entityId: explicit entity id (set_identity / set_relationship / merge), or null",
    "platform: identity platform (set_identity), or null",
    "displayName: identity display name (set_identity), or null",
    "toEntityId: target entity id (set_relationship), or null",
    "fromEntityId: source entity id (set_relationship; defaults to 'self' when omitted), or null",
    "relationshipType: edge type label (set_relationship; e.g. 'manages', 'colleague_of', 'works_at'), or null",
    "sourceEntityIds: array of duplicate entity ids to fold into the target (merge), or null",
    "evidence: short evidence string for set_identity / set_relationship, or null",
    'Example: {"action":"create","shouldAct":true,"response":null,"intent":"add Sam to my Rolodex","name":"Sam","channel":"telegram","handle":"@sam","email":null,"phone":null,"notes":null,"relationshipId":null,"reason":null,"confirmed":null,"entityId":null,"platform":null,"displayName":null,"toEntityId":null,"fromEntityId":null,"relationshipType":null,"sourceEntityIds":null,"evidence":null}',
    "",
    "Choose read when the user wants to see, browse, list, or recall who is in the contacts/Rolodex.",
    "Choose create when the user wants to remember a new person, store a handle, or add them to the contact list.",
    "Choose log_interaction when the user reports a past conversation, call, meeting, or message they had with a known contact.",
    "Choose set_identity when the user adds a (platform, handle) for an existing entity, e.g. 'Pat's Slack handle is @pat'.",
    "Choose set_relationship when the user describes a typed edge between two entities, e.g. 'Pat is my manager', 'Sam works at Acme', 'Carol is my colleague'.",
    "Choose merge when the user says two contact entries are the same person and should be combined.",
    "If the user wants to schedule, list, or close a follow-up cadence, set shouldAct=false and tell them to use SCHEDULED_TASKS - that umbrella owns follow-up verbs.",
    "Set shouldAct=false only when the request is too vague to safely choose any of the actions.",
    "When shouldAct=false, response must be a short clarifying question in the user's language.",
    "Extract only values stated or clearly implied by the request or recent conversation. Do not invent ids, handles, or notes.",
    "For create, extract name plus channel and handle when present.",
    "For set_identity, extract entityId or name plus platform and handle.",
    "For set_relationship, extract fromEntityId/toEntityId or names plus relationshipType.",
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
    actionType: "ENTITY.plan",
    failureMessage: "Entity planning model call failed",
    source: "action:entity",
    modelType: ModelType.TEXT_SMALL,
    purpose: "planner",
  });
  const parsed = result?.parsed;
  if (!parsed) {
    return { subaction: null, shouldAct: null };
  }
  const subaction = normalizeRelationshipSubaction(
    parsed.action ?? parsed.subaction,
  );
  return {
    subaction,
    shouldAct: subaction ? true : normalizeShouldAct(parsed.shouldAct),
    response: normalizePlannerResponse(parsed.response),
    params: entityParamsFromJson(parsed),
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

export const entityAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: "ENTITY",
  similes: [
    // Wave-2 W2-A: RELATIONSHIP is preserved as a one-release simile so
    // the planner does not regress on cached prompts.
    "RELATIONSHIP",
    "CONTACTS",
    "ROLODEX",
    "LOG_INTERACTION",
    "ADD_ENTITY",
    "ADD_PERSON",
    "MERGE_ENTITIES",
    "MERGE_CONTACTS",
    "SET_IDENTITY",
    "SET_RELATIONSHIP",
  ],
  description:
    "Manage people, organizations, projects, and concepts the owner cares about, plus typed relationships between them. Subactions: create, read, set_identity, set_relationship, log_interaction, merge. For rolodex/contact lifecycle (CRUD on a single contact's profile) use CONTACT; ENTITY is the owner-graph umbrella for identity, relationships, and interaction history. Use SCHEDULED_TASK for follow-up cadence; use LIFE for one-off dated reminders to call/text someone.",
  descriptionCompressed:
    "people+relationships: create|read|set_identity|set_relationship|log_interaction|merge; rolodex CRUD → CONTACT; follow-up cadence → SCHEDULED_TASK",
  routingHint:
    'people/contacts/relationships ("add Pat to my contacts", "Pat is my manager") -> ENTITY; follow-up cadence ("follow up with David", "how long since I talked to X", "who is overdue") -> SCHEDULED_TASK; one-off dated reminders to call/text someone ("remember to call mom Sunday") -> LIFE',
  tags: [
    "domain:contacts",
    "capability:read",
    "capability:write",
    "capability:update",
    "capability:delete",
    "surface:internal",
  ],
  contexts: ["contacts", "tasks", "calendar", "messaging", "memory"],
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
        action: "ENTITY",
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
    const explicitSubaction = normalizeRelationshipSubaction(
      params.action ?? params.subaction,
    );
    let subaction: Subaction | null = explicitSubaction;
    if (!subaction) {
      const planIntent = (params.intent ?? body).trim();
      const plan = await resolveEntityPlanWithLlm({
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
          "Tell me whether you want to list contacts, add a contact, log an interaction, set an identity, set a relationship, or merge duplicates. (Follow-up scheduling lives on SCHEDULED_TASK.)";
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

    if (subaction === "read") {
      const contacts = await service.listRelationships({ limit: 50 });
      const fallback =
        contacts.length === 0
          ? "You have no contacts in your Rolodex yet."
          : `You have ${contacts.length} contact${contacts.length === 1 ? "" : "s"}:\n${contacts.map(formatRelationshipLine).join("\n")}`;
      return respond({
        success: true,
        scenario: "entity_list",
        fallback,
        context: { contactCount: contacts.length },
        data: { subaction, contacts },
      });
    }

    if (subaction === "create") {
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
          scenario: "entity_log_missing_id",
          fallback: "I need a known contact to log an interaction.",
          data: { subaction, error: "MISSING_RELATIONSHIP_ID" },
        });
      }
      const rel = await service.getRelationship(relationshipId);
      if (!rel) {
        return respond({
          success: false,
          scenario: "entity_log_not_found",
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
        scenario: "entity_log_interaction",
        fallback: `Logged interaction with ${rel.name} on ${channel}.`,
        context: { name: rel.name, channel },
        data: { subaction, interaction },
      });
    }

    if (subaction === "set_identity") {
      // Wave-2 W2-A: route directly through `EntityStore.observeIdentity`
      // with `verified: true` so the user-asserted identity wins over any
      // ambient platform observation.
      const platform = normalizedNonEmpty(params.platform);
      const handle = normalizedNonEmpty(params.handle);
      if (!platform || !handle) {
        return respond({
          success: false,
          scenario: "entity_set_identity_missing",
          fallback:
            "I need both the platform (e.g. telegram, slack, email) and the handle to record an identity.",
          data: { subaction, error: "MISSING_FIELDS" },
        });
      }
      const repository = new LifeOpsRepository(runtime);
      const entityStore = await repository.entityStore(runtime.agentId);
      const evidence = normalizedNonEmpty(params.evidence) ?? "user_chat";
      const observation = await entityStore.observeIdentity({
        platform,
        handle,
        ...(normalizedNonEmpty(params.displayName)
          ? { displayName: params.displayName as string }
          : {}),
        evidence: [evidence],
        confidence: 1,
        ...(normalizedNonEmpty(params.entityId)
          ? { suggestedType: "person" }
          : {}),
      });
      // Force-mark this identity as verified — the canonical surface for
      // user-asserted identities per IMPL §5.1.
      const verifiedIdentities = observation.entity.identities.map((identity) =>
        identity.platform === platform && identity.handle === handle
          ? { ...identity, verified: true }
          : identity,
      );
      const merged = await entityStore.upsert({
        ...observation.entity,
        identities: verifiedIdentities,
      });
      return respond({
        success: true,
        scenario: "entity_set_identity",
        fallback: `Recorded identity ${platform}:${handle} on ${merged.preferredName}.`,
        context: {
          entityId: merged.entityId,
          platform,
          handle,
        },
        data: {
          subaction,
          entity: merged,
          mergedFrom: observation.mergedFrom ?? null,
        },
      });
    }

    if (subaction === "set_relationship") {
      const toEntityId = normalizedNonEmpty(params.toEntityId);
      const relationshipType = normalizedNonEmpty(params.relationshipType);
      if (!toEntityId || !relationshipType) {
        return respond({
          success: false,
          scenario: "entity_set_relationship_missing",
          fallback:
            "I need the target entity id and the relationship type (e.g. manages, colleague_of, works_at).",
          data: { subaction, error: "MISSING_FIELDS" },
        });
      }
      const repository = new LifeOpsRepository(runtime);
      const relationshipStore = await repository.relationshipStore(
        runtime.agentId,
      );
      const evidence = normalizedNonEmpty(params.evidence) ?? "user_chat";
      const fromEntityId = normalizedNonEmpty(params.fromEntityId) ?? "self";
      const edge = await relationshipStore.upsert({
        fromEntityId,
        toEntityId,
        type: relationshipType,
        metadata: {},
        state: {},
        evidence: [evidence],
        confidence: 1,
        source: "user_chat",
      });
      return respond({
        success: true,
        scenario: "entity_set_relationship",
        fallback: `Recorded ${fromEntityId} -[${relationshipType}]-> ${toEntityId}.`,
        context: { fromEntityId, toEntityId, relationshipType },
        data: { subaction, relationship: edge },
      });
    }

    if (subaction === "merge") {
      const targetEntityId = normalizedNonEmpty(params.entityId);
      const sourceEntityIds = (params.sourceEntityIds ?? []).filter(
        (id): id is string => typeof id === "string" && id.trim().length > 0,
      );
      if (!targetEntityId || sourceEntityIds.length === 0) {
        return respond({
          success: false,
          scenario: "entity_merge_missing",
          fallback:
            "I need a target entityId and at least one sourceEntityId to merge duplicates.",
          data: { subaction, error: "MISSING_FIELDS" },
        });
      }
      const repository = new LifeOpsRepository(runtime);
      const entityStore = await repository.entityStore(runtime.agentId);
      const merged = await entityStore.merge(targetEntityId, sourceEntityIds);
      return respond({
        success: true,
        scenario: "entity_merge",
        fallback: `Merged ${sourceEntityIds.length} entit${
          sourceEntityIds.length === 1 ? "y" : "ies"
        } into ${merged.preferredName}.`,
        context: {
          targetEntityId,
          sourceCount: sourceEntityIds.length,
        },
        data: { subaction, entity: merged, sourceEntityIds },
      });
    }

    return respond({
      success: false,
      scenario: "relationship_unknown_subaction",
      fallback: `Unknown ENTITY subaction: ${subaction}.`,
      context: { subaction },
      data: { error: "UNKNOWN_SUBACTION", subaction },
    });
  },
  parameters: [
    {
      name: "action",
      description:
        "Which ENTITY operation to run: create (new contact), read (load rolodex), log_interaction (record contact event), set_identity (force-merge a platform handle onto an entity), set_relationship (typed edge between entities), merge (collapse duplicate entities). For rolodex/contact lifecycle (read full profile, search, update fields) use CONTACT. Follow-up cadence belongs to SCHEDULED_TASKS.",
      descriptionCompressed:
        "ENTITY op: create | read | log_interaction | set_identity | set_relationship | merge",
      schema: {
        type: "string" as const,
        enum: [...ENTITY_SUBACTIONS],
      },
      examples: ["create", "read", "set_identity"],
    },
    {
      name: "intent",
      description:
        "Free-form user intent used to infer action when not set.",
      descriptionCompressed: "free-form intent infer action",
      schema: { type: "string" as const },
    },
    {
      name: "name",
      description:
        "Contact display name. When relationshipId is omitted, the handler resolves an existing contact by this name.",
      descriptionCompressed: "contact display name",
      schema: { type: "string" as const },
    },
    {
      name: "channel",
      description:
        "Primary channel for the contact (email, telegram, discord, signal, sms, twilio_voice, imessage, whatsapp).",
      descriptionCompressed:
        "primary channel: email|telegram|discord|signal|sms|twilio_voice|imessage|whatsapp",
      schema: {
        type: "string" as const,
        enum: [...LIFEOPS_MESSAGE_CHANNELS],
      },
      examples: ["email", "telegram", "imessage"],
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
      name: "reason",
      description: "Optional reason note.",
      schema: { type: "string" as const },
    },
    {
      name: "confirmed",
      description: "Optional explicit confirmation flag.",
      schema: { type: "boolean" as const },
    },
    {
      name: "entityId",
      description:
        "Target entity id. Used by set_identity (force a new identity onto a known entity), merge (target id), and any operation that needs a stable EntityStore id.",
      schema: { type: "string" as const },
    },
    {
      name: "platform",
      description:
        "Identity platform for set_identity (e.g. telegram, slack, email, twitter). Combine with handle.",
      descriptionCompressed: "set_identity platform e.g. telegram|slack|email|twitter|phone",
      schema: { type: "string" as const },
      examples: ["telegram", "email", "phone", "slack"],
    },
    {
      name: "displayName",
      description:
        "Display name shown alongside an observed identity (set_identity).",
      schema: { type: "string" as const },
    },
    {
      name: "toEntityId",
      description: "Target entity id for set_relationship.",
      schema: { type: "string" as const },
    },
    {
      name: "fromEntityId",
      description:
        "Source entity id for set_relationship. Defaults to 'self' when omitted.",
      schema: { type: "string" as const },
    },
    {
      name: "relationshipType",
      description:
        "Edge type label for set_relationship (e.g. manages, colleague_of, works_at, partner_of, family_of).",
      descriptionCompressed:
        "set_relationship edge type label e.g. manages|colleague_of|works_at|partner_of",
      schema: { type: "string" as const },
      examples: ["manages", "colleague_of", "works_at", "partner_of"],
    },
    {
      name: "sourceEntityIds",
      description:
        "Entity ids being folded into the target entity (merge). Provide as a JSON array of strings.",
      schema: {
        type: "array" as const,
        items: { type: "string" as const },
      },
    },
    {
      name: "evidence",
      description:
        "Free-form evidence string captured alongside set_identity / set_relationship observations.",
      schema: { type: "string" as const },
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
          action: "ENTITY",
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
          action: "ENTITY",
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
          action: "ENTITY",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Pat is my manager." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Recorded self -[manages]-> Pat.",
          action: "ENTITY",
        },
      },
    ],
  ],
};

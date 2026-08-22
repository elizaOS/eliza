/**
 * CONTACT — single umbrella action consolidating Rolodex / contact /
 * entity / relationship lifecycle.
 *
 * Op-based dispatch (Pattern C):
 *   create   — create a new contact entity (and optionally a contact_info
 *              component via RelationshipsService when categories/tags/
 *              preferences/customFields are provided).
 *   read     — load full identity + facts + recent conversations +
 *              relationships for an entity by id or name.
 *   search   — search the Rolodex by name/handle/platform with
 *              line-numbered results.
 *   update   — update an existing contact: name/email/phone/notes via the
 *              entity record, categories/tags/preferences/customFields
 *              via the contact_info component, or component data per
 *              source (UPDATE_ENTITY semantics).
 *   delete   — permanently delete a contact entity (requires confirm).
 *   activity — paginated relationship/identity/fact activity timeline.
 *   followup — schedule a follow-up touch-base with a contact via the
 *              FollowUp service (was SCHEDULE_FOLLOW_UP).
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  Component,
  Entity,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  Metadata,
  ProviderValue,
  RelationshipsGraphService,
  RelationshipsPersonDetail,
  RelationshipsPersonSummary,
  SearchCategoryRegistration,
  State,
  UUID,
} from "@elizaos/core";
import {
  describeUserReference,
  FOLLOW_UP_CAPABLE_ACTION_TAG,
  findEntityByName,
  getEntityDetails,
  logger,
  requireConfirmation,
  stringToUuid,
  toWellFormedUnicode,
} from "@elizaos/core";
import { resolveRelationshipsGraphService } from "../services/relationships-graph.ts";
import { hasContextSignalSyncForKey } from "./context-signal.ts";
import { extractActionParamsViaLlm } from "./extract-params.ts";

// ---------------------------------------------------------------------------
// Op dispatch
// ---------------------------------------------------------------------------

const CONTACT_OPS = [
  "create",
  "read",
  "search",
  "update",
  "delete",
  "activity",
  "followup",
] as const;
type ContactOp = (typeof CONTACT_OPS)[number];

const CONTACT_ACTION = "CONTACT";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ACTIVITY_DEFAULT_LIMIT = 50;
const ACTIVITY_MAX_LIMIT = 100;

interface ContactParams {
  action?: ContactOp;
  subaction?: ContactOp;
  op?: ContactOp;
  // Common
  entityId?: string;
  query?: string;
  name?: string;
  // create / update fields (entity-level)
  email?: string;
  phone?: string;
  notes?: string;
  // create / update fields (rich, contact_info component)
  categories?: string[] | string;
  tags?: string[] | string;
  preferences?: Record<string, string> | string;
  customFields?: Record<string, string> | string;
  attributes?: Record<string, unknown>;
  // update — update_mode for list/map updates (replace | add_to | remove_from)
  update_mode?: string;
  /** @deprecated dispatcher-only alias for update_mode; not part of the schema. */
  operation?: string;
  // update — UPDATE_ENTITY (component) semantics
  source?: string;
  data?: Record<string, unknown>;
  // search
  platform?: string;
  limit?: number;
  filters?: Record<string, unknown>;
  // search — search-by-criteria semantics from core
  searchTerm?: string;
  intent?: string;
  // delete
  confirm?: boolean;
  confirmed?: boolean;
  reason?: string;
  // activity
  since?: string;
  offset?: number;
  // followup
  scheduledAt?: string;
  priority?: string;
  message?: string;
}

interface RelationshipActivityItem {
  type: "relationship" | "identity" | "fact";
  personName: string;
  personId: string;
  summary: string;
  detail: string | null;
  timestamp: string | null;
}

interface RelationshipsServiceLike {
  addContact?(
    entityId: UUID,
    categories: string[],
    preferences: Record<string, string>,
    extra?: { displayName?: string },
  ): Promise<unknown>;
  removeContact?(entityId: UUID): Promise<boolean>;
  searchContacts?(criteria: {
    searchTerm?: string;
    categories?: string[];
    tags?: string[];
  }): Promise<
    Array<{
      entityId: UUID;
      categories: string[];
      tags: string[];
      preferences?: Record<string, string>;
      customFields: Record<string, unknown>;
    }>
  >;
  updateContact?(
    entityId: UUID,
    updates: Record<string, unknown>,
  ): Promise<boolean>;
  getContact?(entityId: UUID): Promise<unknown | null>;
}

interface FollowUpServiceLike {
  scheduleFollowUp(
    entityId: UUID,
    scheduledAt: Date,
    reason: string,
    priority?: "high" | "medium" | "low",
    message?: string,
  ): Promise<{ id?: UUID | string }>;
}

function isRelationshipsServiceLike(
  service: unknown,
): service is RelationshipsServiceLike {
  return typeof service === "object" && service !== null;
}

function isFollowUpServiceLike(
  service: unknown,
): service is FollowUpServiceLike {
  return (
    typeof service === "object" &&
    service !== null &&
    typeof (service as { scheduleFollowUp?: unknown }).scheduleFollowUp ===
      "function"
  );
}

type RuntimeWithDeleteEntities = IAgentRuntime & {
  deleteEntities?: (ids: UUID[]) => Promise<void>;
};

// ---------------------------------------------------------------------------
// Param coercion
// ---------------------------------------------------------------------------

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const values = value
      .map((item) => readString(item))
      .filter((item): item is string => Boolean(item));
    return values.length > 0 ? values : undefined;
  }
  if (typeof value === "string") {
    const values = value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return values.length > 0 ? values : undefined;
  }
  return undefined;
}

function readRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value === "string") {
    const result: Record<string, string> = {};
    for (const entry of value.split(",")) {
      const [key, val] = entry.split(":").map((s) => s.trim());
      if (key && val) result[key] = val;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === "string") result[key] = val;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function readOp(value: unknown): ContactOp | undefined {
  const s = readString(value)?.toLowerCase();
  if (!s) return undefined;
  if ((CONTACT_OPS as readonly string[]).includes(s)) return s as ContactOp;
  return undefined;
}

function isLikelyUuid(value: string | undefined): value is UUID {
  return typeof value === "string" && UUID_REGEX.test(value);
}

function getParams(options: unknown): ContactParams {
  const opts = options as HandlerOptions | undefined;
  return (opts?.parameters as ContactParams | undefined) ?? {};
}

function fail(text: string, error: string, op?: ContactOp): ActionResult {
  return {
    success: false,
    text,
    values: { success: false, error },
    data: { actionName: CONTACT_ACTION, op, error },
  };
}

function clampActivityLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return ACTIVITY_DEFAULT_LIMIT;
  }
  return Math.min(Math.trunc(value), ACTIVITY_MAX_LIMIT);
}

function clampActivityOffset(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.trunc(value);
}

// ---------------------------------------------------------------------------
// Shared helpers (graph snapshot / detail formatting)
// ---------------------------------------------------------------------------

function formatPersonSummary(person: RelationshipsPersonSummary): string {
  const parts: string[] = [];
  parts.push(`Name: ${person.displayName}`);
  if (person.isOwner) parts.push("Role: OWNER");
  if (person.aliases.length > 0)
    parts.push(`Aliases: ${person.aliases.join(", ")}`);
  parts.push(`Platforms: ${person.platforms.join(", ") || "none"}`);

  for (const identity of person.identities) {
    for (const handle of identity.handles) {
      parts.push(
        `  @${handle.handle} on ${handle.platform}${handle.verified ? " (verified)" : ""}`,
      );
    }
  }

  if (person.emails.length > 0)
    parts.push(`Emails: ${person.emails.join(", ")}`);
  if (person.phones.length > 0)
    parts.push(`Phones: ${person.phones.join(", ")}`);
  if (person.websites.length > 0)
    parts.push(`Websites: ${person.websites.join(", ")}`);
  if (person.preferredCommunicationChannel) {
    parts.push(`Preferred channel: ${person.preferredCommunicationChannel}`);
  }
  if (person.categories.length > 0)
    parts.push(`Categories: ${person.categories.join(", ")}`);
  if (person.tags.length > 0) parts.push(`Tags: ${person.tags.join(", ")}`);
  if (person.profiles.length > 0) {
    parts.push(
      `Profiles: ${person.profiles
        .map((profile) => {
          const primary =
            profile.handle ??
            profile.userId ??
            profile.displayName ??
            profile.entityId;
          return `${profile.source}=${primary}`;
        })
        .join(", ")}`,
    );
  }
  parts.push(
    `Facts: ${person.factCount} | Relationships: ${person.relationshipCount}`,
  );
  if (person.lastInteractionAt) {
    parts.push(`Last interaction: ${person.lastInteractionAt.slice(0, 10)}`);
  }

  return parts.join("\n");
}

function formatPersonDetail(detail: RelationshipsPersonDetail): string {
  const sections: string[] = [];

  sections.push("## Identity");
  sections.push(formatPersonSummary(detail));

  if (detail.facts.length > 0) {
    sections.push("\n## Facts");
    for (const fact of detail.facts) {
      const confidence =
        fact.confidence != null
          ? ` (${Math.round(fact.confidence * 100)}%)`
          : "";
      sections.push(`- [${fact.sourceType}]${confidence} ${fact.text}`);
    }
  }

  if (detail.recentConversations.length > 0) {
    sections.push("\n## Recent Conversations");
    for (const convo of detail.recentConversations) {
      sections.push(
        `### ${convo.roomName} (${convo.lastActivityAt?.slice(0, 10) ?? "?"})`,
      );
      for (const msg of convo.messages) {
        const ts = msg.createdAt
          ? new Date(msg.createdAt).toISOString().slice(0, 19)
          : "";
        sections.push(
          `  ${ts} ${msg.speaker}: ${toWellFormedUnicode(msg.text)}`,
        );
      }
    }
  }

  if (detail.relationships.length > 0) {
    sections.push("\n## Relationships");
    for (const rel of detail.relationships) {
      const types = rel.relationshipTypes.join(", ") || "unknown";
      const target =
        rel.sourcePersonId === detail.primaryEntityId
          ? rel.targetPersonName
          : rel.sourcePersonName;
      sections.push(
        `- ${target}: ${types} (strength: ${Math.round(rel.strength * 100)}%, sentiment: ${rel.sentiment}, interactions: ${rel.interactionCount})`,
      );
    }
  }

  return sections.join("\n");
}

async function getGraphService(
  runtime: IAgentRuntime,
): Promise<RelationshipsGraphService | null> {
  return resolveRelationshipsGraphService(runtime);
}

function getRelationshipsService(
  runtime: IAgentRuntime,
): RelationshipsServiceLike | null {
  const svc = runtime.getService("relationships");
  return (svc as RelationshipsServiceLike | null) ?? null;
}

// ---------------------------------------------------------------------------
// Search category registration (Rolodex)
// ---------------------------------------------------------------------------

const ENTITY_SEARCH_CATEGORY: SearchCategoryRegistration = {
  category: "entities",
  label: "Rolodex",
  description: "Search contacts and cross-platform identities.",
  contexts: ["social_posting", "documents"],
  filters: [
    {
      name: "platform",
      label: "Platform",
      description: 'Optional platform source, for example "discord".',
      type: "string",
    },
  ],
  resultSchemaSummary:
    "Contact results with primaryEntityId, displayName, platforms, and factCount.",
  capabilities: ["contacts", "identities", "relationships"],
  source: "agent:entities",
};

function hasSearchCategory(runtime: IAgentRuntime, category: string): boolean {
  try {
    runtime.getSearchCategory(category, { includeDisabled: true });
    return true;
  } catch {
    return false;
  }
}

export function registerEntitySearchCategory(runtime: IAgentRuntime): void {
  if (!hasSearchCategory(runtime, ENTITY_SEARCH_CATEGORY.category)) {
    runtime.registerSearchCategory(ENTITY_SEARCH_CATEGORY);
  }
}

// ---------------------------------------------------------------------------
// op:search
// ---------------------------------------------------------------------------

/**
 * Deterministic room-participant lookup for the contact-search dead-end: an
 * exact (case/`@`-insensitive) name match against the people present in the
 * message's room, excluding the agent itself. Read-only — used to tell the
 * planner "not a saved contact, but they are in this channel".
 */
async function findRoomParticipantMatches(
  runtime: IAgentRuntime,
  roomId: UUID,
  query: string,
): Promise<Array<{ entityId: string; name: string }>> {
  const normalize = (value: string): string =>
    value
      .trim()
      .toLowerCase()
      .replace(/^[@#]+/, "");
  const target = normalize(query);
  if (!target) return [];
  const details = await getEntityDetails({ runtime, roomId });
  const matches: Array<{ entityId: string; name: string }> = [];
  for (const entity of details ?? []) {
    if (!entity.id || entity.id === runtime.agentId) continue;
    const names = [entity.name, ...(entity.names ?? [])].filter(
      (name): name is string => typeof name === "string" && name.length > 0,
    );
    if (names.some((name) => normalize(name) === target)) {
      matches.push({
        entityId: String(entity.id),
        name: names[0] ?? query,
      });
    }
  }
  return matches;
}

async function handleSearch(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  params: ContactParams,
): Promise<ActionResult> {
  registerEntitySearchCategory(runtime);

  // LLM-extracted params (kept from old SEARCH_CONTACT behavior).
  const enriched = (await extractActionParamsViaLlm<ContactParams>({
    runtime,
    message,
    state,
    actionName: CONTACT_ACTION,
    actionDescription:
      "Search the Rolodex for a person by name, handle, or platform.",
    paramSchema: contactAction.parameters ?? [],
    existingParams: params,
    requiredFields: ["query"],
  })) as ContactParams;

  const query = readString(enriched.query) ?? readString(enriched.searchTerm);
  const platform = readString(enriched.platform);
  const limit = Math.min(Math.max(1, enriched.limit ?? 10), 25);

  if (!query || query.length === 0) {
    return fail(
      "CONTACT search requires a non-empty query parameter.",
      "INVALID_PARAMETERS",
      "search",
    );
  }

  const graphService = await getGraphService(runtime);
  if (!graphService) {
    return fail(
      "Relationships service not available.",
      "SERVICE_NOT_FOUND",
      "search",
    );
  }

  try {
    const snapshot = await graphService.getGraphSnapshot({
      search: query,
      platform: platform ?? null,
      limit,
    });

    if (!snapshot || snapshot.people.length === 0) {
      // Honest dead-end: before reporting "not found", check whether the name
      // matches someone PRESENT in the current room. "tell vega …" about a
      // channel participant must not dead-end at the saved-contacts rolodex —
      // surface the participant so the planner can offer an in-room reply.
      // Read-only; no send happens here.
      const roomParticipants = await findRoomParticipantMatches(
        runtime,
        message.roomId,
        query,
      );
      const noMatchText = `No contacts found matching "${query}"${platform ? ` on ${platform}` : ""}.`;
      const participantHint =
        roomParticipants.length > 0
          ? ` However, ${roomParticipants
              .map((p) => `"${p.name}"`)
              .join(
                ", ",
              )} matching that name is present in the current room/channel (not a saved contact). A plain reply in this channel can address them directly — offer that to the user instead of a DM or contact lookup.`
          : "";
      return {
        text: `${noMatchText}${participantHint}`,
        success: true,
        values: {
          success: true,
          resultCount: 0,
          roomParticipantMatchCount: roomParticipants.length,
        },
        data: {
          actionName: CONTACT_ACTION,
          op: "search",
          query,
          platform,
          roomParticipantMatches: roomParticipants,
        },
      };
    }

    const lines: string[] = [];
    for (let i = 0; i < snapshot.people.length; i++) {
      const person = snapshot.people[i];
      const platforms = person.platforms.join(", ") || "none";
      const aliases =
        person.aliases.length > 0 ? ` (aka ${person.aliases.join(", ")})` : "";
      lines.push(
        `${String(i + 1).padStart(3, " ")} | ${person.displayName}${aliases} — ${platforms} — ${person.factCount} facts — entityId: ${person.primaryEntityId}`,
      );
    }

    const header = `Search results for "${query}" | ${snapshot.people.length} contacts found`;
    const footer =
      "\nUse action=read with an entityId to see full details (facts, conversations, relationships).";

    return {
      text: `${header}\n${"─".repeat(60)}\n${lines.join("\n")}\n${footer}`,
      success: true,
      values: { success: true, resultCount: snapshot.people.length },
      data: {
        actionName: CONTACT_ACTION,
        op: "search",
        query,
        platform,
        results: snapshot.people.map((p, i) => ({
          line: i + 1,
          primaryEntityId: p.primaryEntityId,
          displayName: p.displayName,
          platforms: p.platforms,
          factCount: p.factCount,
        })),
      },
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("[CONTACT:search] Error:", errMsg);
    return fail(
      `Failed to search contacts: ${errMsg}`,
      "SEARCH_FAILED",
      "search",
    );
  }
}

// ---------------------------------------------------------------------------
// op:read
// ---------------------------------------------------------------------------

async function handleRead(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  params: ContactParams,
): Promise<ActionResult> {
  const enriched = (await extractActionParamsViaLlm<ContactParams>({
    runtime,
    message,
    state,
    actionName: CONTACT_ACTION,
    actionDescription:
      "Read full details about a person: identity, all facts, recent conversations, and relationships.",
    paramSchema: contactAction.parameters ?? [],
    existingParams: params,
    requiredFields: ["name"],
  })) as ContactParams;

  const entityId = readString(enriched.entityId);
  const name = readString(enriched.name) ?? readString(enriched.query);

  if (!entityId && !name) {
    return fail(
      "CONTACT read requires either entityId, name, or query parameter.",
      "INVALID_PARAMETERS",
      "read",
    );
  }

  const graphService = await getGraphService(runtime);
  if (!graphService) {
    return fail(
      "Relationships service not available.",
      "SERVICE_NOT_FOUND",
      "read",
    );
  }

  try {
    let resolvedEntityId = isLikelyUuid(entityId)
      ? (entityId as UUID)
      : undefined;

    if (!resolvedEntityId && name) {
      const matchLimit = 5;
      const snapshot = await graphService.getGraphSnapshot({
        search: name,
        limit: matchLimit + 1,
      });
      if (snapshot && snapshot.people.length > 0) {
        if (snapshot.people.length > 1) {
          const hasMore = snapshot.people.length > matchLimit;
          const matches = snapshot.people
            .slice(0, matchLimit)
            .map((person) => ({
              entityId: person.primaryEntityId,
              displayName: person.displayName,
            }));
          const choices = matches
            .map(
              (person) =>
                `${person.displayName} (entityId: ${person.entityId})`,
            )
            .join(", ");
          const count = hasMore
            ? `at least ${snapshot.people.length}`
            : String(snapshot.people.length);
          const queryLabel = describeUserReference(name, "that name");
          return {
            success: false,
            text: `${queryLabel} matched ${count} contacts: ${choices}${hasMore ? ", and more" : ""}. Ask which contact they mean, then retry with that entityId. No person's private details were read.`,
            values: {
              success: false,
              error: "AMBIGUOUS_CONTACT",
              matchCount: snapshot.people.length,
              matchCountCapped: hasMore,
            },
            data: {
              actionName: CONTACT_ACTION,
              op: "read",
              error: "AMBIGUOUS_CONTACT",
              matches,
              hasMore,
            },
            error: "AMBIGUOUS_CONTACT",
          };
        }
        resolvedEntityId = snapshot.people[0].primaryEntityId;
      }
    }

    if (!resolvedEntityId) {
      return fail(
        `Could not find entity${name ? ` named "${name}"` : ""}. Try op:search first.`,
        "ENTITY_NOT_FOUND",
        "read",
      );
    }

    const detail = await graphService.getPersonDetail(resolvedEntityId);
    if (!detail) {
      return fail(
        `No details found for entity ${resolvedEntityId}.`,
        "ENTITY_NOT_FOUND",
        "read",
      );
    }

    const formatted = formatPersonDetail(detail);

    return {
      text: formatted,
      success: true,
      values: {
        success: true,
        entityId: resolvedEntityId,
        displayName: detail.displayName,
      },
      data: {
        actionName: CONTACT_ACTION,
        op: "read",
        entityId: resolvedEntityId,
        detail: {
          displayName: detail.displayName,
          platforms: detail.platforms,
          factCount: detail.facts.length,
          conversationCount: detail.recentConversations.length,
          relationshipCount: detail.relationships.length,
        },
      },
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("[CONTACT:read] Error:", errMsg);
    return fail(
      `Failed to read entity details: ${errMsg}`,
      "READ_FAILED",
      "read",
    );
  }
}

// ---------------------------------------------------------------------------
// op:create
// ---------------------------------------------------------------------------

async function handleCreate(
  runtime: IAgentRuntime,
  params: ContactParams,
): Promise<ActionResult> {
  const name = readString(params.name);
  if (!name) {
    return fail(
      "CONTACT create requires a name.",
      "INVALID_PARAMETERS",
      "create",
    );
  }

  // Build entity-level metadata.
  const metadata: Metadata = {};
  const email = readString(params.email);
  const phone = readString(params.phone);
  const notes = readString(params.notes);
  if (email) metadata.email = email;
  if (phone) metadata.phone = phone;
  if (notes) metadata.notes = notes;

  // Allow free-form attributes to be merged.
  if (params.attributes && typeof params.attributes === "object") {
    for (const [key, value] of Object.entries(params.attributes)) {
      if (value !== undefined && value !== null) {
        (metadata as Record<string, unknown>)[key] = value;
      }
    }
  }

  let entityId: UUID;
  if (isLikelyUuid(params.entityId)) {
    entityId = params.entityId as UUID;
  } else {
    entityId = stringToUuid(
      `contact-${runtime.agentId}-${name}-${Date.now()}`,
    ) as UUID;
  }

  const entity: Entity = {
    id: entityId,
    names: [name],
    agentId: runtime.agentId as UUID,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };

  try {
    // Create entity if it doesn't exist already (handle externally-provided ids).
    const existing = await runtime.getEntityById(entityId).catch(() => null);
    if (!existing) {
      const ok = await runtime.createEntity(entity);
      if (!ok) {
        return fail(
          `Failed to create contact "${name}".`,
          "CREATE_FAILED",
          "create",
        );
      }
    }

    // Optionally promote to a richer contact via RelationshipsService when
    // categories / tags / preferences / customFields are supplied — this is
    // the legacy ADD_CONTACT semantic.
    const categories = readStringArray(params.categories);
    const tags = readStringArray(params.tags);
    const preferences = readRecord(params.preferences);
    const customFields = readRecord(params.customFields);
    let promoted = false;

    const relationships = getRelationshipsService(runtime);
    if (
      relationships?.addContact &&
      (categories || tags || preferences || customFields)
    ) {
      const addCategories = categories ?? ["acquaintance"];
      const addPrefs: Record<string, string> = { ...(preferences ?? {}) };
      if (notes) addPrefs.notes = notes;
      await relationships.addContact(entityId, addCategories, addPrefs, {
        displayName: name,
      });
      promoted = true;
    }

    return {
      text: `Created contact "${name}" (entityId: ${entityId}).`,
      success: true,
      values: { success: true, entityId, name },
      data: {
        actionName: CONTACT_ACTION,
        op: "create",
        entityId,
        name,
        metadata,
        promoted,
      },
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("[CONTACT:create] Error:", errMsg);
    return fail(
      `Failed to create contact: ${errMsg}`,
      "CREATE_FAILED",
      "create",
    );
  }
}

// ---------------------------------------------------------------------------
// op:update
// ---------------------------------------------------------------------------

async function handleUpdate(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  params: ContactParams,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  // Branch 1: UPDATE_ENTITY semantics — update a Component (e.g. telegram,
  // discord) keyed by source/data. Triggers when source+data are present.
  const source = readString(params.source);
  const data = params.data;
  if (
    source &&
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    state
  ) {
    return handleUpdateComponent(
      runtime,
      message,
      state,
      source,
      data,
      callback,
    );
  }

  // Branch 2: legacy core UPDATE_CONTACT — categories/tags/preferences via
  // RelationshipsService. Triggers when none of the entity-level fields are
  // present but contact-info-level fields are.
  const entityId = readString(params.entityId);
  const explicitName = readString(params.name);
  const targetName = explicitName;

  const categories = readStringArray(params.categories);
  const tags = readStringArray(params.tags);
  const preferences =
    typeof params.preferences === "string"
      ? readRecord(params.preferences)
      : (params.preferences as Record<string, string> | undefined);
  const customFields =
    typeof params.customFields === "string"
      ? readRecord(params.customFields)
      : (params.customFields as Record<string, string> | undefined);
  const notes = readString(params.notes);

  const isContactInfoUpdate =
    Boolean(categories || tags || preferences || customFields) ||
    (Boolean(notes) && !readString(params.email) && !readString(params.phone));

  if (isContactInfoUpdate && targetName) {
    return handleUpdateContactInfo(runtime, params, callback);
  }

  // Branch 3: simple Entity update — name/email/phone/notes/attributes.
  if (!entityId) {
    return fail(
      "CONTACT update requires entityId (or name + categories/tags/preferences for contact_info updates, or source + data for component updates).",
      "INVALID_PARAMETERS",
      "update",
    );
  }

  let existing: Entity | null = null;
  try {
    existing = await runtime.getEntityById(entityId as UUID);
  } catch {
    existing = null;
  }
  if (!existing) {
    return fail(`Contact ${entityId} was not found.`, "NOT_FOUND", "update");
  }

  const updated: Entity = { ...existing };

  if (explicitName) {
    updated.names = [
      explicitName,
      ...existing.names.filter((n) => n !== explicitName),
    ];
  }

  const existingMeta: Metadata =
    existing.metadata && typeof existing.metadata === "object"
      ? { ...(existing.metadata as Metadata) }
      : {};

  const email = readString(params.email);
  const phone = readString(params.phone);
  if (email) existingMeta.email = email;
  if (phone) existingMeta.phone = phone;
  if (notes) existingMeta.notes = notes;

  if (params.attributes && typeof params.attributes === "object") {
    for (const [key, value] of Object.entries(params.attributes)) {
      if (value !== undefined && value !== null) {
        (existingMeta as Record<string, unknown>)[key] = value;
      }
    }
  }

  updated.metadata = existingMeta;

  try {
    await runtime.updateEntity(updated);
    return {
      text: `Updated contact ${entityId}.`,
      success: true,
      values: { success: true, entityId },
      data: {
        actionName: CONTACT_ACTION,
        op: "update",
        entityId,
        names: updated.names,
        metadata: existingMeta,
      },
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("[CONTACT:update] Error:", errMsg);
    return fail(
      `Failed to update contact: ${errMsg}`,
      "UPDATE_FAILED",
      "update",
    );
  }
}

async function handleUpdateContactInfo(
  runtime: IAgentRuntime,
  params: ContactParams,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const relationships = getRelationshipsService(runtime);
  if (!relationships?.searchContacts || !relationships.updateContact) {
    return fail(
      "Relationships service does not support contact_info updates.",
      "SERVICE_NOT_FOUND",
      "update",
    );
  }

  const contactName = readString(params.name);
  if (!contactName) {
    return fail(
      "CONTACT update (contact_info path) requires a name to look up the contact.",
      "INVALID_PARAMETERS",
      "update",
    );
  }

  const contacts = await relationships.searchContacts({
    searchTerm: contactName,
  });
  if (contacts.length === 0) {
    return fail(
      `I couldn't find a contact named "${contactName}".`,
      "NOT_FOUND",
      "update",
    );
  }

  const contact = contacts[0];
  const operation =
    readString(params.update_mode) ?? readString(params.operation) ?? "replace";

  const updateData: Record<string, unknown> = {};

  const newCategories = readStringArray(params.categories);
  if (newCategories) {
    if (operation === "add_to" && contact.categories) {
      updateData.categories = [
        ...new Set([...contact.categories, ...newCategories]),
      ];
    } else if (operation === "remove_from" && contact.categories) {
      updateData.categories = contact.categories.filter(
        (cat) => !newCategories.includes(cat),
      );
    } else {
      updateData.categories = newCategories;
    }
  }

  const newTags = readStringArray(params.tags);
  if (newTags) {
    if (operation === "add_to" && contact.tags) {
      updateData.tags = [...new Set([...contact.tags, ...newTags])];
    } else if (operation === "remove_from" && contact.tags) {
      updateData.tags = contact.tags.filter((tag) => !newTags.includes(tag));
    } else {
      updateData.tags = newTags;
    }
  }

  const newPrefs =
    typeof params.preferences === "string"
      ? readRecord(params.preferences)
      : (params.preferences as Record<string, string> | undefined);
  if (newPrefs) {
    const existingPrefs = contact.preferences ?? {};
    if (operation === "add_to") {
      updateData.preferences = { ...existingPrefs, ...newPrefs };
    } else if (operation === "remove_from") {
      const remaining = { ...existingPrefs };
      for (const key of Object.keys(newPrefs)) delete remaining[key];
      updateData.preferences = remaining;
    } else {
      updateData.preferences = newPrefs;
    }
  }

  const newCustom =
    typeof params.customFields === "string"
      ? readRecord(params.customFields)
      : (params.customFields as Record<string, string> | undefined);
  if (newCustom) {
    const existingCustom = contact.customFields as Record<string, unknown>;
    if (operation === "add_to") {
      updateData.customFields = { ...existingCustom, ...newCustom };
    } else if (operation === "remove_from") {
      const remaining = { ...existingCustom };
      for (const key of Object.keys(newCustom)) delete remaining[key];
      updateData.customFields = remaining;
    } else {
      updateData.customFields = newCustom;
    }
  }

  const notes = readString(params.notes);
  if (notes) {
    const basePrefs =
      (updateData.preferences as Record<string, string> | undefined) ??
      contact.preferences ??
      {};
    updateData.preferences = { ...basePrefs, notes };
  }

  const updated = await relationships.updateContact(
    contact.entityId,
    updateData,
  );
  if (!updated) {
    return fail(
      "Failed to update contact via RelationshipsService.",
      "UPDATE_FAILED",
      "update",
    );
  }

  const responseText = `I've updated ${contactName}'s contact information.`;
  if (callback) {
    await callback({
      text: responseText,
      action: CONTACT_ACTION,
      metadata: {
        contactId: contact.entityId,
        updatedFields: Object.keys(updateData),
      },
    });
  }

  // The update confirmation is the complete answer to a single-operation
  // turn: verified + turnComplete make the callback the sole delivery instead
  // of double-messaging with the evaluator.
  return {
    success: true,
    text: responseText,
    userFacingText: responseText,
    verifiedUserFacing: true,
    turnComplete: true,
    values: {
      contactId: contact.entityId,
      updatedFieldsStr: Object.keys(updateData).join(","),
    },
    data: {
      actionName: CONTACT_ACTION,
      op: "update",
      contactId: contact.entityId,
      updatedFields: Object.keys(updateData),
    },
  };
}

async function handleUpdateComponent(
  runtime: IAgentRuntime,
  message: Memory,
  state: State,
  source: string,
  data: Record<string, unknown>,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const sourceEntityId = message.entityId;
  const agentId = runtime.agentId;
  const room = state.data.room ?? (await runtime.getRoom(message.roomId));
  if (!room?.worldId) {
    return fail("Could not find room or world.", "ROOM_NOT_FOUND", "update");
  }
  const worldId = room.worldId;

  const entity = await findEntityByName(runtime, message, state);
  if (!entity?.id) {
    return fail(
      "Could not find which entity you're trying to update.",
      "ENTITY_NOT_FOUND",
      "update",
    );
  }

  const componentType = source.toLowerCase();
  const componentData = data as Metadata;
  const entityId = entity.id;
  const entityName = entity.names[0] ?? "Unknown";

  const existing: Component | null = await runtime.getComponent(
    entityId,
    componentType,
    worldId,
    sourceEntityId,
  );

  if (existing) {
    await runtime.updateComponent({
      id: existing.id,
      entityId,
      worldId,
      type: componentType,
      data: componentData,
      agentId,
      roomId: message.roomId,
      sourceEntityId,
      createdAt: existing.createdAt,
    });

    const updatedText = `I've updated the ${componentType} information for ${entityName}.`;
    if (callback) {
      await callback({ text: updatedText, action: CONTACT_ACTION });
    }
    // Same single-delivery contract as handleUpdate: the confirmation is the
    // complete answer to the turn.
    return {
      success: true,
      text: updatedText,
      userFacingText: updatedText,
      verifiedUserFacing: true,
      turnComplete: true,
      values: {
        success: true,
        entityId,
        entityName,
        componentType,
        componentUpdated: true,
        isNewComponent: false,
      },
      data: {
        actionName: CONTACT_ACTION,
        op: "update",
        entityId,
        entityName,
        componentType,
        componentData: componentData as ProviderValue,
        existingComponentId: existing.id,
      },
    };
  }

  const newComponentId = crypto.randomUUID() as UUID;
  await runtime.createComponent({
    id: newComponentId,
    entityId,
    worldId,
    type: componentType,
    data: componentData,
    agentId,
    roomId: message.roomId,
    sourceEntityId,
    createdAt: Date.now(),
  });

  const addedText = `I've added new ${componentType} information for ${entityName}.`;
  if (callback) {
    await callback({ text: addedText, action: CONTACT_ACTION });
  }
  return {
    success: true,
    text: addedText,
    userFacingText: addedText,
    verifiedUserFacing: true,
    turnComplete: true,
    values: {
      success: true,
      entityId,
      entityName,
      componentType,
      componentCreated: true,
      isNewComponent: true,
    },
    data: {
      actionName: CONTACT_ACTION,
      op: "update",
      entityId,
      entityName,
      componentType,
      componentData: componentData as ProviderValue,
      newComponentId,
    },
  };
}

// ---------------------------------------------------------------------------
// op:delete
// ---------------------------------------------------------------------------

async function handleDelete(
  runtime: IAgentRuntime,
  message: Memory,
  params: ContactParams,
  callback: HandlerCallback | undefined,
): Promise<ActionResult> {
  const entityId = readString(params.entityId);
  const contactName = readString(params.name);
  const deleteTarget = contactName ?? entityId ?? "contact";
  const confirmPrompt = contactName
    ? `Remove ${contactName} from your contacts permanently?`
    : `Permanently delete contact ${entityId}?`;

  const decision = await requireConfirmation({
    runtime,
    message,
    actionName: CONTACT_ACTION,
    pendingKey: `delete:${deleteTarget}`,
    prompt: `${confirmPrompt} Reply yes to confirm or no to cancel.`,
    callback,
  });
  if (decision.status !== "confirmed") {
    // requireConfirmation already fired the confirm prompt on the pending
    // path — a second callback here showed the user the identical prompt
    // twice. Pending/cancel detail stays planner-facing.
    const text =
      decision.status === "pending"
        ? `Asked the user to confirm removing ${deleteTarget}; wait for their yes/no reply.`
        : "The user cancelled the contact deletion; nothing was removed.";
    return {
      success: decision.status === "pending",
      text,
      data: {
        actionName: CONTACT_ACTION,
        op: "delete",
        confirmationRequired: decision.status === "pending",
        awaitingUserInput: decision.status === "pending",
        cancelled: decision.status === "cancelled",
      },
    };
  }

  // Path A: REMOVE_CONTACT semantics — name-based with RelationshipsService.
  if (contactName && !entityId) {
    const relationships = getRelationshipsService(runtime);
    if (!relationships?.searchContacts || !relationships.removeContact) {
      return fail(
        "Relationships service does not support name-based delete.",
        "SERVICE_NOT_FOUND",
        "delete",
      );
    }
    const contacts = await relationships.searchContacts({
      searchTerm: contactName,
    });
    if (contacts.length === 0) {
      return fail(
        `I couldn't find a contact named "${contactName}".`,
        "NOT_FOUND",
        "delete",
      );
    }
    const contact = contacts[0];
    const removed = await relationships.removeContact(contact.entityId);
    if (!removed) {
      return fail(
        "Failed to remove contact via RelationshipsService.",
        "DELETE_FAILED",
        "delete",
      );
    }
    const removedText = `I've removed ${contactName} from your contacts.`;
    if (callback) {
      await callback({ text: removedText, action: CONTACT_ACTION });
    }
    // The removal confirmation is the complete answer to a single-operation
    // turn: verified + turnComplete make the callback the sole delivery.
    return {
      success: true,
      text: removedText,
      userFacingText: removedText,
      verifiedUserFacing: true,
      turnComplete: true,
      values: { contactId: contact.entityId },
      data: {
        actionName: CONTACT_ACTION,
        op: "delete",
        contactId: contact.entityId,
      },
    };
  }

  // Path B: DELETE_CONTACT semantics — id-based with runtime.deleteEntities.
  if (!entityId) {
    return fail(
      "CONTACT delete requires entityId (or name for legacy REMOVE_CONTACT).",
      "INVALID_PARAMETERS",
      "delete",
    );
  }

  const rt = runtime as RuntimeWithDeleteEntities;
  if (typeof rt.deleteEntities !== "function") {
    return fail(
      "deleteEntities is not supported by this runtime version.",
      "NOT_SUPPORTED",
      "delete",
    );
  }

  try {
    await rt.deleteEntities([entityId as UUID]);
    return {
      text: `Deleted contact ${entityId}.`,
      success: true,
      values: { success: true, entityId },
      data: { actionName: CONTACT_ACTION, op: "delete", entityId },
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("[CONTACT:delete] Error:", errMsg);
    return fail(
      `Failed to delete contact: ${errMsg}`,
      "DELETE_FAILED",
      "delete",
    );
  }
}

// ---------------------------------------------------------------------------
// op:activity
// ---------------------------------------------------------------------------

async function handleActivity(
  runtime: IAgentRuntime,
  params: ContactParams,
): Promise<ActionResult> {
  const limit = clampActivityLimit(params.limit);
  const offset = clampActivityOffset(params.offset);

  const graphService = await getGraphService(runtime);
  if (!graphService) {
    return fail(
      "Relationships service not available.",
      "SERVICE_NOT_FOUND",
      "activity",
    );
  }

  try {
    const snapshot = await graphService.getGraphSnapshot();
    const personByEntityId = new Map<
      string,
      { personId: string; personName: string }
    >();
    for (const person of snapshot.people) {
      personByEntityId.set(person.primaryEntityId, {
        personId: person.primaryEntityId,
        personName: person.displayName,
      });
      for (const memberEntityId of person.memberEntityIds) {
        personByEntityId.set(memberEntityId, {
          personId: person.primaryEntityId,
          personName: person.displayName,
        });
      }
    }

    const activity: RelationshipActivityItem[] = [];

    for (const edge of snapshot.relationships) {
      const types = edge.relationshipTypes.join(", ") || "connected";
      activity.push({
        type: "relationship",
        personName: edge.sourcePersonName,
        personId: edge.sourcePersonId,
        summary: `${edge.sourcePersonName} ↔ ${edge.targetPersonName}`,
        detail: `${types} · ${edge.sentiment} · strength ${edge.strength.toFixed(2)} · ${edge.interactionCount} interactions`,
        timestamp: edge.lastInteractionAt ?? null,
      });
    }

    for (const person of snapshot.people) {
      const platforms = person.platforms.join(", ") || "no platform";
      activity.push({
        type: "identity",
        personName: person.displayName,
        personId: person.primaryEntityId,
        summary: person.displayName,
        detail: `${person.memberEntityIds.length} identit${person.memberEntityIds.length === 1 ? "y" : "ies"} on ${platforms} · ${person.factCount} facts`,
        timestamp: person.lastInteractionAt ?? null,
      });
    }

    const recentFacts = await runtime.getMemories({
      agentId: runtime.agentId,
      tableName: "facts",
      limit: 200,
    });
    for (const fact of recentFacts) {
      const text =
        typeof fact.content.text === "string" ? fact.content.text.trim() : "";
      if (!text) continue;

      const person = fact.entityId
        ? (personByEntityId.get(fact.entityId) ?? null)
        : null;
      const metadata =
        fact.metadata && typeof fact.metadata === "object"
          ? (fact.metadata as Record<string, unknown>)
          : null;
      const confidence =
        typeof metadata?.confidence === "number" ? metadata.confidence : null;
      const scopeBase =
        metadata?.base && typeof metadata.base === "object"
          ? (metadata.base as Record<string, unknown>)
          : null;
      const scope =
        typeof scopeBase?.scope === "string" ? scopeBase.scope : null;

      const detailParts = [text];
      if (scope) detailParts.push(scope);
      if (confidence !== null)
        detailParts.push(`confidence ${confidence.toFixed(2)}`);

      activity.push({
        type: "fact",
        personName: person?.personName ?? "Unknown person",
        personId: person?.personId ?? fact.entityId,
        summary: person?.personName
          ? `Fact for ${person.personName}`
          : "Fact extracted",
        detail: detailParts.join(" · "),
        timestamp:
          typeof fact.createdAt === "number"
            ? new Date(fact.createdAt).toISOString()
            : null,
      });
    }

    activity.sort((a, b) => {
      const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
      const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
      return tb - ta;
    });

    const total = activity.length;
    const slice = activity.slice(offset, offset + limit);
    const lines = slice.map((item, i) => {
      const ts = item.timestamp ? ` · ${item.timestamp.slice(0, 19)}` : "";
      const detail = item.detail ? ` — ${item.detail}` : "";
      return `${String(offset + i + 1).padStart(3, " ")} | [${item.type}] ${item.summary}${detail}${ts}`;
    });

    const header = `Relationships activity | ${slice.length}/${total} items shown (offset ${offset}, limit ${limit})`;
    const body = lines.length > 0 ? lines.join("\n") : "(no activity yet)";

    return {
      text: `${header}\n${"─".repeat(60)}\n${body}`,
      success: true,
      values: { success: true, total, count: slice.length, offset, limit },
      data: {
        actionName: CONTACT_ACTION,
        op: "activity",
        activity: slice,
        total,
        count: slice.length,
        offset,
        limit,
        hasMore: offset + limit < total,
      },
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error("[CONTACT:activity] Error:", errMsg);
    return fail(
      `Failed to load relationship activity: ${errMsg}`,
      "ACTIVITY_FAILED",
      "activity",
    );
  }
}

// ---------------------------------------------------------------------------
// Op: followup — schedule a follow-up touch-base via FollowUpService
// ---------------------------------------------------------------------------

async function handleFollowup(
  runtime: IAgentRuntime,
  params: ContactParams,
): Promise<ActionResult> {
  const relationshipsService = runtime.getService("relationships");
  const relationships = isRelationshipsServiceLike(relationshipsService)
    ? relationshipsService
    : null;
  const followUpServiceRaw = runtime.getService("follow_up");
  const followUpService = isFollowUpServiceLike(followUpServiceRaw)
    ? followUpServiceRaw
    : null;
  if (!relationships || !followUpService) {
    return fail(
      "Follow-up scheduling is unavailable.",
      "SERVICE_UNAVAILABLE",
      "followup",
    );
  }

  const scheduledAtRaw = readString(params.scheduledAt);
  if (!scheduledAtRaw) {
    return fail("scheduledAt is required.", "MISSING_SCHEDULED_AT", "followup");
  }
  const scheduledAt = new Date(scheduledAtRaw);
  if (Number.isNaN(scheduledAt.getTime())) {
    return fail("Invalid scheduledAt.", "INVALID_SCHEDULED_AT", "followup");
  }

  const contactName = readString(params.name);
  let entityId: UUID | null = isLikelyUuid(readString(params.entityId))
    ? (readString(params.entityId) as UUID)
    : null;
  if (!entityId && contactName) {
    const contacts =
      (await relationships.searchContacts?.({
        searchTerm: contactName,
      })) ?? [];
    entityId = contacts[0]?.entityId ?? null;
    if (!entityId) {
      return fail(
        `Contact "${contactName}" not found.`,
        "CONTACT_NOT_FOUND",
        "followup",
      );
    }
  }
  if (!entityId) {
    return fail("name or entityId is required.", "MISSING_CONTACT", "followup");
  }

  if (relationships.getContact) {
    const contact = await relationships.getContact(entityId);
    if (!contact) {
      return fail(
        "Contact not found in relationships.",
        "CONTACT_NOT_FOUND",
        "followup",
      );
    }
  }

  const reason = readString(params.reason) ?? "Follow-up";
  const priorityRaw = readString(params.priority)?.toLowerCase();
  const priority: "high" | "medium" | "low" =
    priorityRaw === "high" || priorityRaw === "low" ? priorityRaw : "medium";
  const messageText = readString(params.message);

  const task = await followUpService.scheduleFollowUp(
    entityId,
    scheduledAt,
    reason,
    priority,
    messageText,
  );

  return {
    success: true,
    text: `Scheduled follow-up with ${contactName ?? "contact"} for ${scheduledAt.toLocaleString()}.`,
    values: {
      op: "followup",
      contactId: String(entityId),
      taskId: task.id ? String(task.id) : "",
    },
    data: {
      actionName: CONTACT_ACTION,
      op: "followup",
      contactId: String(entityId),
      contactName: contactName ?? "",
      scheduledAt: scheduledAt.toISOString(),
      taskId: task.id ? String(task.id) : "",
      reason,
      priority,
    },
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export const contactAction: Action = {
  name: CONTACT_ACTION,
  contexts: ["contacts", "messaging", "documents", "memory", "documents"],
  tags: [FOLLOW_UP_CAPABLE_ACTION_TAG],
  roleGate: { minRole: "ADMIN" },
  similes: [
    // Original agent leaves
    "SEARCH_CONTACT",
    "READ_CONTACT",
    "CREATE_CONTACT",
    "UPDATE_CONTACT",
    "DELETE_CONTACT",
    "CONTACT_ACTIVITY",
    // Old core action names
    "ADD_CONTACT",
    "REMOVE_CONTACT",
    "SEARCH_CONTACTS",
    "UPDATE_ENTITY",
    // Entity / Rolodex aliases
    "SEARCH_ENTITY",
    "READ_ENTITY",
    // Activity aliases
    "RECENT_ROLODEX_ACTIVITY",
    // Search aliases
    "FIND_PERSON",
    "LOOKUP_USER",
    "FIND_USER",
    "SEARCH_ROLODEX",
    // Read aliases
    "VIEW_PERSON",
    "GET_CONTACT",
    "VIEW_CONTACT",
    "PERSON_DETAILS",
    // Create aliases
    "NEW_CONTACT",
    "SAVE_CONTACT",
    "STORE_CONTACT",
    // Update aliases
    "EDIT_CONTACT",
    "MODIFY_CONTACT",
    "PATCH_CONTACT",
    "CHANGE_CONTACT",
    // Delete aliases
    "ERASE_CONTACT",
    "DROP_CONTACT",
    // Followup aliases
    "SCHEDULE_FOLLOW_UP",
    "SCHEDULE_FOLLOWUP",
    "FOLLOW_UP_CONTACT",
  ],
  description:
    "Manage Rolodex contacts. Action-based dispatch — provide an `action` parameter:\n" +
    "  create   — create a new contact (name required; optional email/phone/notes/categories/tags).\n" +
    "  read     — load full identity, facts, recent conversations, and relationships by entityId or name.\n" +
    "  search   — search contacts by name/handle/platform; line-numbered results.\n" +
    "  update   — update entity-level fields (name/email/phone/notes), contact_info (categories/tags/preferences/customFields), or component data per source (UPDATE_ENTITY semantics).\n" +
    "  delete   — permanently delete a contact (entityId or name; requires confirm:true).\n" +
    "  activity — paginated activity timeline for the Rolodex.\n" +
    "  followup — schedule a follow-up with a contact (scheduledAt + name/entityId; optional reason/priority/message).\n" +
    "Identity claims, verification, and principal merges require the deterministic identity authority and are not CONTACT operations.",
  descriptionCompressed:
    "Rolodex contacts create|read|search|update|delete|activity|followup",
  parameters: [
    {
      name: "action",
      description: `Contact operation: ${CONTACT_OPS.join(", ")}. For owner-graph relationship and interaction operations use ENTITY; CONTACT is the rolodex/contact lifecycle umbrella.`,
      required: true,
      schema: { type: "string" as const, enum: [...CONTACT_OPS] },
    },
    {
      name: "entityId",
      description:
        "Entity id (UUID). Required for read/update/delete/activity; optional for create.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "name",
      description:
        "Display name. Required for create; used as fallback look-up for read/update/delete.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "query",
      description: "search: name, handle, or search term to match contacts.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "platform",
      description: "search: filter by platform (e.g. discord, telegram).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "limit",
      description: "search/activity: max results to return.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "offset",
      description: "activity: pagination offset.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "filters",
      description: "search: optional structured filter map.",
      required: false,
      schema: { type: "object" as const, additionalProperties: true },
    },
    {
      name: "email",
      description: "create/update: contact email.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "phone",
      description: "create/update: contact phone.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "notes",
      description: "create/update: free-text notes about the contact.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "categories",
      description:
        "create/update: relationship categories for the contact_info component.",
      required: false,
      schema: {
        type: "array" as const,
        items: { type: "string" as const },
      },
    },
    {
      name: "tags",
      description: "create/update: tags for the contact_info component.",
      required: false,
      schema: {
        type: "array" as const,
        items: { type: "string" as const },
      },
    },
    {
      name: "preferences",
      description:
        "create/update: preference key-value pairs (timezone, language, notes, …).",
      required: false,
      schema: {
        type: "object" as const,
        additionalProperties: { type: "string" as const },
      },
    },
    {
      name: "customFields",
      description: "update: custom field key-value pairs.",
      required: false,
      schema: {
        type: "object" as const,
        additionalProperties: { type: "string" as const },
      },
    },
    {
      name: "attributes",
      description:
        "create/update: free-form attribute map merged into entity metadata.",
      required: false,
      schema: { type: "object" as const, additionalProperties: true },
    },
    {
      name: "update_mode",
      description:
        "update: how to apply list/map updates — replace, add_to, or remove_from (default: replace).",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["replace", "add_to", "remove_from"],
      },
    },
    {
      name: "source",
      description:
        "update (UPDATE_ENTITY semantics): component source/platform such as telegram, x, discord, email.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "data",
      description:
        "update (UPDATE_ENTITY semantics): structured component data to merge into the entity.",
      required: false,
      schema: { type: "object" as const, additionalProperties: true },
    },
    {
      name: "confirm",
      description: "delete: must be true to proceed with deletion.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "confirmed",
      description: "delete (legacy alias): same as confirm.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "reason",
      description: "followup: reason for the follow-up.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "since",
      description: "activity: ISO timestamp lower bound (currently advisory).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "scheduledAt",
      description: "followup: ISO date/time for the follow-up.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "priority",
      description: "followup: high | medium | low (default medium).",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["high", "medium", "low"] as const,
      },
    },
    {
      name: "message",
      description:
        "followup: optional message text to include with the follow-up.",
      required: false,
      schema: { type: "string" as const },
    },
  ],
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions,
  ): Promise<boolean> => {
    registerEntitySearchCategory(runtime);
    {
      const params = getParams(options);
      if (
        readOp(params.action ?? params.subaction ?? params.op) === "followup"
      ) {
        return true;
      }
    }
    return hasContextSignalSyncForKey(message, state, "search_entity");
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const params = getParams(options);
    const op =
      readOp(params.action) ?? readOp(params.subaction) ?? readOp(params.op);
    if (!op) {
      return fail(
        `action is required and must be one of ${CONTACT_OPS.join(", ")}.`,
        "INVALID",
      );
    }

    switch (op) {
      case "create":
        return handleCreate(runtime, params);
      case "read":
        return handleRead(runtime, message, state, params);
      case "search":
        return handleSearch(runtime, message, state, params);
      case "update":
        return handleUpdate(runtime, message, state, params, callback);
      case "delete":
        return handleDelete(runtime, message, params, callback);
      case "activity":
        return handleActivity(runtime, params);
      case "followup":
        return handleFollowup(runtime, params);
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Look up Jill in my contacts." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Search results for "Jill" | 2 contacts found',
          action: CONTACT_ACTION,
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Add a contact: Jill Park, jill@acme.com." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Created contact "Jill Park".',
          action: CONTACT_ACTION,
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Schedule a follow-up with Alice next Monday at 10am.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Scheduled follow-up with Alice for Monday 10:00 AM.",
          action: CONTACT_ACTION,
        },
      },
    ],
  ] as ActionExample[][],
};

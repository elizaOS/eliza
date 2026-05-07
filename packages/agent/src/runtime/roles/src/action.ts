/**
 * RUNTIME_UPDATE_ROLE action — runtime role assignment backed by LLM extraction.
 *
 * The action becomes available for messages that clearly mention role or
 * authority language. The planner can extract structured parameters, and the
 * handler falls back to a dedicated small-model extractor when parameters are
 * missing or ambiguous.
 */

import {
  type Action,
  type ActionExample,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
  type UUID,
} from "@elizaos/core";
import { asNonEmptyString, asRecord } from "@elizaos/shared";
import {
  extractRoleIntentWithLlm,
  looksLikeRoleIntent,
  normalizeNaturalRoleLabel,
} from "./intent.js";
import type { RoleName } from "./types.js";
import {
  canModifyRole,
  getLiveEntityMetadataFromMessage,
  normalizeRole,
  resolveCanonicalOwnerId,
  resolveEntityRole,
  resolveWorldForMessage,
  setEntityRole,
} from "./utils.js";

/** Maximum length for a target username. */
const MAX_USERNAME_LENGTH = 64;

const RECENT_ROOM_MESSAGE_LIMIT = 100;
const AMBIGUOUS_MATCH_SCORE_GAP = 10;
const MIN_CONFIDENT_MATCH_SCORE = 70;
const ROLE_TARGET_PRONOUNS = new Set([
  "he",
  "him",
  "his",
  "she",
  "her",
  "hers",
  "they",
  "them",
  "their",
  "theirs",
]);

type ParsedRoleCommand =
  | {
      kind: "role";
      targetName: string;
      newRole: RoleName;
      label?: string;
    }
  | {
      kind: "revoke";
      targetName: string;
      newRole: "GUEST";
      label?: string;
    };

type RoleActionParameters = {
  target?: string;
  role?: string;
  mode?: string;
  label?: string;
};

type RelationshipsContactLike = {
  entityId: UUID;
  categories?: string[];
  customFields?: Record<string, unknown>;
};

type RelationshipAnalyticsLike = {
  strength: number;
  interactionCount: number;
  sharedConversationWindows?: number;
  lastInteractionAt?: string;
};

type RelationshipsServiceLike = {
  searchContacts?: (criteria: {
    categories?: string[];
    tags?: string[];
    searchTerm?: string;
    privacyLevel?: string;
  }) => Promise<RelationshipsContactLike[]>;
  getContact?: (entityId: UUID) => Promise<RelationshipsContactLike | null>;
  analyzeRelationship?: (
    sourceEntityId: UUID,
    targetEntityId: UUID,
  ) => Promise<RelationshipAnalyticsLike | null>;
};

type CandidateRecord = {
  entityId: UUID;
  names: string[];
  aliases: string[];
  inCurrentRoom: boolean;
  spokeRecentlyInRoom: boolean;
  lastRoomActivityAt?: number;
  contact: RelationshipsContactLike | null;
  analytics: RelationshipAnalyticsLike | null;
};

function asString(value: unknown): string | null {
  return asNonEmptyString(value) ?? null;
}

function normalizeEntityLookupName(raw: string): string | null {
  const safeRaw = raw.length > 1024 ? raw.slice(0, 1024) : raw;
  const normalized = safeRaw
    .trim()
    .replace(/^@{1,1024}/, "")
    .replace(/[.!?,;:]{1,1024}$/g, "")
    .trim();
  if (!normalized || normalized.length > MAX_USERNAME_LENGTH) {
    return null;
  }
  return normalized;
}

function isRoleTargetPronoun(raw: string): boolean {
  return ROLE_TARGET_PRONOUNS.has(raw.trim().replace(/^@+/, "").toLowerCase());
}

/**
 * Normalize a role string from planner or extractor output to a valid RoleName.
 */
function normalizeInputRole(raw: string): RoleName | null {
  const upper = raw.toUpperCase();
  if (upper === "MEMBER" || upper === "NONE") return "GUEST";
  if (upper === "MOD" || upper === "MODERATOR") return "ADMIN";
  const normalized = normalizeRole(upper);
  return normalized === "GUEST" && upper !== "GUEST" ? null : normalized;
}

function normalizePlannerLabel(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }

  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeRoleMode(raw: unknown): "role" | "revoke" | null {
  if (typeof raw !== "string") {
    return null;
  }

  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (
    normalized === "revoke" ||
    normalized === "remove" ||
    normalized === "delete" ||
    normalized === "unset" ||
    normalized === "demote"
  ) {
    return "revoke";
  }

  if (
    normalized === "role" ||
    normalized === "assign" ||
    normalized === "set" ||
    normalized === "update" ||
    normalized === "promote"
  ) {
    return "role";
  }

  return null;
}

function normalizeRoleActionParams(
  raw: RoleActionParameters | Record<string, unknown> | undefined,
): ParsedRoleCommand | null {
  const params = raw ?? {};
  const target = normalizeEntityLookupName(
    asString(params.target) ??
      asString((params as Record<string, unknown>).user) ??
      "",
  );
  if (!target || isRoleTargetPronoun(target)) {
    return null;
  }

  const label = normalizePlannerLabel(params.label);
  const mode = normalizeRoleMode(params.mode);
  const explicitRole = asString(params.role);
  const role =
    (explicitRole ? normalizeInputRole(explicitRole) : null) ??
    (label ? normalizeNaturalRoleLabel(label) : null);

  if (mode === "revoke") {
    return {
      kind: "revoke",
      targetName: target,
      newRole: "GUEST",
      ...(label ? { label } : {}),
    };
  }

  if (!role) {
    return null;
  }

  return {
    kind: "role",
    targetName: target,
    newRole: role,
    ...(label ? { label } : {}),
  };
}

async function resolveParsedRoleCommand(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  options: HandlerOptions | Record<string, unknown> | undefined;
}): Promise<ParsedRoleCommand | null> {
  const { runtime, message, state, options } = args;

  const params = (options as HandlerOptions | undefined)?.parameters as
    | RoleActionParameters
    | undefined;
  const fromParams = normalizeRoleActionParams(params);
  if (fromParams) {
    return fromParams;
  }

  const extracted = await extractRoleIntentWithLlm({
    runtime,
    message,
    state,
  });
  if (
    !extracted.kind ||
    !extracted.targetName ||
    isRoleTargetPronoun(extracted.targetName)
  ) {
    return null;
  }

  const targetName = normalizeEntityLookupName(extracted.targetName);
  if (!targetName) {
    return null;
  }

  if (extracted.kind === "revoke") {
    return {
      kind: "revoke",
      targetName,
      newRole: "GUEST",
      ...(extracted.label ? { label: extracted.label } : {}),
    };
  }

  if (!extracted.newRole) {
    return null;
  }

  return {
    kind: "role",
    targetName,
    newRole: extracted.newRole,
    ...(extracted.label ? { label: extracted.label } : {}),
  };
}

function extractCustomFieldStrings(
  customFields: Record<string, unknown> | undefined,
  keys: string[],
): string[] {
  if (!customFields) {
    return [];
  }

  const values = new Set<string>();
  for (const key of keys) {
    const rawValue = customFields[key];
    if (typeof rawValue === "string" && rawValue.trim().length > 0) {
      values.add(rawValue.trim());
      continue;
    }
    if (Array.isArray(rawValue)) {
      for (const entry of rawValue) {
        if (typeof entry === "string" && entry.trim().length > 0) {
          values.add(entry.trim());
        }
      }
    }
  }

  return [...values];
}

function getRelationshipsService(
  runtime: IAgentRuntime,
): RelationshipsServiceLike | null {
  if (typeof runtime.getService !== "function") {
    return null;
  }

  return runtime.getService("relationships") as RelationshipsServiceLike | null;
}

function collectCandidateNames(args: {
  names?: string[];
  metadata?: Record<string, unknown>;
  contact?: RelationshipsContactLike | null;
}): { names: string[]; aliases: string[] } {
  const names = new Set<string>();
  const aliases = new Set<string>();

  for (const name of args.names ?? []) {
    if (typeof name === "string" && name.trim().length > 0) {
      names.add(name.trim());
    }
  }

  const metadata = asRecord(args.metadata);
  if (metadata) {
    for (const source of Object.values(metadata)) {
      const sourceRecord = asRecord(source);
      if (!sourceRecord) {
        continue;
      }
      for (const key of [
        "username",
        "userName",
        "name",
        "displayName",
        "handle",
        "screenName",
      ]) {
        const value = asString(sourceRecord[key]);
        if (value) {
          aliases.add(value);
        }
      }
    }
  }

  const contactFields = args.contact?.customFields as
    | Record<string, unknown>
    | undefined;
  for (const value of extractCustomFieldStrings(contactFields, [
    "displayName",
    "preferredName",
    "nickname",
    "nicknames",
    "alias",
    "aliases",
    "username",
    "usernames",
    "handle",
    "handles",
  ])) {
    aliases.add(value);
  }

  return {
    names: [...names],
    aliases: [...aliases],
  };
}

function normalizeComparisonValue(value: string): string {
  return value.trim().replace(/^@+/, "").replace(/\s+/g, " ").toLowerCase();
}

function scoreCandidateNameMatch(
  targetName: string,
  candidate: CandidateRecord,
): { nameScore: number; matchedValue: string | null } {
  const target = normalizeComparisonValue(targetName);
  const values = [...candidate.names, ...candidate.aliases];
  let bestScore = 0;
  let matchedValue: string | null = null;

  for (const rawValue of values) {
    const value = normalizeComparisonValue(rawValue);
    if (!value) {
      continue;
    }

    let score = 0;
    if (value === target) {
      score = 100;
    } else if (value.split(/\s+/).includes(target)) {
      score = 88;
    } else if (value.startsWith(target) || target.startsWith(value)) {
      score = 80;
    } else if (value.includes(target) || target.includes(value)) {
      score = 68;
    }

    if (score > bestScore) {
      bestScore = score;
      matchedValue = rawValue;
    }
  }

  return { nameScore: bestScore, matchedValue };
}

async function getRecentRoomActivity(
  runtime: IAgentRuntime,
  roomId: UUID,
): Promise<Map<UUID, number>> {
  const activity = new Map<UUID, number>();
  if (typeof runtime.getMemoriesByRoomIds !== "function") {
    return activity;
  }

  try {
    const memories = await runtime.getMemoriesByRoomIds({
      tableName: "messages",
      roomIds: [roomId],
      limit: RECENT_ROOM_MESSAGE_LIMIT,
    });
    for (const memory of memories) {
      if (!memory?.entityId || typeof memory.createdAt !== "number") {
        continue;
      }
      const previous = activity.get(memory.entityId as UUID) ?? 0;
      if (memory.createdAt > previous) {
        activity.set(memory.entityId as UUID, memory.createdAt);
      }
    }
  } catch (error) {
    logger.warn(`[roles] Failed to read recent room activity: ${error}`);
  }

  return activity;
}

async function resolveRoleTargetEntity(args: {
  runtime: IAgentRuntime;
  roomId: UUID;
  requesterEntityId: UUID;
  targetName: string;
}): Promise<{
  entityId: UUID | null;
  error?: string;
}> {
  const { runtime, roomId, requesterEntityId, targetName } = args;
  const candidateMap = new Map<UUID, CandidateRecord>();
  const relationships = getRelationshipsService(runtime);
  const recentRoomActivity = await getRecentRoomActivity(runtime, roomId);

  const upsertCandidate = async (
    entityId: UUID,
    options?: {
      names?: string[];
      metadata?: Record<string, unknown>;
      inCurrentRoom?: boolean;
      contact?: RelationshipsContactLike | null;
    },
  ) => {
    let candidate = candidateMap.get(entityId);
    if (!candidate) {
      let entity: {
        names?: string[];
        metadata?: Record<string, unknown>;
      } | null =
        options?.names && options?.metadata
          ? { names: options.names, metadata: options.metadata }
          : null;
      if (!entity && typeof runtime.getEntityById === "function") {
        entity = await runtime.getEntityById(entityId);
      }
      const contact =
        options?.contact ??
        (relationships && typeof relationships.getContact === "function"
          ? await relationships.getContact(entityId)
          : null);
      const identifiers = collectCandidateNames({
        names: entity?.names,
        metadata: entity?.metadata as Record<string, unknown> | undefined,
        contact,
      });
      candidate = {
        entityId,
        names: identifiers.names,
        aliases: identifiers.aliases,
        inCurrentRoom: Boolean(options?.inCurrentRoom),
        spokeRecentlyInRoom: recentRoomActivity.has(entityId),
        lastRoomActivityAt: recentRoomActivity.get(entityId),
        contact,
        analytics: null,
      };
      candidateMap.set(entityId, candidate);
      return;
    }

    if (options?.inCurrentRoom) {
      candidate.inCurrentRoom = true;
    }
    if (!candidate.contact && options?.contact) {
      candidate.contact = options.contact;
    }
  };

  try {
    const roomEntities = await runtime.getEntitiesForRoom(roomId);
    for (const entity of roomEntities) {
      if (!entity?.id) continue;
      await upsertCandidate(entity.id as UUID, {
        names: entity.names as string[] | undefined,
        metadata: entity.metadata as Record<string, unknown> | undefined,
        inCurrentRoom: true,
      });
    }
  } catch (error) {
    logger.warn(`[roles] Failed to load room entities: ${error}`);
  }

  for (const entityId of recentRoomActivity.keys()) {
    await upsertCandidate(entityId, { inCurrentRoom: false });
  }

  if (relationships && typeof relationships.searchContacts === "function") {
    try {
      const contacts = await relationships.searchContacts({
        searchTerm: targetName,
      });
      for (const contact of contacts) {
        if (!contact?.entityId) continue;
        await upsertCandidate(contact.entityId, {
          contact,
        });
      }
    } catch (error) {
      logger.warn(`[roles] Failed to search rolodex contacts: ${error}`);
    }
  }

  const scoredCandidates = await Promise.all(
    [...candidateMap.values()].map(async (candidate) => {
      if (
        relationships &&
        typeof relationships.analyzeRelationship === "function" &&
        candidate.entityId !== requesterEntityId
      ) {
        try {
          candidate.analytics = await relationships.analyzeRelationship(
            requesterEntityId,
            candidate.entityId,
          );
        } catch (error) {
          logger.warn(
            `[roles] Failed to analyze relationship for candidate ${candidate.entityId}: ${error}`,
          );
        }
      }

      const { nameScore } = scoreCandidateNameMatch(targetName, candidate);
      if (nameScore === 0) {
        return null;
      }

      let score = nameScore;
      if (candidate.inCurrentRoom) {
        score += 14;
      }
      if (candidate.spokeRecentlyInRoom) {
        score += 12;
      }
      if (candidate.contact) {
        score += 6;
      }
      if (candidate.analytics) {
        score += Math.round(candidate.analytics.strength / 5);
        score += Math.min(
          (candidate.analytics.sharedConversationWindows ?? 0) * 8,
          24,
        );
        const lastInteractionAt = candidate.analytics.lastInteractionAt;
        if (lastInteractionAt) {
          const ageMs = Date.now() - new Date(lastInteractionAt).getTime();
          if (ageMs <= 1000 * 60 * 60 * 24) {
            score += 12;
          } else if (ageMs <= 1000 * 60 * 60 * 24 * 7) {
            score += 8;
          } else if (ageMs <= 1000 * 60 * 60 * 24 * 30) {
            score += 4;
          }
        }
      }

      return { candidate, score, nameScore };
    }),
  );

  const ranked = scoredCandidates
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((left, right) => right.score - left.score);

  if (ranked.length === 0) {
    return {
      entityId: null,
      error: `Could not find user "${targetName}" in this room or rolodex.`,
    };
  }

  const best = ranked[0];
  const second = ranked[1];
  if (
    best.score < MIN_CONFIDENT_MATCH_SCORE ||
    (second && best.score - second.score < AMBIGUOUS_MATCH_SCORE_GAP)
  ) {
    return {
      entityId: null,
      error: `I found multiple possible matches for "${targetName}". Please use a more specific name or handle.`,
    };
  }

  return { entityId: best.candidate.entityId };
}

export const updateRoleAction: Action = {
  name: "RUNTIME_UPDATE_ROLE",
  contexts: ["admin", "settings"],
  roleGate: { minRole: "OWNER" },
  similes: [
    "CHANGE_ROLE",
    "SET_ROLE",
    "ASSIGN_ROLE",
    "MAKE_ADMIN",
    "MAKE_OWNER",
    "SET_BOSS",
    "SET_COWORKER",
    "REVOKE_ROLE",
  ],
  description:
    "Assign or revoke a role using commands (/role @name ADMIN) or natural language " +
    '("alice is your boss", "bob is not your coworker"). Only OWNERs and ADMINs can manage roles.',
  // The handler already emits the full user-facing result (success, ambiguity,
  // permission denial). Letting the planner add follow-up text after that can
  // cause Discord to rewrite the same message multiple times for one role change.
  suppressPostActionContinuation: true,

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const text =
      typeof message?.content?.text === "string" ? message.content.text : "";
    return looksLikeRoleIntent(text);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ) => {
    const emitRoleUpdate = async (text: string): Promise<void> => {
      await callback?.({
        text,
        action: "RUNTIME_UPDATE_ROLE",
      });
    };

    const parsed = await resolveParsedRoleCommand({
      runtime,
      message,
      state,
      options,
    });
    if (!parsed) {
      await emitRoleUpdate(
        "I couldn't determine whose role to change or which role/relationship you meant.",
      );
      return { success: false };
    }

    const targetName = parsed.targetName;

    // Resolve world
    const resolved = await resolveWorldForMessage(runtime, message);
    if (!resolved) {
      await emitRoleUpdate(
        "Cannot assign roles — no world context found for this room.",
      );
      return { success: false };
    }

    const { world, metadata } = resolved;

    // Check requester's role
    const requesterRole = await resolveEntityRole(
      runtime,
      world,
      metadata,
      message.entityId,
      {
        liveEntityMetadata: getLiveEntityMetadataFromMessage(message),
      },
    );
    if (requesterRole !== "OWNER" && requesterRole !== "ADMIN") {
      await emitRoleUpdate(
        "You don't have permission to manage roles. Only OWNERs and ADMINs can assign roles.",
      );
      return { success: false };
    }

    // Find target entity
    const targetResolution = await resolveRoleTargetEntity({
      runtime,
      roomId: message.roomId,
      requesterEntityId: message.entityId,
      targetName,
    });
    const targetEntityId = targetResolution.entityId;
    if (!targetEntityId) {
      await emitRoleUpdate(
        targetResolution.error ??
          `Could not find user "${targetName}" in this room.`,
      );
      return { success: false };
    }

    // Check if target is the agent itself
    if (targetEntityId === runtime.agentId) {
      await emitRoleUpdate("Cannot change the agent's own role.");
      return { success: false };
    }

    const targetCurrentRole = await resolveEntityRole(
      runtime,
      world,
      metadata,
      targetEntityId,
    );

    // Determine the new role: revoke → GUEST, otherwise use the parsed role.
    const newRole: RoleName =
      parsed.kind === "revoke" ? "GUEST" : parsed.newRole;

    // Permission check
    if (newRole === "OWNER") {
      const canonicalOwnerId = resolveCanonicalOwnerId(runtime, metadata);
      if (!canonicalOwnerId || targetEntityId !== canonicalOwnerId) {
        await emitRoleUpdate(
          "OWNER is reserved for the canonical agent owner. Use ADMIN for additional elevated users.",
        );
        return { success: false };
      }
    }

    // Prevent the last OWNER from demoting themselves
    if (
      targetEntityId === message.entityId &&
      requesterRole === "OWNER" &&
      newRole !== "OWNER"
    ) {
      const otherOwners = Object.entries(metadata.roles ?? {}).filter(
        ([id, r]) => id !== message.entityId && normalizeRole(r) === "OWNER",
      );
      if (otherOwners.length === 0) {
        await emitRoleUpdate(
          "Cannot remove the last OWNER. Promote another user to OWNER first.",
        );
        return { success: false };
      }
    }
    if (!canModifyRole(requesterRole, targetCurrentRole, newRole)) {
      await emitRoleUpdate(
        `Cannot change ${targetName}'s role from ${targetCurrentRole} to ${newRole}. ` +
          `Your role (${requesterRole}) doesn't have sufficient permissions.`,
      );
      return { success: false };
    }

    // Apply the role change via the shared helper so roleSources stays in sync.
    await setEntityRole(runtime, message, targetEntityId, newRole);

    logger.info(
      `[roles] ${message.entityId} set ${targetEntityId} (${targetName}) to ${newRole}`,
    );

    // Build response message using natural language when a label is present.
    let responseText: string;
    if (parsed.kind === "revoke" && parsed.label) {
      responseText = `${targetName} is no longer your ${parsed.label}.`;
    } else if (parsed.label) {
      responseText = `${targetName} is now your ${parsed.label}.`;
    } else {
      responseText = `Updated ${targetName}'s role to **${newRole}**.`;
    }

    await emitRoleUpdate(responseText);

    return {
      success: true,
      data: {
        targetEntityId,
        targetName,
        previousRole: targetCurrentRole,
        newRole,
        assignedBy: message.entityId,
        ...(parsed.kind === "revoke"
          ? { revoked: true, revokedLabel: parsed.label }
          : {}),
        ...(parsed.label ? { label: parsed.label } : {}),
      },
    };
  },

  parameters: [
    {
      name: "target",
      description:
        "The person whose role should change. Resolve pronouns from recent conversation when possible.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "mode",
      description:
        "Whether to assign a role or revoke/remove an existing role.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["assign", "revoke"],
        default: "assign",
      },
    },
    {
      name: "role",
      description:
        "The normalized system role to apply. Map boss/manager/mod/admin to ADMIN, coworker/teammate/friend/member/user to USER, and explicit guest/none to GUEST.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["OWNER", "ADMIN", "USER", "GUEST"],
      },
    },
    {
      name: "label",
      description:
        "Optional natural-language relationship label from the user's wording, such as boss or coworker.",
      required: false,
      schema: { type: "string" as const },
    },
  ],

  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "/role @alice ADMIN" },
      },
      {
        name: "{{agentName}}",
        content: { text: "Updated alice's role to **ADMIN**." },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "bob is your coworker" },
      },
      {
        name: "{{agentName}}",
        content: { text: "bob is now your coworker." },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "charlie is not your boss" },
      },
      {
        name: "{{agentName}}",
        content: { text: "charlie is no longer your boss." },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "hey @{{agentName}}, odi is your boss now (@Odilitime)",
        },
      },
      {
        name: "{{agentName}}",
        content: { text: "odi is now your boss." },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "hey @{{agentName}}, odi is your boss now (@Odilitime)",
        },
      },
      {
        name: "{{agentName}}",
        content: { text: "odi is now your boss." },
      },
      {
        name: "{{name1}}",
        content: { text: "set his role to admin" },
      },
      {
        name: "{{agentName}}",
        content: { text: "Updated odi's role to **ADMIN**." },
      },
    ],
  ] as ActionExample[][],
};

import type { IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { ModelType, parseJSONObjectFromText } from "@elizaos/core";
import {
  findKeywordTermMatch,
  getRecentMessagesData,
  getValidationKeywordTerms,
} from "@elizaos/shared";

import type { RoleName } from "./types.js";

const ROLE_INTENT_KEYWORDS = getValidationKeywordTerms(
  "action.updateRole.intent",
  {
    includeAllLocales: true,
  },
);

const ROLE_CONTEXT_MESSAGE_COUNT = 6;
const EXTRACTED_ROLE_VALUES = ["OWNER", "ADMIN", "USER", "GUEST"] as const;

export const NATURAL_ROLE_MAP: Record<string, RoleName> = {
  boss: "ADMIN",
  manager: "ADMIN",
  supervisor: "ADMIN",
  superior: "ADMIN",
  lead: "ADMIN",
  mod: "ADMIN",
  moderator: "ADMIN",

  coworker: "USER",
  "co-worker": "USER",
  teammate: "USER",
  colleague: "USER",
  peer: "USER",
  friend: "USER",
  partner: "USER",
  member: "USER",
  user: "USER",
};

export type ExtractedRoleIntent = {
  kind: "role" | "revoke" | null;
  targetName: string | null;
  newRole: RoleName | null;
  label?: string;
  confidence: number | null;
};

function messageText(message: Memory): string {
  const text = message.content?.text;
  return typeof text === "string" ? text.trim() : "";
}

function splitStateTextCandidates(value: string): string[] {
  return value
    .split(/\n+/)
    .map((line) =>
      line
        .replace(
          /^(?:user|assistant|system|owner|admin|shaw|chen|eliza)\s*:\s*/i,
          "",
        )
        .trim(),
    )
    .filter((line) => line.length > 0);
}

function stateTextCandidates(state: State | undefined): string[] {
  if (!state || typeof state !== "object") {
    return [];
  }

  const stateRecord = state as Record<string, unknown>;
  const values =
    stateRecord.values && typeof stateRecord.values === "object"
      ? (stateRecord.values as Record<string, unknown>)
      : undefined;

  const candidates: string[] = [];
  const pushText = (value: unknown) => {
    if (typeof value === "string" && value.trim().length > 0) {
      candidates.push(...splitStateTextCandidates(value));
    }
  };

  pushText(values?.recentMessages);
  pushText(stateRecord.text);

  for (const item of getRecentMessagesData(state)) {
    const content = item.content;
    if (!content || typeof content !== "object") {
      continue;
    }
    pushText(content.text);
  }

  return [...new Set(candidates)];
}

async function getRecentConversationMessages(
  runtime: IAgentRuntime,
  roomId: UUID,
): Promise<Memory[]> {
  if (typeof runtime.getMemories === "function") {
    try {
      return await runtime.getMemories({
        tableName: "messages",
        roomId,
        limit: ROLE_CONTEXT_MESSAGE_COUNT,
      });
    } catch {
      // Fall back below.
    }
  }

  if (typeof runtime.getMemoriesByRoomIds === "function") {
    try {
      return await runtime.getMemoriesByRoomIds({
        tableName: "messages",
        roomIds: [roomId],
        limit: ROLE_CONTEXT_MESSAGE_COUNT,
      });
    } catch {
      return [];
    }
  }

  return [];
}

async function getRecentRequesterMessages(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<string[]> {
  const recentMessages = await getRecentConversationMessages(
    runtime,
    message.roomId,
  );
  return recentMessages
    .filter((memory) => memory?.entityId === message.entityId)
    .reverse()
    .map((memory) => {
      const text = memory.content?.text;
      return typeof text === "string" ? text.trim() : "";
    })
    .filter((text) => text.length > 0);
}

function normalizeRoleLabel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeNaturalRoleLabel(label: string): RoleName | null {
  return NATURAL_ROLE_MAP[label.trim().toLowerCase()] ?? null;
}

function normalizeRole(value: unknown): RoleName | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const upper = trimmed.toUpperCase();
  if (upper === "MEMBER" || upper === "NONE") {
    return "GUEST";
  }
  if (upper === "MOD" || upper === "MODERATOR") {
    return "ADMIN";
  }

  if (
    EXTRACTED_ROLE_VALUES.includes(
      upper as (typeof EXTRACTED_ROLE_VALUES)[number],
    )
  ) {
    return upper as RoleName;
  }

  return normalizeNaturalRoleLabel(trimmed);
}

function normalizeKind(value: unknown): "role" | "revoke" | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "none") {
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

function normalizeTargetName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value
    .trim()
    .replace(/^@+/, "")
    .replace(/^\(+/, "")
    .replace(/\)+$/, "")
    .replace(/[.!?,;:]+$/g, "")
    .trim();

  return normalized.length > 0 ? normalized : null;
}

function normalizeConfidence(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(1, parsed));
    }
  }
  return null;
}

export function looksLikeRoleIntent(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  return findKeywordTermMatch(trimmed, ROLE_INTENT_KEYWORDS) !== undefined;
}

export async function extractRoleIntentWithLlm(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
}): Promise<ExtractedRoleIntent> {
  const { runtime, message, state } = args;
  if (typeof runtime.useModel !== "function") {
    return {
      kind: null,
      targetName: null,
      newRole: null,
      confidence: null,
    };
  }

  const currentMessage = messageText(message);
  if (!currentMessage) {
    return {
      kind: null,
      targetName: null,
      newRole: null,
      confidence: null,
    };
  }

  const recentConversation = [
    ...stateTextCandidates(state),
    ...(await getRecentRequesterMessages(runtime, message)),
  ]
    .slice(-8)
    .join("\n");

  const prompt = [
    "Extract a single role-management intent from the conversation.",
    "This is for assigning or revoking a user's role or social authority relationship.",
    "Return kind: none only if the user is clearly not asking to change someone's role or relationship.",
    "",
    "Normalize to these system roles:",
    "  OWNER — explicit canonical owner assignment only.",
    "  ADMIN — boss, manager, supervisor, superior, lead, admin, mod, moderator.",
    "  USER — coworker, co-worker, teammate, colleague, peer, friend, partner, member, user.",
    "  GUEST — guest, none, or the revoked state after removing a role/relationship.",
    "",
    "Rules:",
    "  - Resolve pronouns like him, her, them, his, or their from recent requester messages when possible.",
    "  - For negations/removals like 'not your boss' or 'remove him as coworker', return kind: revoke and newRole: GUEST.",
    "  - When the user uses a natural relationship label like boss or coworker, copy that label into label.",
    "  - When the user uses an explicit role name like admin or guest, leave label empty.",
    "  - Never return prose, markdown, or explanations.",
    "",
    "JSON only.",
    "",
    "Example:",
    '{"kind":"role","targetName":"Odi","newRole":"ADMIN","label":"boss","confidence":0.94}',
    "",
    "Example:",
    '{"kind":"revoke","targetName":"Alice","newRole":"GUEST","label":"coworker","confidence":0.88}',
    "",
    "Example:",
    '{"kind":"none","targetName":null,"newRole":null,"label":null,"confidence":0.0}',
    "",
    `Current request: ${JSON.stringify(currentMessage)}`,
    `Recent requester messages: ${JSON.stringify(recentConversation)}`,
  ].join("\n");

  let rawResponse = "";
  try {
    const result = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
    rawResponse = typeof result === "string" ? result : "";
  } catch (error) {
    runtime.logger?.warn?.(
      {
        src: "roles:update_role",
        error: error instanceof Error ? error.message : String(error),
      },
      "Role intent extraction model call failed",
    );
    return {
      kind: null,
      targetName: null,
      newRole: null,
      confidence: null,
    };
  }

  const parsed = parseJSONObjectFromText(rawResponse) as Record<
    string,
    unknown
  > | null;
  if (!parsed) {
    return {
      kind: null,
      targetName: null,
      newRole: null,
      confidence: null,
    };
  }

  const label = normalizeRoleLabel(
    parsed.label ?? parsed.relationship ?? parsed.relationshipLabel,
  );
  const kind = normalizeKind(parsed.kind);
  const role = normalizeRole(parsed.newRole ?? parsed.role ?? label);

  return {
    kind: kind ?? (role ? "role" : null),
    targetName: normalizeTargetName(
      parsed.targetName ?? parsed.target ?? parsed.user ?? parsed.entityId,
    ),
    newRole: kind === "revoke" ? "GUEST" : role,
    ...(label ? { label } : {}),
    confidence: normalizeConfidence(parsed.confidence),
  };
}

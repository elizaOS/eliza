/**
 * Canonical knowledge-document access wall and facet-filter matcher. Both the
 * HTTP route layer (`@elizaos/plugin-documents/routes.ts`) and the agent-callable
 * knowledge actions (`../actions/knowledge.ts`) apply the SAME rules here so an
 * owner-private item can never spill to a public-room actor through either path
 * (the #13593 spill guard), and the room/sender/media-format/tag/time-range
 * facets (#13595) resolve identically for a REST query and an agent SEARCH.
 *
 * Lives in `@elizaos/agent` (the inner layer) rather than the route plugin so
 * the always-loaded agent actions can depend on it without an
 * agent → plugin-documents cycle; the route plugin imports it the same way it
 * imports `documents-service-loader`.
 */
import { ChannelType, type Memory, type UUID } from "@elizaos/core";
import type {
  DocumentAddedByRole,
  DocumentVisibilityScope,
} from "./documents-service-loader.ts";

/**
 * Room trust classification — the SINGLE source of truth shared by the ingest
 * spill guard (`attachment-knowledge-ingest.roomIsPrivateSurface`), the send
 * wall, and the active-room surfacing wall. A DM / SELF / VOICE_DM / API room is
 * a "private" surface (the owner's own chat); EVERYTHING else — GROUP,
 * VOICE_GROUP, FEED, THREAD, WORLD, FORUM, AUTONOMOUS — is a "public"/community
 * surface that must never receive owner-private or user-private knowledge.
 *
 * Defined here (not with a hand-rolled public-type allowlist) so no surface can
 * drift: a THREAD omitted from a public-types set would silently let private
 * media into a thread. Classifying by the private allowlist + `default: public`
 * fails closed for any future channel type.
 */
export function roomIsPrivateSurface(
  channelType: ChannelType | string | undefined,
): boolean {
  switch (channelType) {
    case ChannelType.DM:
    case ChannelType.SELF:
    case ChannelType.VOICE_DM:
    case ChannelType.API:
      return true;
    default:
      return false;
  }
}

/** A room is a public/community surface iff it is not a private surface. */
export function roomIsPublicSurface(
  channelType: ChannelType | string | undefined,
): boolean {
  return !roomIsPrivateSurface(channelType);
}

export const DOCUMENT_SCOPE_VALUES = new Set<DocumentVisibilityScope>([
  "global",
  "owner-private",
  "user-private",
  "agent-private",
]);

/** Namespaced tag prefix carrying the media-format facet on knowledge records. */
export const MEDIA_FORMAT_TAG_PREFIX = "media-format:";

export type RouteActorRole = "OWNER" | "USER" | "AGENT" | "RUNTIME";

export type RouteActor = {
  entityId: UUID;
  role: RouteActorRole;
  ownerEntityId?: UUID;
};

/**
 * Facet filter set for knowledge queries. Every field is an AND constraint; the
 * media-format facet matches either an explicit `metadata.mediaFormat` or the
 * `media-format:<format>` tag so ingest-tagged and mime-derived records compose.
 */
export type DocumentFilter = {
  scope?: DocumentVisibilityScope;
  scopedToEntityId?: UUID;
  query?: string;
  addedBy?: UUID;
  timeRangeStart?: number;
  timeRangeEnd?: number;
  tags?: string[];
  roomId?: UUID;
  mediaFormat?: string;
};

export type DocumentReadableMemory = {
  id?: UUID;
  agentId?: UUID;
  entityId?: UUID;
  createdAt?: number;
  content?: { text?: string };
  metadata?: unknown;
};

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

export function trimString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function asUuid(value: unknown): UUID | undefined {
  const trimmed = trimString(value);
  return trimmed ? (trimmed as UUID) : undefined;
}

export function parseDocumentScope(
  value: unknown,
): DocumentVisibilityScope | undefined {
  return DOCUMENT_SCOPE_VALUES.has(value as DocumentVisibilityScope)
    ? (value as DocumentVisibilityScope)
    : undefined;
}

export function getDocumentVisibilityScope(
  metadata: Record<string, unknown> | undefined,
): DocumentVisibilityScope {
  return DOCUMENT_SCOPE_VALUES.has(metadata?.scope as DocumentVisibilityScope)
    ? (metadata?.scope as DocumentVisibilityScope)
    : "global";
}

export function routeActorAddedByRole(actor: RouteActor): DocumentAddedByRole {
  return actor.role;
}

export function actorCanManageOwnerDocuments(actor: RouteActor): boolean {
  return actor.role === "OWNER" || actor.role === "RUNTIME";
}

export function actorCanManageAgentDocuments(actor: RouteActor): boolean {
  return (
    actor.role === "OWNER" || actor.role === "AGENT" || actor.role === "RUNTIME"
  );
}

export function documentScopedEntityId(
  memory: DocumentReadableMemory,
): UUID | undefined {
  const metadata = asRecord(memory.metadata);
  return (
    asUuid(metadata?.scopedToEntityId) ??
    asUuid(metadata?.addedBy) ??
    asUuid(memory.entityId)
  );
}

/** Source-room id recorded on a knowledge record (#13593), if any. */
export function documentRoomId(
  metadata: Record<string, unknown> | undefined,
): UUID | undefined {
  return asUuid(metadata?.roomId);
}

export function documentTags(
  metadata: Record<string, unknown> | undefined,
): string[] {
  return Array.isArray(metadata?.tags)
    ? metadata.tags.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
}

/**
 * Media-format facet for a knowledge record (#13593). Prefer an explicit
 * `metadata.mediaFormat`; fall back to the `media-format:<format>` tag so
 * records tagged by the ingest pipeline (or backfill) still match without a
 * dedicated column.
 */
export function documentMediaFormat(
  metadata: Record<string, unknown> | undefined,
  tags: string[],
): string | undefined {
  const explicit = trimString(metadata?.mediaFormat)?.toLowerCase();
  if (explicit) return explicit;
  const tagged = tags.find((tag) => tag.startsWith(MEDIA_FORMAT_TAG_PREFIX));
  return tagged ? tagged.slice(MEDIA_FORMAT_TAG_PREFIX.length) : undefined;
}

export function matchesDocumentFilter(
  memory: DocumentReadableMemory,
  filters: DocumentFilter,
): boolean {
  const metadata = asRecord(memory.metadata);
  if (filters.scope && getDocumentVisibilityScope(metadata) !== filters.scope) {
    return false;
  }
  if (
    filters.scopedToEntityId &&
    documentScopedEntityId(memory) !== filters.scopedToEntityId
  ) {
    return false;
  }
  if (filters.addedBy && metadata?.addedBy !== filters.addedBy) {
    return false;
  }
  const tags = documentTags(metadata);
  if (filters.tags && filters.tags.length > 0) {
    if (!filters.tags.every((tag) => tags.includes(tag))) {
      return false;
    }
  }
  if (filters.roomId && documentRoomId(metadata) !== filters.roomId) {
    return false;
  }
  if (
    filters.mediaFormat &&
    documentMediaFormat(metadata, tags) !== filters.mediaFormat
  ) {
    return false;
  }

  const timestamp =
    typeof metadata?.timestamp === "number"
      ? metadata.timestamp
      : typeof metadata?.addedAt === "number"
        ? metadata.addedAt
        : typeof memory.createdAt === "number"
          ? memory.createdAt
          : undefined;
  if (
    typeof filters.timeRangeStart === "number" &&
    (typeof timestamp !== "number" || timestamp < filters.timeRangeStart)
  ) {
    return false;
  }
  if (
    typeof filters.timeRangeEnd === "number" &&
    (typeof timestamp !== "number" || timestamp > filters.timeRangeEnd)
  ) {
    return false;
  }
  if (filters.query) {
    const query = filters.query.toLowerCase();
    // content.text carries any text-derived title, so the raw metadata title
    // fields plus the body cover the same ground the presenter's derived title
    // would — no need to pull the presenter into the inner layer.
    const haystack = [
      memory.content?.text,
      metadata?.title,
      metadata?.filename,
      metadata?.originalFilename,
      metadata?.source,
      metadata?.url,
    ]
      .filter((value): value is string => typeof value === "string")
      .join("\n")
      .toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  return true;
}

/**
 * The scope wall: can `actor` READ this document memory? owner-private requires
 * owner/runtime; agent-private requires owner/agent/runtime; user-private
 * matches the scoped entity (owner may target a specific entity via
 * `filters.scopedToEntityId`); global is open. This is the guard that keeps an
 * owner-chat item from ever surfacing to a public-room actor (#13593).
 */
export function canReadDocumentMemory(
  memory: DocumentReadableMemory,
  actor: RouteActor,
  filters: DocumentFilter = {},
): boolean {
  const metadata = asRecord(memory.metadata);
  const scope = getDocumentVisibilityScope(metadata);

  if (scope === "global") return true;
  if (scope === "owner-private") return actorCanManageOwnerDocuments(actor);
  if (scope === "agent-private") return actorCanManageAgentDocuments(actor);

  const scopedEntityId = documentScopedEntityId(memory);
  if (!scopedEntityId) return false;

  if (actor.role === "AGENT" || actor.role === "RUNTIME") return true;
  if (actor.role === "OWNER") {
    return filters.scopedToEntityId
      ? scopedEntityId === filters.scopedToEntityId
      : scopedEntityId === actor.entityId;
  }
  return scopedEntityId === actor.entityId;
}

export function canMutateDocumentMemory(
  memory: Memory,
  actor: RouteActor,
): boolean {
  const metadata = asRecord(memory.metadata);
  const scope = getDocumentVisibilityScope(metadata);

  if (scope === "global" || scope === "owner-private") {
    return actorCanManageOwnerDocuments(actor);
  }
  if (scope === "agent-private") {
    return actorCanManageAgentDocuments(actor);
  }

  const scopedEntityId = documentScopedEntityId(memory);
  return (
    actorCanManageAgentDocuments(actor) ||
    (Boolean(scopedEntityId) && scopedEntityId === actor.entityId)
  );
}

/**
 * The send wall for SEND_MEDIA_TO (#13595): can this document be delivered OUT
 * to a target room of the given visibility? An owner-private or user-private
 * item may never leave for a public/shared room. Returns a typed refusal
 * (reason + scope) so callers surface WHY the send was blocked instead of a
 * bare boolean.
 */
export function canSendDocumentToPublic(
  memory: DocumentReadableMemory,
  targetIsPublic: boolean,
):
  | { ok: true }
  | { ok: false; reason: string; scope: DocumentVisibilityScope } {
  const scope = getDocumentVisibilityScope(asRecord(memory.metadata));
  if (!targetIsPublic) return { ok: true };
  if (scope === "owner-private" || scope === "user-private") {
    return {
      ok: false,
      reason:
        scope === "owner-private"
          ? "This is an owner-private item; it cannot be sent into a public room."
          : "This is a private item; it cannot be sent into a public room.",
      scope,
    };
  }
  return { ok: true };
}

/**
 * The ACTIVE-ROOM surfacing wall (#13974 shaw-codex review). SEARCH_KNOWLEDGE
 * and ATTACH_TO_CHAT emit user-facing snippets / attachments INTO the room the
 * triggering message came from. The actor read wall (`canReadDocumentMemory`)
 * only checks whether the ACTOR may read the item — an OWNER asking in a public
 * group still passes it for an owner-private item learned in DM. That would spill
 * the private item to every other participant of the active public room.
 *
 * So before any user-facing output, classify the ACTIVE room: if it is a public
 * surface, an owner-private or user-private item must be refused/filtered even
 * for an owner actor. Private (DM-like) active rooms are unrestricted. Same rule
 * shape as the send wall, keyed on the active room's visibility. Returns a typed
 * refusal so callers surface WHY.
 */
export function canSurfaceDocumentInRoom(
  memory: DocumentReadableMemory,
  activeRoomIsPublic: boolean,
):
  | { ok: true }
  | { ok: false; reason: string; scope: DocumentVisibilityScope } {
  const scope = getDocumentVisibilityScope(asRecord(memory.metadata));
  if (!activeRoomIsPublic) return { ok: true };
  if (scope === "owner-private" || scope === "user-private") {
    return {
      ok: false,
      reason:
        scope === "owner-private"
          ? "This is an owner-private item; it cannot be surfaced in a public room."
          : "This is a private item; it cannot be surfaced in a public room.",
      scope,
    };
  }
  return { ok: true };
}

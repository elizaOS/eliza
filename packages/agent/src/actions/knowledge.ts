/**
 * The three globally-available knowledge actions (#13595) that let the agent do
 * everything the Knowledge hub's UI affordances do — from any view, not just the
 * Knowledge view:
 *
 *   - SEARCH_KNOWLEDGE — semantic + facet search across the multimedia hub
 *     (docs, transcripts, ingested attachments), scope-walled so an owner-private
 *     item never surfaces to a public-room actor.
 *   - ATTACH_TO_CHAT — resolve a stored item to its content-addressed media URL
 *     and deliver it into the ACTIVE conversation via the handler callback (the
 *     agent-side of the reader/list "Attach to chat" button).
 *   - SEND_MEDIA_TO — DM/send a stored item's media to a target room through the
 *     runtime's connector dispatch (`sendMessageToTarget`), mapping the outcome
 *     to a typed `DispatchResult` and REFUSING an owner-/user-private item into a
 *     public room via the shared send wall.
 *
 * All three resolve items and enforce scope through `@elizaos/agent/api/document-access`
 * — the same wall the REST routes use — so the two surfaces cannot drift. They
 * live in `@elizaos/agent` (always-loaded) rather than the support-only
 * `@elizaos/plugin-documents` so they are genuinely global.
 */
import {
  type Action,
  type ActionResult,
  type Content,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Media,
  type Memory,
  type UUID,
} from "@elizaos/core";
import {
  asRecord,
  asUuid,
  canReadDocumentMemory,
  canSendDocumentToPublic,
  canSurfaceDocumentInRoom,
  type DocumentFilter,
  documentMediaFormat,
  documentTags,
  matchesDocumentFilter,
  type RouteActor,
  type RouteActorRole,
  roomIsPublicSurface,
} from "../api/document-access.ts";
import {
  type DocumentSearchMode,
  type DocumentsServiceLike,
  getDocumentsService,
} from "../api/documents-service-loader.ts";

type DispatchResult =
  | { ok: true; messageId?: string }
  | {
      ok: false;
      reason:
        | "disconnected"
        | "rate_limited"
        | "auth_expired"
        | "unknown_recipient"
        | "transport_error";
      retryAfterMinutes?: number;
      userActionable: boolean;
      message?: string;
    };

const MEDIA_URL_PREFIX = "/api/media/";

function fail(text: string, error: string): ActionResult {
  return { success: false, text, data: { error } };
}

/**
 * Classify the room a message came from / is targeted at as a public/community
 * surface. Resolves the room and routes through the SINGLE canonical
 * classifier (`roomIsPublicSurface`) so the send wall, the active-room surfacing
 * wall, and the ingest spill guard all agree — including on THREAD, which a
 * hand-rolled public-types allowlist previously omitted (shaw-codex review).
 * An unresolvable room fails CLOSED (treated as public) so a missing room record
 * can never be the reason a private item leaks.
 */
async function roomIsPublic(
  runtime: IAgentRuntime,
  roomId: UUID | undefined,
): Promise<boolean> {
  if (!roomId) return true;
  const room = await runtime.getRoom(roomId);
  if (!room) return true;
  return roomIsPublicSurface(room.type);
}

/**
 * The requester's authorization role for the scope wall, derived from the
 * triggering message: the configured owner entity is OWNER, the agent itself is
 * AGENT, everyone else is USER. Mirrors the header-derived role the REST routes
 * resolve so both surfaces enforce the same wall.
 */
function actorFromMessage(runtime: IAgentRuntime, message: Memory): RouteActor {
  const agentId = runtime.agentId;
  const ownerEntityId = asUuid(runtime.getSetting?.("ELIZA_ADMIN_ENTITY_ID"));
  const entityId = (message.entityId ?? agentId) as UUID;
  let role: RouteActorRole = "USER";
  if (entityId === agentId) role = "AGENT";
  else if (ownerEntityId && entityId === ownerEntityId) role = "OWNER";
  return { entityId, role, ownerEntityId };
}

function parseSearchMode(value: unknown): DocumentSearchMode | undefined {
  return value === "hybrid" || value === "vector" || value === "keyword"
    ? value
    : undefined;
}

function normalizeTags(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const tags = value.filter(
      (v): v is string => typeof v === "string" && v.trim().length > 0,
    );
    return tags.length > 0 ? tags : undefined;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }
  return undefined;
}

function filtersFromParams(params: Record<string, unknown>): DocumentFilter {
  const filters: DocumentFilter = {};
  const scope = params.scope;
  if (
    scope === "global" ||
    scope === "owner-private" ||
    scope === "user-private" ||
    scope === "agent-private"
  ) {
    filters.scope = scope;
  }
  const roomId = asUuid(params.roomId);
  if (roomId) filters.roomId = roomId;
  const addedBy = asUuid(params.addedBy ?? params.sender);
  if (addedBy) filters.addedBy = addedBy;
  const mediaFormat =
    typeof params.mediaFormat === "string"
      ? params.mediaFormat
      : typeof params.format === "string"
        ? params.format
        : undefined;
  if (mediaFormat) filters.mediaFormat = mediaFormat.toLowerCase();
  const tags = normalizeTags(params.tags);
  if (tags) filters.tags = tags;
  return filters;
}

/**
 * Resolve a knowledge item to a `{ memory, mediaUrl, mimeType, title }` handle
 * by document id OR by the sha256 media filename/url it was ingested from. The
 * memory carries the scope metadata the wall reads; `mediaUrl` is the durable
 * `/api/media/<sha256>` link the ingest pipeline stored on the record.
 */
async function resolveItem(
  runtime: IAgentRuntime,
  itemRef: string,
): Promise<{
  memory: Memory;
  mediaUrl?: string;
  mimeType?: string;
  title: string;
} | null> {
  const { service } = await getDocumentsService(
    runtime as unknown as Parameters<typeof getDocumentsService>[0],
  );
  const asId = asUuid(itemRef);
  let memory: Memory | null = null;
  if (asId) {
    memory =
      (await service?.getDocumentById?.(asId)) ??
      (await runtime.getMemoryById(asId));
  }
  if (!memory) {
    // Fall back to a sha256 media reference: an item may be named by the media
    // it was ingested from rather than its document id.
    const fileName = mediaFileNameFromRef(itemRef);
    if (fileName && service) {
      const docs = await service.getMemories({
        tableName: "documents",
        count: 1000,
      });
      memory =
        docs.find((doc) => {
          const meta = asRecord(doc.metadata);
          return (
            meta?.mediaFileName === fileName ||
            (typeof meta?.mediaUrl === "string" &&
              meta.mediaUrl.endsWith(fileName))
          );
        }) ?? null;
    }
  }
  if (!memory) return null;
  const meta = asRecord(memory.metadata);
  const mediaUrl =
    typeof meta?.mediaUrl === "string" ? meta.mediaUrl : undefined;
  const mimeType =
    typeof meta?.mediaMimeType === "string"
      ? meta.mediaMimeType
      : typeof meta?.contentType === "string"
        ? meta.contentType
        : undefined;
  const title =
    (typeof meta?.title === "string" && meta.title) ||
    (typeof meta?.filename === "string" && meta.filename) ||
    (typeof meta?.originalFilename === "string" && meta.originalFilename) ||
    "knowledge item";
  return { memory, mediaUrl, mimeType, title };
}

function mediaFileNameFromRef(ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const withoutPrefix = trimmed.startsWith(MEDIA_URL_PREFIX)
    ? trimmed.slice(MEDIA_URL_PREFIX.length)
    : (trimmed.split("/").pop() ?? trimmed);
  // sha256 (64 hex) + extension, e.g. "ab12….pdf"
  return /^[0-9a-f]{64}\.[a-z0-9]+$/i.test(withoutPrefix)
    ? withoutPrefix
    : null;
}

function contentTypeFromMime(mime: string | undefined): Media["contentType"] {
  if (!mime) return undefined;
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

function mediaFromItem(item: {
  memory: Memory;
  mediaUrl?: string;
  mimeType?: string;
  title: string;
}): Media | null {
  if (!item.mediaUrl) return null;
  return {
    id: (item.memory.id ?? crypto.randomUUID()) as string,
    url: item.mediaUrl,
    title: item.title,
    source: "knowledge",
    ...(contentTypeFromMime(item.mimeType)
      ? { contentType: contentTypeFromMime(item.mimeType) }
      : {}),
  };
}

/** A retrieved knowledge record, from either the semantic or facet path. */
type KnowledgeSearchRow = {
  id: UUID;
  content: { text?: string };
  similarity?: number;
  metadata?: Record<string, unknown>;
};

/** How many document rows to pull per scan batch in the facet-list path. */
const DOCUMENT_SCAN_BATCH = 200;
/** Cap the facet scan so a huge corpus can't unbounded-loop an action. */
const DOCUMENT_SCAN_MAX = 2000;

/**
 * Free-text retrieval path: semantic/hybrid search over the document store,
 * scoped by the facet room/entity the same way the REST search route scopes it.
 */
async function searchByQuery(
  service: DocumentsServiceLike,
  runtime: IAgentRuntime,
  actor: RouteActor,
  query: string,
  filters: DocumentFilter,
  searchMode: DocumentSearchMode | undefined,
): Promise<KnowledgeSearchRow[]> {
  const searchMessage: Memory = {
    id: crypto.randomUUID() as UUID,
    entityId: actor.entityId,
    agentId: runtime.agentId,
    roomId: (filters.roomId ?? runtime.agentId) as UUID,
    content: { text: query },
    createdAt: Date.now(),
  };
  const scope: { roomId?: UUID; entityId?: UUID } = {};
  if (filters.scopedToEntityId) scope.entityId = filters.scopedToEntityId;
  if (filters.roomId) scope.roomId = filters.roomId;
  return service.searchDocuments(
    searchMessage,
    Object.keys(scope).length > 0 ? scope : undefined,
    searchMode,
  );
}

/**
 * Filter-only retrieval path (#13595 tag/facet surfacing): scan the documents
 * table and return every record, letting the caller's shared
 * `matchesDocumentFilter` + wall filters narrow it. There is no meaningful
 * embedding for an empty query, so a facet-only request lists by scan instead of
 * semantic search — the same approach the REST `/api/documents` list route uses.
 */
async function listByFacets(
  service: DocumentsServiceLike,
  agentId: UUID,
  _actor: RouteActor,
  _filters: DocumentFilter,
): Promise<KnowledgeSearchRow[]> {
  const rows: KnowledgeSearchRow[] = [];
  let offset = 0;
  while (offset < DOCUMENT_SCAN_MAX) {
    const batch = await service.getMemories({
      tableName: "documents",
      count: DOCUMENT_SCAN_BATCH,
      offset,
    });
    if (batch.length === 0) break;
    for (const memory of batch) {
      const meta = asRecord(memory.metadata);
      // Only real document memories for this agent (mirrors isDocumentMemory).
      if (meta?.type !== "document" && meta?.documentId === undefined) continue;
      if (memory.agentId && memory.agentId !== agentId) continue;
      rows.push({
        id: memory.id as UUID,
        content: { text: memory.content?.text },
        metadata: meta,
      });
    }
    if (batch.length < DOCUMENT_SCAN_BATCH) break;
    offset += DOCUMENT_SCAN_BATCH;
  }
  return rows;
}

export const searchKnowledgeAction: Action = {
  name: "SEARCH_KNOWLEDGE",
  contexts: ["knowledge", "documents", "files", "media", "agent_internal"],
  similes: [
    "FIND_KNOWLEDGE",
    "SEARCH_DOCS",
    "SEARCH_FILES",
    "SEARCH_TRANSCRIPTS",
    "FIND_DOCUMENT",
    "LOOKUP_KNOWLEDGE",
  ],
  description:
    "Search the multimedia knowledge hub (documents, transcripts, ingested attachments) by free text plus optional facets (roomId, sender/addedBy, mediaFormat, tags, scope). Returns matching items with their titles, media formats, and ids for follow-up ATTACH_TO_CHAT / SEND_MEDIA_TO. Scope-walled: owner-private items never surface to non-owner callers.",
  descriptionCompressed:
    "semantic + facet search over the knowledge hub; returns items (scope-walled)",
  routingHint:
    "search stored knowledge/documents/transcripts/attachments (by text or by room/sender/media-format/tag) -> SEARCH_KNOWLEDGE; to put a found item INTO this chat -> ATTACH_TO_CHAT; to DM/send it to a contact/room -> SEND_MEDIA_TO",
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
  ): Promise<ActionResult> => {
    const params = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as Record<string, unknown>;
    const query = typeof params.query === "string" ? params.query.trim() : "";

    const { service, reason } = await getDocumentsService(
      runtime as unknown as Parameters<typeof getDocumentsService>[0],
    );
    if (!service) {
      return fail(
        "Knowledge store is not available.",
        `KNOWLEDGE_NO_SERVICE_${reason ?? "unknown"}`.toUpperCase(),
      );
    }

    const actor = actorFromMessage(runtime, message);
    const filters = filtersFromParams(params);
    // Filter-only surfacing (#13595): a tag/room/sender/media-format query with
    // no free text is valid — it lists every item matching those facets. Only a
    // completely empty request (no text AND no facet) is rejected.
    const hasFilter =
      Boolean(filters.scope) ||
      Boolean(filters.roomId) ||
      Boolean(filters.addedBy) ||
      Boolean(filters.mediaFormat) ||
      Boolean(filters.tags && filters.tags.length > 0);
    if (!query && !hasFilter) {
      return fail(
        "A search query or at least one filter (tags, room, sender, or media format) is required.",
        "KNOWLEDGE_INVALID",
      );
    }

    const limit =
      typeof params.limit === "number" && Number.isFinite(params.limit)
        ? Math.max(1, Math.min(50, Math.floor(params.limit)))
        : 10;
    const searchMode = parseSearchMode(params.searchMode);

    // The surfacing wall (#13974): SEARCH renders snippets INTO the active room.
    // If that room is a public/community surface, owner-private and user-private
    // items must be dropped even for an OWNER actor, or the private snippet
    // spills to every participant. Private (DM-like) active rooms are open.
    const activeRoomIsPublic = await roomIsPublic(
      runtime,
      message.roomId as UUID | undefined,
    );

    // Two retrieval paths that converge on the same facet + wall filtering:
    //  - free text  -> semantic/hybrid searchDocuments
    //  - filter-only -> scan the documents table (no meaningful vector for "")
    const raw = query
      ? await searchByQuery(service, runtime, actor, query, filters, searchMode)
      : await listByFacets(service, runtime.agentId, actor, filters);

    const items = raw
      .filter((r) => matchesDocumentFilter(r, { ...filters, query: undefined }))
      .filter((r) => canReadDocumentMemory(r, actor, filters))
      .filter((r) => canSurfaceDocumentInRoom(r, activeRoomIsPublic).ok)
      .slice(0, limit)
      .map((r) => {
        const meta = asRecord(r.metadata);
        const tags = documentTags(meta);
        return {
          id: (meta?.documentId as UUID | undefined) ?? r.id,
          title:
            (typeof meta?.title === "string" && meta.title) ||
            (typeof meta?.filename === "string" && meta.filename) ||
            "Untitled",
          mediaFormat: documentMediaFormat(meta, tags),
          similarity: r.similarity,
          snippet: (r.content.text ?? "").slice(0, 240),
        };
      });

    const label = query ? `for "${query}"` : "for those filters";
    const text = items.length
      ? `Found ${items.length} knowledge item(s) ${label}:\n${items
          .map(
            (it, i) =>
              `${i + 1}. ${it.title}${
                it.mediaFormat ? ` [${it.mediaFormat}]` : ""
              } — ${it.snippet}`,
          )
          .join("\n")}`
      : `No knowledge items match ${label}.`;

    logger.info(
      `[SEARCH_KNOWLEDGE] query="${query}" role=${actor.role} activeRoomPublic=${activeRoomIsPublic} matched=${items.length}`,
    );
    return {
      success: true,
      text,
      userFacingText: text,
      verifiedUserFacing: true,
      data: { query, count: items.length, items },
    };
  },
  parameters: [
    {
      name: "query",
      description:
        "Free-text search over knowledge titles + content. Optional: a facet-only search (tags/room/sender/media-format) with no free text lists every matching item.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "mediaFormat",
      description:
        "Optional facet: image | audio | video | pdf | text | transcript | file",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "roomId",
      description: "Optional source-room UUID facet",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "addedBy",
      description: "Optional sender entity UUID facet",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "tags",
      description: "Optional tag list (array or comma-separated)",
      required: false,
      schema: { type: "array" as const, items: { type: "string" as const } },
    },
    {
      name: "scope",
      description:
        "Optional scope facet: global | owner-private | user-private | agent-private",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "searchMode",
      description: "Optional retrieval mode: hybrid | vector | keyword",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "limit",
      description: "Max results (default 10, max 50)",
      required: false,
      schema: { type: "number" as const },
    },
  ],
};

export const attachToChatAction: Action = {
  name: "ATTACH_TO_CHAT",
  contexts: ["knowledge", "documents", "files", "media", "agent_internal"],
  similes: [
    "ATTACH_KNOWLEDGE",
    "ADD_TO_CHAT",
    "INSERT_ATTACHMENT",
    "SHOW_FILE",
  ],
  description:
    "Attach a stored knowledge item's media into the ACTIVE conversation so the user sees it inline. Takes the item id or its sha256 media reference. Scope-walled: refuses an item the caller may not read.",
  descriptionCompressed:
    "put a stored knowledge item's media into this chat (id | sha256)",
  routingHint:
    "insert/attach a stored knowledge item into THIS chat -> ATTACH_TO_CHAT; to send it to someone else's DM/room -> SEND_MEDIA_TO; to find the item first -> SEARCH_KNOWLEDGE",
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const params = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as Record<string, unknown>;
    const itemRef =
      typeof params.itemId === "string"
        ? params.itemId
        : typeof params.sha256 === "string"
          ? params.sha256
          : typeof params.id === "string"
            ? params.id
            : "";
    if (!itemRef.trim()) {
      return fail(
        "An itemId or sha256 reference is required.",
        "ATTACH_INVALID",
      );
    }

    const item = await resolveItem(runtime, itemRef.trim());
    if (!item)
      return fail(`No knowledge item for "${itemRef}".`, "ATTACH_NOT_FOUND");

    const actor = actorFromMessage(runtime, message);
    if (!canReadDocumentMemory(item.memory, actor)) {
      return fail(
        "You do not have access to that knowledge item.",
        "ATTACH_FORBIDDEN",
      );
    }

    // Surfacing wall (#13974): ATTACH delivers the media INTO the active room.
    // A private item may be readable by an OWNER actor yet must never be
    // attached into a public/community room where other participants see it.
    const activeRoomIsPublic = await roomIsPublic(
      runtime,
      message.roomId as UUID | undefined,
    );
    const surface = canSurfaceDocumentInRoom(item.memory, activeRoomIsPublic);
    if (!surface.ok) {
      logger.warn(
        `[ATTACH_TO_CHAT] refused ${surface.scope} item into public active room ${message.roomId}`,
      );
      return {
        success: false,
        text: surface.reason,
        userFacingText: surface.reason,
        verifiedUserFacing: true,
        data: { error: "ATTACH_SCOPE_REFUSED", scope: surface.scope },
      };
    }

    const media = mediaFromItem(item);
    if (!media) {
      return fail(
        `"${item.title}" has no attachable media (text-only knowledge).`,
        "ATTACH_NO_MEDIA",
      );
    }

    // B1 (#13974): without a chat callback there is no channel to deliver the
    // attachment on, so the action CANNOT have succeeded. Report a typed failure
    // instead of a false success the model would relay as "attached".
    if (!callback) {
      return fail(
        "No chat callback is available to attach into; ATTACH_TO_CHAT needs an active conversation. Use SEND_MEDIA_TO to deliver to a specific room.",
        "ATTACH_NO_CALLBACK",
      );
    }

    const content: Content = {
      text: `Attached: ${item.title}`,
      attachments: [media],
    };
    await callback(content, "ATTACH_TO_CHAT");

    logger.info(
      `[ATTACH_TO_CHAT] item="${item.title}" url=${media.url} role=${actor.role}`,
    );
    return {
      success: true,
      text: `Attached "${item.title}" to the chat.`,
      userFacingText: `Attached "${item.title}" to the chat.`,
      verifiedUserFacing: true,
      data: { mediaUrl: media.url, title: item.title },
    };
  },
  parameters: [
    {
      name: "itemId",
      description: "Knowledge item document id, or its sha256 media reference",
      required: true,
      schema: { type: "string" as const },
    },
  ],
};

export const sendMediaToAction: Action = {
  name: "SEND_MEDIA_TO",
  contexts: ["knowledge", "documents", "files", "media", "agent_internal"],
  roleGate: { minRole: "OWNER" },
  similes: ["SEND_KNOWLEDGE", "SEND_FILE_TO", "SHARE_MEDIA", "DM_MEDIA"],
  description:
    "Send a stored knowledge item's media to a target room/DM through the connector dispatch. Takes the item id (or sha256) and a target roomId. Enforces the send wall: an owner-private or user-private item is REFUSED into a public room. Returns a typed dispatch outcome.",
  descriptionCompressed:
    "send a stored knowledge item's media to a room/DM (scope-walled)",
  routingHint:
    "send/DM/share a stored knowledge item to a contact or room -> SEND_MEDIA_TO; to attach it to the CURRENT chat instead -> ATTACH_TO_CHAT",
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
  ): Promise<ActionResult> => {
    const params = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as Record<string, unknown>;
    const itemRef =
      typeof params.itemId === "string"
        ? params.itemId
        : typeof params.sha256 === "string"
          ? params.sha256
          : "";
    const targetRoomId = asUuid(
      params.roomId ?? params.target ?? params.contact,
    );
    if (!itemRef.trim()) {
      return fail("An itemId or sha256 reference is required.", "SEND_INVALID");
    }
    if (!targetRoomId) {
      return fail("A target roomId is required.", "SEND_NO_TARGET");
    }

    const item = await resolveItem(runtime, itemRef.trim());
    if (!item)
      return fail(`No knowledge item for "${itemRef}".`, "SEND_NOT_FOUND");

    const actor = actorFromMessage(runtime, message);
    if (!canReadDocumentMemory(item.memory, actor)) {
      return fail(
        "You do not have access to that knowledge item.",
        "SEND_FORBIDDEN",
      );
    }

    const media = mediaFromItem(item);
    if (!media) {
      return fail(
        `"${item.title}" has no sendable media (text-only knowledge).`,
        "SEND_NO_MEDIA",
      );
    }

    const targetRoom = await runtime.getRoom(targetRoomId);
    // Classify via the canonical surface classifier (includes THREAD) and fail
    // CLOSED for an unresolvable room: an unknown room is treated as public so a
    // missing room record can never be the reason a private item is sent out.
    const targetIsPublic = targetRoom
      ? roomIsPublicSurface(targetRoom.type)
      : true;
    const wall = canSendDocumentToPublic(item.memory, targetIsPublic);
    if (!wall.ok) {
      logger.warn(
        `[SEND_MEDIA_TO] refused ${wall.scope} item into public room ${targetRoomId}`,
      );
      return {
        success: false,
        text: wall.reason,
        userFacingText: wall.reason,
        verifiedUserFacing: true,
        data: { error: "SEND_SCOPE_REFUSED", scope: wall.scope },
      };
    }

    const content: Content = {
      text: `Shared: ${item.title}`,
      attachments: [media],
    };
    const dispatch = await dispatchToRoom(
      runtime,
      targetRoom?.source ?? "",
      {
        source: targetRoom?.source ?? "",
        roomId: targetRoomId,
        ...(targetRoom?.channelId ? { channelId: targetRoom.channelId } : {}),
        ...(targetRoom?.serverId ? { serverId: targetRoom.serverId } : {}),
      },
      content,
    );

    if (!dispatch.ok) {
      logger.warn(
        `[SEND_MEDIA_TO] dispatch failed reason=${dispatch.reason} room=${targetRoomId}`,
      );
      return {
        success: false,
        text: `Could not send "${item.title}": ${dispatch.message ?? dispatch.reason}.`,
        data: { error: "SEND_DISPATCH_FAILED", dispatch },
      };
    }

    logger.info(
      `[SEND_MEDIA_TO] sent "${item.title}" to room ${targetRoomId} (msg ${dispatch.messageId ?? "?"})`,
    );
    return {
      success: true,
      text: `Sent "${item.title}" to the target.`,
      userFacingText: `Sent "${item.title}" to the target.`,
      verifiedUserFacing: true,
      data: { dispatch, title: item.title },
    };
  },
  parameters: [
    {
      name: "itemId",
      description: "Knowledge item document id, or its sha256 media reference",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "roomId",
      description: "Target room/DM UUID to send the media into",
      required: true,
      schema: { type: "string" as const },
    },
  ],
};

/**
 * Drive the runtime's connector send and map its outcome to a typed
 * `DispatchResult`. `sendMessageToTarget` throws when no send handler is
 * registered for the source (unknown recipient) or when the transport fails;
 * this is the single J1 boundary translating those into the scheduling spine's
 * dispatch vocabulary so callers branch on `reason`, never a bare boolean.
 */
async function dispatchToRoom(
  runtime: IAgentRuntime,
  source: string,
  target: {
    source: string;
    roomId: UUID;
    channelId?: string;
    serverId?: string;
  },
  content: Content,
): Promise<DispatchResult> {
  if (!source) {
    return {
      ok: false,
      reason: "unknown_recipient",
      userActionable: true,
      message: "Target room has no connector source.",
    };
  }
  try {
    const sent = await runtime.sendMessageToTarget(target, content);
    return { ok: true, ...(sent?.id ? { messageId: sent.id } : {}) };
  } catch (err) {
    // error-policy:J1 boundary translation — connector dispatch failures become
    // a structured DispatchResult the action surfaces to the model/user.
    const msg = err instanceof Error ? err.message : String(err);
    const reason = /no send handler|unknown recipient/i.test(msg)
      ? "unknown_recipient"
      : "transport_error";
    return { ok: false, reason, userActionable: true, message: msg };
  }
}

export const knowledgeActions: Action[] = [
  searchKnowledgeAction,
  attachToChatAction,
  sendMediaToAction,
];

/**
 * Attachment → knowledge ingest pipeline (#13593, knowledge slice 1).
 *
 * When a chat message with attachments is persisted, each attachment whose
 * bytes already live in the content-addressed media store is mirrored into the
 * documents/knowledge store as a searchable knowledge record, tagged by room,
 * sender, sender role, and media format, and linked back to the sha256 bytes
 * via `metadata.mediaUrl/mediaHash/mediaFileName` (the existing "knowledge
 * record points at media" pattern — no second store, no new tables per #8876).
 *
 * **Scope-by-source-trust (spill guard):** the visibility scope is derived from
 * the SOURCE ROOM's trust, never from an arbitrary caller. An owner/DM chat →
 * `owner-private`; a public/community room (Discord, groups, feeds) →
 * `user-private` scoped to the sender. This is the WRITE-boundary wall that
 * keeps owner-only knowledge from ever being written into a public-room-visible
 * scope; `canReadDocumentMemory` in the documents routes is the second (read)
 * wall.
 *
 * The pure derivations (`mediaFormatFromMimeType`, `resolveIngestScope`) are
 * exported for unit testing; `registerAttachmentKnowledgeIngestHook` wires the
 * pipeline into the runtime via an `after_memory_persisted` hook filtered to
 * the `messages` table.
 */

import type { IAgentRuntime, Media, Memory, UUID } from "@elizaos/core";
import {
  type ChannelType,
  ContentType,
  ElizaError,
  resolveEntityRole,
} from "@elizaos/core";
import { roomIsPrivateSurface as roomIsPrivateSurfaceShared } from "./document-access.ts";
import { isStoredMediaUrl, mediaFileNameFromUrl } from "./media-store.ts";

/**
 * Coarse media-format tag derived from an attachment's IANA mime type at read
 * time (#8876: derive format from mimeType, do not persist a new enum). Used
 * both as a knowledge tag (`attachment` + `<format>`) and as the searchable
 * `mediaFormat` facet.
 */
export type MediaFormat =
  | "image"
  | "audio"
  | "video"
  | "pdf"
  | "text"
  | "transcript"
  | "file";

/** The tag every ingested chat attachment carries so it is filterable. */
export const ATTACHMENT_DOCUMENT_TAG = "attachment";

/** Tag prefix namespacing the media-format facet on knowledge records. */
export const MEDIA_FORMAT_TAG_PREFIX = "media-format:";

/** Source marker recorded on every chat-ingested knowledge record. */
const ATTACHMENT_INGEST_SOURCE = "chat-attachment";

const TEXT_MIME_PREFIXES = ["text/"] as const;
const TEXT_MIME_EXACT = new Set<string>([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-yaml",
  "application/yaml",
  "text/markdown",
]);

/**
 * Derive the coarse media-format tag from an attachment mime type (and its
 * coarse `ContentType` as a fallback signal). PDFs get their own facet since
 * they are the dominant "document" subtype users search for by format; other
 * documents fall back to `text` (text-backed) or `file` (opaque binary).
 */
export function mediaFormatFromMimeType(
  mimeType: string | undefined,
  contentType?: ContentType | string,
): MediaFormat {
  const mime = (mimeType ?? "").toLowerCase().trim();

  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "pdf";
  if (
    TEXT_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix)) ||
    TEXT_MIME_EXACT.has(mime)
  ) {
    return "text";
  }

  // Fall back on the coarse ContentType when the mime is missing/unknown.
  switch (contentType) {
    case ContentType.IMAGE:
      return "image";
    case ContentType.AUDIO:
      return "audio";
    case ContentType.VIDEO:
      return "video";
    case ContentType.DOCUMENT:
      // A document with no recognizable text mime is an opaque binary file.
      return "file";
    default:
      return "file";
  }
}

/** Build the ordered knowledge tag set for an ingested attachment. */
export function attachmentKnowledgeTags(format: MediaFormat): string[] {
  return [ATTACHMENT_DOCUMENT_TAG, `${MEDIA_FORMAT_TAG_PREFIX}${format}`];
}

/**
 * Room trust classification used by the spill guard. A DM / SELF / VOICE_DM /
 * API room is a "private" surface (owner's own chat); everything else (GROUP,
 * FORUM, FEED, THREAD, WORLD, …) is a "public"/community surface that must not
 * receive owner-private or global writes.
 *
 * Delegates to the canonical classifier in `document-access.ts` so the ingest
 * spill guard, the send wall, and the active-room surfacing wall can never drift
 * (a channel type omitted from one list but not another silently opened a hole).
 * Re-exported here to keep the existing ingest import surface stable.
 */
export function roomIsPrivateSurface(
  channelType: ChannelType | string | undefined,
): boolean {
  return roomIsPrivateSurfaceShared(channelType);
}

export interface IngestScopeDecision {
  scope: "owner-private" | "user-private";
  /** Set only for `user-private`; the sender the item is scoped to. */
  scopedToEntityId?: UUID;
}

/**
 * Scope-by-source-trust: derive the write scope from the SOURCE room's trust
 * plus whether the sender is the owner. Owner/DM chat → `owner-private`; a
 * public/community room → `user-private` scoped to the sender. NEVER returns
 * `global`/`agent-private` and NEVER returns `owner-private` for a public room,
 * so owner-only knowledge cannot spill into a public-room-visible scope at the
 * write boundary.
 */
export function resolveIngestScope(params: {
  channelType: ChannelType | string | undefined;
  senderIsOwner: boolean;
  senderEntityId: UUID;
}): IngestScopeDecision {
  const { channelType, senderIsOwner, senderEntityId } = params;
  // Owner-only knowledge is confined to private (DM-like) surfaces. Even if the
  // owner speaks in a public room, the item is scoped to them (user-private) so
  // a public-room retrieval for another actor can never surface it.
  if (roomIsPrivateSurface(channelType) && senderIsOwner) {
    return { scope: "owner-private" };
  }
  return { scope: "user-private", scopedToEntityId: senderEntityId };
}

/** Minimal document-service surface this pipeline depends on. */
export interface AttachmentIngestDocumentService {
  addDocument(options: {
    agentId?: UUID;
    worldId: UUID;
    roomId: UUID;
    entityId: UUID;
    clientDocumentId: UUID;
    contentType: string;
    originalFilename: string;
    content: string;
    metadata?: Record<string, unknown>;
    scope?: "global" | "owner-private" | "user-private" | "agent-private";
    scopedToEntityId?: UUID;
    addedBy?: UUID;
    addedByRole?: "OWNER" | "ADMIN" | "USER" | "AGENT" | "RUNTIME";
    addedFrom?: string;
  }): Promise<{
    clientDocumentId: string;
    storedDocumentMemoryId: UUID;
    fragmentCount: number;
  }>;
}

/** Map a resolved role name to the documents-store `addedByRole` enum. */
function addedByRoleForRoleName(
  role: string | undefined,
): "OWNER" | "ADMIN" | "USER" | "AGENT" | "RUNTIME" {
  switch (role) {
    case "OWNER":
      return "OWNER";
    case "ADMIN":
      return "ADMIN";
    default:
      return "USER";
  }
}

/**
 * Build the searchable body text for an attachment knowledge record. Prefer the
 * vision/description text the message pipeline already attached (image
 * descriptions, extracted document text); fall back to a filename/format stub
 * so the record is never empty and still matches a filename/format search.
 *
 * A trailing provenance line (media hash + room + sender + scope) is appended so
 * the documents store's content-addressed dedupe key (`generateContentBasedId`,
 * hashes body + filename) is CONTEXT- and BYTES-scoped:
 *  - the SAME bytes shared in a different room, by a different sender, or under
 *    a different scope produce a DISTINCT record (no roomId/sender/scope facet
 *    loss); and
 *  - two DIFFERENT attachments that happen to share a filename + description in
 *    the same (room, sender, scope) still produce DISTINCT records because the
 *    media hash differs — so the second attachment's distinct mediaUrl/hash is
 *    never dropped by dedupe.
 * Identical bytes in the SAME (room, sender, scope) still dedupe idempotently,
 * which is the intended behavior. The marker is a stable single line so
 * re-ingest is a no-op.
 */
function ingestBodyForAttachment(
  attachment: Media,
  format: MediaFormat,
  fileName: string,
  provenance: {
    roomId: UUID;
    senderEntityId: UUID;
    scope: string;
    mediaHash: string;
  },
): string {
  const label = attachment.filename || attachment.title || fileName;
  const described =
    (typeof attachment.description === "string"
      ? attachment.description.trim()
      : "") ||
    (typeof attachment.text === "string" ? attachment.text.trim() : "");
  const header = `[${format} attachment: ${label}]`;
  const provenanceLine = `[ingest media=${provenance.mediaHash} room=${provenance.roomId} sender=${provenance.senderEntityId} scope=${provenance.scope}]`;
  const body = described ? `${header}\n\n${described}` : header;
  return `${body}\n\n${provenanceLine}`;
}

/**
 * Storage filename for the text-backed knowledge record. The documents service
 * special-cases `.pdf`/binary `originalFilename`s (base64-decode + PDF extract)
 * BEFORE fragmenting — feeding it a synthesized-plaintext body under a `.pdf`
 * name corrupts the stored fragments. We ALWAYS store under a `.txt` name so the
 * body is treated as searchable text; the real display filename is preserved in
 * `metadata.filename`/`originalFilename`.
 */
function textStorageFilename(displayFilename: string): string {
  const base = displayFilename.replace(/\.[^./\\]+$/, "");
  const safeBase = base.trim().length > 0 ? base.trim() : "attachment";
  return `${safeBase}.txt`;
}

export interface IngestAttachmentDeps {
  runtime: IAgentRuntime;
  documents: AttachmentIngestDocumentService;
}

export interface IngestAttachmentResult {
  documentId: UUID;
  mediaFileName: string;
  format: MediaFormat;
  scope: IngestScopeDecision["scope"];
}

/**
 * Ingest every stored attachment on a persisted message as a knowledge record.
 * Returns one result per successfully ingested attachment. Attachments whose
 * bytes are not in the content-addressed store (e.g. unrehosted remote links)
 * are skipped — only durable, servable bytes become knowledge. Any individual
 * ingest failure throws a typed `ElizaError` (fail fast) so an attachment can
 * never silently vanish from knowledge; the caller (pipeline hook) reports it.
 */
export async function ingestMessageAttachmentsAsKnowledge(
  deps: IngestAttachmentDeps,
  message: Memory,
): Promise<IngestAttachmentResult[]> {
  const { runtime, documents } = deps;
  const attachments = message.content?.attachments;
  if (!Array.isArray(attachments) || attachments.length === 0) return [];

  const senderEntityId = message.entityId as UUID;
  const agentId = runtime.agentId as UUID;
  const roomId = message.roomId as UUID;

  // Resolve room trust + sender role once for the whole message.
  let room: Awaited<ReturnType<IAgentRuntime["getRoom"]>>;
  try {
    room = await runtime.getRoom(roomId);
  } catch (err) {
    // error-policy:J2 room trust is required for the write-boundary spill
    // guard; fabricating a default surface would hide a broken data path.
    throw new ElizaError("attachment→knowledge ingest could not load room", {
      code: "ATTACHMENT_KNOWLEDGE_ROOM_LOOKUP_FAILED",
      cause: err instanceof Error ? err : new Error(String(err)),
      severity: "ephemeral",
      context: { roomId },
    });
  }
  if (!room) {
    throw new ElizaError("attachment→knowledge ingest room was not found", {
      code: "ATTACHMENT_KNOWLEDGE_ROOM_NOT_FOUND",
      severity: "ephemeral",
      context: { roomId },
    });
  }
  const channelType = room?.type;
  const worldId = (message.worldId ?? room?.worldId ?? agentId) as UUID;

  let world: Awaited<ReturnType<IAgentRuntime["getWorld"]>>;
  try {
    world = await runtime.getWorld(worldId);
  } catch (err) {
    // error-policy:J2 sender role depends on the room's world; defaulting to
    // USER would make an owner/DM attachment look successfully user-scoped.
    throw new ElizaError("attachment→knowledge ingest could not load world", {
      code: "ATTACHMENT_KNOWLEDGE_WORLD_LOOKUP_FAILED",
      cause: err instanceof Error ? err : new Error(String(err)),
      severity: "ephemeral",
      context: { roomId, worldId },
    });
  }
  if (!world) {
    throw new ElizaError("attachment→knowledge ingest world was not found", {
      code: "ATTACHMENT_KNOWLEDGE_WORLD_NOT_FOUND",
      severity: "ephemeral",
      context: { roomId, worldId },
    });
  }

  let roleName: string;
  try {
    roleName = await resolveEntityRole(
      runtime,
      world,
      (world.metadata ?? undefined) as never,
      senderEntityId,
    );
  } catch (err) {
    // error-policy:J2 sender role is part of the persisted knowledge facets and
    // owner spill guard; a fallback role would make broken role resolution look
    // like a healthy USER write.
    throw new ElizaError(
      "attachment→knowledge ingest could not resolve sender role",
      {
        code: "ATTACHMENT_KNOWLEDGE_ROLE_LOOKUP_FAILED",
        cause: err instanceof Error ? err : new Error(String(err)),
        severity: "ephemeral",
        context: { roomId, worldId, senderEntityId },
      },
    );
  }
  const senderIsOwner = roleName === "OWNER";
  const addedByRole = addedByRoleForRoleName(roleName);

  const results: IngestAttachmentResult[] = [];

  for (const attachment of attachments) {
    if (!attachment || typeof attachment.url !== "string") continue;
    // Only mirror durable, store-backed bytes into knowledge. A remote/ephemeral
    // URL is intentionally skipped (nothing durable to point a record at).
    if (!isStoredMediaUrl(attachment.url)) continue;
    const mediaFileName = mediaFileNameFromUrl(attachment.url);
    if (!mediaFileName) continue;

    const format = mediaFormatFromMimeType(
      attachment.mimeType,
      attachment.contentType,
    );
    const { scope, scopedToEntityId } = resolveIngestScope({
      channelType,
      senderIsOwner,
      senderEntityId,
    });

    const fileName = attachment.filename || attachment.title || mediaFileName;
    const mediaHash =
      typeof attachment.checksum === "string"
        ? attachment.checksum
        : mediaFileName.split(".")[0];
    // Store under a .txt name so the documents service treats the synthesized
    // plaintext body as text (never the .pdf/binary base64-decode + extract
    // path). The real display filename lives in metadata.filename.
    const storageFilename = textStorageFilename(fileName);

    try {
      const stored = await documents.addDocument({
        agentId,
        worldId,
        roomId,
        entityId: scope === "user-private" ? senderEntityId : agentId,
        clientDocumentId: "" as UUID,
        // Text-backed so the documents store treats the body as searchable text
        // rather than trying to re-decode opaque bytes it never received.
        contentType: "text/plain",
        originalFilename: storageFilename,
        content: ingestBodyForAttachment(attachment, format, fileName, {
          roomId,
          senderEntityId,
          scope,
          mediaHash,
        }),
        scope,
        ...(scopedToEntityId ? { scopedToEntityId } : {}),
        addedBy: senderEntityId,
        addedByRole,
        addedFrom: "chat",
        metadata: {
          source: ATTACHMENT_INGEST_SOURCE,
          tags: attachmentKnowledgeTags(format),
          mediaFormat: format,
          roomId,
          filename: fileName,
          originalFilename: fileName,
          contentType: attachment.mimeType ?? "application/octet-stream",
          fileType: attachment.mimeType ?? "application/octet-stream",
          textBacked: true,
          scope,
          ...(scopedToEntityId ? { scopedToEntityId } : {}),
          addedBy: senderEntityId,
          addedByRole,
          addedFrom: "chat",
          // Link back to the durable sha256 bytes (the reference-aware GC unions
          // document `metadata.mediaUrl` so the file survives while a record
          // points at it).
          mediaUrl: attachment.url,
          mediaHash,
          mediaFileName,
          ...(typeof attachment.mimeType === "string"
            ? { mediaMimeType: attachment.mimeType }
            : {}),
        },
      });

      results.push({
        documentId: stored.clientDocumentId as UUID,
        mediaFileName,
        format,
        scope,
      });
    } catch (err) {
      // error-policy:J2 add the attachment identity/scope context before the
      // pipeline boundary reports the failure; never silently skip a failed
      // document write and make the attachment vanish from knowledge.
      throw new ElizaError(
        `attachment→knowledge ingest failed for ${fileName} (${mediaFileName})`,
        {
          code: "ATTACHMENT_KNOWLEDGE_INGEST_FAILED",
          cause: err instanceof Error ? err : new Error(String(err)),
          severity: "ephemeral",
          context: { roomId, mediaFileName, format, scope },
        },
      );
    }
  }

  return results;
}

const INGEST_HOOK_ID = "attachment-knowledge-ingest";
const MESSAGES_TABLE = "messages";

/** Resolve the runtime "documents" service, or null if not registered. */
function getIngestDocumentService(
  runtime: IAgentRuntime,
): AttachmentIngestDocumentService | null {
  const service = runtime.getService("documents") as
    | (AttachmentIngestDocumentService & object)
    | null;
  if (
    service &&
    typeof (service as AttachmentIngestDocumentService).addDocument ===
      "function"
  ) {
    return service as AttachmentIngestDocumentService;
  }
  return null;
}

/**
 * Register the attachment→knowledge ingest pipeline. Runs on
 * `after_memory_persisted` for the `messages` table only: after a user message
 * with attachments commits, its store-backed attachments are mirrored into the
 * knowledge store with room/sender/role/media-format tags and a
 * source-trust-derived scope. Idempotency is provided by the documents store's
 * content-addressed id (`generateContentBasedId`): re-ingesting the same body +
 * filename returns the existing document instead of duplicating.
 */
export function registerAttachmentKnowledgeIngestHook(
  runtime: IAgentRuntime,
): void {
  runtime.registerPipelineHook({
    id: INGEST_HOOK_ID,
    phase: "after_memory_persisted",
    // Reader phase: it must not mutate the just-persisted message.
    mutatesPrimary: false,
    schedule: "concurrent",
    handler: async (rt, ctx) => {
      if (ctx.phase !== "after_memory_persisted") return;
      if (ctx.tableName !== MESSAGES_TABLE) return;
      const message = ctx.memory;
      const attachments = message.content?.attachments;
      if (!Array.isArray(attachments) || attachments.length === 0) return;
      // Only mirror inbound (user/other) attachments — the agent's own outgoing
      // attachments are already the agent's context, not new knowledge to file.
      if (message.entityId === rt.agentId) return;

      const documents = getIngestDocumentService(rt);
      if (!documents) {
        // Documents service not enabled for this agent — nothing to ingest into.
        return;
      }

      try {
        await ingestMessageAttachmentsAsKnowledge(
          { runtime: rt, documents },
          message,
        );
      } catch (err) {
        // error-policy:J1 pipeline-hook boundary: a typed ingest failure
        // surfaces through RECENT_ERRORS / owner escalation instead of aborting
        // the message pipeline.
        rt.reportError("attachment-knowledge-ingest", err, {
          roomId: message.roomId,
        });
      }
    },
  });
}

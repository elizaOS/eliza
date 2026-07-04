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
  ChannelType,
  ContentType,
  ElizaError,
  resolveEntityRole,
} from "@elizaos/core";
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
 * A trailing provenance line (room + sender + scope) is appended so the
 * documents store's content-addressed dedupe key (`generateContentBasedId`,
 * hashes body + filename) is CONTEXT-scoped: the SAME bytes shared in a
 * different room, by a different sender, or under a different scope produce a
 * DISTINCT knowledge record instead of collapsing onto the first occurrence and
 * losing that occurrence's roomId/sender/scope facets. Identical bytes in the
 * SAME (room, sender, scope) still dedupe idempotently, which is the intended
 * behavior. The marker is a stable single line so re-ingest is a no-op.
 */
function ingestBodyForAttachment(
  attachment: Media,
  format: MediaFormat,
  fileName: string,
  provenance: { roomId: UUID; senderEntityId: UUID; scope: string },
): string {
  const label = attachment.filename || attachment.title || fileName;
  const described =
    (typeof attachment.description === "string"
      ? attachment.description.trim()
      : "") ||
    (typeof attachment.text === "string" ? attachment.text.trim() : "");
  const header = `[${format} attachment: ${label}]`;
  const provenanceLine = `[ingest room=${provenance.roomId} sender=${provenance.senderEntityId} scope=${provenance.scope}]`;
  const body = described ? `${header}\n\n${described}` : header;
  return `${body}\n\n${provenanceLine}`;
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
  const room = await runtime.getRoom(roomId).catch(() => null);
  const channelType = room?.type;
  const worldId = (message.worldId ?? room?.worldId ?? agentId) as UUID;

  const world = worldId
    ? await runtime.getWorld(worldId).catch(() => null)
    : null;
  const roleName = await resolveEntityRole(
    runtime,
    world,
    (world?.metadata ?? undefined) as never,
    senderEntityId,
  ).catch(() => "USER");
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
        originalFilename: fileName,
        content: ingestBodyForAttachment(attachment, format, fileName, {
          roomId,
          senderEntityId,
          scope,
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
      // Fail fast with a typed error: never a silent skip that makes an
      // attachment vanish from knowledge. The pipeline-hook boundary catches
      // this and routes it to reportError.
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
        // Boundary: a typed ingest failure surfaces through RECENT_ERRORS /
        // owner escalation instead of aborting the message pipeline.
        rt.reportError("attachment-knowledge-ingest", err, {
          roomId: message.roomId,
        });
      }
    },
  });
}

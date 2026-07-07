/**
 * Chat-message attachment DTO shaping + per-viewer disclosure selection
 * (#14781) — the use-case layer behind the conversation message-list route.
 * Serialization (which raw `content.attachments` entries become wire DTOs)
 * and disclosure (what THIS viewer may see of them) live here so the route
 * only assembles fields.
 *
 * Disclosure follows the ONE core predicate (`resolveArtifactDisclosure`) fed
 * with the message row's metadata. Chat messages default to scope `"room"`
 * (open): a viewer who can read the conversation sees its attachments, which
 * preserves existing behavior for every unmarked message. Only a message
 * explicitly marked (scope metadata or share grants) narrows: a
 * redacted-grant viewer gets each attachment's PII-scrubbed variant
 * (`Media.redactedUrl`, a separate content-addressed object) flagged
 * `redacted: true` with the original URL and enrichment text withheld; an
 * undisclosed viewer gets nothing.
 */
import type { AccessContext, Memory, MemoryScope, UUID } from "@elizaos/core";
import {
  parseArtifactShareGrants,
  resolveArtifactDisclosure,
} from "@elizaos/core";

/** One chat attachment as served in the message-list DTO. */
export type SerializedMessageAttachment = {
  id: string;
  url: string;
  contentType?: string;
  title?: string;
  description?: string;
  source?: string;
  text?: string;
  mimeType?: string;
  thumbnailUrl?: string;
  /** Reason enrichment could not extract text/description (see Media.notProcessed). */
  notProcessed?: string;
  /** Present (true) when `url` is the PII-scrubbed variant, not the original (#14781). */
  redacted?: true;
};

/**
 * Only URLs the browser can actually load are renderable. Inline-upload
 * placeholders (e.g. `attachment:img-0`) whose bytes were never persisted are
 * dropped here so the client never paints a broken image — real uploads and
 * generated media carry a served `/api/media/...`, remote https, or inline
 * `data:`/`blob:` URL.
 */
const RENDERABLE_ATTACHMENT_URL = /^(?:https?:|data:|blob:|\/)/i;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

export function serializeMessageAttachments(
  content: Record<string, unknown> | undefined,
): SerializedMessageAttachment[] | undefined {
  const raw = content?.attachments;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: SerializedMessageAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    const url = typeof a.url === "string" ? a.url : "";
    if (!url || !RENDERABLE_ATTACHMENT_URL.test(url)) continue;
    out.push({
      id: str(a.id) ?? `att-${out.length}`,
      url,
      ...(str(a.contentType) ? { contentType: str(a.contentType) } : {}),
      ...(str(a.title) ? { title: str(a.title) } : {}),
      ...(str(a.description) ? { description: str(a.description) } : {}),
      ...(str(a.source) ? { source: str(a.source) } : {}),
      ...(str(a.text) ? { text: str(a.text) } : {}),
      ...(str(a.mimeType) ? { mimeType: str(a.mimeType) } : {}),
      ...(str(a.thumbnailUrl) ? { thumbnailUrl: str(a.thumbnailUrl) } : {}),
      ...(str(a.notProcessed) ? { notProcessed: str(a.notProcessed) } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Serialize the redacted view of a message's attachments: each entry with a
 * `redactedUrl` variant is emitted under that URL, flagged, with the original
 * URL, thumbnail, and enrichment text/description withheld (they derive from
 * the ORIGINAL bytes and may carry exactly the PII the variant scrubs).
 * Entries with no variant are omitted — fail closed, never the original.
 */
function serializeRedactedAttachments(
  content: Record<string, unknown> | undefined,
): SerializedMessageAttachment[] | undefined {
  const raw = content?.attachments;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: SerializedMessageAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    const redactedUrl = str(a.redactedUrl) ?? "";
    if (!redactedUrl || !RENDERABLE_ATTACHMENT_URL.test(redactedUrl)) continue;
    out.push({
      id: str(a.id) ?? `att-${out.length}`,
      url: redactedUrl,
      ...(str(a.contentType) ? { contentType: str(a.contentType) } : {}),
      ...(str(a.title) ? { title: str(a.title) } : {}),
      ...(str(a.mimeType) ? { mimeType: str(a.mimeType) } : {}),
      redacted: true,
    });
  }
  return out.length > 0 ? out : undefined;
}

const MEMORY_SCOPES: ReadonlySet<string> = new Set<MemoryScope>([
  "global",
  "shared",
  "room",
  "private",
  "owner-private",
  "user-private",
  "agent-private",
]);

/**
 * Select the attachments DTO of one message row for one viewer. No access
 * context (the single-owner dashboard boundary) serves the full DTO,
 * unchanged. Unknown scope strings fail CLOSED to `owner-private` — a marked
 * row whose marking cannot be read must not widen.
 */
export function selectAttachmentsForViewer(
  row: Pick<Memory, "content" | "metadata" | "entityId">,
  accessContext: AccessContext | undefined,
  agentId: UUID,
): SerializedMessageAttachment[] | undefined {
  const content = row.content as Record<string, unknown> | undefined;
  if (!accessContext) return serializeMessageAttachments(content);

  const metadata = row.metadata as Record<string, unknown> | undefined;
  const rawScope = metadata?.scope;
  const scope: MemoryScope =
    rawScope === undefined
      ? "room"
      : typeof rawScope === "string" && MEMORY_SCOPES.has(rawScope)
        ? (rawScope as MemoryScope)
        : "owner-private";
  const scopedTo = metadata?.scopedToEntityId;
  const disclosure = resolveArtifactDisclosure(
    {
      scope,
      scopedEntityId:
        typeof scopedTo === "string" ? (scopedTo as UUID) : row.entityId,
      grants: parseArtifactShareGrants(metadata),
    },
    accessContext,
    agentId,
  );
  if (disclosure === "full") return serializeMessageAttachments(content);
  if (disclosure === "redacted") return serializeRedactedAttachments(content);
  return undefined;
}

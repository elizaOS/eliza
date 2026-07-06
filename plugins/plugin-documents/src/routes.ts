/**
 * REST route handlers for the document store: list, stats, semantic/keyword
 * search, single fetch, fragment listing, single + bulk upload, URL/YouTube
 * ingestion, and delete. Persistence and search are delegated to the runtime
 * document service (resolved from `@elizaos/agent/api/documents-service-loader`);
 * this module handles HTTP shaping and access-control scoping only.
 */

import {
  actorCanManageAgentDocuments,
  actorCanManageOwnerDocuments,
  asRecord,
  asUuid,
  canMutateDocumentMemory,
  canReadDocumentMemory,
  type DocumentReadableMemory,
  documentMediaFormat,
  documentScopedEntityId,
  documentTags,
  matchesDocumentFilter as matchesSharedDocumentFilter,
  parseDocumentScope,
  type RouteActor,
  routeActorAddedByRole,
  type DocumentFilter as SharedDocumentFilter,
  trimString,
} from "@elizaos/agent/api/document-access";
import type {
  AgentRuntime,
  IFileStorageService,
  Memory,
  RouteHelpers,
  RouteRequestContext,
  UUID,
} from "@elizaos/core";
import {
  __setDocumentUrlFetchImplForTests,
  fetchDocumentFromUrl,
  isYouTubeUrl,
  ServiceType,
} from "@elizaos/core";
import { parseClampedFloat, parsePositiveInteger } from "@elizaos/shared";
import {
  getDocumentContentType,
  getDocumentDeleteability,
  getDocumentEditability,
  getDocumentProvenance,
  getDocumentTitleFromMetadata,
  presentDocument,
} from "./document-presenter.js";
import {
  type DocumentAddedFrom,
  type DocumentSearchMode,
  type DocumentsServiceLike,
  type DocumentVisibilityScope,
  getDocumentsService,
} from "./service-loader.js";

export type DocumentRouteHelpers = RouteHelpers;

export interface DocumentRouteContext extends RouteRequestContext {
  url: URL;
  runtime: AgentRuntime | null;
  decodePathComponent?: (
    raw: string,
    res: DocumentRouteContext["res"],
    label: string,
  ) => string | null;
}

const DOCUMENTS_TABLE = "documents";
const DOCUMENT_FRAGMENTS_TABLE = "document_fragments";
const FRAGMENT_BATCH_SIZE = 500;
const DOCUMENT_UPLOAD_MAX_BODY_BYTES = 32 * 1_048_576; // 32 MB
const MAX_BULK_DOCUMENTS = 100;

type DocumentFilter = SharedDocumentFilter & {
  /**
   * Hub display facet (#13594): the coarse client-facing bucket the Knowledge
   * hub's segmented control filters by: all | doc | image | audio | video |
   * transcript. Unlike {@link mediaFormat} (an exact fine-grained match), `doc`
   * groups the pdf/text/file document subtypes, so the hub's facet rows and
   * counts come from the whole readable store, not just the first page.
   */
  knowledgeFacet?: KnowledgeHubFacet;
};

/** The Knowledge hub's coarse display facets (#13594); `all` is the no-op. */
type KnowledgeHubFacet =
  | "all"
  | "doc"
  | "image"
  | "audio"
  | "video"
  | "transcript";

const KNOWLEDGE_HUB_FACETS: readonly KnowledgeHubFacet[] = [
  "all",
  "doc",
  "image",
  "audio",
  "video",
  "transcript",
];

function parseKnowledgeFacet(
  value: string | null,
): KnowledgeHubFacet | undefined {
  const normalized = trimString(value)?.toLowerCase();
  if (!normalized) return undefined;
  return (KNOWLEDGE_HUB_FACETS as readonly string[]).includes(normalized)
    ? (normalized as KnowledgeHubFacet)
    : undefined;
}
type DocumentUploadBody = {
  content: string;
  filename: string;
  contentType?: string;
  metadata?: Record<string, unknown>;
  roomId?: string;
  worldId?: string;
  entityId?: string;
  scope?: string;
  scopedToEntityId?: string;
  addedFrom?: string;
};

function isTextBackedContentType(
  contentType: string,
  filename: string,
): boolean {
  if (contentType.startsWith("text/")) return true;
  if (
    contentType === "application/json" ||
    contentType === "application/xml" ||
    contentType === "application/javascript" ||
    contentType === "text/markdown"
  ) {
    return true;
  }

  const lowerFilename = filename.toLowerCase();
  return (
    lowerFilename.endsWith(".md") ||
    lowerFilename.endsWith(".mdx") ||
    lowerFilename.endsWith(".txt") ||
    lowerFilename.endsWith(".json") ||
    lowerFilename.endsWith(".xml") ||
    lowerFilename.endsWith(".csv") ||
    lowerFilename.endsWith(".tsv")
  );
}

function getOwnerEntityId(runtime: AgentRuntime | null): UUID | undefined {
  if (!runtime || typeof runtime.getSetting !== "function") return undefined;
  return asUuid(runtime.getSetting("ELIZA_ADMIN_ENTITY_ID"));
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return firstHeaderValue(value[0]);
  if (typeof value !== "string") return null;
  const normalized = value.split(",")[0]?.trim();
  return normalized ? normalized : null;
}

function resolveRouteActor(
  req: DocumentRouteContext["req"],
  agentId: UUID,
  ownerEntityId?: UUID,
): RouteActor {
  const headerEntityId =
    asUuid(firstHeaderValue(req.headers["x-eliza-entity-id"])) ??
    asUuid(firstHeaderValue(req.headers["x-eliza-actor-entity-id"]));

  const entityId = headerEntityId ?? ownerEntityId ?? agentId;
  if (headerEntityId === agentId) {
    return { entityId, role: "AGENT", ownerEntityId };
  }
  if (!headerEntityId || (ownerEntityId && headerEntityId === ownerEntityId)) {
    return { entityId, role: "OWNER", ownerEntityId };
  }
  return { entityId, role: "USER", ownerEntityId };
}

function parseSearchMode(value: unknown): DocumentSearchMode | undefined {
  return value === "hybrid" || value === "vector" || value === "keyword"
    ? value
    : undefined;
}

function parseTimestampParam(value: unknown): number | undefined {
  const trimmed = trimString(value);
  if (!trimmed) return undefined;

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return numeric;

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseTagsFromSearchParams(searchParams: URLSearchParams): string[] {
  const values = [
    ...searchParams.getAll("tag"),
    ...searchParams.getAll("tags"),
  ];
  return values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value): value is string => value.length > 0);
}

function filtersFromSearchParams(
  url: URL,
  options: { includeTextQuery?: boolean } = {},
): DocumentFilter {
  const scope = parseDocumentScope(url.searchParams.get("scope"));
  const scopedToEntityId = asUuid(url.searchParams.get("scopedToEntityId"));
  const query = options.includeTextQuery
    ? (trimString(url.searchParams.get("q")) ??
      trimString(url.searchParams.get("query")) ??
      trimString(url.searchParams.get("text")))
    : (trimString(url.searchParams.get("query")) ??
      trimString(url.searchParams.get("text")));
  const addedBy = asUuid(url.searchParams.get("addedBy"));
  const timeRangeStart = parseTimestampParam(
    url.searchParams.get("timeRangeStart") ??
      url.searchParams.get("from") ??
      url.searchParams.get("start"),
  );
  const timeRangeEnd = parseTimestampParam(
    url.searchParams.get("timeRangeEnd") ??
      url.searchParams.get("to") ??
      url.searchParams.get("end"),
  );
  const tags = parseTagsFromSearchParams(url.searchParams);
  const roomId = asUuid(url.searchParams.get("roomId"));
  const mediaFormat = trimString(
    url.searchParams.get("mediaFormat") ?? url.searchParams.get("format"),
  )?.toLowerCase();
  const knowledgeFacet = parseKnowledgeFacet(
    url.searchParams.get("knowledgeFacet") ?? url.searchParams.get("facet"),
  );
  return {
    ...(scope ? { scope } : {}),
    ...(scopedToEntityId ? { scopedToEntityId } : {}),
    ...(query ? { query } : {}),
    ...(addedBy ? { addedBy } : {}),
    ...(typeof timeRangeStart === "number" ? { timeRangeStart } : {}),
    ...(typeof timeRangeEnd === "number" ? { timeRangeEnd } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(roomId ? { roomId } : {}),
    ...(mediaFormat ? { mediaFormat } : {}),
    ...(knowledgeFacet ? { knowledgeFacet } : {}),
  };
}

function filtersFromUploadBody(
  body: {
    metadata?: Record<string, unknown>;
    scope?: string;
    scopedToEntityId?: string;
  },
  actor: RouteActor,
): { scope: DocumentVisibilityScope; scopedToEntityId?: UUID; error?: string } {
  const metadata = asRecord(body.metadata);
  const scope =
    parseDocumentScope(body.scope) ??
    parseDocumentScope(metadata?.scope) ??
    (actor.role === "USER"
      ? "user-private"
      : actor.role === "AGENT"
        ? "agent-private"
        : "global");

  const scopedToEntityId =
    asUuid(body.scopedToEntityId) ?? asUuid(metadata?.scopedToEntityId);

  if (scope === "global" || scope === "owner-private") {
    if (!actorCanManageOwnerDocuments(actor)) {
      return {
        scope,
        error: "Only the owner can write global or owner-private documents.",
      };
    }
    return { scope };
  }

  if (scope === "agent-private") {
    if (!actorCanManageAgentDocuments(actor)) {
      return {
        scope,
        error:
          "Only the owner or agent runtime can write agent-private documents.",
      };
    }
    return { scope, scopedToEntityId: scopedToEntityId ?? actor.entityId };
  }

  const targetEntityId = scopedToEntityId ?? actor.entityId;
  if (actor.role === "USER" && targetEntityId !== actor.entityId) {
    return {
      scope,
      scopedToEntityId: targetEntityId,
      error: "Users can only write documents to their own private scope.",
    };
  }

  return { scope, scopedToEntityId: targetEntityId };
}

function hasUuidId(memory: Memory): memory is Memory & { id: UUID } {
  return typeof memory.id === "string" && memory.id.length > 0;
}

function hasUuidIdAndCreatedAt(
  memory: Memory,
): memory is Memory & { id: UUID; createdAt: number } {
  return hasUuidId(memory) && typeof memory.createdAt === "number";
}

function isDocumentMemory(memory: Memory, agentId: UUID): boolean {
  if (memory.agentId && memory.agentId !== agentId) return false;
  const metadata = asRecord(memory.metadata);
  return (
    metadata?.type === "document" ||
    metadata?.type === "custom" ||
    (typeof metadata?.documentId === "string" &&
      metadata.documentId === memory.id)
  );
}

function matchesDocumentFilter(
  memory: DocumentReadableMemory,
  filters: DocumentFilter,
): boolean {
  if (!matchesSharedDocumentFilter(memory, filters)) return false;

  const metadata = asRecord(memory.metadata);
  if (
    !filters.knowledgeFacet ||
    filters.knowledgeFacet === "all" ||
    documentHubFacet(metadata, documentTags(metadata)) ===
      filters.knowledgeFacet
  ) {
    return true;
  }

  return false;
}

/**
 * Coarse Knowledge-hub facet for a record (#13594). Collapses the fine
 * media-format vocabulary into the hub's display buckets: image/audio/video and
 * transcript pass through; pdf/text/file (and any non-media document) group as
 * `doc`. Falls back to the record's mime type when the format tag is absent, so
 * legacy/un-backfilled records still bucket correctly and the whole store is
 * counted — not just the tagged first page. Transcript-backed records
 * (`transcriptId`) are always the `transcript` bucket, mirroring the client.
 */
function documentHubFacet(
  metadata: Record<string, unknown> | undefined,
  tags: string[],
): Exclude<KnowledgeHubFacet, "all"> {
  if (trimString(metadata?.transcriptId)) return "transcript";
  const format = documentMediaFormat(metadata, tags);
  switch (format) {
    case "image":
    case "audio":
    case "video":
    case "transcript":
      return format;
    case "pdf":
    case "text":
    case "file":
      return "doc";
    default:
      break;
  }
  const mime = getDocumentContentType(metadata).toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "doc";
}
function buildRouteMessage({
  agentId,
  text,
  filters,
  actor,
}: {
  agentId: UUID;
  text: string;
  filters?: DocumentFilter;
  actor: RouteActor;
}): Memory {
  return {
    id: crypto.randomUUID() as UUID,
    entityId: actor.entityId,
    agentId,
    roomId: agentId,
    worldId: agentId,
    content: { text },
    metadata: {
      ...(filters?.scope ? { scope: filters.scope } : {}),
      ...(filters?.scopedToEntityId
        ? { scopedToEntityId: filters.scopedToEntityId }
        : {}),
    },
    createdAt: Date.now(),
  };
}

function serviceSearchScope(
  filters: DocumentFilter,
): { entityId?: UUID; roomId?: UUID } | undefined {
  // Push room scoping into the service BEFORE ranking/capping so a room-filtered
  // search isn't starved by higher-ranked matches from other rooms filling the
  // capped result set (the service filters on the document memory's roomId,
  // which the attachment-ingest writer sets to the source room). scopedToEntityId
  // continues to narrow to a user's private space.
  const scope: { entityId?: UUID; roomId?: UUID } = {};
  if (filters.scopedToEntityId) scope.entityId = filters.scopedToEntityId;
  if (filters.roomId) scope.roomId = filters.roomId;
  return scope.entityId || scope.roomId ? scope : undefined;
}

function decodeMatchedPathComponent(
  ctx: DocumentRouteContext,
  raw: string,
  label: string,
): string | null {
  if (ctx.decodePathComponent) {
    return ctx.decodePathComponent(raw, ctx.res, label);
  }

  try {
    return decodeURIComponent(raw);
  } catch {
    ctx.error(ctx.res, `Invalid ${label}: malformed URL encoding`, 400);
    return null;
  }
}

async function countDocumentFragmentsForDocument(
  documentsService: DocumentsServiceLike,
  roomId: UUID | undefined,
  documentId: UUID,
): Promise<number> {
  let offset = 0;
  let fragmentCount = 0;

  while (true) {
    const fragmentBatch = await documentsService.getMemories({
      tableName: DOCUMENT_FRAGMENTS_TABLE,
      roomId,
      count: FRAGMENT_BATCH_SIZE,
      offset,
    });

    if (fragmentBatch.length === 0) break;

    fragmentCount += fragmentBatch.filter((memory) => {
      const metadata = asRecord(memory.metadata);
      return metadata?.documentId === documentId;
    }).length;

    if (fragmentBatch.length < FRAGMENT_BATCH_SIZE) break;
    offset += FRAGMENT_BATCH_SIZE;
  }

  return fragmentCount;
}

async function mapDocumentFragmentsByDocumentId(
  documentsService: DocumentsServiceLike,
  roomId: UUID | undefined,
  documentIds: readonly UUID[],
): Promise<Map<UUID, number>> {
  const fragmentCounts = new Map<UUID, number>();
  const trackedDocumentIds = new Set(documentIds);
  for (const documentId of trackedDocumentIds) {
    fragmentCounts.set(documentId, 0);
  }

  if (trackedDocumentIds.size === 0) return fragmentCounts;

  let offset = 0;
  while (true) {
    const fragmentBatch = await documentsService.getMemories({
      tableName: DOCUMENT_FRAGMENTS_TABLE,
      roomId,
      count: FRAGMENT_BATCH_SIZE,
      offset,
    });

    if (fragmentBatch.length === 0) break;

    for (const memory of fragmentBatch) {
      const metadata = asRecord(memory.metadata);
      const documentId = metadata?.documentId;
      if (
        typeof documentId === "string" &&
        trackedDocumentIds.has(documentId as UUID)
      ) {
        const currentCount = fragmentCounts.get(documentId as UUID) ?? 0;
        fragmentCounts.set(documentId as UUID, currentCount + 1);
      }
    }

    if (fragmentBatch.length < FRAGMENT_BATCH_SIZE) break;
    offset += FRAGMENT_BATCH_SIZE;
  }

  return fragmentCounts;
}

async function listDocumentFragmentsForDocument(
  documentsService: DocumentsServiceLike,
  roomId: UUID | undefined,
  documentId: UUID,
): Promise<UUID[]> {
  let offset = 0;
  const fragmentIds: UUID[] = [];

  while (true) {
    const fragmentBatch = await documentsService.getMemories({
      tableName: DOCUMENT_FRAGMENTS_TABLE,
      roomId,
      count: FRAGMENT_BATCH_SIZE,
      offset,
    });

    for (const memory of fragmentBatch) {
      const metadata = asRecord(memory.metadata);
      if (metadata?.documentId === documentId && hasUuidId(memory)) {
        fragmentIds.push(memory.id);
      }
    }

    if (fragmentBatch.length < FRAGMENT_BATCH_SIZE) break;
    offset += FRAGMENT_BATCH_SIZE;
  }

  return fragmentIds;
}

async function listDocumentMemories({
  documentsService,
  agentId,
  actor,
  filters,
  limit,
  offset,
}: {
  documentsService: DocumentsServiceLike;
  agentId: UUID;
  actor: RouteActor;
  filters: DocumentFilter;
  limit: number;
  offset: number;
}): Promise<{ documents: Memory[]; total: number }> {
  let scanOffset = 0;
  let total = 0;
  const documents: Memory[] = [];

  while (true) {
    const batch = await documentsService.getMemories({
      tableName: DOCUMENTS_TABLE,
      count: FRAGMENT_BATCH_SIZE,
      offset: scanOffset,
    });

    if (batch.length === 0) break;

    for (const memory of batch) {
      if (
        !isDocumentMemory(memory, agentId) ||
        !matchesDocumentFilter(memory, filters) ||
        !canReadDocumentMemory(memory, actor, filters)
      ) {
        continue;
      }

      if (total >= offset && documents.length < limit) {
        documents.push(memory);
      }
      total += 1;
    }

    if (batch.length < FRAGMENT_BATCH_SIZE) break;
    scanOffset += FRAGMENT_BATCH_SIZE;
  }

  return { documents, total };
}

/**
 * Per-facet counts for the Knowledge hub (#13594), computed over the WHOLE
 * readable store in one scan — not a page slice — so the hub's segmented control
 * shows true totals and no facet goes missing/miscounted once its records fall
 * outside the first page (the review blocker). Honors every filter EXCEPT the
 * hub facet itself (so the counts describe what each facet would show under the
 * current scope/room/tag/search narrowing).
 */
async function countDocumentFacets({
  documentsService,
  agentId,
  actor,
  filters,
}: {
  documentsService: DocumentsServiceLike;
  agentId: UUID;
  actor: RouteActor;
  filters: DocumentFilter;
}): Promise<Record<KnowledgeHubFacet, number>> {
  const counts: Record<KnowledgeHubFacet, number> = {
    all: 0,
    doc: 0,
    image: 0,
    audio: 0,
    video: 0,
    transcript: 0,
  };
  // Drop the hub facet so the scan sees every bucket; keep the rest of the
  // narrowing (scope/room/tag/search) so counts match the visible list.
  const { knowledgeFacet: _ignored, ...baseFilters } = filters;
  let scanOffset = 0;

  while (true) {
    const batch = await documentsService.getMemories({
      tableName: DOCUMENTS_TABLE,
      count: FRAGMENT_BATCH_SIZE,
      offset: scanOffset,
    });
    if (batch.length === 0) break;

    for (const memory of batch) {
      if (
        !isDocumentMemory(memory, agentId) ||
        !matchesDocumentFilter(memory, baseFilters) ||
        !canReadDocumentMemory(memory, actor, baseFilters)
      ) {
        continue;
      }
      const metadata = asRecord(memory.metadata);
      const documentTags = Array.isArray(metadata?.tags)
        ? metadata.tags.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      counts[documentHubFacet(metadata, documentTags)] += 1;
      counts.all += 1;
    }

    if (batch.length < FRAGMENT_BATCH_SIZE) break;
    scanOffset += FRAGMENT_BATCH_SIZE;
  }

  return counts;
}

export const __setDocumentFetchImplForTests = __setDocumentUrlFetchImplForTests;

export async function handleDocumentsRoutes(
  ctx: DocumentRouteContext,
): Promise<boolean> {
  const {
    req,
    res,
    method,
    pathname,
    url,
    runtime,
    json,
    error,
    readJsonBody,
  } = ctx;

  if (!pathname.startsWith("/api/documents")) return false;

  const { service: documentsService, reason } =
    await getDocumentsService(runtime);
  if (!documentsService) {
    if (reason === "timeout") {
      res.setHeader("Retry-After", "5");
      error(
        res,
        "Documents service is still loading. Please retry shortly.",
        503,
      );
    } else {
      error(
        res,
        "Documents service is not available. Agent may not be running.",
        503,
      );
    }
    return true;
  }

  if (!runtime?.agentId) {
    error(res, "Agent runtime is not available", 503);
    return true;
  }
  const agentId = runtime.agentId as UUID;
  const ownerEntityId = getOwnerEntityId(runtime);
  const routeActor = resolveRouteActor(req, agentId, ownerEntityId);

  if (method === "GET" && pathname === "/api/documents/stats") {
    const documentCount = await documentsService.countMemories({
      tableName: DOCUMENTS_TABLE,
      unique: false,
    });
    const fragmentCount = await documentsService.countMemories({
      tableName: DOCUMENT_FRAGMENTS_TABLE,
      unique: false,
    });

    json(res, {
      documentCount,
      fragmentCount,
      agentId,
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/documents/facets") {
    // Whole-store facet counts for the Knowledge hub segmented control
    // (#13594). The facet param itself is dropped inside countDocumentFacets so
    // every bucket is counted; the remaining scope/room/tag/search filters are
    // honored so the counts describe the current narrowing.
    const filters = filtersFromSearchParams(url, { includeTextQuery: true });
    const counts = await countDocumentFacets({
      documentsService,
      agentId,
      actor: routeActor,
      filters,
    });
    json(res, {
      ok: true,
      available: true,
      agentId,
      counts,
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/documents") {
    const limit = parsePositiveInteger(url.searchParams.get("limit"), 100);
    const offset = parsePositiveInteger(url.searchParams.get("offset"), 0);
    const filters = filtersFromSearchParams(url, { includeTextQuery: true });

    const { documents, total } = await listDocumentMemories({
      documentsService,
      agentId,
      actor: routeActor,
      filters,
      limit,
      offset,
    });
    const documentIds = documents.filter(hasUuidId).map((doc) => doc.id);
    const fragmentCounts = await mapDocumentFragmentsByDocumentId(
      documentsService,
      undefined,
      documentIds,
    );
    const cleanedDocuments = documents.map((doc) =>
      presentDocument(
        doc,
        hasUuidId(doc) ? (fragmentCounts.get(doc.id) ?? 0) : 0,
      ),
    );

    json(res, {
      ok: true,
      available: true,
      agentId,
      documents: cleanedDocuments,
      total,
      limit,
      offset: offset > 0 ? offset : 0,
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/documents/search") {
    const query = url.searchParams.get("q");
    if (!query?.trim()) {
      error(res, "Search query (q) is required");
      return true;
    }

    const threshold = parseClampedFloat(url.searchParams.get("threshold"), {
      fallback: 0.3,
      min: 0,
      max: 1,
    });
    const limit = parsePositiveInteger(url.searchParams.get("limit"), 20);
    const filters = filtersFromSearchParams(url);
    const searchMode = parseSearchMode(url.searchParams.get("searchMode"));
    const searchMessage = buildRouteMessage({
      agentId,
      text: query.trim(),
      filters,
      actor: routeActor,
    });

    const results = await documentsService.searchDocuments(
      searchMessage,
      serviceSearchScope(filters),
      searchMode,
    );

    const filteredResults = results
      .filter((result) => (result.similarity ?? 0) >= threshold)
      .filter((result) => matchesDocumentFilter(result, filters))
      .filter((result) => canReadDocumentMemory(result, routeActor, filters))
      .slice(0, limit)
      .map((result) => {
        const meta = asRecord(result.metadata);
        return {
          id: result.id,
          text: result.content.text || "",
          similarity: result.similarity,
          documentId: meta?.documentId,
          documentTitle: getDocumentTitleFromMetadata(
            meta,
            result.content.text,
          ),
          documentProvenance: meta ? getDocumentProvenance(meta) : undefined,
          position: meta?.position,
        };
      });

    json(res, {
      query: query.trim(),
      threshold,
      results: filteredResults,
      count: filteredResults.length,
    });
    return true;
  }

  const fragmentsMatch = /^\/api\/documents\/([^/]+)\/fragments$/.exec(
    pathname,
  );
  if (method === "GET" && fragmentsMatch) {
    const decodedDocumentId = decodeMatchedPathComponent(
      ctx,
      fragmentsMatch[1],
      "document id",
    );
    if (!decodedDocumentId) return true;
    const documentId = decodedDocumentId as UUID;
    const document = await runtime.getMemoryById(documentId);
    if (
      !document ||
      !isDocumentMemory(document, agentId) ||
      !canReadDocumentMemory(document, routeActor, {
        scopedToEntityId: documentScopedEntityId(document),
      })
    ) {
      error(res, "Document not found", 404);
      return true;
    }

    const allFragments: Array<{
      id: UUID;
      text: string;
      position: unknown;
      createdAt: number;
    }> = [];
    let fragmentOffset = 0;

    while (true) {
      const fragmentBatch = await documentsService.getMemories({
        tableName: DOCUMENT_FRAGMENTS_TABLE,
        count: FRAGMENT_BATCH_SIZE,
        offset: fragmentOffset,
      });

      if (fragmentBatch.length === 0) break;

      for (const fragment of fragmentBatch) {
        const metadata = asRecord(fragment.metadata);
        if (metadata?.documentId !== documentId) continue;
        if (!hasUuidIdAndCreatedAt(fragment)) continue;
        allFragments.push({
          id: fragment.id,
          text: (fragment.content as { text?: string })?.text || "",
          position: metadata.position,
          createdAt: fragment.createdAt,
        });
      }

      if (fragmentBatch.length < FRAGMENT_BATCH_SIZE) break;
      fragmentOffset += FRAGMENT_BATCH_SIZE;
    }

    const documentFragments = allFragments
      .sort((a, b) => {
        const posA = typeof a.position === "number" ? a.position : 0;
        const posB = typeof b.position === "number" ? b.position : 0;
        return posA - posB;
      })
      .map((fragment) => ({
        id: fragment.id,
        text: fragment.text,
        position: fragment.position,
        createdAt: fragment.createdAt,
      }));

    json(res, {
      documentId,
      fragments: documentFragments,
      count: documentFragments.length,
    });
    return true;
  }

  const docIdMatch = /^\/api\/documents\/([^/]+)$/.exec(pathname);
  if (method === "GET" && docIdMatch) {
    const decodedDocumentId = decodeMatchedPathComponent(
      ctx,
      docIdMatch[1],
      "document id",
    );
    if (!decodedDocumentId) return true;
    const documentId = decodedDocumentId as UUID;
    const document = await runtime.getMemoryById(documentId);
    if (
      !document ||
      !isDocumentMemory(document, agentId) ||
      !canReadDocumentMemory(document, routeActor, {
        scopedToEntityId: documentScopedEntityId(document),
      })
    ) {
      error(res, "Document not found", 404);
      return true;
    }

    const fragmentCount = await countDocumentFragmentsForDocument(
      documentsService,
      undefined,
      documentId,
    );

    json(res, {
      document: presentDocument(document, fragmentCount, {
        includeContent: true,
      }),
    });
    return true;
  }

  if (method === "PATCH" && docIdMatch) {
    const decodedDocumentId = decodeMatchedPathComponent(
      ctx,
      docIdMatch[1],
      "document id",
    );
    if (!decodedDocumentId) return true;
    const documentId = decodedDocumentId as UUID;
    const document = await runtime.getMemoryById(documentId);
    if (
      !document ||
      !isDocumentMemory(document, agentId) ||
      !canMutateDocumentMemory(document, routeActor)
    ) {
      error(res, "Document not found", 404);
      return true;
    }

    const editability = getDocumentEditability(document);
    if (!editability.canEditText) {
      error(res, editability.reason || "This document cannot be edited.", 400);
      return true;
    }

    const body = await readJsonBody<{ content?: string }>(req, res, {
      maxBytes: DOCUMENT_UPLOAD_MAX_BODY_BYTES,
    });
    if (!body) return true;

    if (typeof body.content !== "string" || body.content.trim().length === 0) {
      error(res, "content must be a non-empty string");
      return true;
    }

    const result = await documentsService.updateDocument({
      documentId,
      content: body.content,
      message: buildRouteMessage({
        agentId,
        text: body.content,
        actor: routeActor,
      }),
    });

    json(res, {
      ok: true,
      documentId: result.documentId,
      fragmentCount: result.fragmentCount,
    });
    return true;
  }

  if (method === "DELETE" && docIdMatch) {
    const decodedDocumentId = decodeMatchedPathComponent(
      ctx,
      docIdMatch[1],
      "document id",
    );
    if (!decodedDocumentId) return true;
    const documentId = decodedDocumentId as UUID;
    const existingDocument = await runtime.getMemoryById(documentId);
    if (
      !existingDocument ||
      !isDocumentMemory(existingDocument, agentId) ||
      !canMutateDocumentMemory(existingDocument, routeActor)
    ) {
      error(res, "Document not found", 404);
      return true;
    }

    const deleteability = getDocumentDeleteability(existingDocument);
    if (!deleteability.canDelete) {
      error(
        res,
        deleteability.reason || "This document cannot be deleted.",
        400,
      );
      return true;
    }

    const fragmentIds = await listDocumentFragmentsForDocument(
      documentsService,
      undefined,
      documentId,
    );

    for (const fragmentId of fragmentIds) {
      await documentsService.deleteMemory(fragmentId);
    }
    await documentsService.deleteMemory(documentId);

    json(res, {
      ok: true,
      deletedFragments: fragmentIds.length,
    });
    return true;
  }

  async function addDocument(
    service: DocumentsServiceLike,
    document: DocumentUploadBody,
    actor: RouteActor,
  ): Promise<{
    documentId: UUID;
    fragmentCount: number;
    warnings?: string[];
  }> {
    let content = document.content;
    // Capture the bytes exactly as uploaded before any content rewrite (e.g.
    // image → description text), so the linked original-bytes file is faithful.
    const originalContent = document.content;
    const originalContentType = document.contentType || "text/plain";
    let contentType = originalContentType;
    const warnings: string[] = [];
    const textBacked = isTextBackedContentType(
      originalContentType,
      document.filename,
    );

    if (contentType.startsWith("image/")) {
      const includeDescriptions =
        asRecord(document.metadata)?.includeImageDescriptions === true;
      if (!includeDescriptions) {
        throw new Error(
          "Image uploads require metadata.includeImageDescriptions=true so the document store can persist real searchable text.",
        );
      }
      if (!runtime || typeof runtime.useModel !== "function") {
        throw new Error(
          "Image uploads require an IMAGE_DESCRIPTION model handler; no runtime model handler is available.",
        );
      }
      const { ModelType } = await import("@elizaos/core");
      const dataUri = `data:${contentType};base64,${content}`;
      let description: unknown;
      try {
        description = await runtime.useModel(ModelType.IMAGE_DESCRIPTION, {
          imageUrl: dataUri,
          prompt: `Describe this image in detail for a document store. Focus on text content, data, charts, and key visual elements. Image filename: ${document.filename}`,
        });
      } catch (modelErr) {
        throw new Error(`Image description model failed: ${String(modelErr)}`);
      }
      const descText =
        typeof description === "string"
          ? description.trim()
          : typeof (description as { description?: unknown }).description ===
              "string"
            ? (description as { description: string }).description.trim()
            : "";
      if (!descText) {
        throw new Error("Image description model returned empty text.");
      }
      content = `[Image: ${document.filename}]\n\n${descText}`;
      contentType = "text/plain";
    }

    if (document.filename.endsWith(".mdx")) {
      contentType = "text/markdown";
    }

    const uploadFilters = filtersFromUploadBody(document, actor);
    if (uploadFilters.error) {
      throw new Error(uploadFilters.error);
    }
    const scopedToEntityId = uploadFilters.scopedToEntityId;
    const roomId = asUuid(document.roomId) ?? agentId;
    const worldId = asUuid(document.worldId) ?? agentId;
    const entityId =
      uploadFilters.scope === "user-private"
        ? (scopedToEntityId ?? actor.entityId)
        : actor.entityId;
    const metadata = asRecord(document.metadata);
    const requestedAddedFrom =
      typeof document.addedFrom === "string" && document.addedFrom.trim()
        ? document.addedFrom.trim()
        : typeof metadata?.addedFrom === "string" && metadata.addedFrom.trim()
          ? metadata.addedFrom.trim()
          : "upload";
    const addedFrom = (
      requestedAddedFrom === "import" ? "import" : "upload"
    ) as DocumentAddedFrom;
    const source = addedFrom;

    // Persist the ORIGINAL uploaded bytes (content-addressed) and link them on
    // the document record so it stays downloadable/previewable. Best-effort: a
    // missing service or storage failure must never fail the upload — we log a
    // warning and proceed without the link.
    let mediaLink:
      | { mediaUrl: string; mediaHash: string; mediaFileName: string }
      | undefined;
    if (originalContent.length > 0) {
      try {
        const fileStorage = runtime?.getService(
          ServiceType.REMOTE_FILES,
        ) as IFileStorageService | null;
        if (fileStorage) {
          // Text uploads carry UTF-8 text; binary/non-text uploads (images,
          // PDFs, …) arrive base64-encoded in `content`.
          const bytes = textBacked
            ? Buffer.from(originalContent, "utf8")
            : Buffer.from(originalContent, "base64");
          const stored = await fileStorage.store(bytes, originalContentType);
          mediaLink = {
            mediaUrl: stored.url,
            mediaHash: stored.hash,
            mediaFileName: stored.fileName,
          };
        }
      } catch (storageErr) {
        runtime?.logger?.warn(
          `[documents] failed to persist original bytes for "${document.filename}": ${
            storageErr instanceof Error
              ? storageErr.message
              : String(storageErr)
          }`,
        );
      }
    }

    const result = await service.addDocument({
      agentId,
      worldId,
      roomId,
      entityId,
      clientDocumentId: "" as UUID,
      contentType,
      originalFilename: document.filename,
      content,
      scope: uploadFilters.scope,
      scopedToEntityId,
      addedBy: actor.entityId,
      addedByRole: routeActorAddedByRole(actor),
      addedFrom,
      metadata: {
        ...metadata,
        source,
        filename: document.filename,
        originalFilename: document.filename,
        fileType: originalContentType,
        contentType,
        textBacked,
        scope: uploadFilters.scope,
        ...(scopedToEntityId ? { scopedToEntityId } : {}),
        addedBy: actor.entityId,
        addedByRole: routeActorAddedByRole(actor),
        addedFrom,
        ...(mediaLink ?? {}),
      },
    });

    const warningsValue = (result as { warnings?: unknown }).warnings;
    if (Array.isArray(warningsValue)) {
      for (const warning of warningsValue) {
        if (typeof warning === "string") warnings.push(warning);
      }
    }

    return {
      documentId: result.clientDocumentId as UUID,
      fragmentCount: result.fragmentCount,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  if (method === "POST" && pathname === "/api/documents") {
    const body = await readJsonBody<DocumentUploadBody>(req, res, {
      maxBytes: DOCUMENT_UPLOAD_MAX_BODY_BYTES,
    });
    if (!body) return true;

    if (
      typeof body.content !== "string" ||
      typeof body.filename !== "string" ||
      body.content.trim().length === 0 ||
      body.filename.trim().length === 0
    ) {
      error(res, "content and filename must be non-empty strings");
      return true;
    }

    let result: {
      documentId: string;
      fragmentCount: number;
      warnings?: string[];
    };
    try {
      result = await addDocument(documentsService, body, routeActor);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      error(
        res,
        `Failed to add document: ${message}`,
        /Only the owner|Users can only/i.test(message)
          ? 403
          : /Image uploads require|Image description model/i.test(message)
            ? 400
            : 500,
      );
      return true;
    }

    json(res, {
      ok: true,
      documentId: result.documentId,
      fragmentCount: result.fragmentCount,
      warnings: result.warnings,
    });
    return true;
  }

  if (method === "POST" && pathname === "/api/documents/bulk") {
    const body = await readJsonBody<{
      documents?: DocumentUploadBody[];
      scope?: string;
      scopedToEntityId?: string;
    }>(req, res, {
      maxBytes: DOCUMENT_UPLOAD_MAX_BODY_BYTES,
    });
    if (!body) return true;

    if (!Array.isArray(body.documents) || body.documents.length === 0) {
      error(res, "documents array is required");
      return true;
    }

    if (body.documents.length > MAX_BULK_DOCUMENTS) {
      error(
        res,
        `documents array exceeds limit (${MAX_BULK_DOCUMENTS} per request)`,
      );
      return true;
    }

    const results: Array<{
      index: number;
      ok: boolean;
      filename: string;
      documentId?: UUID;
      fragmentCount?: number;
      error?: string;
      warnings?: string[];
    }> = [];

    for (const [index, document] of body.documents.entries()) {
      if (
        !document ||
        typeof document !== "object" ||
        Array.isArray(document)
      ) {
        results.push({
          index,
          ok: false,
          filename: `document-${index + 1}`,
          error: "content and filename must be non-empty strings",
        });
        continue;
      }

      const filename = document.filename || `document-${index + 1}`;
      if (
        typeof document.content !== "string" ||
        typeof document.filename !== "string" ||
        document.content.trim().length === 0 ||
        document.filename.trim().length === 0
      ) {
        results.push({
          index,
          ok: false,
          filename,
          error: "content and filename must be non-empty strings",
        });
        continue;
      }

      const normalizedDocument: DocumentUploadBody = {
        ...document,
        content: document.content,
        filename: document.filename.trim(),
        scope: document.scope ?? body.scope,
        scopedToEntityId: document.scopedToEntityId ?? body.scopedToEntityId,
      };

      try {
        const uploadResult = await addDocument(
          documentsService,
          normalizedDocument,
          routeActor,
        );
        results.push({
          index,
          ok: true,
          filename,
          documentId: uploadResult.documentId,
          fragmentCount: uploadResult.fragmentCount,
          warnings: uploadResult.warnings,
        });
      } catch (err) {
        results.push({
          index,
          ok: false,
          filename,
          error: String(err),
        });
      }
    }

    const successCount = results.filter((item) => item.ok).length;
    const failureCount = results.length - successCount;

    json(res, {
      ok: failureCount === 0,
      total: results.length,
      successCount,
      failureCount,
      results,
    });
    return true;
  }

  if (method === "POST" && pathname === "/api/documents/url") {
    const body = await readJsonBody<{
      url: string;
      metadata?: Record<string, unknown>;
      roomId?: string;
      worldId?: string;
      entityId?: string;
      scope?: string;
      scopedToEntityId?: string;
      includeImageDescriptions?: boolean;
    }>(req, res);
    if (!body) return true;

    const urlToFetch = trimString(body.url);
    if (!urlToFetch) {
      error(res, "url is required");
      return true;
    }

    let fetchedContent: Awaited<ReturnType<typeof fetchDocumentFromUrl>>;
    try {
      fetchedContent = await fetchDocumentFromUrl(urlToFetch, {
        includeImageDescriptions: body.includeImageDescriptions === true,
      });
    } catch (fetchErr) {
      error(res, `Failed to fetch URL content: ${String(fetchErr)}`, 400);
      return true;
    }

    const { content, mimeType, filename } = fetchedContent;
    const contentType = mimeType;
    const uploadFilters = filtersFromUploadBody(body, routeActor);
    if (uploadFilters.error) {
      error(res, uploadFilters.error, 403);
      return true;
    }
    const scopedToEntityId = uploadFilters.scopedToEntityId;
    const roomId = asUuid(body.roomId) ?? agentId;
    const worldId = asUuid(body.worldId) ?? agentId;
    const entityId =
      uploadFilters.scope === "user-private"
        ? (scopedToEntityId ?? routeActor.entityId)
        : routeActor.entityId;
    const isYouTubeTranscript = isYouTubeUrl(urlToFetch);

    const result = await documentsService.addDocument({
      agentId,
      worldId,
      roomId,
      entityId,
      clientDocumentId: "" as UUID,
      contentType,
      originalFilename: filename,
      content,
      scope: uploadFilters.scope,
      scopedToEntityId,
      addedBy: routeActor.entityId,
      addedByRole: routeActorAddedByRole(routeActor),
      addedFrom: "url",
      metadata: {
        ...body.metadata,
        url: urlToFetch,
        source: isYouTubeTranscript ? "youtube" : "url",
        filename,
        originalFilename: filename,
        fileType: contentType,
        contentType,
        textBacked: fetchedContent.contentType !== "binary",
        scope: uploadFilters.scope,
        ...(scopedToEntityId ? { scopedToEntityId } : {}),
        addedBy: routeActor.entityId,
        addedByRole: routeActorAddedByRole(routeActor),
      },
    });

    json(res, {
      ok: true,
      documentId: result.clientDocumentId,
      fragmentCount: result.fragmentCount,
      filename,
      contentType,
      isYouTubeTranscript,
    });
    return true;
  }

  return false;
}

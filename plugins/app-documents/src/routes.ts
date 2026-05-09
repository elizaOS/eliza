import type { RouteHelpers, RouteRequestContext } from "@elizaos/core";
import {
  parseClampedFloat,
  parsePositiveInteger,
} from "@elizaos/agent";
import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import {
  __setDocumentUrlFetchImplForTests,
  fetchDocumentFromUrl,
  isYouTubeUrl,
} from "@elizaos/core";
import {
  getDocumentDeleteability,
  getDocumentEditability,
  getDocumentProvenance,
  getDocumentTitleFromMetadata,
  getDocumentVisibilityScope,
  presentDocument,
} from "./document-presenter.js";
import {
  type DocumentAddedByRole,
  type DocumentSearchMode,
  type DocumentsServiceLike,
  type DocumentVisibilityScope,
  getDocumentsService,
} from "./service-loader.js";

export type DocumentRouteHelpers = RouteHelpers;

export interface DocumentRouteContext extends RouteRequestContext {
  url: URL;
  runtime: AgentRuntime | null;
}

const DOCUMENTS_TABLE = "documents";
const DOCUMENT_FRAGMENTS_TABLE = "document_fragments";
const FRAGMENT_BATCH_SIZE = 500;
const DOCUMENT_UPLOAD_MAX_BODY_BYTES = 32 * 1_048_576; // 32 MB
const MAX_BULK_DOCUMENTS = 100;

const DOCUMENT_SCOPE_VALUES = new Set<DocumentVisibilityScope>([
  "global",
  "owner-private",
  "user-private",
  "agent-private",
]);

type DocumentFilter = {
  scope?: DocumentVisibilityScope;
  scopedToEntityId?: UUID;
  query?: string;
  addedBy?: UUID;
  timeRangeStart?: number;
  timeRangeEnd?: number;
  tags?: string[];
};

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
};

type RouteActorRole = "OWNER" | "USER" | "AGENT" | "RUNTIME";

type RouteActor = {
  entityId: UUID;
  role: RouteActorRole;
  ownerEntityId?: UUID;
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function trimString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asUuid(value: unknown): UUID | undefined {
  const trimmed = trimString(value);
  return trimmed ? (trimmed as UUID) : undefined;
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

function routeActorAddedByRole(actor: RouteActor): DocumentAddedByRole {
  return actor.role;
}

function actorCanManageOwnerDocuments(actor: RouteActor): boolean {
  return actor.role === "OWNER" || actor.role === "RUNTIME";
}

function actorCanManageAgentDocuments(actor: RouteActor): boolean {
  return (
    actor.role === "OWNER" || actor.role === "AGENT" || actor.role === "RUNTIME"
  );
}

function parseDocumentScope(
  value: unknown,
): DocumentVisibilityScope | undefined {
  return DOCUMENT_SCOPE_VALUES.has(value as DocumentVisibilityScope)
    ? (value as DocumentVisibilityScope)
    : undefined;
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
  return {
    ...(scope ? { scope } : {}),
    ...(scopedToEntityId ? { scopedToEntityId } : {}),
    ...(query ? { query } : {}),
    ...(addedBy ? { addedBy } : {}),
    ...(typeof timeRangeStart === "number" ? { timeRangeStart } : {}),
    ...(typeof timeRangeEnd === "number" ? { timeRangeEnd } : {}),
    ...(tags.length > 0 ? { tags } : {}),
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
  memory: Memory,
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
  if (filters.tags && filters.tags.length > 0) {
    const documentTags = Array.isArray(metadata?.tags)
      ? metadata.tags.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    if (!filters.tags.every((tag) => documentTags.includes(tag))) {
      return false;
    }
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
    const haystack = [
      memory.content?.text,
      getDocumentTitleFromMetadata(metadata, memory.content?.text),
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

function documentScopedEntityId(memory: Memory): UUID | undefined {
  const metadata = asRecord(memory.metadata);
  return (
    asUuid(metadata?.scopedToEntityId) ??
    asUuid(metadata?.addedBy) ??
    asUuid(memory.entityId)
  );
}

function canReadDocumentMemory(
  memory: Memory,
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

function canMutateDocumentMemory(memory: Memory, actor: RouteActor): boolean {
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
): { entityId?: UUID } | undefined {
  return filters.scopedToEntityId
    ? { entityId: filters.scopedToEntityId }
    : undefined;
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
      .filter((result) =>
        matchesDocumentFilter(result as unknown as Memory, filters),
      )
      .filter((result) =>
        canReadDocumentMemory(result as unknown as Memory, routeActor, filters),
      )
      .slice(0, limit)
      .map((result) => {
        const meta = asRecord(result.metadata);
        return {
          id: result.id,
          text: result.content?.text || "",
          similarity: result.similarity,
          documentId: meta?.documentId,
          documentTitle: getDocumentTitleFromMetadata(
            meta,
            result.content?.text,
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
    const documentId = decodeURIComponent(fragmentsMatch[1]) as UUID;
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
          position: metadata?.position,
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
    const documentId = decodeURIComponent(docIdMatch[1]) as UUID;
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
    const documentId = decodeURIComponent(docIdMatch[1]) as UUID;
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
    const documentId = decodeURIComponent(docIdMatch[1]) as UUID;
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
      if (includeDescriptions && runtime) {
        try {
          const { ModelType } = await import("@elizaos/core");
          const dataUri = `data:${contentType};base64,${content}`;
          const description = await runtime.useModel(
            ModelType.IMAGE_DESCRIPTION,
            {
              imageUrl: dataUri,
              prompt: `Describe this image in detail for a document store. Focus on text content, data, charts, and key visual elements. Image filename: ${document.filename}`,
            },
          );
          const descText =
            typeof description === "string"
              ? description
              : (description as { description?: string }).description ||
                "Image uploaded";
          content = `[Image: ${document.filename}]\n\n${descText}`;
          contentType = "text/plain";
        } catch (modelErr) {
          warnings.push(`Image description failed: ${String(modelErr)}`);
          content = `[Image: ${document.filename}] - Image description unavailable (model error).`;
          contentType = "text/plain";
        }
      } else {
        content = `[Image: ${document.filename}] - Image uploaded without text extraction.`;
        contentType = "text/plain";
      }
    }

    if (document.filename?.endsWith(".mdx")) {
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
      addedFrom: "upload",
      metadata: {
        ...metadata,
        source: "upload",
        filename: document.filename,
        originalFilename: document.filename,
        fileType: originalContentType,
        contentType,
        textBacked,
        scope: uploadFilters.scope,
        ...(scopedToEntityId ? { scopedToEntityId } : {}),
        addedBy: actor.entityId,
        addedByRole: routeActorAddedByRole(actor),
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

    if (!body.content || !body.filename) {
      error(res, "content and filename are required");
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
        /Only the owner|Users can only/i.test(message) ? 403 : 500,
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
      const filename = document?.filename || `document-${index + 1}`;
      if (
        typeof document?.content !== "string" ||
        typeof document?.filename !== "string" ||
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

    if (!body.url?.trim()) {
      error(res, "url is required");
      return true;
    }

    const urlToFetch = body.url.trim();
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

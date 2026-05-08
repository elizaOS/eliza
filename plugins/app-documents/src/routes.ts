import type {
  RouteHelpers,
  RouteRequestContext,
} from "@elizaos/agent/api/route-helpers";
import {
  parseClampedFloat,
  parsePositiveInteger,
} from "@elizaos/agent/utils/number-parsing";
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
  getDocumentsService,
  type DocumentSearchMode,
  type DocumentServiceLike,
  type DocumentVisibilityScope,
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

function filtersFromSearchParams(url: URL): DocumentFilter {
  const scope = parseDocumentScope(url.searchParams.get("scope"));
  const scopedToEntityId = asUuid(url.searchParams.get("scopedToEntityId"));
  return {
    ...(scope ? { scope } : {}),
    ...(scopedToEntityId ? { scopedToEntityId } : {}),
  };
}

function filtersFromUploadBody(body: {
  metadata?: Record<string, unknown>;
  scope?: string;
  scopedToEntityId?: string;
}): Required<DocumentFilter> {
  const metadata = asRecord(body.metadata);
  const scope =
    parseDocumentScope(body.scope) ??
    parseDocumentScope(metadata?.scope) ??
    "global";
  const scopedToEntityId =
    asUuid(body.scopedToEntityId) ?? asUuid(metadata?.scopedToEntityId);
  return {
    scope,
    scopedToEntityId: scopedToEntityId ?? ("" as UUID),
  };
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
    (typeof metadata?.documentId === "string" && metadata.documentId === memory.id)
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
    metadata?.scopedToEntityId !== filters.scopedToEntityId
  ) {
    return false;
  }
  return true;
}

function buildRouteMessage({
  agentId,
  text,
  filters,
}: {
  agentId: UUID;
  text: string;
  filters?: DocumentFilter;
}): Memory {
  const entityId = filters?.scopedToEntityId ?? agentId;
  return {
    id: crypto.randomUUID() as UUID,
    entityId,
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
  documentsService: DocumentServiceLike,
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
  documentsService: DocumentServiceLike,
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
  documentsService: DocumentServiceLike,
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
  filters,
  limit,
  offset,
}: {
  documentsService: DocumentServiceLike;
  agentId: UUID;
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
        !matchesDocumentFilter(memory, filters)
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

export const __setDocumentFetchImplForTests =
  __setDocumentUrlFetchImplForTests;

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
    const filters = filtersFromSearchParams(url);

    const { documents, total } = await listDocumentMemories({
      documentsService,
      agentId,
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
    if (!document || !isDocumentMemory(document, agentId)) {
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
    if (!document || !isDocumentMemory(document, agentId)) {
      error(res, "Document not found", 404);
      return true;
    }

    const editability = getDocumentEditability(document);
    if (!editability.canEditText) {
      error(
        res,
        editability.reason || "This document cannot be edited.",
        400,
      );
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
      message: buildRouteMessage({ agentId, text: body.content }),
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
    if (!existingDocument || !isDocumentMemory(existingDocument, agentId)) {
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
    service: DocumentServiceLike,
    document: DocumentUploadBody,
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

    const uploadFilters = filtersFromUploadBody(document);
    const scopedToEntityId =
      uploadFilters.scopedToEntityId.length > 0
        ? uploadFilters.scopedToEntityId
        : undefined;
    const roomId = asUuid(document.roomId) ?? agentId;
    const worldId = asUuid(document.worldId) ?? agentId;
    const entityId = asUuid(document.entityId) ?? scopedToEntityId ?? agentId;
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
      addedBy: entityId,
      addedByRole: entityId === agentId ? "AGENT" : "USER",
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
      result = await addDocument(documentsService, body);
    } catch (err) {
      error(res, `Failed to add document: ${String(err)}`, 500);
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
    const uploadFilters = filtersFromUploadBody(body);
    const scopedToEntityId =
      uploadFilters.scopedToEntityId.length > 0
        ? uploadFilters.scopedToEntityId
        : undefined;
    const roomId = asUuid(body.roomId) ?? agentId;
    const worldId = asUuid(body.worldId) ?? agentId;
    const entityId = asUuid(body.entityId) ?? scopedToEntityId ?? agentId;
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
      addedBy: entityId,
      addedByRole: entityId === agentId ? "AGENT" : "USER",
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

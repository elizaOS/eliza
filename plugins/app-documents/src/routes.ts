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
  presentDocument,
} from "./document-presenter.js";
import {
  getDocumentsService,
  type DocumentServiceLike,
} from "./service-loader.js";

export type DocumentRouteHelpers = RouteHelpers;

export interface DocumentRouteContext extends RouteRequestContext {
  url: URL;
  runtime: AgentRuntime | null;
}

const FRAGMENT_COUNT_BATCH_SIZE = 500;
const DOCUMENT_UPLOAD_MAX_BODY_BYTES = 32 * 1_048_576; // 32 MB
const MAX_BULK_DOCUMENTS = 100;
const DOCUMENT_SCOPES = new Set([
  "global",
  "owner-private",
  "user-private",
  "agent-private",
]);
const DOCUMENT_ID_ROUTE_PATTERN =
  /^\/api\/documents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const DOCUMENT_FRAGMENTS_ROUTE_PATTERN =
  /^\/api\/documents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/fragments$/i;

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

function hasUuidId(memory: Memory): memory is Memory & { id: UUID } {
  return typeof memory.id === "string" && memory.id.length > 0;
}

function hasUuidIdAndCreatedAt(
  memory: Memory,
): memory is Memory & { id: UUID; createdAt: number } {
  return hasUuidId(memory) && typeof memory.createdAt === "number";
}

function normalizeScope(value: unknown):
  | "global"
  | "owner-private"
  | "user-private"
  | "agent-private"
  | undefined {
  return typeof value === "string" && DOCUMENT_SCOPES.has(value)
    ? (value as
        | "global"
        | "owner-private"
        | "user-private"
        | "agent-private")
    : undefined;
}

function getDocumentTimestamp(memory: Memory): number {
  const metadata = memory.metadata as Record<string, unknown> | undefined;
  const metadataTimestamp = metadata?.timestamp;
  if (typeof metadataTimestamp === "number") return metadataTimestamp;
  return typeof memory.createdAt === "number" ? memory.createdAt : 0;
}

function memoryMatchesDocumentFilters(memory: Memory, url: URL): boolean {
  const metadata = memory.metadata as Record<string, unknown> | undefined;
  const scope = url.searchParams.get("scope");
  if (scope && metadata?.scope !== scope) return false;

  const scopedToEntityId = url.searchParams.get("scopedToEntityId");
  if (scopedToEntityId && metadata?.scopedToEntityId !== scopedToEntityId) {
    return false;
  }

  const addedBy = url.searchParams.get("addedBy");
  if (addedBy && metadata?.addedBy !== addedBy) return false;

  const query = (url.searchParams.get("q") ?? url.searchParams.get("query"))
    ?.trim()
    .toLowerCase();
  if (query) {
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

  const timeRangeStart = Date.parse(
    url.searchParams.get("timeRangeStart") ?? "",
  );
  if (
    Number.isFinite(timeRangeStart) &&
    getDocumentTimestamp(memory) < timeRangeStart
  ) {
    return false;
  }

  const timeRangeEnd = Date.parse(url.searchParams.get("timeRangeEnd") ?? "");
  if (
    Number.isFinite(timeRangeEnd) &&
    getDocumentTimestamp(memory) > timeRangeEnd
  ) {
    return false;
  }

  return true;
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
      tableName: "document_fragments",
      roomId,
      count: FRAGMENT_COUNT_BATCH_SIZE,
      offset,
    });

    if (fragmentBatch.length === 0) {
      break;
    }

    fragmentCount += fragmentBatch.filter((memory) => {
      const metadata = memory.metadata as Record<string, unknown> | undefined;
      return metadata?.documentId === documentId;
    }).length;

    if (fragmentBatch.length < FRAGMENT_COUNT_BATCH_SIZE) {
      break;
    }

    offset += FRAGMENT_COUNT_BATCH_SIZE;
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
      tableName: "document_fragments",
      roomId,
      count: FRAGMENT_COUNT_BATCH_SIZE,
      offset,
    });

    if (fragmentBatch.length === 0) {
      break;
    }

    for (const memory of fragmentBatch) {
      const metadata = memory.metadata as Record<string, unknown> | undefined;
      const documentId = metadata?.documentId;
      if (
        typeof documentId === "string" &&
        trackedDocumentIds.has(documentId as UUID)
      ) {
        const currentCount = fragmentCounts.get(documentId as UUID) ?? 0;
        fragmentCounts.set(documentId as UUID, currentCount + 1);
      }
    }

    if (fragmentBatch.length < FRAGMENT_COUNT_BATCH_SIZE) {
      break;
    }
    offset += FRAGMENT_COUNT_BATCH_SIZE;
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
      tableName: "document_fragments",
      roomId,
      count: FRAGMENT_COUNT_BATCH_SIZE,
      offset,
    });

    for (const memory of fragmentBatch) {
      const metadata = memory.metadata as Record<string, unknown> | undefined;
      if (metadata?.documentId === documentId && hasUuidId(memory)) {
        fragmentIds.push(memory.id);
      }
    }

    if (fragmentBatch.length < FRAGMENT_COUNT_BATCH_SIZE) {
      break;
    }

    offset += FRAGMENT_COUNT_BATCH_SIZE;
  }

  return fragmentIds;
}

// Re-export the URL fetch test hook for backwards compatibility with previous
// callers that imported it from this module.
export const __setPinnedFetchImplForTests = __setDocumentUrlFetchImplForTests;

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

  // ── GET /api/documents/stats ────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/documents/stats") {
    const documentCount = await documentsService.countMemories({
      tableName: "documents",
      unique: false,
    });

    const fragmentCount = await documentsService.countMemories({
      tableName: "document_fragments",
      unique: false,
    });

    json(res, {
      documentCount,
      fragmentCount,
      agentId,
    });
    return true;
  }

  // ── GET /api/documents ────────────────────────────────────────
  if (method === "GET" && pathname === "/api/documents") {
    const limit = parsePositiveInteger(url.searchParams.get("limit"), 100);
    const offset = parsePositiveInteger(url.searchParams.get("offset"), 0);

    const rawDocuments = await documentsService.getMemories({
      tableName: "documents",
      count: Math.max(limit + offset, limit, 100),
    });
    const filteredDocuments = rawDocuments.filter((memory) =>
      memoryMatchesDocumentFilters(memory, url),
    );
    const documents = filteredDocuments.slice(offset, offset + limit);
    const total = filteredDocuments.length;

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
      documents: cleanedDocuments,
      total,
      limit,
      offset: offset > 0 ? offset : 0,
    });
    return true;
  }

  // ── GET /api/documents/:id ────────────────────────────────────
  const docIdMatch = DOCUMENT_ID_ROUTE_PATTERN.exec(pathname);
  if (method === "GET" && docIdMatch) {
    const documentId = decodeURIComponent(docIdMatch[1]) as UUID;

    const document = await runtime.getMemoryById(documentId);
    const documentMetadata = document?.metadata as
      | Record<string, unknown>
      | undefined;
    const isDocument =
      document?.agentId === agentId &&
      (documentMetadata?.documentId === documentId ||
        documentMetadata?.type === "document" ||
        documentMetadata?.type === "custom");
    if (!document || !isDocument) {
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
    if (!document || document.agentId !== agentId) {
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

    if (typeof documentsService.updateDocument !== "function") {
      error(res, "Document editing is unavailable", 503);
      return true;
    }

    const result = await documentsService.updateDocument({
      documentId,
      content: body.content,
    });

    json(res, {
      ok: true,
      documentId: result.documentId,
      fragmentCount: result.fragmentCount,
    });
    return true;
  }

  // ── DELETE /api/documents/:id ─────────────────────────────────
  if (method === "DELETE" && docIdMatch) {
    const documentId = decodeURIComponent(docIdMatch[1]) as UUID;
    const existingDocument = await runtime.getMemoryById(documentId);
    if (!existingDocument || existingDocument.agentId !== agentId) {
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

    // Then delete the document itself
    await documentsService.deleteMemory(documentId);

    json(res, {
      ok: true,
      deletedFragments: fragmentIds.length,
    });
    return true;
  }

  type DocumentUploadBody = {
    content: string;
    filename: string;
    contentType?: string;
    metadata?: Record<string, unknown>;
    roomId?: string;
    entityId?: string;
    scope?: string;
    scopedToEntityId?: string;
  };

  async function addDocumentFromBody(
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

    // Image files: the content is base64-encoded binary which can't be
    // text-extracted. Convert to a text description for embedding.
    if (contentType.startsWith("image/")) {
      const includeDescriptions =
        (document.metadata as Record<string, unknown>)
          ?.includeImageDescriptions === true;
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
          content = `[Image: ${document.filename}] — Image description unavailable (model error).`;
          contentType = "text/plain";
        }
      } else {
        // No vision requested — store as a reference entry
        content = `[Image: ${document.filename}] — Image uploaded without text extraction.`;
        contentType = "text/plain";
      }
    }

    // MDX files: treat as markdown
    if (document.filename?.endsWith(".mdx")) {
      contentType = "text/markdown";
    }

    const scope = normalizeScope(document.scope ?? document.metadata?.scope);
    const scopedToEntityId =
      typeof document.scopedToEntityId === "string" &&
      document.scopedToEntityId.trim().length > 0
        ? (document.scopedToEntityId.trim() as UUID)
        : typeof document.metadata?.scopedToEntityId === "string" &&
            document.metadata.scopedToEntityId.trim().length > 0
          ? (document.metadata.scopedToEntityId.trim() as UUID)
          : undefined;
    const ownerEntityId =
      scope === "user-private"
        ? (scopedToEntityId ??
          (typeof document.entityId === "string" &&
          document.entityId.trim().length > 0
            ? (document.entityId.trim() as UUID)
            : agentId))
        : agentId;

    const result = await service.addDocument({
      agentId,
      worldId: agentId,
      roomId:
        typeof document.roomId === "string" && document.roomId.trim().length > 0
          ? (document.roomId.trim() as UUID)
          : agentId,
      entityId: ownerEntityId,
      clientDocumentId: "" as UUID, // Will be generated
      contentType,
      originalFilename: document.filename,
      content,
      scope,
      scopedToEntityId,
      addedBy: ownerEntityId,
      addedByRole: "USER",
      addedFrom: "upload",
      metadata: {
        ...document.metadata,
        source: "upload",
        scope,
        scopedToEntityId,
        filename: document.filename,
        originalFilename: document.filename,
        fileType: originalContentType,
        contentType,
        textBacked,
      },
    });

    const warningsValue = (result as { warnings?: unknown }).warnings;
    if (Array.isArray(warningsValue)) {
      for (const w of warningsValue) {
        if (typeof w === "string") warnings.push(w);
      }
    }

    return {
      documentId: result.clientDocumentId,
      fragmentCount: result.fragmentCount,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  // ── POST /api/documents ───────────────────────────────────────
  // Upload document from base64 content or text
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
      result = await addDocumentFromBody(documentsService, body);
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

  // ── POST /api/documents/bulk ──────────────────────────────────
  if (method === "POST" && pathname === "/api/documents/bulk") {
    const body = await readJsonBody<{
      documents?: DocumentUploadBody[];
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
      };

      try {
        const uploadResult = await addDocumentFromBody(
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

  // ── POST /api/documents/url ───────────────────────────────────
  // Upload document from URL (including YouTube auto-transcription)
  if (method === "POST" && pathname === "/api/documents/url") {
    const body = await readJsonBody<{
      url: string;
      metadata?: Record<string, unknown>;
      scope?: string;
      scopedToEntityId?: string;
    }>(req, res);
    if (!body) return true;

    if (!body.url?.trim()) {
      error(res, "url is required");
      return true;
    }

    const urlToFetch = body.url.trim();

    // Fetch and process the URL content using the shared helper from
    // @elizaos/core, which handles YouTube transcripts, filename derivation,
    // and binary-vs-text disambiguation.
    let fetchedContent: Awaited<ReturnType<typeof fetchDocumentFromUrl>>;
    try {
      fetchedContent = await fetchDocumentFromUrl(urlToFetch);
    } catch (fetchErr) {
      error(res, `Failed to fetch URL content: ${String(fetchErr)}`, 400);
      return true;
    }

    const { content, mimeType, filename } = fetchedContent;
    const contentType = mimeType;

    const scope = normalizeScope(body.scope ?? body.metadata?.scope);
    const scopedToEntityId =
      typeof body.scopedToEntityId === "string" &&
      body.scopedToEntityId.trim().length > 0
        ? (body.scopedToEntityId.trim() as UUID)
        : typeof body.metadata?.scopedToEntityId === "string" &&
            body.metadata.scopedToEntityId.trim().length > 0
          ? (body.metadata.scopedToEntityId.trim() as UUID)
          : undefined;
    const ownerEntityId =
      scope === "user-private" ? (scopedToEntityId ?? agentId) : agentId;

    const result = await documentsService.addDocument({
      agentId,
      worldId: agentId,
      roomId: agentId,
      entityId: ownerEntityId,
      clientDocumentId: "" as UUID,
      contentType,
      originalFilename: filename,
      content,
      scope,
      scopedToEntityId,
      addedBy: ownerEntityId,
      addedByRole: "USER",
      addedFrom: "url",
      metadata: {
        ...body.metadata,
        url: urlToFetch,
        source: isYouTubeUrl(urlToFetch) ? "youtube" : "url",
        scope,
        scopedToEntityId,
        filename,
        originalFilename: filename,
        fileType: contentType,
        contentType,
        textBacked: true,
      },
    });

    json(res, {
      ok: true,
      documentId: result.clientDocumentId,
      fragmentCount: result.fragmentCount,
      filename,
      contentType,
      isYouTubeTranscript: isYouTubeUrl(urlToFetch),
    });
    return true;
  }

  // ── GET /api/documents/search ───────────────────────────────────────────
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

    // Create a mock message for the search
    const searchMessage: Memory = {
      id: crypto.randomUUID() as UUID,
      entityId: agentId,
      agentId,
      roomId: agentId,
      content: { text: query.trim() },
      createdAt: Date.now(),
    };

    const results = await documentsService.searchDocuments(searchMessage);

    // Filter by threshold and limit
    const filteredResults = results
      .filter((result) => {
        const memory: Memory = {
          id: result.id,
          agentId,
          roomId: agentId,
          content: result.content,
          metadata: result.metadata,
        };
        return memoryMatchesDocumentFilters(memory, url);
      })
      .filter((r) => (r.similarity ?? 0) >= threshold)
      .slice(0, limit)
      .map((r) => {
        const meta = r.metadata as Record<string, unknown> | undefined;
        return {
          id: r.id,
          text: r.content?.text || "",
          similarity: r.similarity,
          documentId: meta?.documentId,
          documentTitle: getDocumentTitleFromMetadata(
            meta,
            r.content?.text,
          ),
          documentProvenance: meta
            ? getDocumentProvenance(meta)
            : undefined,
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

  // ── GET /api/documents/:documentId ────────────────────────────
  const fragmentsMatch = DOCUMENT_FRAGMENTS_ROUTE_PATTERN.exec(pathname);
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
        tableName: "document_fragments",
        count: FRAGMENT_COUNT_BATCH_SIZE,
        offset: fragmentOffset,
      });

      if (fragmentBatch.length === 0) {
        break;
      }

      const matchingFragments = fragmentBatch.filter((fragment) => {
        const metadata = fragment.metadata as
          | Record<string, unknown>
          | undefined;
        return metadata?.documentId === documentId;
      });

      for (const fragment of matchingFragments) {
        if (!hasUuidIdAndCreatedAt(fragment)) {
          continue;
        }
        const meta = fragment.metadata as Record<string, unknown> | undefined;
        allFragments.push({
          id: fragment.id,
          text: (fragment.content as { text?: string })?.text || "",
          position: meta?.position,
          createdAt: fragment.createdAt,
        });
      }

      if (fragmentBatch.length < FRAGMENT_COUNT_BATCH_SIZE) {
        break;
      }
      fragmentOffset += FRAGMENT_COUNT_BATCH_SIZE;
    }

    const documentFragments = allFragments
      .sort((a, b) => {
        const posA = typeof a.position === "number" ? a.position : 0;
        const posB = typeof b.position === "number" ? b.position : 0;
        return posA - posB;
      })
      .map((f) => {
        return {
          id: f.id,
          text: f.text,
          position: f.position,
          createdAt: f.createdAt,
        };
      });

    json(res, {
      documentId,
      fragments: documentFragments,
      count: documentFragments.length,
    });
    return true;
  }

  // Route not matched within /api/documents prefix
  return false;
}

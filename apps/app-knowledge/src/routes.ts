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
  __setKnowledgeUrlFetchImplForTests,
  fetchKnowledgeFromUrl,
  isYouTubeUrl,
} from "@elizaos/core";
import {
  getKnowledgeDocumentDeleteability,
  getKnowledgeDocumentEditability,
  getKnowledgeDocumentProvenance,
  getKnowledgeDocumentTitleFromMetadata,
  presentKnowledgeDocument,
} from "./document-presenter.js";
import {
  handleScratchpadTopicRoutes,
  ScratchpadTopicService,
} from "./scratchpad-topics.js";
import {
  getKnowledgeService,
  type KnowledgeServiceLike,
} from "./service-loader.js";

export type KnowledgeRouteHelpers = RouteHelpers;

export interface KnowledgeRouteContext extends RouteRequestContext {
  url: URL;
  runtime: AgentRuntime | null;
}

const FRAGMENT_COUNT_BATCH_SIZE = 500;
const KNOWLEDGE_UPLOAD_MAX_BODY_BYTES = 32 * 1_048_576; // 32 MB
const MAX_BULK_DOCUMENTS = 100;

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

async function countKnowledgeFragmentsForDocument(
  knowledgeService: KnowledgeServiceLike,
  roomId: UUID | undefined,
  documentId: UUID,
): Promise<number> {
  let offset = 0;
  let fragmentCount = 0;

  while (true) {
    const knowledgeBatch = await knowledgeService.getMemories({
      tableName: "knowledge",
      roomId,
      count: FRAGMENT_COUNT_BATCH_SIZE,
      offset,
    });

    if (knowledgeBatch.length === 0) {
      break;
    }

    fragmentCount += knowledgeBatch.filter((memory) => {
      const metadata = memory.metadata as Record<string, unknown> | undefined;
      return metadata?.documentId === documentId;
    }).length;

    if (knowledgeBatch.length < FRAGMENT_COUNT_BATCH_SIZE) {
      break;
    }

    offset += FRAGMENT_COUNT_BATCH_SIZE;
  }

  return fragmentCount;
}

async function mapKnowledgeFragmentsByDocumentId(
  knowledgeService: KnowledgeServiceLike,
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
    const knowledgeBatch = await knowledgeService.getMemories({
      tableName: "knowledge",
      roomId,
      count: FRAGMENT_COUNT_BATCH_SIZE,
      offset,
    });

    if (knowledgeBatch.length === 0) {
      break;
    }

    for (const memory of knowledgeBatch) {
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

    if (knowledgeBatch.length < FRAGMENT_COUNT_BATCH_SIZE) {
      break;
    }
    offset += FRAGMENT_COUNT_BATCH_SIZE;
  }

  return fragmentCounts;
}

async function listKnowledgeFragmentsForDocument(
  knowledgeService: KnowledgeServiceLike,
  roomId: UUID | undefined,
  documentId: UUID,
): Promise<UUID[]> {
  let offset = 0;
  const fragmentIds: UUID[] = [];

  while (true) {
    const knowledgeBatch = await knowledgeService.getMemories({
      tableName: "knowledge",
      roomId,
      count: FRAGMENT_COUNT_BATCH_SIZE,
      offset,
    });

    for (const memory of knowledgeBatch) {
      const metadata = memory.metadata as Record<string, unknown> | undefined;
      if (metadata?.documentId === documentId && hasUuidId(memory)) {
        fragmentIds.push(memory.id);
      }
    }

    if (knowledgeBatch.length < FRAGMENT_COUNT_BATCH_SIZE) {
      break;
    }

    offset += FRAGMENT_COUNT_BATCH_SIZE;
  }

  return fragmentIds;
}

// Re-export the URL fetch test hook for backwards compatibility with previous
// callers that imported it from this module.
export const __setPinnedFetchImplForTests = __setKnowledgeUrlFetchImplForTests;

export async function handleKnowledgeRoutes(
  ctx: KnowledgeRouteContext,
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

  if (!pathname.startsWith("/api/knowledge")) return false;

  const { service: knowledgeService, reason } =
    await getKnowledgeService(runtime);
  if (!knowledgeService) {
    if (reason === "timeout") {
      res.setHeader("Retry-After", "5");
      error(
        res,
        "Knowledge service is still loading. Please retry shortly.",
        503,
      );
    } else {
      error(
        res,
        "Knowledge service is not available. Agent may not be running.",
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

  if (pathname.startsWith("/api/knowledge/scratchpad")) {
    return handleScratchpadTopicRoutes(
      ctx,
      new ScratchpadTopicService(runtime, knowledgeService),
    );
  }

  // ── GET /api/knowledge ──────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/knowledge") {
    const documentCount = await knowledgeService.countMemories({
      tableName: "documents",
      unique: false,
    });

    const fragmentCount = await knowledgeService.countMemories({
      tableName: "knowledge",
      unique: false,
    });

    json(res, {
      ok: true,
      available: true,
      agentId,
      documentCount,
      fragmentCount,
    });
    return true;
  }

  // ── GET /api/knowledge/stats ────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/knowledge/stats") {
    const documentCount = await knowledgeService.countMemories({
      tableName: "documents",
      unique: false,
    });

    const fragmentCount = await knowledgeService.countMemories({
      tableName: "knowledge",
      unique: false,
    });

    json(res, {
      documentCount,
      fragmentCount,
      agentId,
    });
    return true;
  }

  // ── GET /api/knowledge/documents ────────────────────────────────────────
  if (method === "GET" && pathname === "/api/knowledge/documents") {
    const limit = parsePositiveInteger(url.searchParams.get("limit"), 100);
    const offset = parsePositiveInteger(url.searchParams.get("offset"), 0);

    const documents = await knowledgeService.getMemories({
      tableName: "documents",
      count: limit,
      offset: offset > 0 ? offset : undefined,
    });
    const total = await knowledgeService.countMemories({
      tableName: "documents",
      unique: false,
    });

    const documentIds = documents.filter(hasUuidId).map((doc) => doc.id);
    const fragmentCounts = await mapKnowledgeFragmentsByDocumentId(
      knowledgeService,
      undefined,
      documentIds,
    );

    const cleanedDocuments = documents.map((doc) =>
      presentKnowledgeDocument(
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

  // ── GET /api/knowledge/documents/:id ────────────────────────────────────
  const docIdMatch = /^\/api\/knowledge\/documents\/([^/]+)$/.exec(pathname);
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

    const fragmentCount = await countKnowledgeFragmentsForDocument(
      knowledgeService,
      undefined,
      documentId,
    );

    json(res, {
      document: presentKnowledgeDocument(document, fragmentCount, {
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

    const editability = getKnowledgeDocumentEditability(document);
    if (!editability.canEditText) {
      error(
        res,
        editability.reason || "This knowledge document cannot be edited.",
        400,
      );
      return true;
    }

    const body = await readJsonBody<{ content?: string }>(req, res, {
      maxBytes: KNOWLEDGE_UPLOAD_MAX_BODY_BYTES,
    });
    if (!body) return true;

    if (typeof body.content !== "string" || body.content.trim().length === 0) {
      error(res, "content must be a non-empty string");
      return true;
    }

    if (typeof knowledgeService.updateKnowledgeDocument !== "function") {
      error(res, "Knowledge document editing is unavailable", 503);
      return true;
    }

    const result = await knowledgeService.updateKnowledgeDocument({
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

  // ── DELETE /api/knowledge/documents/:id ─────────────────────────────────
  if (method === "DELETE" && docIdMatch) {
    const documentId = decodeURIComponent(docIdMatch[1]) as UUID;
    const existingDocument = await runtime.getMemoryById(documentId);
    if (!existingDocument || existingDocument.agentId !== agentId) {
      error(res, "Document not found", 404);
      return true;
    }

    const deleteability = getKnowledgeDocumentDeleteability(existingDocument);
    if (!deleteability.canDelete) {
      error(
        res,
        deleteability.reason || "This knowledge document cannot be deleted.",
        400,
      );
      return true;
    }

    const fragmentIds = await listKnowledgeFragmentsForDocument(
      knowledgeService,
      undefined,
      documentId,
    );

    for (const fragmentId of fragmentIds) {
      await knowledgeService.deleteMemory(fragmentId);
    }

    // Then delete the document itself
    await knowledgeService.deleteMemory(documentId);

    json(res, {
      ok: true,
      deletedFragments: fragmentIds.length,
    });
    return true;
  }

  type KnowledgeUploadDocumentBody = {
    content: string;
    filename: string;
    contentType?: string;
    metadata?: Record<string, unknown>;
    roomId?: string;
  };

  async function addKnowledgeDocument(
    service: KnowledgeServiceLike,
    document: KnowledgeUploadDocumentBody,
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
              prompt: `Describe this image in detail for a knowledge base. Focus on text content, data, charts, and key visual elements. Image filename: ${document.filename}`,
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

    const result = await service.addKnowledge({
      agentId,
      worldId: agentId,
      roomId:
        typeof document.roomId === "string" && document.roomId.trim().length > 0
          ? (document.roomId.trim() as UUID)
          : agentId,
      entityId: agentId,
      clientDocumentId: "" as UUID, // Will be generated
      contentType,
      originalFilename: document.filename,
      content,
      metadata: {
        ...document.metadata,
        source: "upload",
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

  // ── POST /api/knowledge/documents ───────────────────────────────────────
  // Upload document from base64 content or text
  if (method === "POST" && pathname === "/api/knowledge/documents") {
    const body = await readJsonBody<KnowledgeUploadDocumentBody>(req, res, {
      maxBytes: KNOWLEDGE_UPLOAD_MAX_BODY_BYTES,
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
      result = await addKnowledgeDocument(knowledgeService, body);
    } catch (err) {
      error(res, `Failed to add knowledge document: ${String(err)}`, 500);
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

  // ── POST /api/knowledge/documents/bulk ──────────────────────────────────
  if (method === "POST" && pathname === "/api/knowledge/documents/bulk") {
    const body = await readJsonBody<{
      documents?: KnowledgeUploadDocumentBody[];
    }>(req, res, {
      maxBytes: KNOWLEDGE_UPLOAD_MAX_BODY_BYTES,
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

      const normalizedDocument: KnowledgeUploadDocumentBody = {
        ...document,
        content: document.content,
        filename: document.filename.trim(),
      };

      try {
        const uploadResult = await addKnowledgeDocument(
          knowledgeService,
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

  // ── POST /api/knowledge/documents/url ───────────────────────────────────
  // Upload document from URL (including YouTube auto-transcription)
  if (method === "POST" && pathname === "/api/knowledge/documents/url") {
    const body = await readJsonBody<{
      url: string;
      metadata?: Record<string, unknown>;
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
    let fetchedContent: Awaited<ReturnType<typeof fetchKnowledgeFromUrl>>;
    try {
      fetchedContent = await fetchKnowledgeFromUrl(urlToFetch);
    } catch (fetchErr) {
      error(res, `Failed to fetch URL content: ${String(fetchErr)}`, 400);
      return true;
    }

    const { content, mimeType, filename } = fetchedContent;
    const contentType = mimeType;

    const result = await knowledgeService.addKnowledge({
      agentId,
      worldId: agentId,
      roomId: agentId,
      entityId: agentId,
      clientDocumentId: "" as UUID,
      contentType,
      originalFilename: filename,
      content,
      metadata: {
        ...body.metadata,
        url: urlToFetch,
        source: isYouTubeUrl(urlToFetch) ? "youtube" : "url",
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

  // ── GET /api/knowledge/search ───────────────────────────────────────────
  if (method === "GET" && pathname === "/api/knowledge/search") {
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

    const results = await knowledgeService.getKnowledge(searchMessage);

    // Filter by threshold and limit
    const filteredResults = results
      .filter((r) => (r.similarity ?? 0) >= threshold)
      .slice(0, limit)
      .map((r) => {
        const meta = r.metadata as Record<string, unknown> | undefined;
        return {
          id: r.id,
          text: r.content?.text || "",
          similarity: r.similarity,
          documentId: meta?.documentId,
          documentTitle: getKnowledgeDocumentTitleFromMetadata(
            meta,
            r.content?.text,
          ),
          documentProvenance: meta
            ? getKnowledgeDocumentProvenance(meta)
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

  // ── GET /api/knowledge/fragments/:documentId ────────────────────────────
  const fragmentsMatch = /^\/api\/knowledge\/fragments\/([^/]+)$/.exec(
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
      const fragmentBatch = await knowledgeService.getMemories({
        tableName: "knowledge",
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

  // Route not matched within /api/knowledge prefix
  return false;
}

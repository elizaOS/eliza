import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { IAgentRuntime, Memory, Metadata, Route, UUID } from "@elizaos/core";
import { createUniqueUuid, logger, MemoryType, ModelType } from "@elizaos/core";
import multer from "multer";
import { KnowledgeService } from "./service";
import { fetchUrlContent, normalizeS3Url } from "./utils";

interface ExtendedRequest extends IncomingMessage {
  body?: Record<string, unknown>;
  params?: Record<string, string>;
  query?: Record<string, string | string[]>;
  files?: MulterFile[];
  originalUrl?: string;
  path?: string;
  url?: string;
}

type ExtendedResponse = ServerResponse<IncomingMessage> & {
  pipe?: <T extends NodeJS.WritableStream>(destination: T) => T;
};

function asWritableStream(res: ExtendedResponse): NodeJS.WritableStream {
  return res as NodeJS.WritableStream;
}

const createUploadMiddleware = (runtime: IAgentRuntime) => {
  const uploadDir = String(runtime.getSetting("KNOWLEDGE_UPLOAD_DIR") || "/tmp/uploads/");
  const maxFileSize = parseInt(
    String(runtime.getSetting("KNOWLEDGE_MAX_FILE_SIZE") || "52428800"),
    10
  );
  const maxFiles = parseInt(String(runtime.getSetting("KNOWLEDGE_MAX_FILES") || "10"), 10);
  const allowedMimeTypes =
    String(runtime.getSetting("KNOWLEDGE_ALLOWED_MIME_TYPES") || "")
      .split(",")
      .filter(Boolean).length > 0
      ? String(runtime.getSetting("KNOWLEDGE_ALLOWED_MIME_TYPES") || "").split(",")
      : [
          "text/plain",
          "text/markdown",
          "application/pdf",
          "application/msword",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "text/html",
          "application/json",
          "application/xml",
          "text/csv",
        ];

  return multer({
    dest: uploadDir,
    limits: {
      fileSize: maxFileSize,
      files: maxFiles,
    },
    fileFilter: (_req, file, cb) => {
      if (allowedMimeTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(
          new Error(
            `File type ${file.mimetype} not allowed. Allowed types: ${allowedMimeTypes.join(", ")}`
          )
        );
      }
    },
  });
};

// Add this type declaration to fix Express.Multer.File error
interface MulterFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  destination: string;
  filename: string;
  path: string;
  buffer: Buffer;
}

function sendSuccess(res: ExtendedResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ success: true, data }));
}

function sendError(
  res: ExtendedResponse,
  status: number,
  code: string,
  message: string,
  details?: string
) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ success: false, error: { code, message, details } }));
}

// Helper to clean up a single file
const cleanupFile = (filePath: string) => {
  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      logger.error({ error }, `Error cleaning up file ${filePath}`);
    }
  }
};

const cleanupFiles = (files: MulterFile[]) => {
  if (files) {
    files.forEach((file) => {
      cleanupFile(file.path);
    });
  }
};

async function uploadKnowledgeHandler(
  req: ExtendedRequest,
  res: ExtendedResponse,
  runtime: IAgentRuntime
) {
  const service = runtime.getService<KnowledgeService>(KnowledgeService.serviceType);
  if (!service) {
    return sendError(res, 500, "SERVICE_NOT_FOUND", "KnowledgeService not found");
  }

  // Check if the request has uploaded files or URLs
  const hasUploadedFiles = req.files && req.files.length > 0;
  const isJsonRequest = !hasUploadedFiles && req.body && (req.body.fileUrl || req.body.fileUrls);

  if (!hasUploadedFiles && !isJsonRequest) {
    return sendError(res, 400, "INVALID_REQUEST", "Request must contain either files or URLs");
  }

  try {
    if (hasUploadedFiles) {
      const files = req.files as MulterFile[];

      if (!files || files.length === 0) {
        return sendError(res, 400, "NO_FILES", "No files uploaded");
      }

      const invalidFiles = files.filter((file) => {
        if (file.size === 0) {
          logger.warn(`File ${file.originalname} is empty`);
          return true;
        }

        if (!file.originalname || file.originalname.trim() === "") {
          logger.warn(`File has no name`);
          return true;
        }

        if (!file.path) {
          logger.warn(`File ${file.originalname} has no path`);
          return true;
        }

        return false;
      });

      if (invalidFiles.length > 0) {
        cleanupFiles(files);
        const invalidFileNames = invalidFiles.map((f) => f.originalname || "unnamed").join(", ");
        return sendError(
          res,
          400,
          "INVALID_FILES",
          `Invalid or corrupted files: ${invalidFileNames}`
        );
      }

      const agentId = (req.body?.agentId as UUID) || (req.query?.agentId as UUID);

      if (!agentId) {
        logger.error("No agent ID provided in upload request");
        return sendError(
          res,
          400,
          "MISSING_AGENT_ID",
          "Agent ID is required for uploading knowledge"
        );
      }

      const worldId = (req.body?.worldId as UUID) || agentId;
      logger.info(`Processing file upload for agent: ${agentId}`);

      const processingPromises = files.map(async (file) => {
        const originalFilename = file.originalname;
        const filePath = file.path;

        try {
          const fileBuffer = await fs.promises.readFile(filePath);
          const base64Content = fileBuffer.toString("base64");

          const addKnowledgeOpts: import("./types.ts").AddKnowledgeOptions = {
            agentId: agentId,
            clientDocumentId: "" as UUID,
            contentType: file.mimetype,
            originalFilename: originalFilename,
            content: base64Content,
            worldId,
            roomId: agentId,
            entityId: agentId,
          };

          const result = await service.addKnowledge(addKnowledgeOpts);

          cleanupFile(filePath);

          return {
            id: result.clientDocumentId,
            filename: originalFilename,
            type: file.mimetype,
            size: file.size,
            uploadedAt: Date.now(),
            status: "success",
          };
        } catch (fileError) {
          logger.error(
            `Error processing file ${file.originalname}: ${fileError instanceof Error ? fileError.message : String(fileError)}`
          );
          cleanupFile(filePath);
          return {
            id: "",
            filename: originalFilename,
            status: "error_processing",
            error: fileError instanceof Error ? fileError.message : String(fileError),
          };
        }
      });

      const results = await Promise.all(processingPromises);
      sendSuccess(res, results);
    } else if (isJsonRequest) {
      const fileUrls = Array.isArray(req.body?.fileUrls)
        ? req.body?.fileUrls
        : req.body?.fileUrl
          ? [req.body?.fileUrl]
          : [];

      if (fileUrls.length === 0) {
        return sendError(res, 400, "MISSING_URL", "File URL is required");
      }

      const agentId = (req.body?.agentId as UUID) || (req.query?.agentId as UUID);

      if (!agentId) {
        logger.error("No agent ID provided in URL request");
        return sendError(
          res,
          400,
          "MISSING_AGENT_ID",
          "Agent ID is required for uploading knowledge from URLs"
        );
      }

      const processingPromises = fileUrls.map(async (fileUrl: string) => {
        try {
          const normalizedUrl = normalizeS3Url(fileUrl);

          const urlObject = new URL(fileUrl);
          const pathSegments = urlObject.pathname.split("/");
          const encodedFilename = pathSegments[pathSegments.length - 1] || "document.pdf";
          const originalFilename = decodeURIComponent(encodedFilename);

          logger.debug(`Fetching content from URL: ${fileUrl}`);

          const { content, contentType: fetchedContentType } = await fetchUrlContent(fileUrl);

          let contentType = fetchedContentType;

          if (contentType === "application/octet-stream") {
            const fileExtension = originalFilename.split(".").pop()?.toLowerCase();
            if (fileExtension) {
              if (["pdf"].includes(fileExtension)) {
                contentType = "application/pdf";
              } else if (["txt", "text"].includes(fileExtension)) {
                contentType = "text/plain";
              } else if (["md", "markdown"].includes(fileExtension)) {
                contentType = "text/markdown";
              } else if (["doc", "docx"].includes(fileExtension)) {
                contentType = "application/msword";
              } else if (["html", "htm"].includes(fileExtension)) {
                contentType = "text/html";
              } else if (["json"].includes(fileExtension)) {
                contentType = "application/json";
              } else if (["xml"].includes(fileExtension)) {
                contentType = "application/xml";
              }
            }
          }

          const addKnowledgeOpts: import("./types.ts").AddKnowledgeOptions = {
            agentId: agentId,
            clientDocumentId: "" as UUID,
            contentType: contentType,
            originalFilename: originalFilename,
            content: content,
            worldId: agentId,
            roomId: agentId,
            entityId: agentId,
            metadata: {
              url: normalizedUrl,
            },
          };

          const result = await service.addKnowledge(addKnowledgeOpts);

          return {
            id: result.clientDocumentId,
            fileUrl: fileUrl,
            filename: originalFilename,
            message: "Knowledge created successfully",
            createdAt: Date.now(),
            fragmentCount: result.fragmentCount,
            status: "success",
          };
        } catch (urlError) {
          logger.error(
            `Error processing URL ${fileUrl}: ${urlError instanceof Error ? urlError.message : String(urlError)}`
          );
          return {
            fileUrl: fileUrl,
            status: "error_processing",
            error: urlError instanceof Error ? urlError.message : String(urlError),
          };
        }
      });

      const results = await Promise.all(processingPromises);
      sendSuccess(res, results);
    }
  } catch (error) {
    logger.error({ error }, "Error processing knowledge");
    if (hasUploadedFiles) {
      cleanupFiles(req.files as MulterFile[]);
    }
    sendError(
      res,
      500,
      "PROCESSING_ERROR",
      "Failed to process knowledge",
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function getKnowledgeDocumentsHandler(
  req: ExtendedRequest,
  res: ExtendedResponse,
  runtime: IAgentRuntime
) {
  const service = runtime.getService<KnowledgeService>(KnowledgeService.serviceType);
  if (!service) {
    return sendError(
      res,
      500,
      "SERVICE_NOT_FOUND",
      "KnowledgeService not found for getKnowledgeDocumentsHandler"
    );
  }

  try {
    const limit = req.query?.limit ? Number.parseInt(req.query.limit as string, 10) : 10000;
    const before = req.query?.before ? Number.parseInt(req.query.before as string, 10) : Date.now();
    const includeEmbedding = req.query?.includeEmbedding === "true";

    const fileUrls = req.query?.fileUrls
      ? typeof req.query?.fileUrls === "string" && req.query.fileUrls.includes(",")
        ? req.query.fileUrls.split(",")
        : [req.query?.fileUrls]
      : null;

    const memories = await service.getMemories({
      tableName: "documents",
      count: limit,
      end: before,
    });

    let filteredMemories = memories;
    if (fileUrls && fileUrls.length > 0) {
      const normalizedRequestUrls = fileUrls.map((url) => normalizeS3Url(String(url)));
      const urlBasedIds = normalizedRequestUrls.map((url: string) =>
        createUniqueUuid(runtime, url)
      );

      filteredMemories = memories.filter(
        (memory) =>
          urlBasedIds.includes(memory.id) ||
          (memory.metadata &&
            "url" in memory.metadata &&
            typeof memory.metadata.url === "string" &&
            normalizedRequestUrls.includes(normalizeS3Url(memory.metadata.url)))
      );
    }

    const cleanMemories = includeEmbedding
      ? filteredMemories
      : filteredMemories.map((memory: Memory) => ({
          ...memory,
          embedding: undefined,
        }));
    sendSuccess(res, {
      memories: cleanMemories,
      urlFiltered: !!fileUrls,
      totalFound: cleanMemories.length,
      totalRequested: fileUrls ? fileUrls.length : 0,
    });
  } catch (error) {
    logger.error({ error }, "Error retrieving documents");
    sendError(
      res,
      500,
      "RETRIEVAL_ERROR",
      "Failed to retrieve documents",
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function deleteKnowledgeDocumentHandler(
  req: ExtendedRequest,
  res: ExtendedResponse,
  runtime: IAgentRuntime
) {
  const service = runtime.getService<KnowledgeService>(KnowledgeService.serviceType);
  if (!service) {
    return sendError(
      res,
      500,
      "SERVICE_NOT_FOUND",
      "KnowledgeService not found for deleteKnowledgeDocumentHandler"
    );
  }

  // Get the ID directly from the route parameters
  const knowledgeId = req.params?.knowledgeId;

  if (!knowledgeId || knowledgeId.length < 36) {
    logger.error(`Invalid knowledge ID format: ${knowledgeId}`);
    return sendError(res, 400, "INVALID_ID", "Invalid Knowledge ID format");
  }

  try {
    const typedKnowledgeId = knowledgeId as `${string}-${string}-${string}-${string}-${string}`;
    logger.debug(`Deleting document: ${typedKnowledgeId}`);

    await service.deleteMemory(typedKnowledgeId);
    sendSuccess(res, null, 204);
  } catch (error) {
    logger.error({ error }, `Error deleting document ${knowledgeId}`);
    sendError(
      res,
      500,
      "DELETE_ERROR",
      "Failed to delete document",
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function getKnowledgeByIdHandler(
  req: ExtendedRequest,
  res: ExtendedResponse,
  runtime: IAgentRuntime
) {
  const service = runtime.getService<KnowledgeService>(KnowledgeService.serviceType);
  if (!service) {
    return sendError(
      res,
      500,
      "SERVICE_NOT_FOUND",
      "KnowledgeService not found for getKnowledgeByIdHandler"
    );
  }

  // Get the ID directly from the route parameters
  const knowledgeId = req.params?.knowledgeId;

  if (!knowledgeId || knowledgeId.length < 36) {
    logger.error(`Invalid knowledge ID format: ${knowledgeId}`);
    return sendError(res, 400, "INVALID_ID", "Invalid Knowledge ID format");
  }

  try {
    logger.debug(`Retrieving document: ${knowledgeId}`);

    const memories = await service.getMemories({
      tableName: "documents",
      count: 10000,
    });

    const typedKnowledgeId = knowledgeId as `${string}-${string}-${string}-${string}-${string}`;
    const document = memories.find((memory) => memory.id === typedKnowledgeId);

    if (!document) {
      return sendError(res, 404, "NOT_FOUND", `Knowledge with ID ${typedKnowledgeId} not found`);
    }

    const cleanDocument = {
      ...document,
      embedding: undefined,
    };

    sendSuccess(res, { document: cleanDocument });
  } catch (error) {
    logger.error({ error }, `Error retrieving document ${knowledgeId}`);
    sendError(
      res,
      500,
      "RETRIEVAL_ERROR",
      "Failed to retrieve document",
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function knowledgePanelHandler(
  req: ExtendedRequest,
  res: ExtendedResponse,
  runtime: IAgentRuntime
) {
  const agentId = runtime.agentId;
  const requestPath = req.originalUrl || req.url || req.path || "";
  const pluginBasePath = requestPath.replace(/\/display.*$/, "");

  try {
    const currentDir = path.dirname(new URL(import.meta.url).pathname);
    const frontendPath = path.join(currentDir, "../dist/index.html");

    if (fs.existsSync(frontendPath)) {
      const html = await fs.promises.readFile(frontendPath, "utf8");
      let injectedHtml = html.replace(
        "<head>",
        `<head>
          <script>
            window.ELIZA_CONFIG = {
              agentId: '${agentId}',
              apiBase: '${pluginBasePath}'
            };
          </script>`
      );

      injectedHtml = injectedHtml.replace(/src="\.\/assets\//g, `src="${pluginBasePath}/assets/`);
      injectedHtml = injectedHtml.replace(/href="\.\/assets\//g, `href="${pluginBasePath}/assets/`);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(injectedHtml);
    } else {
      let cssFile = "index.css";
      let jsFile = "index.js";

      const manifestPath = path.join(currentDir, "../dist/manifest.json");
      if (fs.existsSync(manifestPath)) {
        try {
          const manifestContent = await fs.promises.readFile(manifestPath, "utf8");
          const manifest = JSON.parse(manifestContent);

          interface ViteManifestEntry {
            file?: string;
            css?: string[];
            isEntry?: boolean;
          }
          for (const [key, value] of Object.entries(manifest)) {
            if (typeof value === "object" && value !== null) {
              const entry = value as ViteManifestEntry;
              if (key.endsWith(".css") || entry.file?.endsWith(".css")) {
                cssFile = entry.file || key;
              }
              if (key.endsWith(".js") || entry.file?.endsWith(".js")) {
                jsFile = entry.file || key;
              }
            }
          }
        } catch {}
      }

      const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Knowledge</title>
    <script>
      window.ELIZA_CONFIG = {
        agentId: '${agentId}',
        apiBase: '${pluginBasePath}'
      };
    </script>
    <link rel="stylesheet" href="${pluginBasePath}/assets/${cssFile}">
    <style>
        body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 20px; }
        .container { max-width: 1200px; margin: 0 auto; }
        .loading { text-align: center; padding: 40px; color: #666; }
    </style>
</head>
<body>
    <div class="container">
        <div id="root">
            <div class="loading">Loading Knowledge Library...</div>
        </div>
    </div>
    <script type="module" src="${pluginBasePath}/assets/${jsFile}"></script>
</body>
</html>`;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    }
  } catch (error) {
    logger.error({ error }, "Error serving frontend");
    sendError(
      res,
      500,
      "FRONTEND_ERROR",
      "Failed to load knowledge panel",
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function frontendAssetHandler(
  req: ExtendedRequest,
  res: ExtendedResponse,
  _runtime: IAgentRuntime
) {
  try {
    const fullPath = req.originalUrl || req.url || req.path || "";
    const currentDir = path.dirname(new URL(import.meta.url).pathname);

    const assetsMarker = "/assets/";
    const assetsStartIndex = fullPath.lastIndexOf(assetsMarker);

    let assetName: string | null = null;
    if (assetsStartIndex !== -1) {
      assetName = fullPath.substring(assetsStartIndex + assetsMarker.length);
      const queryIndex = assetName.indexOf("?");
      if (queryIndex !== -1) {
        assetName = assetName.substring(0, queryIndex);
      }
    }

    if (!assetName || assetName.includes("..")) {
      return sendError(
        res,
        400,
        "BAD_REQUEST",
        `Invalid asset name: '${assetName}' from path ${fullPath}`
      );
    }

    const assetPath = path.join(currentDir, "../dist/assets", assetName);

    if (fs.existsSync(assetPath)) {
      const fileStream = fs.createReadStream(assetPath);
      let contentType = "application/octet-stream";
      if (assetPath.endsWith(".js")) {
        contentType = "application/javascript";
      } else if (assetPath.endsWith(".css")) {
        contentType = "text/css";
      }
      res.writeHead(200, { "Content-Type": contentType });
      fileStream.pipe(asWritableStream(res));
    } else {
      sendError(res, 404, "NOT_FOUND", `Asset not found: ${req.url}`);
    }
  } catch (error) {
    logger.error({ error }, `Error serving asset ${req.url}`);
    sendError(
      res,
      500,
      "ASSET_ERROR",
      `Failed to load asset ${req.url}`,
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function getKnowledgeChunksHandler(
  req: ExtendedRequest,
  res: ExtendedResponse,
  runtime: IAgentRuntime
) {
  const service = runtime.getService<KnowledgeService>(KnowledgeService.serviceType);
  if (!service) {
    return sendError(res, 500, "SERVICE_NOT_FOUND", "KnowledgeService not found");
  }

  try {
    const documentId = req.query?.documentId as string | undefined;
    const documentsOnly = req.query?.documentsOnly === "true";

    const documents = await service.getMemories({
      tableName: "documents",
      count: 10000,
      end: Date.now(),
    });

    if (documentsOnly) {
      sendSuccess(res, {
        chunks: documents,
        stats: {
          documents: documents.length,
          fragments: 0,
          mode: "documents-only",
        },
      });
      return;
    }

    if (documentId) {
      const allFragments = await service.getMemories({
        tableName: "knowledge",
        count: 50000,
      });

      const documentFragments = allFragments.filter((fragment) => {
        const metadata = fragment.metadata as Metadata;
        return typeof metadata?.documentId === "string" && metadata.documentId === documentId;
      });

      const specificDocument = documents.find((d) => d.id === documentId);
      const results = specificDocument
        ? [specificDocument, ...documentFragments]
        : documentFragments;

      sendSuccess(res, {
        chunks: results,
        stats: {
          documents: specificDocument ? 1 : 0,
          fragments: documentFragments.length,
          mode: "single-document",
          documentId,
        },
      });
      return;
    }

    sendSuccess(res, {
      chunks: documents,
      stats: {
        documents: documents.length,
        fragments: 0,
        mode: "documents-only",
      },
    });
  } catch (error) {
    logger.error({ error }, "Error retrieving chunks");
    sendError(
      res,
      500,
      "RETRIEVAL_ERROR",
      "Failed to retrieve knowledge chunks",
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function searchKnowledgeHandler(
  req: ExtendedRequest,
  res: ExtendedResponse,
  runtime: IAgentRuntime
) {
  const service = runtime.getService<KnowledgeService>(KnowledgeService.serviceType);
  if (!service) {
    return sendError(res, 500, "SERVICE_NOT_FOUND", "KnowledgeService not found");
  }

  try {
    const searchText = req.query?.q as string;

    const parsedThreshold = req.query?.threshold
      ? Number.parseFloat(req.query.threshold as string)
      : NaN;
    let matchThreshold = Number.isNaN(parsedThreshold) ? 0.5 : parsedThreshold;
    matchThreshold = Math.max(0, Math.min(1, matchThreshold));

    const parsedLimit = req.query?.limit ? Number.parseInt(req.query.limit as string, 10) : NaN;
    let limit = Number.isNaN(parsedLimit) ? 20 : parsedLimit;
    limit = Math.max(1, Math.min(100, limit));

    const agentId = (req.query?.agentId as UUID) || runtime.agentId;

    if (!searchText || searchText.trim().length === 0) {
      return sendError(res, 400, "INVALID_QUERY", "Search query cannot be empty");
    }

    const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
      text: searchText,
    });

    const results = await runtime.searchMemories({
      tableName: "knowledge",
      embedding,
      query: searchText,
      count: limit,
      match_threshold: matchThreshold,
      roomId: agentId,
    });

    const enhancedResults = await Promise.all(
      results.map(async (fragment) => {
        let documentTitle = "";
        let documentFilename = "";

        if (
          fragment.metadata &&
          typeof fragment.metadata === "object" &&
          "documentId" in fragment.metadata
        ) {
          const documentId = fragment.metadata.documentId as UUID;
          try {
            const document = await runtime.getMemoryById(documentId);
            if (document?.metadata) {
              const docMetadata = document.metadata as Metadata;
              documentTitle =
                (typeof docMetadata.title === "string" ? docMetadata.title : undefined) ||
                (typeof docMetadata.filename === "string" ? docMetadata.filename : undefined) ||
                "";
              documentFilename =
                (typeof docMetadata.filename === "string" ? docMetadata.filename : undefined) || "";
            }
          } catch {}
        }

        return {
          id: fragment.id,
          content: fragment.content,
          similarity: fragment.similarity || 0,
          metadata: {
            ...(fragment.metadata || {}),
            documentTitle,
            documentFilename,
          },
        };
      })
    );

    sendSuccess(res, {
      query: searchText,
      threshold: matchThreshold,
      results: enhancedResults,
      count: enhancedResults.length,
    });
  } catch (error) {
    logger.error({ error }, "Error searching knowledge");
    sendError(
      res,
      500,
      "SEARCH_ERROR",
      "Failed to search knowledge",
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function getGraphNodesHandler(
  req: ExtendedRequest,
  res: ExtendedResponse,
  runtime: IAgentRuntime
) {
  const service = runtime.getService<KnowledgeService>(KnowledgeService.serviceType);
  if (!service) {
    return sendError(res, 500, "SERVICE_NOT_FOUND", "KnowledgeService not found");
  }

  try {
    const parsedPage = req.query?.page ? Number.parseInt(req.query.page as string, 10) : 1;
    const parsedLimit = req.query?.limit ? Number.parseInt(req.query.limit as string, 10) : 20;
    const type = req.query?.type as "document" | "fragment" | undefined;
    const agentId = (req.query?.agentId as UUID) || runtime.agentId;

    const page = Number.isNaN(parsedPage) || parsedPage < 1 ? 1 : parsedPage;
    const limit = Number.isNaN(parsedLimit) || parsedLimit < 1 ? 20 : Math.min(parsedLimit, 50);
    const offset = (page - 1) * limit;

    const totalDocuments = await service.countMemories({
      tableName: "documents",
      roomId: agentId,
      unique: false,
    });

    const totalPages = Math.ceil(totalDocuments / limit);
    const hasMore = page < totalPages;

    const paginatedDocuments = await service.getMemories({
      tableName: "documents",
      roomId: agentId,
      count: limit,
      offset: offset,
    });

    const nodes: Array<{ id: UUID; type: "document" | "fragment" }> = [];
    const links: Array<{ source: UUID; target: UUID }> = [];

    paginatedDocuments.forEach((doc) => {
      if (!doc.id) {
        logger.warn("Skipping document without ID");
        return;
      }
      nodes.push({ id: doc.id, type: "document" });
    });

    if (type !== "document") {
      const allFragments = await service.getMemories({
        tableName: "knowledge",
        roomId: agentId,
        count: 50000,
      });

      paginatedDocuments.forEach((doc) => {
        if (!doc.id) {
          return;
        }

        const docFragments = allFragments.filter((fragment) => {
          const metadata = fragment.metadata as Metadata;
          const typeString = typeof metadata?.type === "string" ? metadata.type : null;
          const isFragment =
            (typeString && typeString.toLowerCase() === "fragment") ||
            metadata?.type === MemoryType.FRAGMENT ||
            (!metadata?.type && metadata?.documentId);
          return metadata?.documentId === doc.id && isFragment;
        });

        docFragments.forEach((frag) => {
          const docId = doc.id;
          if (!frag.id || !docId) {
            return;
          }
          nodes.push({ id: frag.id, type: "fragment" });
          links.push({ source: docId, target: frag.id });
        });
      });
    }

    sendSuccess(res, {
      nodes,
      links,
      pagination: {
        currentPage: page,
        totalPages,
        hasMore,
        totalDocuments,
      },
    });
  } catch (error: unknown) {
    logger.error({ error }, "Error fetching graph nodes");
    sendError(
      res,
      500,
      "GRAPH_ERROR",
      "Failed to fetch graph nodes",
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function getGraphNodeDetailsHandler(
  req: ExtendedRequest,
  res: ExtendedResponse,
  runtime: IAgentRuntime
) {
  const service = runtime.getService<KnowledgeService>(KnowledgeService.serviceType);
  if (!service) {
    return sendError(res, 500, "SERVICE_NOT_FOUND", "KnowledgeService not found");
  }

  const nodeId = req.params?.nodeId as UUID;
  const agentId = (req.query?.agentId as UUID) || runtime.agentId;

  if (!nodeId || nodeId.length < 36) {
    return sendError(res, 400, "INVALID_ID", "Invalid node ID format");
  }

  try {
    const allDocuments = await service.getMemories({
      tableName: "documents",
      count: 10000,
    });

    let document = allDocuments.find((doc) => doc.id === nodeId && doc.roomId === agentId);

    if (!document) {
      document = allDocuments.find((doc) => doc.id === nodeId);
    }

    if (document) {
      sendSuccess(res, {
        id: document.id,
        type: "document",
        content: document.content,
        metadata: document.metadata,
        createdAt: document.createdAt,
        entityId: document.entityId,
        roomId: document.roomId,
        agentId: document.agentId,
        worldId: document.worldId,
      });
      return;
    }

    const allFragments = await service.getMemories({
      tableName: "knowledge",
      count: 50000,
    });

    let fragment = allFragments.find((frag) => frag.id === nodeId && frag.roomId === agentId);

    if (!fragment) {
      fragment = allFragments.find((frag) => frag.id === nodeId);
    }

    if (fragment) {
      sendSuccess(res, {
        id: fragment.id,
        type: "fragment",
        content: fragment.content,
        metadata: fragment.metadata,
        createdAt: fragment.createdAt,
        entityId: fragment.entityId,
        roomId: fragment.roomId,
        agentId: fragment.agentId,
        worldId: fragment.worldId,
      });
      return;
    }

    logger.error(`Node ${nodeId} not found`);
    sendError(res, 404, "NOT_FOUND", `Node with ID ${nodeId} not found`);
  } catch (error) {
    logger.error({ error }, `Error fetching node details for ${nodeId}`);
    sendError(
      res,
      500,
      "GRAPH_ERROR",
      "Failed to fetch node details",
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function expandDocumentGraphHandler(
  req: ExtendedRequest,
  res: ExtendedResponse,
  runtime: IAgentRuntime
) {
  const service = runtime.getService<KnowledgeService>(KnowledgeService.serviceType);
  if (!service) {
    return sendError(res, 500, "SERVICE_NOT_FOUND", "KnowledgeService not found");
  }

  const documentId = req.params?.documentId as UUID;
  const agentId = (req.query?.agentId as UUID) || runtime.agentId;

  if (!documentId || documentId.length < 36) {
    return sendError(res, 400, "INVALID_ID", "Invalid document ID format");
  }

  try {
    const allFragments = await service.getMemories({
      tableName: "knowledge",
      roomId: agentId,
      count: 50000,
    });

    const documentFragments = allFragments.filter((fragment) => {
      const metadata = fragment.metadata as Metadata;
      const typeString = typeof metadata?.type === "string" ? metadata.type : null;
      const isFragment =
        (typeString && typeString.toLowerCase() === "fragment") ||
        metadata?.type === MemoryType.FRAGMENT ||
        (!metadata?.type && metadata?.documentId);
      return metadata?.documentId === documentId && isFragment;
    });
    const nodes = documentFragments
      .filter((frag) => frag.id !== undefined)
      .map((frag) => ({
        id: frag.id as UUID,
        type: "fragment" as const,
      }));

    const links = documentFragments
      .filter((frag) => frag.id !== undefined)
      .map((frag) => ({
        source: documentId,
        target: frag.id as UUID,
      }));

    sendSuccess(res, {
      documentId,
      nodes,
      links,
      fragmentCount: nodes.length,
    });
  } catch (error) {
    logger.error({ error }, `Error expanding document ${documentId}`);
    sendError(
      res,
      500,
      "GRAPH_ERROR",
      "Failed to expand document",
      error instanceof Error ? error.message : String(error)
    );
  }
}

type MulterMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err: Error | null) => void
) => void;

async function uploadKnowledgeWithMulter(
  req: ExtendedRequest,
  res: ExtendedResponse,
  runtime: IAgentRuntime
) {
  const upload = createUploadMiddleware(runtime);
  const uploadArray = upload.array(
    "files",
    parseInt(String(runtime.getSetting("KNOWLEDGE_MAX_FILES") || "10"), 10)
  ) as MulterMiddleware;

  uploadArray(req, res, (err: Error | null) => {
    if (err) {
      logger.error({ error: err }, "File upload error");
      return sendError(res, 400, "UPLOAD_ERROR", err.message);
    }
    uploadKnowledgeHandler(req, res, runtime);
  });
}

type ExtendedRouteHandler = (
  req: ExtendedRequest,
  res: ExtendedResponse,
  runtime: IAgentRuntime
) => Promise<void>;

function asRouteHandler(handler: ExtendedRouteHandler): Route["handler"] {
  return handler as unknown as Route["handler"];
}

export const knowledgeRoutes: Route[] = [
  {
    type: "GET",
    name: "Knowledge",
    path: "/display",
    handler: asRouteHandler(knowledgePanelHandler),
    public: true,
  },
  {
    type: "GET",
    path: "/assets/*",
    handler: asRouteHandler(frontendAssetHandler),
  },
  {
    type: "POST",
    path: "/documents",
    handler: asRouteHandler(uploadKnowledgeWithMulter),
  },
  {
    type: "GET",
    path: "/documents",
    handler: asRouteHandler(getKnowledgeDocumentsHandler),
  },
  {
    type: "GET",
    path: "/documents/:knowledgeId",
    handler: asRouteHandler(getKnowledgeByIdHandler),
  },
  {
    type: "DELETE",
    path: "/documents/:knowledgeId",
    handler: asRouteHandler(deleteKnowledgeDocumentHandler),
  },
  {
    type: "GET",
    path: "/knowledges",
    handler: asRouteHandler(getKnowledgeChunksHandler),
  },
  {
    type: "GET",
    path: "/search",
    handler: asRouteHandler(searchKnowledgeHandler),
  },
  {
    type: "GET",
    path: "/graph/nodes",
    handler: asRouteHandler(getGraphNodesHandler),
  },
  {
    type: "GET",
    path: "/graph/node/:nodeId",
    handler: asRouteHandler(getGraphNodeDetailsHandler),
  },
  {
    type: "GET",
    path: "/graph/expand/:documentId",
    handler: asRouteHandler(expandDocumentGraphHandler),
  },
];

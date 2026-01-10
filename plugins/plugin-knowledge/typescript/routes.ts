import type { IAgentRuntime, Route, UUID, Memory, KnowledgeItem } from '@elizaos/core';
import { MemoryType, createUniqueUuid, logger, ModelType } from '@elizaos/core';
import { KnowledgeService } from './service';
import fs from 'node:fs'; // For file operations in upload
import path from 'node:path'; // For path operations
import multer from 'multer'; // For handling multipart uploads
import { fetchUrlContent, normalizeS3Url } from './utils'; // Import utils functions

// Create multer configuration function that uses runtime settings
const createUploadMiddleware = (runtime: IAgentRuntime) => {
  const uploadDir = runtime.getSetting('KNOWLEDGE_UPLOAD_DIR') || '/tmp/uploads/';
  const maxFileSize = parseInt(runtime.getSetting('KNOWLEDGE_MAX_FILE_SIZE') || '52428800'); // 50MB default
  const maxFiles = parseInt(runtime.getSetting('KNOWLEDGE_MAX_FILES') || '10');
  const allowedMimeTypes = runtime.getSetting('KNOWLEDGE_ALLOWED_MIME_TYPES')?.split(',') || [
    'text/plain',
    'text/markdown',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/html',
    'application/json',
    'application/xml',
    'text/csv',
  ];

  return multer({
    dest: uploadDir,
    limits: {
      fileSize: maxFileSize,
      files: maxFiles,
    },
    fileFilter: (req, file, cb) => {
      if (allowedMimeTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(
          new Error(
            `File type ${file.mimetype} not allowed. Allowed types: ${allowedMimeTypes.join(', ')}`
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

// Helper to send success response
function sendSuccess(res: any, data: any, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true, data }));
}

// Helper to send error response
function sendError(res: any, status: number, code: string, message: string, details?: string) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
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

// Helper to clean up multiple files
const cleanupFiles = (files: MulterFile[]) => {
  if (files) {
    files.forEach((file) => cleanupFile(file.path));
  }
};

// Main upload handler (without multer, multer is applied by wrapper)
async function uploadKnowledgeHandler(req: any, res: any, runtime: IAgentRuntime) {
  const service = runtime.getService<KnowledgeService>(KnowledgeService.serviceType);
  if (!service) {
    return sendError(res, 500, 'SERVICE_NOT_FOUND', 'KnowledgeService not found');
  }

  // Check if the request has uploaded files or URLs
  const hasUploadedFiles = req.files && req.files.length > 0;
  const isJsonRequest = !hasUploadedFiles && req.body && (req.body.fileUrl || req.body.fileUrls);

  if (!hasUploadedFiles && !isJsonRequest) {
    return sendError(res, 400, 'INVALID_REQUEST', 'Request must contain either files or URLs');
  }

  try {
    // Process multipart requests (file uploads)
    if (hasUploadedFiles) {
      const files = req.files as MulterFile[];

      if (!files || files.length === 0) {
        return sendError(res, 400, 'NO_FILES', 'No files uploaded');
      }

      // Validate files for corruption/truncation
      const invalidFiles = files.filter((file) => {
        // Check for empty files
        if (file.size === 0) {
          logger.warn(`File ${file.originalname} is empty`);
          return true;
        }

        // Check if file has a name
        if (!file.originalname || file.originalname.trim() === '') {
          logger.warn(`File has no name`);
          return true;
        }

        // Check if file has valid path
        if (!file.path) {
          logger.warn(`File ${file.originalname} has no path`);
          return true;
        }

        return false;
      });

      if (invalidFiles.length > 0) {
        cleanupFiles(files);
        const invalidFileNames = invalidFiles.map((f) => f.originalname || 'unnamed').join(', ');
        return sendError(
          res,
          400,
          'INVALID_FILES',
          `Invalid or corrupted files: ${invalidFileNames}`
        );
      }

      // Get agentId from request body or query parameter BEFORE processing files
      // IMPORTANT: We require explicit agent ID to prevent cross-agent contamination
      const agentId = (req.body.agentId as UUID) || (req.query.agentId as UUID);

      if (!agentId) {
        logger.error('[Document Processor] ❌ No agent ID provided in upload request');
        return sendError(
          res,
          400,
          'MISSING_AGENT_ID',
          'Agent ID is required for uploading knowledge'
        );
      }

      const worldId = (req.body.worldId as UUID) || agentId;
      logger.info(`[Document Processor] 📤 Processing file upload for agent: ${agentId}`);

      const processingPromises = files.map(async (file, index) => {
        const originalFilename = file.originalname;
        const filePath = file.path;

        logger.debug(
          `[Document Processor] 📄 Processing file: ${originalFilename} (agent: ${agentId})`
        );

        try {
          const fileBuffer = await fs.promises.readFile(filePath);
          const base64Content = fileBuffer.toString('base64');

          // Construct AddKnowledgeOptions directly using available variables
          // Note: We no longer provide clientDocumentId - the service will generate it
          const addKnowledgeOpts: import('./types.ts').AddKnowledgeOptions = {
            agentId: agentId, // Pass the agent ID from frontend
            clientDocumentId: '' as UUID, // This will be ignored by the service
            contentType: file.mimetype, // Directly from multer file object
            originalFilename: originalFilename, // Directly from multer file object
            content: base64Content, // The base64 string of the file
            worldId,
            roomId: agentId, // Use the correct agent ID
            entityId: agentId, // Use the correct agent ID
          };

          const result = await service.addKnowledge(addKnowledgeOpts);

          cleanupFile(filePath);

          return {
            id: result.clientDocumentId, // Use the content-based ID returned by the service
            filename: originalFilename,
            type: file.mimetype,
            size: file.size,
            uploadedAt: Date.now(),
            status: 'success',
          };
        } catch (fileError: any) {
          logger.error(
            `[Document Processor] ❌ Error processing file ${file.originalname}:`,
            fileError
          );
          cleanupFile(filePath);
          return {
            id: '', // No ID since processing failed
            filename: originalFilename,
            status: 'error_processing',
            error: fileError.message,
          };
        }
      });

      const results = await Promise.all(processingPromises);
      sendSuccess(res, results);
    }
    // Process JSON requests (URL uploads)
    else if (isJsonRequest) {
      // Accept either an array of URLs or a single URL
      const fileUrls = Array.isArray(req.body.fileUrls)
        ? req.body.fileUrls
        : req.body.fileUrl
          ? [req.body.fileUrl]
          : [];

      if (fileUrls.length === 0) {
        return sendError(res, 400, 'MISSING_URL', 'File URL is required');
      }

      // Get agentId from request body or query parameter
      // IMPORTANT: We require explicit agent ID to prevent cross-agent contamination
      const agentId = (req.body.agentId as UUID) || (req.query.agentId as UUID);

      if (!agentId) {
        logger.error('[Document Processor] ❌ No agent ID provided in URL request');
        return sendError(
          res,
          400,
          'MISSING_AGENT_ID',
          'Agent ID is required for uploading knowledge from URLs'
        );
      }

      logger.info(`[Document Processor] 📤 Processing URL upload for agent: ${agentId}`);

      // Process each URL as a distinct file
      const processingPromises = fileUrls.map(async (fileUrl: string) => {
        try {
          // Normalize the URL for storage (remove query parameters)
          const normalizedUrl = normalizeS3Url(fileUrl);

          // Remove the knowledgeId generation here - let the service handle it based on content

          // Extract filename from URL for better display
          const urlObject = new URL(fileUrl);
          const pathSegments = urlObject.pathname.split('/');
          // Decode URL-encoded characters and handle empty filename
          const encodedFilename = pathSegments[pathSegments.length - 1] || 'document.pdf';
          const originalFilename = decodeURIComponent(encodedFilename);

          logger.debug(`[Document Processor] 🌐 Fetching content from URL: ${fileUrl}`);

          // Fetch the content from the URL
          const { content, contentType: fetchedContentType } = await fetchUrlContent(fileUrl);

          // Determine content type, using the one from the server response or inferring from extension
          let contentType = fetchedContentType;

          // If content type is generic, try to infer from file extension
          if (contentType === 'application/octet-stream') {
            const fileExtension = originalFilename.split('.').pop()?.toLowerCase();
            if (fileExtension) {
              if (['pdf'].includes(fileExtension)) {
                contentType = 'application/pdf';
              } else if (['txt', 'text'].includes(fileExtension)) {
                contentType = 'text/plain';
              } else if (['md', 'markdown'].includes(fileExtension)) {
                contentType = 'text/markdown';
              } else if (['doc', 'docx'].includes(fileExtension)) {
                contentType = 'application/msword';
              } else if (['html', 'htm'].includes(fileExtension)) {
                contentType = 'text/html';
              } else if (['json'].includes(fileExtension)) {
                contentType = 'application/json';
              } else if (['xml'].includes(fileExtension)) {
                contentType = 'application/xml';
              }
            }
          }

          // Construct AddKnowledgeOptions with the fetched content
          const addKnowledgeOpts: import('./types.ts').AddKnowledgeOptions = {
            agentId: agentId, // Pass the agent ID from frontend
            clientDocumentId: '' as UUID, // This will be ignored by the service
            contentType: contentType,
            originalFilename: originalFilename,
            content: content, // Use the base64 encoded content from the URL
            worldId: agentId,
            roomId: agentId,
            entityId: agentId,
            // Store the normalized URL in metadata
            metadata: {
              url: normalizedUrl,
            },
          };

          logger.debug(
            `[Document Processor] 📄 Processing knowledge from URL: ${originalFilename} (type: ${contentType})`
          );
          const result = await service.addKnowledge(addKnowledgeOpts);

          return {
            id: result.clientDocumentId, // Use the content-based ID returned by the service
            fileUrl: fileUrl,
            filename: originalFilename,
            message: 'Knowledge created successfully',
            createdAt: Date.now(),
            fragmentCount: result.fragmentCount,
            status: 'success',
          };
        } catch (urlError: any) {
          logger.error(`[Document Processor] ❌ Error processing URL ${fileUrl}:`, urlError);
          return {
            fileUrl: fileUrl,
            status: 'error_processing',
            error: urlError.message,
          };
        }
      });

      const results = await Promise.all(processingPromises);
      sendSuccess(res, results);
    }
  } catch (error: any) {
    logger.error({ error }, '[Document Processor] ❌ Error processing knowledge');
    if (hasUploadedFiles) {
      cleanupFiles(req.files as MulterFile[]);
    }
    sendError(res, 500, 'PROCESSING_ERROR', 'Failed to process knowledge', error.message);
  }
}

async function getKnowledgeDocumentsHandler(req: any, res: any, runtime: IAgentRuntime) {
  const service = runtime.getService<KnowledgeService>(KnowledgeService.serviceType);
  if (!service) {
    return sendError(
      res,
      500,
      'SERVICE_NOT_FOUND',
      'KnowledgeService not found for getKnowledgeDocumentsHandler'
    );
  }

  try {
    const limit = req.query.limit ? Number.parseInt(req.query.limit as string, 10) : 10000;
    const before = req.query.before ? Number.parseInt(req.query.before as string, 10) : Date.now();
    const includeEmbedding = req.query.includeEmbedding === 'true';
    const agentId = req.query.agentId as UUID | undefined;

    // Retrieve fileUrls if they are provided in the request
    const fileUrls = req.query.fileUrls
      ? typeof req.query.fileUrls === 'string' && req.query.fileUrls.includes(',')
        ? req.query.fileUrls.split(',')
        : [req.query.fileUrls]
      : null;

    const memories = await service.getMemories({
      tableName: 'documents',
      count: limit,
      end: before,
    });

    // Filter documents by URL if fileUrls is provided
    let filteredMemories = memories;
    if (fileUrls && fileUrls.length > 0) {
      // Normalize the URLs for comparison
      const normalizedRequestUrls = fileUrls.map((url: string) => normalizeS3Url(url));

      // Create IDs based on normalized URLs for comparison
      const urlBasedIds = normalizedRequestUrls.map((url: string) =>
        createUniqueUuid(runtime, url)
      );

      filteredMemories = memories.filter(
        (memory) =>
          urlBasedIds.includes(memory.id) || // If the ID corresponds directly
          // Or if the URL is stored in the metadata (check if it exists)
          (memory.metadata &&
            'url' in memory.metadata &&
            typeof memory.metadata.url === 'string' &&
            normalizedRequestUrls.includes(normalizeS3Url(memory.metadata.url)))
      );

      logger.debug(
        `[Document Processor] 🔍 Filtered documents by URLs: ${fileUrls.length} URLs, found ${filteredMemories.length} matching documents`
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
      urlFiltered: fileUrls ? true : false,
      totalFound: cleanMemories.length,
      totalRequested: fileUrls ? fileUrls.length : 0,
    });
  } catch (error: any) {
    logger.error({ error }, '[Document Processor] ❌ Error retrieving documents');
    sendError(res, 500, 'RETRIEVAL_ERROR', 'Failed to retrieve documents', error.message);
  }
}

async function deleteKnowledgeDocumentHandler(req: any, res: any, runtime: IAgentRuntime) {
  logger.debug(`[Document Processor] 🗑️ DELETE request for document: ${req.params.knowledgeId}`);

  const service = runtime.getService<KnowledgeService>(KnowledgeService.serviceType);
  if (!service) {
    return sendError(
      res,
      500,
      'SERVICE_NOT_FOUND',
      'KnowledgeService not found for deleteKnowledgeDocumentHandler'
    );
  }

  // Get the ID directly from the route parameters
  const knowledgeId = req.params.knowledgeId;

  if (!knowledgeId || knowledgeId.length < 36) {
    logger.error(`[Document Processor] ❌ Invalid knowledge ID format: ${knowledgeId}`);
    return sendError(res, 400, 'INVALID_ID', 'Invalid Knowledge ID format');
  }

  try {
    // Use type conversion with template string to ensure the typing is correct
    const typedKnowledgeId = knowledgeId as `${string}-${string}-${string}-${string}-${string}`;
    logger.debug(`[Document Processor] 🗑️ Deleting document: ${typedKnowledgeId}`);

    await service.deleteMemory(typedKnowledgeId);
    logger.info(`[Document Processor] ✅ Successfully deleted document: ${typedKnowledgeId}`);
    sendSuccess(res, null, 204);
  } catch (error: any) {
    logger.error({ error }, `[Document Processor] ❌ Error deleting document ${knowledgeId}`);
    sendError(res, 500, 'DELETE_ERROR', 'Failed to delete document', error.message);
  }
}

async function getKnowledgeByIdHandler(req: any, res: any, runtime: IAgentRuntime) {
  logger.debug(`[Document Processor] 🔍 GET request for document: ${req.params.knowledgeId}`);

  const service = runtime.getService<KnowledgeService>(KnowledgeService.serviceType);
  if (!service) {
    return sendError(
      res,
      500,
      'SERVICE_NOT_FOUND',
      'KnowledgeService not found for getKnowledgeByIdHandler'
    );
  }

  // Get the ID directly from the route parameters
  const knowledgeId = req.params.knowledgeId;

  if (!knowledgeId || knowledgeId.length < 36) {
    logger.error(`[Document Processor] ❌ Invalid knowledge ID format: ${knowledgeId}`);
    return sendError(res, 400, 'INVALID_ID', 'Invalid Knowledge ID format');
  }

  try {
    logger.debug(`[Document Processor] 🔍 Retrieving document: ${knowledgeId}`);
    const agentId = req.query.agentId as UUID | undefined;

    // Use the service methods instead of calling runtime directly
    // We can't use getMemoryById directly because it's not exposed by the service
    // So we'll use getMemories with a filter
    const memories = await service.getMemories({
      tableName: 'documents',
      count: 10000,
    });

    // Use type conversion with template string to ensure the typing is correct
    const typedKnowledgeId = knowledgeId as `${string}-${string}-${string}-${string}-${string}`;

    // Find the document with the corresponding ID
    const document = memories.find((memory) => memory.id === typedKnowledgeId);

    if (!document) {
      return sendError(res, 404, 'NOT_FOUND', `Knowledge with ID ${typedKnowledgeId} not found`);
    }

    // Filter the embedding if necessary
    const cleanDocument = {
      ...document,
      embedding: undefined,
    };

    sendSuccess(res, { document: cleanDocument });
  } catch (error: any) {
    logger.error({ error }, `[Document Processor] ❌ Error retrieving document ${knowledgeId}`);
    sendError(res, 500, 'RETRIEVAL_ERROR', 'Failed to retrieve document', error.message);
  }
}

// Handler for the panel itself - serves the actual HTML frontend
async function knowledgePanelHandler(req: any, res: any, runtime: IAgentRuntime) {
  const agentId = runtime.agentId; // Get from runtime context

  logger.debug(`[Document Processor] 🌐 Serving knowledge panel for agent ${agentId}`);

  // Extract the plugin API base path from the request path
  // Request path will be like: /api/agents/[uuid]/plugins/knowledge/display
  // We need: /api/agents/[uuid]/plugins/knowledge
  const requestPath = req.originalUrl || req.url || req.path;
  const pluginBasePath = requestPath.replace(/\/display.*$/, '');

  logger.debug(`[Document Processor] 🌐 Plugin base path: ${pluginBasePath}`);

  try {
    const currentDir = path.dirname(new URL(import.meta.url).pathname);
    // Serve the main index.html from Vite's build output
    const frontendPath = path.join(currentDir, '../dist/index.html');

    logger.debug(`[Document Processor] 🌐 Looking for frontend at: ${frontendPath}`);

    if (fs.existsSync(frontendPath)) {
      const html = await fs.promises.readFile(frontendPath, 'utf8');
      // Inject config into existing HTML with the correct API base path
      // Also fix relative asset paths to use absolute paths
      let injectedHtml = html.replace(
        '<head>',
        `<head>
          <script>
            window.ELIZA_CONFIG = {
              agentId: '${agentId}',
              apiBase: '${pluginBasePath}'
            };
          </script>`
      );

      // Fix relative asset paths to be absolute
      injectedHtml = injectedHtml.replace(/src="\.\/assets\//g, `src="${pluginBasePath}/assets/`);
      injectedHtml = injectedHtml.replace(/href="\.\/assets\//g, `href="${pluginBasePath}/assets/`);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(injectedHtml);
    } else {
      // Fallback: serve a basic HTML page that loads the JS bundle from the assets folder
      // Use manifest.json to get the correct asset filenames if it exists
      let cssFile = 'index.css';
      let jsFile = 'index.js';

      const manifestPath = path.join(currentDir, '../dist/manifest.json');
      if (fs.existsSync(manifestPath)) {
        try {
          const manifestContent = await fs.promises.readFile(manifestPath, 'utf8');
          const manifest = JSON.parse(manifestContent);

          // Look for the entry points in the manifest
          // Different Vite versions might structure the manifest differently
          for (const [key, value] of Object.entries(manifest)) {
            if (typeof value === 'object' && value !== null) {
              if (key.endsWith('.css') || (value as any).file?.endsWith('.css')) {
                cssFile = (value as any).file || key;
              }
              if (key.endsWith('.js') || (value as any).file?.endsWith('.js')) {
                jsFile = (value as any).file || key;
              }
            }
          }
        } catch (manifestError) {
          logger.error({ error: manifestError }, '[Document Processor] ❌ Error reading manifest');
          // Continue with default filenames if manifest can't be read
        }
      }

      logger.debug(`[Document Processor] 🌐 Using fallback with CSS: ${cssFile}, JS: ${jsFile}`);

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
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    }
  } catch (error: any) {
    logger.error({ error }, '[Document Processor] ❌ Error serving frontend');
    sendError(res, 500, 'FRONTEND_ERROR', 'Failed to load knowledge panel', error.message);
  }
}

// Generic handler to serve static assets from the dist/assets directory
async function frontendAssetHandler(req: any, res: any, runtime: IAgentRuntime) {
  try {
    // Use originalUrl or url first, fallback to path
    const fullPath = req.originalUrl || req.url || req.path;
    logger.debug(`[Document Processor] 🌐 Asset request: ${fullPath}`);
    const currentDir = path.dirname(new URL(import.meta.url).pathname);

    // The path will be like: /api/agents/X/plugins/knowledge/assets/file.js
    // We need to extract everything after '/assets/'
    const assetsMarker = '/assets/';
    const assetsStartIndex = fullPath.lastIndexOf(assetsMarker); // Use lastIndexOf to get the last occurrence

    let assetName = null;
    if (assetsStartIndex !== -1) {
      assetName = fullPath.substring(assetsStartIndex + assetsMarker.length);
      // Remove any query parameters if present
      const queryIndex = assetName.indexOf('?');
      if (queryIndex !== -1) {
        assetName = assetName.substring(0, queryIndex);
      }
    }

    if (!assetName || assetName.includes('..')) {
      // Basic sanitization
      return sendError(
        res,
        400,
        'BAD_REQUEST',
        `Invalid asset name: '${assetName}' from path ${fullPath}`
      );
    }

    const assetPath = path.join(currentDir, '../dist/assets', assetName);
    logger.debug(`[Document Processor] 🌐 Serving asset: ${assetPath}`);

    if (fs.existsSync(assetPath)) {
      const fileStream = fs.createReadStream(assetPath);
      let contentType = 'application/octet-stream'; // Default
      if (assetPath.endsWith('.js')) {
        contentType = 'application/javascript';
      } else if (assetPath.endsWith('.css')) {
        contentType = 'text/css';
      }
      res.writeHead(200, { 'Content-Type': contentType });
      fileStream.pipe(res);
    } else {
      sendError(res, 404, 'NOT_FOUND', `Asset not found: ${req.url}`);
    }
  } catch (error: any) {
    logger.error({ error }, `[Document Processor] ❌ Error serving asset ${req.url}`);
    sendError(res, 500, 'ASSET_ERROR', `Failed to load asset ${req.url}`, error.message);
  }
}

async function getKnowledgeChunksHandler(req: any, res: any, runtime: IAgentRuntime) {
  const service = runtime.getService<KnowledgeService>(KnowledgeService.serviceType);
  if (!service) {
    return sendError(res, 500, 'SERVICE_NOT_FOUND', 'KnowledgeService not found');
  }

  try {
    const documentId = req.query.documentId as string | undefined;
    const documentsOnly = req.query.documentsOnly === 'true';

    // Always get documents first
    const documents = await service.getMemories({
      tableName: 'documents',
      count: 10000, // High limit to get all documents
      end: Date.now(),
    });

    // If documentsOnly mode, return only documents
    if (documentsOnly) {
      sendSuccess(res, {
        chunks: documents,
        stats: {
          documents: documents.length,
          fragments: 0,
          mode: 'documents-only',
        },
      });
      return;
    }

    // If specific document requested, get ALL its fragments
    if (documentId) {
      // High limit to support documents with many fragments, but reduced from 100k to prevent memory issues
      const allFragments = await service.getMemories({
        tableName: 'knowledge',
        count: 50000, // Reduced from 100000 - still high enough for large documents
      });

      const documentFragments = allFragments.filter((fragment) => {
        const metadata = fragment.metadata as any;
        return metadata?.documentId === documentId;
      });

      // Return the specific document and its fragments
      const specificDocument = documents.find((d) => d.id === documentId);
      const results = specificDocument
        ? [specificDocument, ...documentFragments]
        : documentFragments;

      sendSuccess(res, {
        chunks: results,
        stats: {
          documents: specificDocument ? 1 : 0,
          fragments: documentFragments.length,
          mode: 'single-document',
          documentId,
        },
      });
      return;
    }

    // Default: return only documents
    sendSuccess(res, {
      chunks: documents,
      stats: {
        documents: documents.length,
        fragments: 0,
        mode: 'documents-only',
      },
    });
  } catch (error: any) {
    logger.error({ error }, '[Document Processor] ❌ Error retrieving chunks');
    sendError(res, 500, 'RETRIEVAL_ERROR', 'Failed to retrieve knowledge chunks', error.message);
  }
}

async function searchKnowledgeHandler(req: any, res: any, runtime: IAgentRuntime) {
  const service = runtime.getService<KnowledgeService>(KnowledgeService.serviceType);
  if (!service) {
    return sendError(res, 500, 'SERVICE_NOT_FOUND', 'KnowledgeService not found');
  }

  try {
    const searchText = req.query.q as string;

    // Parse threshold with NaN check
    const parsedThreshold = req.query.threshold
      ? Number.parseFloat(req.query.threshold as string)
      : NaN;
    let matchThreshold = Number.isNaN(parsedThreshold) ? 0.5 : parsedThreshold;

    // Clamp threshold between 0 and 1
    matchThreshold = Math.max(0, Math.min(1, matchThreshold));

    // Parse limit with NaN check
    const parsedLimit = req.query.limit ? Number.parseInt(req.query.limit as string, 10) : NaN;
    let limit = Number.isNaN(parsedLimit) ? 20 : parsedLimit;

    // Clamp limit between 1 and 100
    limit = Math.max(1, Math.min(100, limit));

    const agentId = (req.query.agentId as UUID) || runtime.agentId;

    if (!searchText || searchText.trim().length === 0) {
      return sendError(res, 400, 'INVALID_QUERY', 'Search query cannot be empty');
    }

    // Log if values were clamped
    if (req.query.threshold && (parsedThreshold < 0 || parsedThreshold > 1)) {
      logger.debug(
        `[Document Processor] 🔍 Threshold value ${parsedThreshold} was clamped to ${matchThreshold}`
      );
    }
    if (req.query.limit && (parsedLimit < 1 || parsedLimit > 100)) {
      logger.debug(`[Document Processor] 🔍 Limit value ${parsedLimit} was clamped to ${limit}`);
    }

    logger.debug(
      `[Document Processor] 🔍 Searching: "${searchText}" (threshold: ${matchThreshold}, limit: ${limit})`
    );

    // First get the embedding for the search text
    const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
      text: searchText,
    });

    // Use searchMemories directly for more control over the search
    const results = await runtime.searchMemories({
      tableName: 'knowledge',
      embedding,
      query: searchText,
      count: limit,
      match_threshold: matchThreshold,
      roomId: agentId,
    });

    // Enhance results with document information
    const enhancedResults = await Promise.all(
      results.map(async (fragment) => {
        let documentTitle = 'Unknown Document';
        let documentFilename = 'unknown';

        // Try to get the parent document information
        if (
          fragment.metadata &&
          typeof fragment.metadata === 'object' &&
          'documentId' in fragment.metadata
        ) {
          const documentId = fragment.metadata.documentId as UUID;
          try {
            const document = await runtime.getMemoryById(documentId);
            if (document && document.metadata) {
              documentTitle =
                (document.metadata as any).title ||
                (document.metadata as any).filename ||
                documentTitle;
              documentFilename = (document.metadata as any).filename || documentFilename;
            }
          } catch (e) {
            logger.debug(`Could not fetch document ${documentId} for fragment`);
          }
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

    logger.info(
      `[Document Processor] 🔍 Found ${enhancedResults.length} results for: "${searchText}"`
    );

    sendSuccess(res, {
      query: searchText,
      threshold: matchThreshold,
      results: enhancedResults,
      count: enhancedResults.length,
    });
  } catch (error: any) {
    logger.error({ error }, '[Document Processor] ❌ Error searching knowledge');
    sendError(res, 500, 'SEARCH_ERROR', 'Failed to search knowledge', error.message);
  }
}

// New Graph-specific handlers for ultra-lightweight rendering

async function getGraphNodesHandler(req: any, res: any, runtime: IAgentRuntime) {
  const service = runtime.getService<KnowledgeService>(KnowledgeService.serviceType);
  if (!service) {
    return sendError(res, 500, 'SERVICE_NOT_FOUND', 'KnowledgeService not found');
  }

  try {
    // Parse pagination parameters
    const parsedPage = req.query.page ? Number.parseInt(req.query.page as string, 10) : 1;
    const parsedLimit = req.query.limit ? Number.parseInt(req.query.limit as string, 10) : 20;
    const type = req.query.type as 'document' | 'fragment' | undefined;
    const agentId = (req.query.agentId as UUID) || runtime.agentId;

    const page = Number.isNaN(parsedPage) || parsedPage < 1 ? 1 : parsedPage;
    const limit = Number.isNaN(parsedLimit) || parsedLimit < 1 ? 20 : Math.min(parsedLimit, 50);
    const offset = (page - 1) * limit;

    logger.debug(
      `[Graph API] 📊 Fetching graph nodes: page=${page}, limit=${limit}, type=${type || 'all'}, agent=${agentId}`
    );

    // Get total count of documents for pagination metadata
    const totalDocuments = await service.countMemories({
      tableName: 'documents',
      roomId: agentId,
      unique: false, // Count all documents, not just unique ones
    });

    // Calculate pagination
    const totalPages = Math.ceil(totalDocuments / limit);
    const hasMore = page < totalPages;

    // Fetch only the required page of documents using database-level pagination
    const paginatedDocuments = await service.getMemories({
      tableName: 'documents',
      roomId: agentId,
      count: limit,
      offset: offset,
    });

    // Build lightweight nodes
    const nodes: Array<{ id: UUID; type: 'document' | 'fragment' }> = [];
    const links: Array<{ source: UUID; target: UUID }> = [];

    // Add document nodes (filter out any without IDs)
    paginatedDocuments.forEach((doc) => {
      if (!doc.id) {
        logger.warn(`[Graph API] ⚠️  Skipping document without ID`);
        return;
      }
      nodes.push({ id: doc.id, type: 'document' });
    });

    // Always include fragments for the paginated documents (unless specifically requesting documents only)
    if (type !== 'document') {
      // Get all fragments for the paginated documents
      // High limit to support documents with many fragments, but reduced from 100k to prevent memory issues
      const allFragments = await service.getMemories({
        tableName: 'knowledge',
        roomId: agentId,
        count: 50000, // Reduced from 100000 - still high enough for large documents
      });

      logger.debug(`[Graph API] 📊 Total fragments found: ${allFragments.length}`);

      // Debug: Log the first few fragment metadata to understand structure
      if (allFragments.length > 0) {
        logger.debug(
          `[Graph API] 📊 Sample fragment metadata: ${JSON.stringify(
            allFragments.slice(0, 3).map((f) => ({
              id: f.id,
              metadata: f.metadata,
            }))
          )}`
        );
      }

      // For each document, find its fragments and add them
      paginatedDocuments.forEach((doc) => {
        // Skip documents without IDs
        if (!doc.id) {
          return;
        }

        const docFragments = allFragments.filter((fragment) => {
          const metadata = fragment.metadata as any;
          // Check both documentId match and that it's a fragment type (case-insensitive)
          // Safely handle type checking with string validation
          const typeString = typeof metadata?.type === 'string' ? metadata.type : null;
          const isFragment =
            (typeString && typeString.toLowerCase() === 'fragment') ||
            metadata?.type === MemoryType.FRAGMENT ||
            // If no type but has documentId, assume it's a fragment
            (!metadata?.type && metadata?.documentId);
          return metadata?.documentId === doc.id && isFragment;
        });

        if (docFragments.length > 0) {
          logger.debug(`[Graph API] 📊 Document ${doc.id} has ${docFragments.length} fragments`);
        }

        // Add fragment nodes and links (filter out any without IDs)
        docFragments.forEach((frag) => {
          // TypeScript guard: doc.id is already checked above, but reassign for type safety
          const docId = doc.id;
          if (!frag.id || !docId) {
            logger.warn(
              `[Graph API] ⚠️  Skipping fragment without ID for document ${docId || 'unknown'}`
            );
            return;
          }
          nodes.push({ id: frag.id, type: 'fragment' });
          links.push({ source: docId, target: frag.id });
        });
      });

      logger.info(
        `[Graph API] 📊 Final graph: ${nodes.length} nodes (${paginatedDocuments.length} documents), ${links.length} links`
      );
    }

    // Return the graph data with nodes and links
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
  } catch (error: any) {
    logger.error('[Graph API] ❌ Error fetching graph nodes:', error);
    sendError(res, 500, 'GRAPH_ERROR', 'Failed to fetch graph nodes', error.message);
  }
}

async function getGraphNodeDetailsHandler(req: any, res: any, runtime: IAgentRuntime) {
  const service = runtime.getService<KnowledgeService>(KnowledgeService.serviceType);
  if (!service) {
    return sendError(res, 500, 'SERVICE_NOT_FOUND', 'KnowledgeService not found');
  }

  const nodeId = req.params.nodeId as UUID;
  const agentId = (req.query.agentId as UUID) || runtime.agentId;

  if (!nodeId || nodeId.length < 36) {
    return sendError(res, 400, 'INVALID_ID', 'Invalid node ID format');
  }

  try {
    logger.info(`[Graph API] 📊 Fetching node details for: ${nodeId}, agent: ${agentId}`);

    // Try to find in documents first - don't filter by roomId initially to see if node exists at all
    const allDocuments = await service.getMemories({
      tableName: 'documents',
      count: 10000,
    });

    logger.debug(`[Graph API] 📊 Total documents in DB: ${allDocuments.length}`);

    // First try exact match with roomId filter
    let document = allDocuments.find((doc) => doc.id === nodeId && doc.roomId === agentId);

    // If not found with roomId filter, try without filter (for backward compatibility)
    if (!document) {
      logger.debug(`[Graph API] 📊 Document not found with roomId filter, trying without filter`);
      document = allDocuments.find((doc) => doc.id === nodeId);
      if (document) {
        logger.warn(
          `[Graph API] ⚠️ Document ${nodeId} found but has different roomId: ${document.roomId} vs ${agentId}`
        );
      }
    }

    if (document) {
      logger.info(`[Graph API] ✅ Found document: ${nodeId}`);
      // Return document details without embedding
      sendSuccess(res, {
        id: document.id,
        type: 'document',
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

    // If not found in documents, try fragments
    logger.debug(`[Graph API] 📊 Document not found, searching in fragments`);
    // High limit to support documents with many fragments, but reduced from 100k to prevent memory issues
    const allFragments = await service.getMemories({
      tableName: 'knowledge',
      count: 50000, // Reduced from 100000 - still high enough for large documents
    });

    logger.debug(`[Graph API] 📊 Total fragments in DB: ${allFragments.length}`);

    // First try exact match with roomId filter
    let fragment = allFragments.find((frag) => frag.id === nodeId && frag.roomId === agentId);

    // If not found with roomId filter, try without filter
    if (!fragment) {
      logger.debug(`[Graph API] 📊 Fragment not found with roomId filter, trying without filter`);
      fragment = allFragments.find((frag) => frag.id === nodeId);
      if (fragment) {
        logger.warn(
          `[Graph API] ⚠️ Fragment ${nodeId} found but has different roomId: ${fragment.roomId} vs ${agentId}`
        );
      }
    }

    if (fragment) {
      logger.info(`[Graph API] ✅ Found fragment: ${nodeId}`);
      sendSuccess(res, {
        id: fragment.id,
        type: 'fragment',
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

    logger.error(`[Graph API] ❌ Node ${nodeId} not found in documents or fragments`);
    sendError(res, 404, 'NOT_FOUND', `Node with ID ${nodeId} not found`);
  } catch (error: any) {
    logger.error(`[Graph API] ❌ Error fetching node details for ${nodeId}:`, error);
    sendError(res, 500, 'GRAPH_ERROR', 'Failed to fetch node details', error.message);
  }
}

async function expandDocumentGraphHandler(req: any, res: any, runtime: IAgentRuntime) {
  const service = runtime.getService<KnowledgeService>(KnowledgeService.serviceType);
  if (!service) {
    return sendError(res, 500, 'SERVICE_NOT_FOUND', 'KnowledgeService not found');
  }

  const documentId = req.params.documentId as UUID;
  const agentId = (req.query.agentId as UUID) || runtime.agentId;

  if (!documentId || documentId.length < 36) {
    return sendError(res, 400, 'INVALID_ID', 'Invalid document ID format');
  }

  try {
    logger.debug(`[Graph API] 📊 Expanding document: ${documentId}, agent: ${agentId}`);

    // Get all fragments for this document
    // High limit to support documents with many fragments, but reduced from 100k to prevent memory issues
    const allFragments = await service.getMemories({
      tableName: 'knowledge',
      roomId: agentId, // Filter by agent
      count: 50000, // Reduced from 100000 - still high enough for large documents
    });

    logger.debug(`[Graph API] 📊 Total fragments in knowledge table: ${allFragments.length}`);

    // Log a sample fragment to see its structure (only in development/debug mode)
    if (allFragments.length > 0 && process.env.NODE_ENV !== 'production') {
      logger.debug(
        `[Graph API] 📊 Sample fragment metadata: ${JSON.stringify(allFragments[0].metadata)}`
      );

      // Log all unique metadata types found
      const uniqueTypes = new Set(allFragments.map((f) => (f.metadata as any)?.type));
      logger.debug(
        `[Graph API] 📊 Unique metadata types found in knowledge table: ${JSON.stringify(Array.from(uniqueTypes))}`
      );

      // Log metadata of all fragments for this specific document
      const relevantFragments = allFragments.filter((fragment) => {
        const metadata = fragment.metadata as any;
        const hasDocumentId = metadata?.documentId === documentId;
        if (hasDocumentId) {
          logger.debug(
            `[Graph API] 📊 Fragment ${fragment.id} metadata: ${JSON.stringify(metadata)}`
          );
        }
        return hasDocumentId;
      });

      logger.debug(
        `[Graph API] 📊 Fragments with matching documentId: ${relevantFragments.length}`
      );
    }

    const documentFragments = allFragments.filter((fragment) => {
      const metadata = fragment.metadata as any;
      // Check both documentId match and that it's a fragment type (case-insensitive)
      // Safely handle type checking with string validation
      const typeString = typeof metadata?.type === 'string' ? metadata.type : null;
      const isFragment =
        (typeString && typeString.toLowerCase() === 'fragment') ||
        metadata?.type === MemoryType.FRAGMENT ||
        // If no type but has documentId, assume it's a fragment
        (!metadata?.type && metadata?.documentId);
      return metadata?.documentId === documentId && isFragment;
    });

    // Build fragment nodes and links (filter out any without IDs)
    const nodes = documentFragments
      .filter((frag) => frag.id !== undefined)
      .map((frag) => ({
        id: frag.id as UUID,
        type: 'fragment' as const,
      }));

    const links = documentFragments
      .filter((frag) => frag.id !== undefined)
      .map((frag) => ({
        source: documentId,
        target: frag.id as UUID,
      }));

    logger.info(`[Graph API] 📊 Found ${nodes.length} fragments for document ${documentId}`);

    sendSuccess(res, {
      documentId,
      nodes,
      links,
      fragmentCount: nodes.length,
    });
  } catch (error: any) {
    logger.error(`[Graph API] ❌ Error expanding document ${documentId}:`, error);
    sendError(res, 500, 'GRAPH_ERROR', 'Failed to expand document', error.message);
  }
}

// Wrapper handler that applies multer middleware before calling the upload handler
async function uploadKnowledgeWithMulter(req: any, res: any, runtime: IAgentRuntime) {
  const upload = createUploadMiddleware(runtime);
  const uploadArray = upload.array(
    'files',
    parseInt(runtime.getSetting('KNOWLEDGE_MAX_FILES') || '10')
  );

  // Apply multer middleware manually
  uploadArray(req, res, (err: any) => {
    if (err) {
      logger.error({ error: err }, '[Document Processor] ❌ File upload error');
      return sendError(res, 400, 'UPLOAD_ERROR', err.message);
    }
    // If multer succeeded, call the actual handler
    uploadKnowledgeHandler(req, res, runtime);
  });
}

export const knowledgeRoutes: Route[] = [
  {
    type: 'GET',
    name: 'Knowledge',
    path: '/display',
    handler: knowledgePanelHandler,
    public: true,
  },
  {
    type: 'GET',
    path: '/assets/*',
    handler: frontendAssetHandler,
  },
  {
    type: 'POST',
    path: '/documents',
    handler: uploadKnowledgeWithMulter,
  },
  {
    type: 'GET',
    path: '/documents',
    handler: getKnowledgeDocumentsHandler,
  },
  {
    type: 'GET',
    path: '/documents/:knowledgeId',
    handler: getKnowledgeByIdHandler,
  },
  {
    type: 'DELETE',
    path: '/documents/:knowledgeId',
    handler: deleteKnowledgeDocumentHandler,
  },
  {
    type: 'GET',
    path: '/knowledges',
    handler: getKnowledgeChunksHandler,
  },
  {
    type: 'GET',
    path: '/search',
    handler: searchKnowledgeHandler,
  },
  // New graph routes
  {
    type: 'GET',
    path: '/graph/nodes',
    handler: getGraphNodesHandler,
  },
  {
    type: 'GET',
    path: '/graph/node/:nodeId',
    handler: getGraphNodeDetailsHandler,
  },
  {
    type: 'GET',
    path: '/graph/expand/:documentId',
    handler: expandDocumentGraphHandler,
  },
];

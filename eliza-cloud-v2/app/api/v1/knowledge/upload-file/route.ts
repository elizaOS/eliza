import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { requireAuthOrApiKey } from "@/lib/auth";
import { getKnowledgeService } from "@/lib/eliza/knowledge-service";
import type { UUID } from "@elizaos/core";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";
import { userContextService } from "@/lib/eliza/user-context";
import { RuntimeFactory, invalidateRuntime } from "@/lib/eliza/runtime-factory";
import { AgentMode } from "@/lib/eliza/agent-mode-types";
import { userCharactersRepository } from "@/db/repositories/characters";
import {
  KNOWLEDGE_CONSTANTS,
  ALLOWED_EXTENSIONS,
  ALLOWED_CONTENT_TYPES,
  isValidFilename,
} from "@/lib/constants/knowledge";

export const maxDuration = 300; // 5 minutes for large file processing

function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  return lastDot !== -1 ? filename.slice(lastDot).toLowerCase() : "";
}

interface UploadResult {
  id: string;
  filename: string;
  type: string;
  size: number;
  uploadedAt: number;
  status: string;
  fragmentCount?: number;
  error?: string;
}

/**
 * POST /api/v1/knowledge/upload-file
 * Uploads one or more files to the knowledge base.
 * Processes files and creates knowledge fragments for semantic search.
 *
 * @param req - Form data with files array and optional characterId.
 * @returns Upload results for each file including fragment counts.
 */
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB - Next.js default limit

async function handlePOST(req: NextRequest) {
  try {
    const authResult = await requireAuthOrApiKey(req);
    const { user } = authResult;

    // Parse form data with proper error handling
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const lowerMessage = errorMessage.toLowerCase();

      // Check for specific body size limit errors (413 Payload Too Large)
      const isSizeLimitError =
        lowerMessage.includes("request entity too large") ||
        lowerMessage.includes("body exceeded") ||
        lowerMessage.includes("payload too large") ||
        lowerMessage.includes("body limit") ||
        lowerMessage.includes("file too large") ||
        lowerMessage.includes("size limit");

      if (isSizeLimitError) {
        logger.warn("[KnowledgeUpload] Request body too large", {
          error: errorMessage,
        });
        return NextResponse.json(
          {
            error: "Upload too large",
            details: `Total upload size must be under ${MAX_BODY_SIZE / (1024 * 1024)}MB. Please upload smaller files or fewer files at once.`,
          },
          { status: 413 },
        );
      }

      // Check for malformed request errors (400 Bad Request)
      const isMalformedRequest =
        lowerMessage.includes("boundary") ||
        lowerMessage.includes("unexpected end") ||
        lowerMessage.includes("malformed") ||
        lowerMessage.includes("invalid multipart") ||
        lowerMessage.includes("missing content-type");

      if (isMalformedRequest) {
        logger.warn("[KnowledgeUpload] Malformed form data request", {
          error: errorMessage,
        });
        return NextResponse.json(
          {
            error: "Malformed request",
            details:
              "The upload request was malformed. Please ensure the request uses valid multipart/form-data encoding.",
          },
          { status: 400 },
        );
      }

      throw error;
    }

    const files = formData.getAll("files") as File[];
    const characterId = formData.get("characterId") as string | null;

    // Validate files are provided first (before expensive operations)
    if (!files || files.length === 0) {
      return NextResponse.json(
        {
          error: "No files provided",
          details: "Please upload at least one file",
        },
        { status: 400 },
      );
    }

    // Validate file count
    if (files.length > KNOWLEDGE_CONSTANTS.MAX_FILES_PER_REQUEST) {
      return NextResponse.json(
        {
          error: "Too many files",
          details: `Maximum ${KNOWLEDGE_CONSTANTS.MAX_FILES_PER_REQUEST} files per request`,
        },
        { status: 400 },
      );
    }

    // Validate total batch size
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    if (totalSize > KNOWLEDGE_CONSTANTS.MAX_BATCH_SIZE) {
      return NextResponse.json(
        {
          error: "Batch too large",
          details: `Total upload size must be under ${KNOWLEDGE_CONSTANTS.MAX_BATCH_SIZE / (1024 * 1024)}MB`,
        },
        { status: 400 },
      );
    }

    // Validate individual files (size, type, filename)
    for (const file of files) {
      // Validate filename
      if (!isValidFilename(file.name)) {
        return NextResponse.json(
          {
            error: "Invalid filename",
            details: `${file.name} contains invalid characters. Filenames cannot contain / \\ : * ? " < > | or ..`,
          },
          { status: 400 },
        );
      }

      // Validate file size
      if (file.size > KNOWLEDGE_CONSTANTS.MAX_FILE_SIZE) {
        return NextResponse.json(
          {
            error: "File too large",
            details: `${file.name} exceeds maximum file size of ${KNOWLEDGE_CONSTANTS.MAX_FILE_SIZE / (1024 * 1024)}MB`,
          },
          { status: 400 },
        );
      }

      // Validate file extension
      const ext = getFileExtension(file.name);
      if (
        !ext ||
        !ALLOWED_EXTENSIONS.includes(ext as (typeof ALLOWED_EXTENSIONS)[number])
      ) {
        return NextResponse.json(
          {
            error: "Unsupported file type",
            details: `${file.name}: Extension ${ext || "(none)"} is not supported. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}`,
          },
          { status: 400 },
        );
      }

      // Validate content type (allow octet-stream for text files like md, txt)
      const contentType = file.type || "application/octet-stream";
      if (
        !ALLOWED_CONTENT_TYPES.includes(
          contentType as (typeof ALLOWED_CONTENT_TYPES)[number],
        )
      ) {
        return NextResponse.json(
          {
            error: "Unsupported content type",
            details: `${file.name}: Content type ${contentType} is not supported`,
          },
          { status: 400 },
        );
      }
    }

    // CRITICAL: Verify character ownership if characterId is provided
    // This prevents users from uploading knowledge to characters they don't own
    if (characterId) {
      const character = await userCharactersRepository.findById(characterId);
      if (!character || character.organization_id !== user.organization_id) {
        return NextResponse.json(
          { error: "Character not found or unauthorized" },
          { status: 403 },
        );
      }
    }

    // Build user context with ASSISTANT mode (required for knowledge plugin)
    const userContext = await userContextService.buildContext({
      user,
      apiKey: authResult.apiKey,
      isAnonymous: false,
      agentMode: AgentMode.ASSISTANT,
    });

    if (characterId) {
      userContext.characterId = characterId;
    }

    // Create runtime with user-specific context (includes API key for embeddings)
    const runtimeFactory = RuntimeFactory.getInstance();
    const runtime = await runtimeFactory.createRuntimeForUser(userContext);

    const knowledgeService = await getKnowledgeService(runtime);

    if (!knowledgeService) {
      return NextResponse.json(
        { error: "Knowledge service not available" },
        { status: 503 },
      );
    }

    // Process all files
    const results: UploadResult[] = await Promise.all(
      files.map(async (file) => {
        try {
          // Read file content and convert to base64
          const arrayBuffer = await file.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          const base64Content = buffer.toString("base64");
          const contentType = file.type || "application/octet-stream";

          // Add knowledge document (matching plugin-knowledge pattern exactly)
          // Use runtime.agentId for roomId, worldId, entityId (same as plugin)
          const result = await knowledgeService.addKnowledge({
            agentId: runtime.agentId,
            clientDocumentId: "" as UUID, // Auto-generated by service
            content: base64Content,
            contentType,
            originalFilename: file.name,
            worldId: runtime.agentId,
            roomId: runtime.agentId,
            entityId: runtime.agentId,
            metadata: {
              uploadedBy: user.id,
              uploadedAt: Date.now(),
              organizationId: user.organization_id,
              fileSize: file.size,
              filename: file.name,
              fileName: file.name, // camelCase for getDocumentName() compatibility
            },
          });

          return {
            id: result.clientDocumentId,
            filename: file.name,
            type: contentType,
            size: file.size,
            uploadedAt: Date.now(),
            fragmentCount: result.fragmentCount,
            status: "success",
          };
        } catch (fileError) {
          logger.error(`Error processing file ${file.name}:`, fileError);
          return {
            id: "",
            filename: file.name,
            type: file.type,
            size: file.size,
            uploadedAt: Date.now(),
            status: "error_processing",
            error:
              fileError instanceof Error ? fileError.message : "Unknown error",
          };
        }
      }),
    );

    // Check if any files failed
    const successCount = results.filter((r) => r.status === "success").length;
    const failedCount = results.length - successCount;

    // CRITICAL: Invalidate runtime cache after knowledge upload
    // This ensures the next request creates a fresh runtime with updated knowledge
    if (successCount > 0) {
      const agentIdStr = runtime.agentId as string;
      await invalidateRuntime(agentIdStr).catch((e) => {
        logger.warn(`[Knowledge Upload] Failed to invalidate runtime: ${e}`);
      });
      logger.info(
        `[Knowledge Upload] Invalidated runtime cache for agent ${agentIdStr} after uploading ${successCount} file(s)`,
      );
    }

    return NextResponse.json({
      success: successCount > 0,
      data: results,
      message:
        failedCount === 0
          ? `Successfully uploaded ${successCount} file(s)`
          : `Uploaded ${successCount} file(s), ${failedCount} failed`,
      successCount,
      failedCount,
      totalCount: results.length,
    });
  } catch (error) {
    logger.error("Error uploading files to knowledge:", error);
    return NextResponse.json(
      {
        error: "Failed to upload files",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

export const POST = withRateLimit(handlePOST, RateLimitPresets.STANDARD);

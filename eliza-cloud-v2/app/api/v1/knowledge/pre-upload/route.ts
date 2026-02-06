import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKey } from "@/lib/auth";
import { logger } from "@/lib/utils/logger";
import {
  extractUserIdFromBlobPath,
  trackOrphanedBlobBatch,
  type OrphanedBlobInfo,
} from "@/lib/utils/knowledge";
import { uploadToBlob, deleteBlob, isValidBlobUrl } from "@/lib/blob";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";
import type { PreUploadedFile } from "@/lib/types/knowledge";
import {
  KNOWLEDGE_CONSTANTS,
  ALLOWED_EXTENSIONS,
  ALLOWED_CONTENT_TYPES,
  TEXT_EXTENSIONS_FOR_OCTET_STREAM,
  isValidFilename,
} from "@/lib/constants/knowledge";
import { fileTypeFromBuffer } from "file-type";

const MAX_FILENAME_LENGTH = 255;

function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  return lastDot !== -1 ? filename.slice(lastDot).toLowerCase() : "";
}

/**
 * POST /api/v1/knowledge/pre-upload
 * Pre-uploads files to Vercel Blob storage without processing through knowledge service.
 * Used for uploading files before character creation.
 * Files are stored temporarily and will be processed when the character is saved.
 *
 * @param req - Form data with files array.
 * @returns Pre-uploaded file metadata including blob URLs.
 */

async function handlePOST(req: NextRequest) {
  const authResult = await requireAuthOrApiKey(req);
  const { user } = authResult;

  const formData = await req.formData();

  const files = formData.getAll("files") as File[];

  if (!files || files.length === 0) {
    return NextResponse.json(
      {
        error: "No files provided",
        details: "Please upload at least one file",
      },
      { status: 400 },
    );
  }

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

  // Validate files before upload
  for (const file of files) {
    // Validate filename length
    if (file.name.length > MAX_FILENAME_LENGTH) {
      return NextResponse.json(
        {
          error: "Filename too long",
          details: `${file.name.substring(0, 50)}... exceeds ${MAX_FILENAME_LENGTH} character limit`,
        },
        { status: 400 },
      );
    }

    // Reject filenames with path-unsafe characters to prevent path traversal
    if (!isValidFilename(file.name)) {
      return NextResponse.json(
        {
          error: "Invalid filename",
          details: `${file.name} contains invalid characters. Filenames cannot contain / \\ : * ? " < > | or ..`,
        },
        { status: 400 },
      );
    }

    if (file.size > KNOWLEDGE_CONSTANTS.MAX_FILE_SIZE) {
      return NextResponse.json(
        {
          error: "File too large",
          details: `${file.name} exceeds ${KNOWLEDGE_CONSTANTS.MAX_FILE_SIZE / 1024 / 1024}MB limit`,
        },
        { status: 400 },
      );
    }

    const ext = getFileExtension(file.name);
    if (
      !ALLOWED_EXTENSIONS.includes(ext as (typeof ALLOWED_EXTENSIONS)[number])
    ) {
      return NextResponse.json(
        {
          error: "Invalid file type",
          details: `${file.name} has unsupported extension. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}`,
        },
        { status: 400 },
      );
    }

    const contentType = file.type || "application/octet-stream";
    if (
      !ALLOWED_CONTENT_TYPES.includes(
        contentType as (typeof ALLOWED_CONTENT_TYPES)[number],
      )
    ) {
      return NextResponse.json(
        {
          error: "Invalid content type",
          details: `${file.name} has unsupported content type: ${contentType}`,
        },
        { status: 400 },
      );
    }

    // Stricter validation for application/octet-stream
    // Only allow octet-stream for text-based file formats that browsers may misidentify
    if (contentType === "application/octet-stream") {
      if (
        !TEXT_EXTENSIONS_FOR_OCTET_STREAM.includes(
          ext as (typeof TEXT_EXTENSIONS_FOR_OCTET_STREAM)[number],
        )
      ) {
        return NextResponse.json(
          {
            error: "Invalid content type",
            details: `${file.name}: Binary files (${ext}) must have explicit content type, not application/octet-stream`,
          },
          { status: 400 },
        );
      }
    }
  }

  const results: PreUploadedFile[] = [];
  const errors: Array<{ filename: string; error: string }> = [];

  for (const file of files) {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Content inspection for application/octet-stream files
      // Verifies actual file content matches the claimed extension
      const declaredContentType = file.type || "application/octet-stream";
      let finalContentType = declaredContentType;

      if (declaredContentType === "application/octet-stream") {
        const ext = getFileExtension(file.name);
        const detectedType = await fileTypeFromBuffer(buffer);

        if (detectedType) {
          // Binary file detected - verify it matches expected type for extension
          // This prevents uploading malicious binaries with text extensions
          const isTextExtension = TEXT_EXTENSIONS_FOR_OCTET_STREAM.includes(
            ext as (typeof TEXT_EXTENSIONS_FOR_OCTET_STREAM)[number],
          );

          if (isTextExtension) {
            // SECURITY: Log content mismatch before rejection for audit purposes
            logger.warn(
              "[PreUpload] Content mismatch detected - rejecting file",
              {
                filename: file.name,
                declaredExtension: ext,
                detectedMimeType: detectedType.mime,
                userId: user.id,
                reason: "binary_file_with_text_extension",
              },
            );
            // Expected text file but detected as binary - reject
            throw new Error(
              `Content mismatch: ${file.name} appears to be a binary file (${detectedType.mime}) but has a text extension`,
            );
          }

          // Use detected content type for binary files
          finalContentType = detectedType.mime;

          // Verify detected type is allowed
          if (
            !ALLOWED_CONTENT_TYPES.includes(
              finalContentType as (typeof ALLOWED_CONTENT_TYPES)[number],
            )
          ) {
            throw new Error(
              `Detected content type ${finalContentType} is not allowed for ${file.name}`,
            );
          }
        }
        // If no type detected and it's a text extension, keep as octet-stream (text files)
      }

      // Upload to Vercel Blob
      const blobResult = await uploadToBlob(buffer, {
        filename: file.name,
        contentType: finalContentType,
        folder: "knowledge-pre-upload",
        userId: user.id,
      });

      results.push({
        id: crypto.randomUUID(),
        filename: file.name,
        blobUrl: blobResult.url,
        contentType: blobResult.contentType,
        size: blobResult.size,
        uploadedAt: Date.now(),
      });

      logger.info("[PreUpload] File uploaded to blob", {
        filename: file.name,
        blobUrl: blobResult.url,
        size: blobResult.size,
        detectedContentType:
          finalContentType !== declaredContentType
            ? finalContentType
            : undefined,
      });
    } catch (error) {
      logger.error(`[PreUpload] Error uploading file ${file.name}:`, error);
      errors.push({
        filename: file.name,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  // Cleanup: If some files failed, delete successfully uploaded blobs to avoid orphans
  if (errors.length > 0 && results.length > 0) {
    logger.info(
      "[PreUpload] Partial failure - cleaning up successful uploads",
      {
        successCount: results.length,
        errorCount: errors.length,
      },
    );

    // Parallel cleanup for better performance
    const cleanupResults = await Promise.allSettled(
      results.map((uploaded) => deleteBlob(uploaded.blobUrl)),
    );

    const orphanedBlobs: OrphanedBlobInfo[] = [];
    cleanupResults.forEach((result, index) => {
      if (result.status === "fulfilled") {
        logger.info("[PreUpload] Cleaned up blob", {
          blobUrl: results[index].blobUrl,
        });
      } else {
        // Track orphaned blob for later cleanup
        orphanedBlobs.push({
          blobUrl: results[index].blobUrl,
          userId: user.id,
          reason: "partial_upload_failure",
          originalError:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
          timestamp: Date.now(),
        });
      }
    });

    // Track orphaned blobs for monitoring and future cleanup
    if (orphanedBlobs.length > 0) {
      trackOrphanedBlobBatch(orphanedBlobs, {
        operation: "pre-upload-rollback",
        userId: user.id,
      });
    }

    return NextResponse.json(
      {
        error: "Some files failed to upload - batch rolled back",
        details: errors,
        orphanedBlobs:
          orphanedBlobs.length > 0
            ? orphanedBlobs.map((b) => b.blobUrl)
            : undefined,
      },
      { status: 400 },
    );
  }

  if (results.length === 0) {
    return NextResponse.json(
      {
        error: "All file uploads failed",
        details: errors,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    success: true,
    files: results,
    successCount: results.length,
    failureCount: errors.length,
    errors: errors.length > 0 ? errors : undefined,
  });
}

/**
 * DELETE /api/v1/knowledge/pre-upload
 * Deletes a pre-uploaded file from Vercel Blob storage.
 * Used when users remove files from the pre-upload list before saving a character.
 * Verifies that the blob belongs to the authenticated user before deletion.
 *
 * @param req - JSON body with blobUrl to delete.
 * @returns Success or error response.
 */
async function handleDELETE(req: NextRequest) {
  const authResult = await requireAuthOrApiKey(req);
  const { user } = authResult;

  const body = await req.json();
  const { blobUrl } = body as { blobUrl: string };

  if (!blobUrl) {
    return NextResponse.json({ error: "blobUrl is required" }, { status: 400 });
  }

  if (!isValidBlobUrl(blobUrl)) {
    return NextResponse.json(
      { error: "Invalid or untrusted blob URL" },
      { status: 400 },
    );
  }

  // Verify blob ownership - user can only delete their own pre-uploaded files
  const blobOwnerId = extractUserIdFromBlobPath(blobUrl);
  if (!blobOwnerId || blobOwnerId !== user.id) {
    return NextResponse.json(
      { error: "Unauthorized to delete this file" },
      { status: 403 },
    );
  }

  try {
    await deleteBlob(blobUrl);

    logger.info("[PreUpload] File deleted from blob", {
      blobUrl,
      userId: user.id,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("[PreUpload] Error deleting blob:", error);
    return NextResponse.json(
      { error: "Failed to delete file" },
      { status: 500 },
    );
  }
}

export const POST = withRateLimit(handlePOST, RateLimitPresets.STANDARD);
export const DELETE = withRateLimit(handleDELETE, RateLimitPresets.STANDARD);

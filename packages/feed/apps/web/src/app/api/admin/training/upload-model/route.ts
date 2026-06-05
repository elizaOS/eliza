/**
 * Admin Training Upload Model API
 *
 * @route POST /api/admin/training/upload-model - Upload trained model
 * @access Admin
 *
 * @description
 * Uploads trained model to Vercel Blob storage. Called by Python deployment
 * script after training completes. Supports multipart file uploads.
 *
 * @openapi
 * /api/admin/training/upload-model:
 *   post:
 *     tags:
 *       - Admin
 *     summary: Upload trained model
 *     description: Uploads trained model to blob storage (admin only)
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - modelFile
 *               - version
 *             properties:
 *               modelFile:
 *                 type: string
 *                 format: binary
 *               version:
 *                 type: string
 *     responses:
 *       200:
 *         description: Model uploaded successfully
 *       400:
 *         description: Invalid file or version
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *
 * @example
 * ```typescript
 * const formData = new FormData();
 * formData.append('modelFile', file);
 * formData.append('version', 'v1.0.0');
 * await fetch('/api/admin/training/upload-model', {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${adminToken}` },
 *   body: formData
 * });
 * ```
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { modelStorage } from "@feed/agents/training";
import { requireAdmin, successResponse, withErrorHandling } from "@feed/api";
import { logger } from "@feed/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const maxDuration = 300; // 5 minutes for large uploads

export const POST = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  const formData = await request.formData();
  const modelFile = formData.get("model") as File;
  const version = formData.get("version") as string;
  const metadataStr = formData.get("metadata") as string;

  if (!modelFile || !version) {
    return NextResponse.json(
      { error: "Missing model file or version" },
      { status: 400 },
    );
  }

  const metadata = metadataStr ? JSON.parse(metadataStr) : {};

  logger.info("Uploading model to Vercel Blob", {
    version,
    size: modelFile.size,
  });

  // Save to temp file
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "model-upload-"));
  const tempPath = path.join(tempDir, "model.safetensors");

  const buffer = Buffer.from(await modelFile.arrayBuffer());
  await fs.writeFile(tempPath, buffer);

  // Upload using ModelStorageService
  const result = await modelStorage.uploadModel({
    version,
    modelPath: tempPath,
    metadata,
  });

  // Cleanup
  await fs.rm(tempDir, { recursive: true, force: true });

  logger.info("Model uploaded successfully", {
    version,
    url: result.blobUrl,
  });

  return successResponse({
    success: true,
    url: result.blobUrl,
    version: result.version,
    size: result.size,
  });
});

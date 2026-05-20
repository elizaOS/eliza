/**
 * Image Upload API
 *
 * @description
 * Handles image uploads for user profiles, cover images, and post attachments.
 * Stores raw images - optimization is handled by Vercel's Image Optimization CDN.
 *
 * **Features:**
 * - Rate limiting to prevent abuse
 * - Multi-folder organization (profiles, covers, posts)
 * - Preserves original image format (JPEG, PNG, GIF, WebP)
 * - Vercel Image Optimization for delivery (WebP/AVIF, resizing, caching)
 *
 * **Supported Image Types:**
 * - profile: User profile avatars
 * - cover: User cover images
 * - post: Post attachments
 *
 * **Storage:**
 * - **Development (USE_LOCAL_STORAGE=true):** Local filesystem `/public/uploads/`
 * - **Development (MinIO):** S3-compatible MinIO container
 * - **Production:** Vercel Blob Storage
 *
 * **Image Optimization:**
 * Images are stored as-is. When displayed via `next/image`, Vercel automatically:
 * - Converts to WebP/AVIF for modern browsers
 * - Resizes to requested dimensions
 * - Caches at the CDN edge globally
 *
 * @see https://vercel.com/docs/image-optimization
 *
 * @openapi
 * /api/upload/image:
 *   post:
 *     tags:
 *       - Upload
 *     summary: Upload image
 *     description: Upload and optimize images for profiles, covers, or posts
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: Image file to upload
 *               type:
 *                 type: string
 *                 enum: [profile, cover, post]
 *                 description: Image type/category
 *     responses:
 *       200:
 *         description: Image uploaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 url:
 *                   type: string
 *                   description: Public URL of uploaded image
 *                 key:
 *                   type: string
 *                   description: Storage key/path
 *                 size:
 *                   type: integer
 *                   description: File size in bytes
 *                 filename:
 *                   type: string
 *                   description: Generated filename
 *       400:
 *         description: Invalid file or type
 *       401:
 *         description: Unauthorized
 *       429:
 *         description: Rate limit exceeded
 *
 * @example
 * ```typescript
 * // Upload profile image
 * const formData = new FormData();
 * formData.append('file', imageFile);
 * formData.append('type', 'profile');
 *
 * const response = await fetch('/api/upload/image', {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${token}` },
 *   body: formData
 * });
 *
 * const { url, size } = await response.json();
 * console.log(`Uploaded to: ${url} (${size} bytes)`);
 * ```
 *
 * @see {@link @feed/shared} S3 storage client
 * @see {@link /lib/validation/schemas} Upload validation
 */

import {
  authenticate,
  checkRateLimitAndDuplicates,
  getStorageClient,
  RATE_LIMIT_CONFIGS,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { ImageUploadSchema, logger } from '@feed/shared';
import { mkdir, writeFile } from 'fs/promises';
import type { NextRequest } from 'next/server';
import { join } from 'path';
import { validateImageMagicBytes } from '@/lib/api/image-validation';

// Map MIME types to file extensions
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

// Configuration - only allow local storage in development
const USE_LOCAL_STORAGE =
  process.env.USE_LOCAL_STORAGE === 'true' &&
  process.env.NODE_ENV === 'development';

// Runtime configuration for Vercel
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/upload/image
 * Upload an image file to S3-compatible storage
 */
export const POST = withErrorHandling(async (request: NextRequest) => {
  // Authenticate user
  const authUser = await authenticate(request);

  // Apply rate limiting (no duplicate detection for uploads)
  const rateLimitError = checkRateLimitAndDuplicates(
    authUser.userId,
    null,
    RATE_LIMIT_CONFIGS.UPLOAD_IMAGE
  );
  if (rateLimitError) {
    return rateLimitError;
  }

  // Parse multipart form data
  const formData = await request.formData();
  const file = formData.get('file') as File | null;
  const imageType = formData.get('type') as string | null; // 'profile', 'cover', or 'post'

  // Validate using schema
  ImageUploadSchema.parse({
    file: file ? { size: file.size, type: file.type } : null,
    type: imageType || undefined,
  });

  if (!file) {
    throw new Error('No file provided');
  }

  // Determine folder based on image type
  let folder: 'profiles' | 'covers' | 'posts' = 'posts';
  if (imageType === 'profile') folder = 'profiles';
  else if (imageType === 'cover') folder = 'covers';

  // Generate unique filename with original extension
  const timestamp = Date.now();
  const randomString = Math.random().toString(36).substring(7);
  const extension = MIME_TO_EXT[file.type] || 'jpg';
  const filename = `${authUser.userId}_${timestamp}_${randomString}.${extension}`;

  // Convert file to buffer
  const bytes = await file.arrayBuffer();
  const buffer = Buffer.from(bytes);

  // Validate magic bytes match declared MIME type (prevents fake file uploads)
  if (!validateImageMagicBytes(buffer, file.type)) {
    throw new Error(
      'File content does not match declared type. Ensure you are uploading a valid image.'
    );
  }

  if (USE_LOCAL_STORAGE) {
    // Check if we're in a Node.js environment with file system access
    if (typeof process === 'undefined' || typeof process.cwd !== 'function') {
      throw new Error(
        'Local storage requires Node.js environment with file system access. Not available in edge runtime.'
      );
    }

    const uploadDir = join(process.cwd(), 'public', 'uploads', folder);
    await mkdir(uploadDir, { recursive: true });

    const filePath = join(uploadDir, filename);
    await writeFile(filePath, buffer);

    const url = `/uploads/${folder}/${filename}`;

    logger.info(
      'Image uploaded successfully to local storage (dev only)',
      {
        userId: authUser.userId,
        filename,
        path: filePath,
        size: buffer.length,
        type: imageType || 'unknown',
      },
      'POST /api/upload/image'
    );

    return successResponse({
      success: true,
      url,
      key: `${folder}/${filename}`,
      size: buffer.length,
      filename,
    });
  }

  // Upload to S3-compatible storage (production or fallback)
  // Image optimization is handled by Vercel's Image Optimization CDN
  const storage = getStorageClient();
  const result = await storage.uploadImage({
    file: buffer,
    filename,
    contentType: file.type,
    folder,
  });

  logger.info(
    'Image uploaded successfully to external storage',
    {
      userId: authUser.userId,
      filename,
      key: result.key,
      size: result.size,
      originalSize: file.size,
      type: imageType || 'unknown',
    },
    'POST /api/upload/image'
  );

  return successResponse({
    success: true,
    url: result.url,
    key: result.key,
    size: result.size,
    filename,
  });
});

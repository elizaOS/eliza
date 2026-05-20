/**
 * Banner Upload API
 *
 * @description Handles banner/cover image uploads for agent and user profiles.
 *
 * @route POST /api/upload/banner
 * @access Authenticated
 */

import {
  authenticate,
  checkRateLimitAndDuplicates,
  getStorageClient,
  RATE_LIMIT_CONFIGS,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { db, eq, users } from '@feed/db';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { validateImageMagicBytes } from '@/lib/api/image-validation';

const MAX_BANNER_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const VALID_TARGET_TYPES = ['user', 'agent'] as const;
type TargetType = (typeof VALID_TARGET_TYPES)[number];

// Map MIME types to file extensions (safer than splitting MIME type)
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * POST /api/upload/banner
 * Upload banner image for user or agent profile
 */
export const POST = withErrorHandling(async (request: NextRequest) => {
  const user = await authenticate(request);

  // Rate limiting
  const rateLimitError = checkRateLimitAndDuplicates(
    user.userId,
    null,
    RATE_LIMIT_CONFIGS.UPLOAD_IMAGE
  );
  if (rateLimitError) {
    return rateLimitError;
  }

  const formData = await request.formData();
  const file = formData.get('file') as File;
  const targetId = formData.get('targetId') as string | null;
  const rawTargetType = (formData.get('targetType') as string) || 'user';

  // Validate targetType against allowed values
  if (!VALID_TARGET_TYPES.includes(rawTargetType as TargetType)) {
    return NextResponse.json(
      {
        error: `Invalid targetType. Allowed: ${VALID_TARGET_TYPES.join(', ')}`,
      },
      { status: 400 }
    );
  }
  const targetType = rawTargetType as TargetType;

  if (!file) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  }

  // Require targetId when uploading for an agent
  if (targetType === 'agent' && !targetId) {
    return NextResponse.json(
      { error: 'targetId is required when uploading a banner for an agent' },
      { status: 400 }
    );
  }

  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json(
      {
        error: `Invalid file type. Allowed: ${ALLOWED_TYPES.join(', ')}`,
      },
      { status: 400 }
    );
  }

  if (file.size > MAX_BANNER_SIZE) {
    return NextResponse.json(
      { error: `File too large. Max size: ${MAX_BANNER_SIZE / 1024 / 1024}MB` },
      { status: 400 }
    );
  }

  // Verify ownership - targetId is required for agents (validated above), optional for users
  const effectiveTargetId = targetId ?? user.userId;
  if (targetType === 'agent') {
    // Verify user owns/manages the agent
    const [agent] = await db
      .select({ managedBy: users.managedBy, isAgent: users.isAgent })
      .from(users)
      .where(eq(users.id, effectiveTargetId))
      .limit(1);

    if (!agent || !agent.isAgent || agent.managedBy !== user.userId) {
      return NextResponse.json(
        { error: 'You can only upload banners for your own agents' },
        { status: 403 }
      );
    }
  } else if (effectiveTargetId !== user.userId) {
    return NextResponse.json(
      { error: 'You can only upload banners for your own profile' },
      { status: 403 }
    );
  }

  // Convert file to buffer for validation
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Validate magic bytes match declared MIME type (prevents fake file uploads)
  if (!validateImageMagicBytes(buffer, file.type)) {
    return NextResponse.json(
      {
        error:
          'File content does not match declared type. Ensure you are uploading a valid image.',
      },
      { status: 400 }
    );
  }

  // Upload to storage
  const storage = getStorageClient();
  const timestamp = Date.now();
  const extension = MIME_TO_EXT[file.type] || 'jpg';
  const filename = `${effectiveTargetId}_${timestamp}.${extension}`;

  const folder = targetType === 'agent' ? 'actor-banners' : 'user-banners';
  const result = await storage.uploadImage({
    file: buffer,
    filename,
    contentType: file.type,
    folder,
  });

  // Update database - both agents and users use the User table with coverImageUrl
  await db
    .update(users)
    .set({ coverImageUrl: result.url })
    .where(eq(users.id, effectiveTargetId));

  logger.info(
    `Banner uploaded for ${targetType}`,
    { targetId: effectiveTargetId, url: result.url },
    'BannerUpload'
  );

  return successResponse({
    url: result.url,
    filename,
    size: result.size,
  });
});

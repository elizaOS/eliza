/**
 * @route POST /api/agents/generate-avatar — Generate agent profile image (fal.ai)
 * @access Authenticated
 *
 * Requires `Idempotency-Key` header (or JSON `idempotencyKey`) so duplicate
 * calls (e.g. React Strict Mode) reuse one fal job + stored URL.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  authenticateUser,
  checkRateLimitAndDuplicates,
  executeAgentAvatarOnce,
  getCachedAgentAvatarUrl,
  getStorageClient,
  RATE_LIMIT_CONFIGS,
  successResponse,
  withErrorHandling,
} from '@babylon/api';
import {
  generateAgentMonkeyProfileImage,
  initFalClient,
} from '@babylon/engine';
import { logger } from '@babylon/shared';
import { fal } from '@fal-ai/client';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export const maxDuration = 120;

const BUNDLED_REFERENCE = join(
  process.cwd(),
  'public/assets/user-pfps/pfp-001.png'
);

/** Cached fal CDN URL after uploading bundled reference (avoid re-uploading every request). */
let bundledReferenceFalUrl: string | null | undefined;

const IDEMPOTENCY_KEY_RE = /^[a-zA-Z0-9_.-]{8,200}$/;

function parseIdempotencyKey(
  req: NextRequest,
  body: { idempotencyKey?: string }
): string | null {
  const header = req.headers.get('Idempotency-Key')?.trim();
  const fromBody = body.idempotencyKey?.trim();
  const raw = header || fromBody || '';
  if (!IDEMPOTENCY_KEY_RE.test(raw)) {
    return null;
  }
  return raw;
}

/**
 * Public reference URL from env, or upload bundled pfp-001.png to fal CDN
 * (localhost app URLs are not reachable by fal.ai).
 */
async function resolveReferenceImageUrlForFal(): Promise<string | null> {
  const explicit = process.env.AGENT_AVATAR_REFERENCE_IMAGE_URL?.trim();
  if (explicit) {
    return explicit;
  }

  if (bundledReferenceFalUrl !== undefined) {
    return bundledReferenceFalUrl;
  }

  if (!existsSync(BUNDLED_REFERENCE) || !process.env.FAL_KEY?.trim()) {
    bundledReferenceFalUrl = null;
    return null;
  }

  try {
    initFalClient();
    const buf = await readFile(BUNDLED_REFERENCE);
    const blob = new Blob([buf], { type: 'image/png' });
    const uploaded = await fal.storage.upload(blob);
    const url = uploaded ?? null;
    bundledReferenceFalUrl = url;
    return url;
  } catch (error) {
    logger.warn(
      'Failed to upload bundled agent avatar reference to fal',
      { error: String(error) },
      'GenerateAgentAvatar'
    );
    bundledReferenceFalUrl = null;
    return null;
  }
}

export const POST = withErrorHandling(async function POST(req: NextRequest) {
  const user = await authenticateUser(req);

  let body: { displayName?: string; idempotencyKey?: string } = {};
  try {
    body = (await req.json()) as {
      displayName?: string;
      idempotencyKey?: string;
    };
  } catch {
    body = {};
  }

  const idempotencyKey = parseIdempotencyKey(req, body);
  if (!idempotencyKey) {
    return NextResponse.json(
      {
        error:
          'Send Idempotency-Key header or JSON idempotencyKey (8–200 chars: letters, digits, _, ., -).',
      },
      { status: 400 }
    );
  }

  const cachedUrl = await getCachedAgentAvatarUrl(user.userId, idempotencyKey);
  if (cachedUrl) {
    return successResponse({
      success: true as const,
      url: cachedUrl,
      cached: true as const,
    });
  }

  const rateLimitError = checkRateLimitAndDuplicates(
    user.userId,
    null,
    RATE_LIMIT_CONFIGS.GENERATE_AGENT_AVATAR
  );
  if (rateLimitError) {
    return rateLimitError;
  }

  const displayName =
    typeof body.displayName === 'string' ? body.displayName : undefined;

  try {
    const { url } = await executeAgentAvatarOnce(
      user.userId,
      idempotencyKey,
      async () => {
        const referenceImageUrl = await resolveReferenceImageUrlForFal();

        const falUrl = await generateAgentMonkeyProfileImage({
          displayName,
          referenceImageUrl,
        });

        if (!falUrl) {
          logger.warn(
            'Agent avatar generation produced no URL',
            { userId: user.userId },
            'GenerateAgentAvatar'
          );
          throw new Error('FAL_UNAVAILABLE');
        }

        const imageRes = await fetch(falUrl);
        if (!imageRes.ok) {
          logger.error(
            'Failed to download fal avatar image',
            { status: imageRes.status, userId: user.userId },
            'GenerateAgentAvatar'
          );
          throw new Error('FAL_DOWNLOAD_FAILED');
        }

        const arrayBuffer = await imageRes.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const contentType =
          imageRes.headers.get('content-type')?.split(';')[0]?.trim() ||
          'image/png';
        const ext =
          contentType === 'image/jpeg' || contentType === 'image/jpg'
            ? 'jpg'
            : contentType === 'image/webp'
              ? 'webp'
              : 'png';

        const storage = getStorageClient();
        const uploaded = await storage.uploadImage({
          file: buffer,
          filename: `agent-${randomUUID()}.${ext}`,
          contentType,
          folder: 'profiles',
        });

        logger.info(
          'Agent avatar generated and stored',
          { userId: user.userId },
          'GenerateAgentAvatar'
        );

        return { url: uploaded.url };
      }
    );

    return successResponse({ success: true as const, url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg === 'FAL_UNAVAILABLE') {
      return NextResponse.json(
        {
          error:
            'Image generation is unavailable. Set FAL_KEY. Optional: AGENT_AVATAR_REFERENCE_IMAGE_URL or public/assets/user-pfps/pfp-001.png for style-matched edits.',
        },
        { status: 503 }
      );
    }
    if (msg === 'FAL_DOWNLOAD_FAILED') {
      return NextResponse.json(
        { error: 'Failed to persist generated image' },
        { status: 502 }
      );
    }
    throw err;
  }
});

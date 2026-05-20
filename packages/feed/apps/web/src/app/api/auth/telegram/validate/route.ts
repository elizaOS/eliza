/**
 * Telegram Mini App initData Validation API
 *
 * @route POST /api/auth/telegram/validate - Validate Telegram Mini App initData
 * @access Public (called from the Telegram Mini App iframe)
 *
 * @description
 * Validates the authenticity of Telegram Mini App launch data (`initData`)
 * using HMAC-SHA-256 with the bot token, following Telegram's official
 * validation algorithm.
 *
 * This prevents spoofing attacks where a malicious client could forge
 * `initData` with arbitrary user IDs.
 *
 * Algorithm (from Telegram docs):
 * 1. Parse `initData` as URL-encoded params
 * 2. Extract `hash` param, remove it from the data
 * 3. Sort remaining params alphabetically by key
 * 4. Join as `key=value` pairs with `\n`
 * 5. Compute secret_key = HMAC-SHA-256("WebAppData", bot_token)
 * 6. Compute data_hash  = HMAC-SHA-256(secret_key, data_check_string)
 * 7. Compare data_hash with the extracted hash (hex-encoded)
 *
 * @see https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */

import { withErrorHandling } from '@feed/api';
import { logger } from '@feed/shared';
import { createHmac, timingSafeEqual } from 'crypto';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';

/** Maximum age of initData before it's considered stale (5 minutes). */
const MAX_AUTH_AGE_SECONDS = 300;

const RequestSchema = z.object({
  initData: z.string().min(1, 'initData is required'),
});

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  language_code?: string;
  is_premium?: boolean;
}

interface ValidatedInitData {
  user: TelegramUser;
  authDate: number;
  queryId?: string;
  chatType?: string;
  chatInstance?: string;
}

/**
 * Validate Telegram initData using HMAC-SHA-256.
 *
 * @param initDataRaw - The raw initData query string from Telegram
 * @param botToken - The Telegram bot token (secret)
 * @returns The validated and parsed initData, or an error reason
 */
function validateTelegramInitData(
  initDataRaw: string,
  botToken: string
): { valid: true; data: ValidatedInitData } | { valid: false; reason: string } {
  // Parse the URL-encoded initData string
  const params = new URLSearchParams(initDataRaw);

  // Extract and remove the hash
  const hash = params.get('hash');
  if (!hash) {
    return { valid: false, reason: 'missing hash parameter' };
  }
  params.delete('hash');

  // Sort remaining parameters alphabetically and construct the data check string.
  // Each entry is formatted as `key=value` and joined with newlines.
  const entries: string[] = [];
  for (const [key, value] of params.entries()) {
    entries.push(`${key}=${value}`);
  }
  entries.sort();
  const dataCheckString = entries.join('\n');

  // Step 1: Derive the secret key from the bot token.
  // secret_key = HMAC-SHA-256("WebAppData", bot_token)
  const secretKey = createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  // Step 2: Compute the expected hash.
  // data_hash = HMAC-SHA-256(secret_key, data_check_string)
  const computedHash = createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  // Step 3: Compare using timing-safe comparison.
  const hashBuffer = Buffer.from(hash, 'hex');
  const computedBuffer = Buffer.from(computedHash, 'hex');

  if (hashBuffer.length !== computedBuffer.length) {
    return { valid: false, reason: 'hash length mismatch' };
  }

  if (!timingSafeEqual(hashBuffer, computedBuffer)) {
    return { valid: false, reason: 'hash verification failed' };
  }

  // Step 4: Validate auth_date freshness to prevent replay attacks.
  const authDateStr = params.get('auth_date');
  if (!authDateStr) {
    return { valid: false, reason: 'missing auth_date' };
  }

  const authDate = Number.parseInt(authDateStr, 10);
  if (Number.isNaN(authDate)) {
    return { valid: false, reason: 'invalid auth_date' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (now - authDate > MAX_AUTH_AGE_SECONDS) {
    return { valid: false, reason: 'auth_date expired' };
  }

  // Step 5: Parse user data from the validated initData.
  const userStr = params.get('user');
  if (!userStr) {
    return { valid: false, reason: 'missing user data' };
  }

  let user: TelegramUser;
  try {
    user = JSON.parse(userStr) as TelegramUser;
  } catch {
    return { valid: false, reason: 'malformed user JSON' };
  }

  if (!user.id || !user.first_name) {
    return { valid: false, reason: 'incomplete user data' };
  }

  return {
    valid: true,
    data: {
      user,
      authDate,
      queryId: params.get('query_id') ?? undefined,
      chatType: params.get('chat_type') ?? undefined,
      chatInstance: params.get('chat_instance') ?? undefined,
    },
  };
}

export const POST = withErrorHandling(async (request: NextRequest) => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  if (!botToken) {
    // If the bot token isn't configured, we can't validate initData.
    // Log a warning and return a clear error — this is a deployment
    // configuration issue, not a runtime error.
    logger.warn(
      'Telegram initData validation skipped: TELEGRAM_BOT_TOKEN not configured',
      {},
      'TelegramMiniApp'
    );
    return NextResponse.json(
      { error: 'Telegram validation not configured' },
      { status: 501 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Missing or invalid initData' },
      { status: 400 }
    );
  }

  const { initData } = parsed.data;

  const result = validateTelegramInitData(initData, botToken);

  if (!result.valid) {
    logger.warn(
      'Telegram initData validation failed',
      { reason: result.reason },
      'TelegramMiniApp'
    );
    return NextResponse.json(
      { error: 'Invalid initData', reason: result.reason },
      { status: 403 }
    );
  }

  logger.info(
    'Telegram initData validated successfully',
    { userId: result.data.user.id, username: result.data.user.username },
    'TelegramMiniApp'
  );

  return NextResponse.json({
    valid: true,
    user: result.data.user,
    authDate: result.data.authDate,
  });
});

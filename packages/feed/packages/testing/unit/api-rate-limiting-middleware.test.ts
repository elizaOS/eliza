import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// Restore real modules before importing to prevent leakage from other tests
const _realNextServer = await import('next/server');
mock.module('next/server', () => _realNextServer);
const _realApi = await import('@babylon/api');
mock.module('@babylon/api', () => _realApi);
const _realShared = await import('@babylon/shared');
mock.module('@babylon/shared', () => _realShared);

const { NextRequest } = _realNextServer;

import { createAgentSession } from '../../api/src/agent-auth';
import {
  addPublicReadHeaders,
  checkRateLimitAndDuplicates,
  duplicateContentError,
  publicRateLimit,
  rateLimitError,
} from '../../api/src/rate-limiting/middleware';
import {
  clearAllRateLimits,
  RATE_LIMIT_CONFIGS,
} from '../../api/src/rate-limiting/user-rate-limiter';
import {
  clearAllDuplicates,
  DUPLICATE_DETECTION_CONFIGS,
} from '../../api/src/utils/duplicate-detector';

const ORIGINAL_DISABLE_RATE_LIMITING = process.env.DISABLE_RATE_LIMITING;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const TEST_AGENT_ID = 'public-rate-limit-agent';
const TEST_AGENT_SESSION_TOKEN = 'public-rate-limit-session-token';
const ENV = process.env as Record<string, string | undefined>;

function buildRequest(
  headers: HeadersInit = {},
  path = 'http://localhost:3000/api/test'
): InstanceType<typeof NextRequest> {
  return new NextRequest(path, { headers });
}

describe('API rate-limiting middleware', () => {
  beforeEach(async () => {
    delete ENV.DISABLE_RATE_LIMITING;
    ENV.NODE_ENV = 'test';
    await clearAllRateLimits();
    clearAllDuplicates();
  });

  afterEach(async () => {
    if (ORIGINAL_DISABLE_RATE_LIMITING === undefined) {
      delete ENV.DISABLE_RATE_LIMITING;
    } else {
      ENV.DISABLE_RATE_LIMITING = ORIGINAL_DISABLE_RATE_LIMITING;
    }

    if (ORIGINAL_NODE_ENV === undefined) {
      delete ENV.NODE_ENV;
    } else {
      ENV.NODE_ENV = ORIGINAL_NODE_ENV;
    }

    await clearAllRateLimits();
    clearAllDuplicates();
  });

  test('returns a 429 response with retry metadata when rate limits are exceeded', async () => {
    const response = rateLimitError(17);
    const payload = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('17');
    expect(response.headers.get('X-RateLimit-Exceeded')).toBe('true');
    expect(payload).toEqual({
      success: false,
      error: 'Rate limit exceeded',
      message: 'Too many requests. Please try again in 17 seconds.',
      retryAfter: 17,
    });
  });

  test('returns a 409 response with the duplicate timestamp when content repeats', async () => {
    const lastPostedAt = new Date('2026-03-29T12:34:56.000Z');
    const response = duplicateContentError(lastPostedAt);
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error).toBe('Duplicate content');
    expect(payload.lastPostedAt).toBe(lastPostedAt.toISOString());
  });

  test('blocks duplicate content after the first accepted request', async () => {
    const userId = 'duplicate-user';
    const content = 'Repeat me';

    expect(
      checkRateLimitAndDuplicates(
        userId,
        content,
        RATE_LIMIT_CONFIGS.CREATE_POST,
        DUPLICATE_DETECTION_CONFIGS.POST
      )
    ).toBeNull();

    const duplicateResponse = checkRateLimitAndDuplicates(
      userId,
      content,
      RATE_LIMIT_CONFIGS.CREATE_POST,
      DUPLICATE_DETECTION_CONFIGS.POST
    );
    const payload = await duplicateResponse?.json();

    expect(duplicateResponse?.status).toBe(409);
    expect(payload?.error).toBe('Duplicate content');
    expect(typeof payload?.lastPostedAt).toBe('string');
  });

  test('returns 429 after the configured request budget is exhausted', async () => {
    const userId = 'limited-user';

    for (
      let index = 0;
      index < RATE_LIMIT_CONFIGS.CREATE_POST.maxRequests;
      index += 1
    ) {
      expect(
        checkRateLimitAndDuplicates(
          userId,
          null,
          RATE_LIMIT_CONFIGS.CREATE_POST
        )
      ).toBeNull();
    }

    const limitedResponse = checkRateLimitAndDuplicates(
      userId,
      null,
      RATE_LIMIT_CONFIGS.CREATE_POST
    );
    const payload = await limitedResponse?.json();

    expect(limitedResponse?.status).toBe(429);
    expect(limitedResponse?.headers.get('X-RateLimit-Exceeded')).toBe('true');
    expect(payload?.retryAfter).toBeGreaterThan(0);
  });

  test('adds cache and rate-limit headers for successful public reads', () => {
    const response = addPublicReadHeaders(
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      }) as unknown as import('next/server').NextResponse,
      {
        limit: 20,
        remaining: 19,
        resetAt: new Date('2026-03-29T10:00:00.000Z'),
      }
    );

    expect(response.headers.get('X-RateLimit-Limit')).toBe('20');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('19');
    expect(response.headers.get('X-RateLimit-Reset')).toBe(
      '2026-03-29T10:00:00.000Z'
    );
    expect(response.headers.get('Cache-Control')).toBe(
      'public, s-maxage=5, stale-while-revalidate=10'
    );
  });

  test('uses the authenticated public bucket when a valid agent session token is provided', async () => {
    await createAgentSession(TEST_AGENT_ID, TEST_AGENT_SESSION_TOKEN);

    const request = buildRequest({
      authorization: `Bearer ${TEST_AGENT_SESSION_TOKEN}`,
      'x-forwarded-for': '203.0.113.10',
    });

    const result = await publicRateLimit(request, 'firehose');

    expect(result.error).toBeNull();
    expect(result.user?.userId).toBe(TEST_AGENT_ID);
    expect(result.rateLimitInfo?.limit).toBe(
      RATE_LIMIT_CONFIGS.PUBLIC_FIREHOSE_AUTHED.maxRequests
    );
    expect(result.rateLimitInfo?.remaining).toBe(
      RATE_LIMIT_CONFIGS.PUBLIC_FIREHOSE_AUTHED.maxRequests - 1
    );
  });

  test('enforces the IP-scoped firehose limit and returns a real 429 response', async () => {
    const request = buildRequest({
      'x-forwarded-for': '198.51.100.24',
    });

    for (
      let index = 0;
      index < RATE_LIMIT_CONFIGS.PUBLIC_FIREHOSE.maxRequests;
      index += 1
    ) {
      const result = await publicRateLimit(request, 'firehose');
      expect(result.error).toBeNull();
      expect(result.user).toBeNull();
    }

    const limitedResult = await publicRateLimit(request, 'firehose');
    const payload = await limitedResult.error?.json();

    expect(limitedResult.error?.status).toBe(429);
    expect(payload?.error).toBe('Rate limit exceeded');
  });

  test('falls back to the anonymous bucket when no client IP is present', async () => {
    const request = buildRequest();

    for (
      let index = 0;
      index < RATE_LIMIT_CONFIGS.PUBLIC_FIREHOSE_ANONYMOUS.maxRequests;
      index += 1
    ) {
      const result = await publicRateLimit(request, 'firehose');
      expect(result.error).toBeNull();
      expect(result.rateLimitInfo?.limit).toBe(
        RATE_LIMIT_CONFIGS.PUBLIC_FIREHOSE_ANONYMOUS.maxRequests
      );
    }

    const limitedResult = await publicRateLimit(request, 'firehose');
    expect(limitedResult.error?.status).toBe(429);
    expect(limitedResult.user).toBeNull();
  });

  test('bypasses rate limiting in non-production when explicitly disabled', async () => {
    ENV.DISABLE_RATE_LIMITING = 'true';

    const request = buildRequest({
      'x-forwarded-for': '203.0.113.77',
    });

    const result = await publicRateLimit(request, 'read');

    expect(result.error).toBeNull();
    expect(result.rateLimitInfo?.limit).toBe(
      RATE_LIMIT_CONFIGS.PUBLIC_READ_AUTHED.maxRequests
    );
    expect(result.rateLimitInfo?.remaining).toBe(
      RATE_LIMIT_CONFIGS.PUBLIC_READ_AUTHED.maxRequests
    );
  });
});

/**
 * Admin API Endpoints Integration Tests
 *
 * Tests admin API endpoints for proper functionality including:
 * - Analytics endpoint with LIMIT protection
 * - Audit logs endpoint with pagination
 * - Content queue endpoint with moderation actions
 *
 * Run with: bun test integration/admin-endpoints.integration.test.ts --preload ./integration/preload.ts
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { getAdminToken } from './helpers';

const BASE_URL =
  process.env.TEST_API_URL ||
  process.env.PLAYWRIGHT_BASE_URL ||
  'http://localhost:3000';

let serverAvailable = false;
let adminToken: string | null = null;

function applyAdminAuth(
  headers: HeadersInit & Record<string, string>,
  token?: string
): void {
  if (!token) {
    return;
  }
  if (token.startsWith('dev_admin_')) {
    headers['x-dev-admin-token'] = token;
    return;
  }
  headers['Authorization'] = `Bearer ${token}`;
}

async function checkServerHealth(): Promise<boolean> {
  const response = await fetch(`${BASE_URL}/api/health`, {
    signal: AbortSignal.timeout(5000),
  });
  return response.ok;
}

async function getWithAuth(path: string, token?: string): Promise<Response> {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };
  applyAdminAuth(headers, token);
  return fetch(`${BASE_URL}${path}`, {
    headers,
    signal: AbortSignal.timeout(30000),
  });
}

describe('Admin API Endpoints Integration', () => {
  beforeAll(async () => {
    serverAvailable = await checkServerHealth().catch(() => false);
    if (!serverAvailable) {
      console.warn('⚠️  Server not available - Admin API tests will be skipped');
    }

    adminToken = getAdminToken();
  });

  // ============================================
  // ANALYTICS ENDPOINT
  // ============================================
  describe('Analytics - GET /api/admin/analytics', () => {
    test('should require authentication', async () => {
      if (!serverAvailable) return;
      const res = await getWithAuth('/api/admin/analytics');
      expect(res.status).toBe(401);
    });

    test('should return 403 for non-admin users', async () => {
      if (!serverAvailable || !process.env.TEST_USER_TOKEN) return;
      const res = await getWithAuth(
        '/api/admin/analytics',
        process.env.TEST_USER_TOKEN
      );
      expect(res.status).toBe(403);
    });

    test('should return analytics data for admin users', async () => {
      if (!serverAvailable || !adminToken) {
        console.log('⏭️  Skipping admin analytics test - no admin token');
        return;
      }
      const res = await getWithAuth('/api/admin/analytics', adminToken);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.period).toBeDefined();
      expect(data.startDate).toBeDefined();
      expect(data.endDate).toBeDefined();
      expect(data.timeSeries).toBeInstanceOf(Array);
      expect(data.totals).toBeDefined();
      expect(data.totals.users).toBeDefined();
      expect(data.totals.posts).toBeDefined();
    });

    test('should support period parameter (day, week, month)', async () => {
      if (!serverAvailable || !adminToken) return;

      for (const period of ['day', 'week', 'month']) {
        const res = await getWithAuth(
          `/api/admin/analytics?period=${period}`,
          adminToken
        );
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.period).toBe(period);
      }
    });

    test('should limit data points to prevent memory issues', async () => {
      if (!serverAvailable || !adminToken) return;
      const res = await getWithAuth(
        '/api/admin/analytics?period=month',
        adminToken
      );
      expect(res.status).toBe(200);

      const data = await res.json();
      // Should have at most 200 data points (MAX_DATA_POINTS)
      expect(data.timeSeries.length).toBeLessThanOrEqual(200);
    });
  });

  // ============================================
  // AUDIT LOGS ENDPOINT
  // ============================================
  describe('Audit Logs - GET /api/admin/audit-logs', () => {
    test('should require authentication', async () => {
      if (!serverAvailable) return;
      const res = await getWithAuth('/api/admin/audit-logs');
      expect(res.status).toBe(401);
    });

    test('should return audit logs for admin users', async () => {
      if (!serverAvailable || !adminToken) {
        console.log('⏭️  Skipping admin audit-logs test - no admin token');
        return;
      }
      const res = await getWithAuth('/api/admin/audit-logs', adminToken);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.logs).toBeInstanceOf(Array);
      expect(data.pagination).toBeDefined();
      expect(data.pagination.limit).toBeDefined();
      expect(data.pagination.offset).toBeDefined();
      expect(data.pagination.total).toBeDefined();
      expect(data.filters).toBeDefined();
    });

    test('should support pagination with limit and offset', async () => {
      if (!serverAvailable || !adminToken) return;
      const res = await getWithAuth(
        '/api/admin/audit-logs?limit=10&offset=0',
        adminToken
      );
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.pagination.limit).toBe(10);
      expect(data.pagination.offset).toBe(0);
      expect(data.logs.length).toBeLessThanOrEqual(10);
    });

    test('should support filtering by action type', async () => {
      if (!serverAvailable || !adminToken) return;
      const res = await getWithAuth(
        '/api/admin/audit-logs?action=MODIFY',
        adminToken
      );
      expect(res.status).toBe(200);

      const data = await res.json();
      // All logs should have the filtered action (uppercase as stored in DB)
      for (const log of data.logs) {
        expect(log.action).toBe('MODIFY');
      }
    });

    test('should support filtering by resource type', async () => {
      if (!serverAvailable || !adminToken) return;
      const res = await getWithAuth(
        '/api/admin/audit-logs?resourceType=user',
        adminToken
      );
      expect(res.status).toBe(200);

      const data = await res.json();
      // All logs should have the filtered resource type
      for (const log of data.logs) {
        expect(log.resourceType).toBe('user');
      }
    });

    test('should reject offset > 1000 (lowered max offset)', async () => {
      if (!serverAvailable || !adminToken) return;
      // Max offset was lowered from 10000 to 1000
      const res = await getWithAuth(
        '/api/admin/audit-logs?offset=1001',
        adminToken
      );
      // Should return 400 error due to max offset validation
      expect(res.status).toBe(400);
    });

    test('should support cursor-based pagination', async () => {
      if (!serverAvailable || !adminToken) return;

      // First request without cursor
      const res1 = await getWithAuth(
        '/api/admin/audit-logs?limit=5',
        adminToken
      );
      expect(res1.status).toBe(200);

      const data1 = await res1.json();
      expect(data1.pagination.hasMore).toBeDefined();

      // If there's more data and we have a nextCursor, test cursor pagination
      if (data1.pagination.nextCursor) {
        const res2 = await getWithAuth(
          `/api/admin/audit-logs?limit=5&cursor=${encodeURIComponent(data1.pagination.nextCursor)}`,
          adminToken
        );
        expect(res2.status).toBe(200);

        const data2 = await res2.json();
        expect(data2.pagination.cursor).toBe(data1.pagination.nextCursor);
        expect(data2.pagination.offset).toBeUndefined(); // Cursor mode doesn't use offset
        expect(data2.pagination.total).toBeUndefined(); // Cursor mode doesn't count total

        // Ensure we got different logs (no overlap)
        const ids1 = new Set(data1.logs.map((l: { id: string }) => l.id));
        for (const log of data2.logs) {
          expect(ids1.has(log.id)).toBe(false);
        }
      }
    });
  });

  // ============================================
  // CONTENT QUEUE ENDPOINT
  // ============================================
  describe('Content Queue - GET /api/admin/content-queue', () => {
    test('should require authentication', async () => {
      if (!serverAvailable) return;
      const res = await getWithAuth('/api/admin/content-queue');
      expect(res.status).toBe(401);
    });

    test('should return content queue for admin users', async () => {
      if (!serverAvailable || !adminToken) {
        console.log('⏭️  Skipping admin content-queue test - no admin token');
        return;
      }
      const res = await getWithAuth('/api/admin/content-queue', adminToken);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.posts).toBeInstanceOf(Array);
      expect(data.comments).toBeInstanceOf(Array);
      expect(data.stats).toBeDefined();
      expect(data.stats.posts).toBeDefined();
      expect(data.stats.comments).toBeDefined();
      expect(data.stats.totalPending).toBeDefined();
    });

    test('should support type filter (all, posts, comments)', async () => {
      if (!serverAvailable || !adminToken) return;

      for (const type of ['all', 'posts', 'comments']) {
        const res = await getWithAuth(
          `/api/admin/content-queue?type=${type}`,
          adminToken
        );
        expect(res.status).toBe(200);
        const data = await res.json();

        if (type === 'posts') {
          expect(data.comments.length).toBe(0);
        } else if (type === 'comments') {
          expect(data.posts.length).toBe(0);
        }
      }
    });

    test('should reject offset > 1000 (max offset protection)', async () => {
      if (!serverAvailable || !adminToken) return;
      const res = await getWithAuth(
        '/api/admin/content-queue?offset=1001',
        adminToken
      );
      // Should return 400 error due to max offset validation
      expect(res.status).toBe(400);
    });

    test('should support pagination with limit', async () => {
      if (!serverAvailable || !adminToken) return;
      const res = await getWithAuth(
        '/api/admin/content-queue?limit=5',
        adminToken
      );
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.posts.length).toBeLessThanOrEqual(5);
      expect(data.comments.length).toBeLessThanOrEqual(5);
    });
  });

  // ============================================
  // MARKET ACTIONS ENDPOINT
  // ============================================
  describe('Market Actions - POST /api/admin/markets/[marketId]', () => {
    test('should require authentication', async () => {
      if (!serverAvailable) return;
      const res = await fetch(`${BASE_URL}/api/admin/markets/test-market-id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resolve', resolution: true }),
      });
      expect(res.status).toBe(401);
    });

    test('should return 404 for non-existent market', async () => {
      if (!serverAvailable || !adminToken) {
        console.log('⏭️  Skipping market action test - no admin token');
        return;
      }
      const res = await fetch(
        `${BASE_URL}/api/admin/markets/non-existent-market-12345`,
        {
          method: 'POST',
          headers: (() => {
            const headers: HeadersInit & Record<string, string> = {
              'Content-Type': 'application/json',
            };
            applyAdminAuth(headers, adminToken);
            return headers;
          })(),
          body: JSON.stringify({ action: 'resolve', resolution: true }),
        }
      );
      expect(res.status).toBe(404);
    });

    test('should validate action parameter', async () => {
      if (!serverAvailable || !adminToken) return;
      const headers: HeadersInit & Record<string, string> = {
        'Content-Type': 'application/json',
      };
      applyAdminAuth(headers, adminToken);
      const res = await fetch(`${BASE_URL}/api/admin/markets/test-market-id`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'invalid-action' }),
      });
      expect(res.status).toBe(400);
    });
  });

  // ============================================
  // ADMIN STATS ENDPOINT (Basic Admin Check)
  // ============================================
  describe('Admin Stats - GET /api/admin/stats', () => {
    test('should require authentication', async () => {
      if (!serverAvailable) return;
      const res = await getWithAuth('/api/admin/stats');
      expect(res.status).toBe(401);
    });

    test('should return stats for admin users', async () => {
      if (!serverAvailable || !adminToken) {
        console.log('⏭️  Skipping admin stats test - no admin token');
        return;
      }
      const res = await getWithAuth('/api/admin/stats', adminToken);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.users).toBeDefined();
      expect(data.markets).toBeDefined();
      expect(data.trading).toBeDefined();
    });
  });
});

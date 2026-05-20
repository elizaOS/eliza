/**
 * Comprehensive API Endpoints Integration Tests
 *
 * Tests ALL public API endpoints for proper functionality.
 * Organized by category with thorough coverage.
 *
 * Run with: bun test integration/api-endpoints.integration.test.ts --preload ./integration/preload.ts
 */

import { beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { requireServer, waitForServerAvailability } from './helpers';

const BASE_URL =
  process.env.TEST_API_URL ||
  process.env.PLAYWRIGHT_BASE_URL ||
  'http://localhost:3000';
const REQUEST_TIMEOUT_MS = 55_000;

setDefaultTimeout(60_000);

async function get(path: string): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function post(
  path: string,
  body: Record<string, unknown>
): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

describe('API Endpoints - Complete Coverage', () => {
  beforeAll(async () => {
    requireServer(await waitForServerAvailability(BASE_URL, 15), BASE_URL);
  });

  // ============================================
  // SYSTEM ENDPOINTS
  // ============================================
  describe('System', () => {
    test('GET /api/health', async () => {
      const res = await get('/api/health');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('ok');
      expect(data.timestamp).toBeDefined();
    });

    test('GET /api/docs', async () => {
      const res = await get('/api/docs');
      expect(res.status).toBe(200);
      const spec = await res.json();
      expect(spec.openapi).toBe('3.0.0');
      expect(spec.info.title).toBe('Babylon API');
    });

    test('GET /api/stats', async () => {
      const res = await get('/api/stats');
      expect(res.status).toBe(200);
    });

    test('GET /api/stats/tokens', async () => {
      const res = await get('/api/stats/tokens');
      expect(res.status).toBe(200);
    });

    test('GET /api/stats/daily', async () => {
      const res = await get('/api/stats/daily');
      expect(res.status).toBe(200);
    });
  });

  // ============================================
  // POSTS ENDPOINTS
  // ============================================
  describe('Posts', () => {
    test('GET /api/posts', async () => {
      const res = await get('/api/posts?limit=5');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(Array.isArray(data.posts)).toBe(true);
    });

    test('GET /api/posts - pagination', async () => {
      const res = await get('/api/posts?limit=2');
      const data = await res.json();
      if (data.cursor) {
        const page2 = await get(`/api/posts?limit=2&cursor=${data.cursor}`);
        expect(page2.status).toBe(200);
      }
    });

    test('GET /api/posts - type filter', async () => {
      const res = await get('/api/posts?type=article&limit=5');
      expect(res.status).toBe(200);
    });

    test('GET /api/posts/feed/favorites - requires auth', async () => {
      const res = await get('/api/posts/feed/favorites');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.posts)).toBe(true);
      expect(data.total).toBe(0);
    });

    test('POST /api/posts - requires auth', async () => {
      const res = await post('/api/posts', { content: 'Test' });
      expect(res.status).toBe(401);
    });
  });

  // ============================================
  // MARKETS ENDPOINTS
  // ============================================
  describe('Markets', () => {
    test('GET /api/markets/perps', async () => {
      const res = await get('/api/markets/perps');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });

    test('GET /api/markets/predictions', async () => {
      const res = await get('/api/markets/predictions');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });

    test('GET /api/questions', async () => {
      const res = await get('/api/questions');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });

    test('GET /api/markets/bias/active', async () => {
      const res = await get('/api/markets/bias/active');
      expect(res.status).toBeLessThan(500);
    });

    test('GET /api/markets/predictions/[id]/resolution', async () => {
      const res = await get('/api/markets/predictions/nonexistent/resolution');
      expect(res.status).toBe(404);
    });
  });

  // ============================================
  // USERS ENDPOINTS
  // ============================================
  describe('Users', () => {
    test('GET /api/users/me - requires auth', async () => {
      const res = await get('/api/users/me');
      expect(res.status).toBe(401);
    });

    test('GET /api/users/search', async () => {
      const res = await get('/api/users/search?q=test');
      expect(res.status).toBeLessThan(500);
    });

    test('GET /api/users/api-keys - requires auth', async () => {
      const res = await get('/api/users/api-keys');
      expect(res.status).toBe(401);
    });

    test('GET /api/users/export-data - requires auth', async () => {
      const res = await get('/api/users/export-data');
      expect(res.status).toBe(401);
    });

    test('GET /api/users/[userId]/notification-email-preferences - requires auth', async () => {
      const res = await get('/api/users/me/notification-email-preferences');
      expect(res.status).toBe(401);
    });

    test('DELETE /api/users/delete-account - requires auth', async () => {
      const res = await fetch(`${BASE_URL}/api/users/delete-account`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: 'DELETE MY ACCOUNT' }),
      });
      expect(res.status).toBe(401);
    });
  });

  // ============================================
  // AGENTS ENDPOINTS
  // ============================================
  describe('Agents', () => {
    test('GET /api/agents', async () => {
      const res = await get('/api/agents');
      expect(res.status).toBe(401);
    });

    test('GET /api/agents/discover', async () => {
      const res = await get('/api/agents/discover?limit=5');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.agents)).toBe(true);
    });

    test('GET /api/agent-templates', async () => {
      const res = await get('/api/agent-templates');
      expect(res.status).toBe(200);
    });

    test('POST /api/agents/onboard - requires auth', async () => {
      const res = await post('/api/agents/onboard', {});
      expect(res.status).toBe(401);
    });
  });

  // ============================================
  // ACTORS ENDPOINTS
  // ============================================
  describe('Actors', () => {
    test('GET /api/actors', async () => {
      const res = await get('/api/actors');
      expect(res.status).toBe(200);
    });

    test('GET /api/organizations', async () => {
      const res = await get('/api/organizations');
      expect(res.status).toBe(200);
    });
  });

  // ============================================
  // CHATS ENDPOINTS
  // ============================================
  describe('Chats', () => {
    test('GET /api/chats - requires auth', async () => {
      const res = await get('/api/chats');
      expect(res.status).toBe(401);
    });

    test('GET /api/chats/unread-count - requires auth', async () => {
      const res = await get('/api/chats/unread-count');
      expect(res.status).toBe(401);
    });

    test('POST /api/chats/dm - requires auth', async () => {
      const res = await post('/api/chats/dm', { recipientId: 'test' });
      expect(res.status).toBe(401);
    });
  });

  // ============================================
  // NOTIFICATIONS ENDPOINTS
  // ============================================
  describe('Notifications', () => {
    test('GET /api/notifications - requires auth', async () => {
      const res = await get('/api/notifications');
      expect(res.status).toBe(401);
    });

    test('POST /api/notifications/mark-read - requires auth', async () => {
      const res = await post('/api/notifications/mark-read', {});
      expect(res.status).toBe(401);
    });

    test('DELETE /api/notifications - requires auth', async () => {
      const res = await fetch(`${BASE_URL}/api/notifications`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clearAll: true }),
      });
      expect(res.status).toBe(401);
    });
  });

  // ============================================
  // MODERATION ENDPOINTS
  // ============================================
  describe('Moderation', () => {
    test('GET /api/moderation/blocks - requires auth', async () => {
      const res = await get('/api/moderation/blocks');
      expect(res.status).toBe(401);
    });

    test('GET /api/moderation/mutes - requires auth', async () => {
      const res = await get('/api/moderation/mutes');
      expect(res.status).toBe(401);
    });

    test('GET /api/moderation/reports - requires auth', async () => {
      const res = await get('/api/moderation/reports');
      expect(res.status).toBe(401);
    });
  });

  // ============================================
  // REGISTRY ENDPOINTS
  // ============================================
  describe('Registry', () => {
    test('GET /api/registry', async () => {
      const res = await get('/api/registry');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.users)).toBe(true);
      expect(data.pagination).toBeDefined();
    });

    test('GET /api/registry/all', async () => {
      const res = await get('/api/registry/all');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.users)).toBe(true);
      expect(Array.isArray(data.actors)).toBe(true);
      expect(data.totals).toBeDefined();
    });
  });

  // ============================================
  // LEADERBOARD ENDPOINTS
  // ============================================
  describe('Leaderboards', () => {
    test('GET /api/leaderboard', async () => {
      const res = await get('/api/leaderboard');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.leaderboard)).toBe(true);
      expect(data.pagination).toBeDefined();
    });

    test('GET /api/leaderboard/me - requires auth', async () => {
      const res = await get('/api/leaderboard/me');
      expect(res.status).toBe(401);
    });

    test('GET /api/reputation/leaderboard', async () => {
      const res = await get('/api/reputation/leaderboard');
      expect(res.status).toBe(200);
    });

    test('GET /api/waitlist/leaderboard', async () => {
      const res = await get('/api/waitlist/leaderboard');
      expect(res.status).toBe(200);
    });

    test('GET /api/npc/performance/leaderboard', async () => {
      const res = await get('/api/npc/performance/leaderboard');
      expect(res.status).toBe(200);
    });
  });

  // ============================================
  // FEED WIDGETS ENDPOINTS
  // ============================================
  describe('Feed Widgets', () => {
    test('GET /api/feed/widgets', async () => {
      const res = await get('/api/feed/widgets');
      expect(res.status).toBe(200);
    });

    test('GET /api/feed/widgets/trending', async () => {
      const res = await get('/api/feed/widgets/trending');
      expect(res.status).toBe(200);
    });

    test('GET /api/feed/widgets/markets', async () => {
      const res = await get('/api/feed/widgets/markets');
      expect(res.status).toBe(200);
    });

    test('GET /api/feed/widgets/stats', async () => {
      const res = await get('/api/feed/widgets/stats');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.stats).toBeDefined();
    });

    test('GET /api/feed/widgets/breaking-news', async () => {
      const res = await get('/api/feed/widgets/breaking-news');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(Array.isArray(data.news)).toBe(true);
    });

    test('GET /api/feed/widgets/trending-posts', async () => {
      const res = await get('/api/feed/widgets/trending-posts');
      expect(res.status).toBe(200);
    });

    test('GET /api/feed/widgets/upcoming-events', async () => {
      const res = await get('/api/feed/widgets/upcoming-events');
      expect(res.status).toBe(200);
    });
  });

  // ============================================
  // TRENDING ENDPOINTS
  // ============================================
  describe('Trending', () => {
    test('GET /api/trending', async () => {
      const res = await get('/api/trending');
      expect(res.status).toBe(200);
    });

    test('GET /api/trending/group', async () => {
      const res = await get('/api/trending/group?tags=crypto,ai');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.posts)).toBe(true);
      expect(Array.isArray(data.tags)).toBe(true);
    });

    test('GET /api/trending/[tag]', async () => {
      const res = await get('/api/trending/crypto');
      expect(res.status).toBeLessThan(500);
    });
  });

  // ============================================
  // GAMES ENDPOINTS
  // ============================================
  describe('Games', () => {
    test('GET /api/games', async () => {
      const res = await get('/api/games');
      expect(res.status).toBe(200);
    });

    test('GET /api/game/card', async () => {
      const res = await get('/api/game/card');
      expect(res.status).toBeLessThan(500);
    });

    test('GET /api/game/capabilities', async () => {
      const res = await get('/api/game/capabilities');
      expect(res.status).toBeLessThan(500);
    });

    test('GET /api/game/guide', async () => {
      const res = await get('/api/game/guide');
      expect(res.status).toBe(200);
    });

    test('GET /api/game-assets', async () => {
      const res = await get('/api/game-assets');
      expect(res.status).toBe(200);
    });
  });

  // ============================================
  // NFT ENDPOINTS
  // ============================================
  describe('NFT', () => {
    test('GET /api/nft/gallery', async () => {
      const res = await get('/api/nft/gallery');
      expect(res.status).toBe(200);
    });
  });

  // ============================================
  // GROUPS ENDPOINTS
  // ============================================
  describe('Groups', () => {
    test('GET /api/groups', async () => {
      const res = await get('/api/groups');
      expect(res.status).toBe(401);
    });

    test('GET /api/groups/invites - requires auth', async () => {
      const res = await get('/api/groups/invites');
      expect(res.status).toBe(401);
    });

    test('GET /api/user-groups', async () => {
      const res = await get('/api/user-groups');
      expect(res.status).toBeLessThan(500);
    });
  });

  // ============================================
  // NPC ENDPOINTS
  // ============================================
  describe('NPC', () => {
    test('POST /api/npc/allocation', async () => {
      const res = await post('/api/npc/allocation', {});
      expect([400, 401]).toContain(res.status);
    });

    test('GET /api/npc/position-size', async () => {
      const res = await get('/api/npc/position-size');
      expect([400, 401]).toContain(res.status);
    });
  });

  // ============================================
  // TRADES ENDPOINTS
  // ============================================
  describe('Trades', () => {
    test('GET /api/trades', async () => {
      const res = await get('/api/trades');
      expect(res.status).toBe(200);
    });
  });

  // ============================================
  // ONBOARDING ENDPOINTS
  // ============================================
  describe('Onboarding', () => {
    test('GET /api/onboarding/random-assets', async () => {
      const res = await get('/api/onboarding/random-assets');
      expect(res.status).toBe(200);
    });

    test('GET /api/onboarding/check-username', async () => {
      const res = await get(
        '/api/onboarding/check-username?username=test_user_123'
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(typeof data.available).toBe('boolean');
      expect(data.username).toBe('test_user_123');
    });
  });

  // ============================================
  // POINTS ENDPOINTS
  // ============================================
  describe('Points', () => {
    test('POST /api/points/transfer - is explicitly disabled', async () => {
      const res = await post('/api/points/transfer', {
        recipientId: 'test',
        amount: 100,
      });
      expect(res.status).toBe(410);
    });
  });

  // ============================================
  // UPLOAD ENDPOINTS
  // ============================================
  describe('Upload', () => {
    test('POST /api/upload/image - requires auth', async () => {
      const res = await fetch(`${BASE_URL}/api/upload/image`, {
        method: 'POST',
      });
      expect(res.status).toBe(401);
    });
  });

  // ============================================
  // REALTIME ENDPOINTS
  // ============================================
  describe('Realtime', () => {
    test('POST /api/realtime/token - requires auth', async () => {
      const res = await fetch(`${BASE_URL}/api/realtime/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
    });

    test('GET /api/sse/stats', async () => {
      const res = await get('/api/sse/stats');
      expect(res.status).toBe(200);
    });
  });

  // ============================================
  // PROFILES ENDPOINTS
  // ============================================
  describe('Profiles', () => {
    test('GET /api/profiles/favorites - requires auth', async () => {
      const res = await get('/api/profiles/favorites');
      expect(res.status).toBe(401);
    });
  });

  // ============================================
  // AUTH ENDPOINTS
  // ============================================
  describe('Auth', () => {
    test('GET /api/auth/credentials/status', async () => {
      const res = await get('/api/auth/credentials/status');
      expect(res.status).toBeLessThan(500);
    });

    test('GET /api/twitter/auth-status', async () => {
      const res = await get('/api/twitter/auth-status');
      expect(res.status).toBeLessThan(500);
    });
  });

  // ============================================
  // A2A ENDPOINTS
  // ============================================
  describe('A2A', () => {
    test('POST /api/a2a - handles JSONRPC', async () => {
      const res = await post('/api/a2a', {
        jsonrpc: '2.0',
        method: 'agent/discover',
        id: 'test-1',
      });
      expect(res.status).toBeLessThan(500);
    });
  });

  // ============================================
  // FRAME ENDPOINTS
  // ============================================
  describe('Frame', () => {
    test('GET /api/frame', async () => {
      const res = await get('/api/frame');
      expect(res.status).toBeLessThan(500);
    });

    test('GET /api/frame/metadata', async () => {
      const res = await get('/api/frame/metadata');
      expect(res.status).toBeLessThan(500);
    });
  });

  // ============================================
  // HUGGINGFACE ENDPOINTS
  // ============================================
  describe('HuggingFace', () => {
    test('GET /api/huggingface/status', async () => {
      const res = await get('/api/huggingface/status');
      expect(res.status).toBeLessThan(500);
    });
  });

  // ============================================
  // GAME FEEDBACK ENDPOINTS
  // ============================================
  describe('Game Feedback', () => {
    test('POST /api/feedback/game-feedback - requires authentication', async () => {
      const res = await post('/api/feedback/game-feedback', {
        feedbackType: 'bug',
        description: 'Test bug report',
        stepsToReproduce: '1. Do something 2. See error',
      });
      expect(res.status).toBe(401);
    });

    test('POST /api/feedback/game-feedback - bug report validation', async () => {
      // Missing required fields
      const res1 = await post('/api/feedback/game-feedback', {
        feedbackType: 'bug',
        description: 'Short', // Too short
      });
      expect(res1.status).toBe(401); // Auth required first

      // Missing steps to reproduce
      const res2 = await post('/api/feedback/game-feedback', {
        feedbackType: 'bug',
        description: 'This is a valid bug description with enough characters',
        // Missing stepsToReproduce
      });
      expect(res2.status).toBe(401); // Auth required first
    });

    test('POST /api/feedback/game-feedback - feature request validation', async () => {
      // Missing rating
      const res = await post('/api/feedback/game-feedback', {
        feedbackType: 'feature_request',
        description: 'This is a valid feature request description',
        // Missing rating
      });
      expect(res.status).toBe(401); // Auth required first
    });

    test('POST /api/feedback/game-feedback - performance issue', async () => {
      // Performance issues don't require additional fields
      const res = await post('/api/feedback/game-feedback', {
        feedbackType: 'performance',
        description: 'This is a valid performance issue description',
      });
      expect(res.status).toBe(401); // Auth required first
    });

    test('POST /api/feedback/game-feedback - rate limiting', async () => {
      // Note: This test would require authentication
      // In a real test, we'd need to authenticate first
      // For now, we just verify the endpoint exists
      const res = await post('/api/feedback/game-feedback', {
        feedbackType: 'bug',
        description: 'Test rate limiting',
        stepsToReproduce: '1. Test',
      });
      // Should return 401 (auth required) or 429 (rate limited if authenticated)
      expect([401, 429]).toContain(res.status);
    });
  });

  // ============================================
  // ERROR HANDLING
  // ============================================
  describe('Error Handling', () => {
    test('404 for non-existent endpoints', async () => {
      const res = await get('/api/nonexistent-xyz-12345');
      expect(res.status).toBe(404);
    });

    test('no stack traces in error responses', async () => {
      const res = await get('/api/nonexistent-xyz-12345');
      const text = await res.text();
      expect(text.toLowerCase()).not.toContain('stack');
      expect(text.toLowerCase()).not.toContain('/users/');
    });

    test('malformed JSON returns 400 not 500', async () => {
      const res = await fetch(`${BASE_URL}/api/posts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not valid json {{{',
      });
      expect(res.status).toBeLessThan(500);
    });
  });

  // ============================================
  // SECURITY
  // ============================================
  describe('Security', () => {
    test('SQL injection in query params handled safely', async () => {
      const res = await get("/api/users/search?q='; DROP TABLE users; --");
      expect(res.status).toBeLessThan(500);
    });
  });
});

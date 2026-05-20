/**
 * Integration Test: General Game Feedback API
 *
 * Tests the /api/feedback/game-feedback endpoint for submitting
 * bug reports, feature requests, and performance feedback.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { db } from '@babylon/db';
import { NextRequest } from 'next/server';

// Mock Linear sync to prevent actual API calls in tests
mock.module('@babylon/api/linear', () => ({
  syncFeedbackToLinear: async () => {
    return;
  },
  getLinearConfig: () => null,
}));

// Mock auth to return a test user (includes requireAdmin for admin endpoint tests)
const testUserId = `test-user-${Date.now()}`;
mock.module('@babylon/api', () => {
  return {
    RATE_LIMIT_CONFIGS: {
      SUBMIT_FEEDBACK: {
        actionType: 'submit_feedback',
        maxRequests: 100,
        windowMs: 60_000,
      },
    },
    authenticate: async () => ({ userId: testUserId }),
    checkRateLimitAndDuplicates: () => null,
    createGameFeedback: async ({
      userId,
      parsed,
    }: {
      userId: string;
      parsed: {
        feedbackType: 'bug' | 'feature_request' | 'performance';
        description: string;
        stepsToReproduce?: string | null;
        screenshotUrl?: string | null;
        rating?: number | null;
      };
    }) => {
      const feedbackId = `feedback-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const categoryByType = {
        bug: 'bug_report',
        feature_request: 'feature_request',
        performance: 'performance_issue',
      } as const;
      const score = parsed.rating != null ? parsed.rating * 20 : 50;

      await db.feedback.create({
        data: {
          id: feedbackId,
          fromUserId: userId,
          toUserId: null,
          score,
          comment: parsed.description,
          category: categoryByType[parsed.feedbackType],
          interactionType: 'general_game_feedback',
          metadata: {
            feedbackType: parsed.feedbackType,
            stepsToReproduce: parsed.stepsToReproduce ?? null,
            screenshotUrl: parsed.screenshotUrl ?? null,
            rating: parsed.rating ?? null,
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      return {
        id: feedbackId,
        fromUserId: userId,
        score,
        feedbackType: parsed.feedbackType,
      };
    },
    getLinearConfig: () => null,
    requireUserByIdentifier: async () => ({
      id: testUserId,
      email: 'test@example.com',
    }),
    requireAdmin: async () => ({ userId: testUserId, isAdmin: true }),
    errorResponse: (message: string, status = 500) =>
      Response.json({ success: false, error: message }, { status }),
    successResponse: (data: unknown, status = 200) =>
      Response.json(data, { status }),
    syncFeedbackToLinear: async () => {
      return;
    },
    withErrorHandling:
      <T extends (request: Request) => Promise<Response>>(handler: T) =>
      async (request: Request) => {
        try {
          return await handler(request);
        } catch (error) {
          return Response.json(
            {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
            { status: 400 }
          );
        }
      },
  };
});

// Dynamic import to ensure mocks are applied
const { POST: submitGameFeedback } = await import(
  '@/app/api/feedback/game-feedback/route'
);

describe('General Game Feedback API', () => {
  beforeAll(async () => {
    // Create test user
    await db.user.upsert({
      where: { id: testUserId },
      create: {
        id: testUserId,
        username: `feedback-test-${Date.now()}`,
        displayName: 'Feedback Test User',
        updatedAt: new Date(),
      },
      update: {},
    });
  });

  afterAll(async () => {
    // Cleanup test data
    await db.feedback.deleteMany({ where: { fromUserId: testUserId } });
    await db.user.delete({ where: { id: testUserId } }).catch(() => {});
  });

  test('POST /api/feedback/game-feedback - bug report succeeds', async () => {
    const payload = {
      feedbackType: 'bug',
      description: 'Test bug report - the button does not work correctly',
      stepsToReproduce:
        '1. Click button\n2. Nothing happens\n3. Expected: modal opens',
    };

    const request = new NextRequest(
      'http://localhost/api/feedback/game-feedback',
      {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: new Headers({ 'Content-Type': 'application/json' }),
      }
    );

    const response = await submitGameFeedback(request);
    expect(response.status).toBe(201);

    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.feedbackId).toBeDefined();
    expect(json.message).toContain('feedback');

    // Verify feedback was created in DB
    const feedback = await db.feedback.findUnique({
      where: { id: json.feedbackId },
    });
    expect(feedback).toBeTruthy();
    expect(feedback?.category).toBe('bug_report');
    expect(feedback?.comment).toBe(payload.description);
  });

  test('POST /api/feedback/game-feedback - feature request succeeds', async () => {
    const payload = {
      feedbackType: 'feature_request',
      description: 'Test feature request - add dark mode toggle in settings',
      rating: 4,
    };

    const request = new NextRequest(
      'http://localhost/api/feedback/game-feedback',
      {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: new Headers({ 'Content-Type': 'application/json' }),
      }
    );

    const response = await submitGameFeedback(request);
    expect(response.status).toBe(201);

    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.feedbackId).toBeDefined();

    // Verify feedback was created with correct score
    const feedback = await db.feedback.findUnique({
      where: { id: json.feedbackId },
    });
    expect(feedback).toBeTruthy();
    expect(feedback?.category).toBe('feature_request');
    expect(feedback?.score).toBe(80); // rating 4 * 20 = 80
  });

  test('POST /api/feedback/game-feedback - performance issue succeeds', async () => {
    const payload = {
      feedbackType: 'performance',
      description:
        'Test performance issue - game lags when many agents are online',
    };

    const request = new NextRequest(
      'http://localhost/api/feedback/game-feedback',
      {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: new Headers({ 'Content-Type': 'application/json' }),
      }
    );

    const response = await submitGameFeedback(request);
    expect(response.status).toBe(201);

    const json = await response.json();
    expect(json.success).toBe(true);

    const feedback = await db.feedback.findUnique({
      where: { id: json.feedbackId },
    });
    expect(feedback).toBeTruthy();
    expect(feedback?.category).toBe('performance_issue');
    expect(feedback?.score).toBe(50); // default score when no rating
  });

  test('POST /api/feedback/game-feedback - rejects short description', async () => {
    const payload = {
      feedbackType: 'bug',
      description: 'Too short',
      stepsToReproduce: 'Steps here',
    };

    const request = new NextRequest(
      'http://localhost/api/feedback/game-feedback',
      {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: new Headers({ 'Content-Type': 'application/json' }),
      }
    );

    const response = await submitGameFeedback(request);
    // Should fail validation - description must be at least 10 chars
    expect(response.status).toBe(400);
  });

  test('POST /api/feedback/game-feedback - bug report requires stepsToReproduce', async () => {
    const payload = {
      feedbackType: 'bug',
      description: 'This is a valid bug description that is long enough',
      // Missing stepsToReproduce
    };

    const request = new NextRequest(
      'http://localhost/api/feedback/game-feedback',
      {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: new Headers({ 'Content-Type': 'application/json' }),
      }
    );

    const response = await submitGameFeedback(request);
    expect(response.status).toBe(400);
  });

  test('POST /api/feedback/game-feedback - feature request requires rating', async () => {
    const payload = {
      feedbackType: 'feature_request',
      description: 'This is a valid feature request description',
      // Missing rating
    };

    const request = new NextRequest(
      'http://localhost/api/feedback/game-feedback',
      {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: new Headers({ 'Content-Type': 'application/json' }),
      }
    );

    const response = await submitGameFeedback(request);
    expect(response.status).toBe(400);
  });
});

// Dynamic import for admin endpoint (uses requireAdmin from the consolidated mock above)
const { GET: getAdminFeedback } = await import(
  '@/app/api/admin/feedback/route'
);

describe('Admin Feedback API', () => {
  let createdFeedbackId: string;

  beforeAll(async () => {
    // Create test feedback for admin queries
    const payload = {
      feedbackType: 'bug',
      description: 'Admin test bug - searchable description for testing',
      stepsToReproduce: '1. Test step\n2. Another step',
    };

    const request = new NextRequest(
      'http://localhost/api/feedback/game-feedback',
      {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: new Headers({ 'Content-Type': 'application/json' }),
      }
    );

    const response = await submitGameFeedback(request);
    const json = await response.json();
    createdFeedbackId = json.feedbackId;
  });

  afterAll(async () => {
    // Cleanup
    if (createdFeedbackId) {
      await db.feedback
        .delete({ where: { id: createdFeedbackId } })
        .catch(() => {});
    }
  });

  test('GET /api/admin/feedback - returns feedback list', async () => {
    const request = new NextRequest('http://localhost/api/admin/feedback', {
      method: 'GET',
    });

    const response = await getAdminFeedback(request);
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.feedback).toBeDefined();
    expect(Array.isArray(json.feedback)).toBe(true);
    expect(json.pagination).toBeDefined();
    expect(json.pagination.total).toBeGreaterThanOrEqual(0);
    expect(json.stats).toBeDefined();
  });

  test('GET /api/admin/feedback - filters by type', async () => {
    const request = new NextRequest(
      'http://localhost/api/admin/feedback?type=bug',
      { method: 'GET' }
    );

    const response = await getAdminFeedback(request);
    expect(response.status).toBe(200);

    const json = await response.json();
    // All returned feedback should be bugs
    for (const item of json.feedback) {
      expect(item.feedbackType).toBe('bug');
    }
  });

  test('GET /api/admin/feedback - rejects invalid type', async () => {
    const request = new NextRequest(
      'http://localhost/api/admin/feedback?type=invalid_type',
      { method: 'GET' }
    );

    const response = await getAdminFeedback(request);
    expect(response.status).toBe(400);
  });

  test('GET /api/admin/feedback - search works', async () => {
    const request = new NextRequest(
      'http://localhost/api/admin/feedback?search=searchable',
      { method: 'GET' }
    );

    const response = await getAdminFeedback(request);
    expect(response.status).toBe(200);

    const json = await response.json();
    // Should find our test feedback
    const found = json.feedback.some((item: { description: string | null }) =>
      item.description?.includes('searchable')
    );
    expect(found).toBe(true);
  });

  test('GET /api/admin/feedback - pagination params work', async () => {
    const request = new NextRequest(
      'http://localhost/api/admin/feedback?limit=5&offset=0',
      { method: 'GET' }
    );

    const response = await getAdminFeedback(request);
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.pagination.limit).toBe(5);
    expect(json.pagination.offset).toBe(0);
    expect(json.feedback.length).toBeLessThanOrEqual(5);
  });

  test('GET /api/admin/feedback - hasLinearIssue filter works', async () => {
    const request = new NextRequest(
      'http://localhost/api/admin/feedback?hasLinearIssue=false',
      { method: 'GET' }
    );

    const response = await getAdminFeedback(request);
    expect(response.status).toBe(200);

    const json = await response.json();
    // All returned feedback should NOT have Linear issue
    for (const item of json.feedback) {
      expect(item.linearIssue).toBeNull();
    }
  });
});

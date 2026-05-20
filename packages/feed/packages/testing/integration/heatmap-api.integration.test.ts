/**
 * Heatmap API Integration Tests
 *
 * Tests the /api/admin/stats/heatmap endpoint that provides:
 * - Hourly heatmap (activity by hour × day of week)
 * - Calendar heatmap (daily activity counts)
 *
 * Run: bun test integration/heatmap-api.integration.test.ts --preload ./integration/preload.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  getAdminToken,
  requireAuth as requireAuthShared,
  requireServer as requireServerShared,
} from './helpers';

const BASE_URL =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://localhost:3000';

let serverAvailable = false;
let devAdminToken: string | null = null;

function requireServer(): void {
  requireServerShared(serverAvailable, BASE_URL);
}

function requireAuth(): void {
  requireAuthShared(serverAvailable, devAdminToken, BASE_URL);
}

async function adminRequest(path: string, options: RequestInit = {}) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (devAdminToken) headers['x-dev-admin-token'] = devAdminToken;

  return fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
    signal: AbortSignal.timeout(30000),
  });
}

async function publicRequest(path: string, options: RequestInit = {}) {
  return fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    },
    signal: AbortSignal.timeout(15000),
  });
}

describe('Heatmap API', () => {
  beforeAll(async () => {
    try {
      const response = await fetch(`${BASE_URL}/api/health`, {
        signal: AbortSignal.timeout(5000),
      });
      serverAvailable = response.ok;
      console.log(
        `Server availability: ${serverAvailable ? 'Available' : 'Unavailable'}`
      );
    } catch {
      serverAvailable = false;
      console.log('Server not available - tests will be skipped');
    }

    devAdminToken = getAdminToken();
  });

  afterAll(async () => {
    // No test data to clean up - this endpoint is read-only
  });

  describe('Authentication', () => {
    test('requires authentication', async () => {
      requireServer();

      const res = await publicRequest('/api/admin/stats/heatmap');
      expect(res.status).toBe(401);

      const data = await res.json();
      expect(data.error).toBeDefined();
    });

    test('accepts valid dev admin token', async () => {
      requireAuth();

      const res = await adminRequest('/api/admin/stats/heatmap');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.type).toBe('hourly');
      expect(Array.isArray(data.data)).toBe(true);
    });
  });

  describe('Hourly Heatmap', () => {
    test('returns complete hourly heatmap structure', async () => {
      requireAuth();

      const res = await adminRequest('/api/admin/stats/heatmap?type=hourly');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.type).toBe('hourly');
      expect(data.activityType).toBeDefined();
      expect(Array.isArray(data.data)).toBe(true);

      // Should have 7 * 24 = 168 data points (one per hour per day)
      expect(data.data.length).toBe(168);

      // Verify structure of each data point
      for (const point of data.data) {
        expect(typeof point.dayOfWeek).toBe('number');
        expect(point.dayOfWeek).toBeGreaterThanOrEqual(0);
        expect(point.dayOfWeek).toBeLessThanOrEqual(6);
        expect(typeof point.hour).toBe('number');
        expect(point.hour).toBeGreaterThanOrEqual(0);
        expect(point.hour).toBeLessThanOrEqual(23);
        expect(typeof point.count).toBe('number');
        expect(point.count).toBeGreaterThanOrEqual(0);
        expect(typeof point.intensity).toBe('number');
        expect(point.intensity).toBeGreaterThanOrEqual(0);
        expect(point.intensity).toBeLessThanOrEqual(1);
      }

      // Verify metadata
      expect(data.metadata).toBeDefined();
      expect(data.metadata.startDate).toBeDefined();
      expect(data.metadata.endDate).toBeDefined();
      expect(typeof data.metadata.maxCount).toBe('number');
      expect(typeof data.metadata.totalActivities).toBe('number');
    });

    test('covers all 24 hours for each day', async () => {
      requireAuth();

      const res = await adminRequest('/api/admin/stats/heatmap?type=hourly');
      const data = await res.json();

      // Create a map of day -> hours
      const dayHours = new Map<number, Set<number>>();
      for (const point of data.data) {
        if (!dayHours.has(point.dayOfWeek)) {
          dayHours.set(point.dayOfWeek, new Set());
        }
        dayHours.get(point.dayOfWeek)!.add(point.hour);
      }

      // Each day should have all 24 hours
      for (let day = 0; day < 7; day++) {
        expect(dayHours.has(day)).toBe(true);
        expect(dayHours.get(day)!.size).toBe(24);
      }
    });

    test('intensity is 0 when count is 0', async () => {
      requireAuth();

      const res = await adminRequest('/api/admin/stats/heatmap?type=hourly');
      const data = await res.json();

      for (const point of data.data) {
        if (point.count === 0) {
          expect(point.intensity).toBe(0);
        }
      }
    });

    test('max intensity is 1 at peak count', async () => {
      requireAuth();

      const res = await adminRequest('/api/admin/stats/heatmap?type=hourly');
      const data = await res.json();

      const maxCount = data.metadata.maxCount;
      if (maxCount > 0) {
        // At least one point should have intensity 1
        const hasMaxIntensity = data.data.some(
          (p: { count: number; intensity: number }) =>
            p.count === maxCount && p.intensity === 1
        );
        expect(hasMaxIntensity).toBe(true);
      }
    });
  });

  describe('Calendar Heatmap', () => {
    test('returns complete calendar heatmap structure', async () => {
      requireAuth();

      const res = await adminRequest('/api/admin/stats/heatmap?type=calendar');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.type).toBe('calendar');
      expect(data.activityType).toBeDefined();
      expect(Array.isArray(data.data)).toBe(true);

      // Verify structure of each data point
      for (const point of data.data) {
        expect(point.date).toBeDefined();
        // Date should be in YYYY-MM-DD format
        expect(point.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(typeof point.count).toBe('number');
        expect(point.count).toBeGreaterThanOrEqual(0);
        expect(typeof point.intensity).toBe('number');
        expect(point.intensity).toBeGreaterThanOrEqual(0);
        expect(point.intensity).toBeLessThanOrEqual(1);
      }

      // Verify metadata
      expect(data.metadata).toBeDefined();
      expect(data.metadata.startDate).toBeDefined();
      expect(data.metadata.endDate).toBeDefined();
      expect(typeof data.metadata.maxCount).toBe('number');
      expect(typeof data.metadata.totalActivities).toBe('number');
      expect(typeof data.metadata.daysWithActivity).toBe('number');
    });

    test('dates are in chronological order', async () => {
      requireAuth();

      const res = await adminRequest('/api/admin/stats/heatmap?type=calendar');
      const data = await res.json();

      if (data.data.length >= 2) {
        for (let i = 1; i < data.data.length; i++) {
          const prev = new Date(data.data[i - 1].date);
          const curr = new Date(data.data[i].date);
          expect(curr.getTime()).toBeGreaterThanOrEqual(prev.getTime());
        }
      }
    });

    test('daysWithActivity matches data length', async () => {
      requireAuth();

      const res = await adminRequest('/api/admin/stats/heatmap?type=calendar');
      const data = await res.json();

      expect(data.metadata.daysWithActivity).toBe(data.data.length);
    });
  });

  describe('Activity Type Filter', () => {
    const activityTypes = ['all', 'trades', 'posts', 'messages'];

    for (const activityType of activityTypes) {
      test(`accepts ${activityType} activity type for hourly`, async () => {
        requireAuth();

        const res = await adminRequest(
          `/api/admin/stats/heatmap?type=hourly&activityType=${activityType}`
        );
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.type).toBe('hourly');
        expect(data.activityType).toBe(activityType);
      });

      test(`accepts ${activityType} activity type for calendar`, async () => {
        requireAuth();

        const res = await adminRequest(
          `/api/admin/stats/heatmap?type=calendar&activityType=${activityType}`
        );
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.type).toBe('calendar');
        expect(data.activityType).toBe(activityType);
      });
    }

    test('defaults to "all" for invalid activity type', async () => {
      requireAuth();

      const res = await adminRequest(
        '/api/admin/stats/heatmap?activityType=invalid'
      );
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.activityType).toBe('all');
    });
  });

  describe('Type Parameter', () => {
    test('defaults to hourly when type not specified', async () => {
      requireAuth();

      const res = await adminRequest('/api/admin/stats/heatmap');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.type).toBe('hourly');
    });

    test('defaults to hourly for invalid type', async () => {
      requireAuth();

      const res = await adminRequest('/api/admin/stats/heatmap?type=invalid');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.type).toBe('hourly');
    });
  });

  describe('Date Range Parameters', () => {
    test('accepts custom date range', async () => {
      requireAuth();

      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

      const res = await adminRequest(
        `/api/admin/stats/heatmap?startDate=${startDate.toISOString()}&endDate=${endDate.toISOString()}`
      );
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(new Date(data.metadata.startDate).getTime()).toBeCloseTo(
        startDate.getTime(),
        -3
      );
      expect(new Date(data.metadata.endDate).getTime()).toBeCloseTo(
        endDate.getTime(),
        -3
      );
    });

    test('uses default 90 days when dates not specified', async () => {
      requireAuth();

      const res = await adminRequest('/api/admin/stats/heatmap');
      const data = await res.json();

      const startDate = new Date(data.metadata.startDate);
      const endDate = new Date(data.metadata.endDate);
      const daysDiff =
        (endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000);

      // Should be approximately 90 days
      expect(daysDiff).toBeGreaterThan(85);
      expect(daysDiff).toBeLessThan(95);
    });

    test('handles invalid date format gracefully', async () => {
      requireAuth();

      const res = await adminRequest(
        '/api/admin/stats/heatmap?startDate=not-a-date'
      );
      // Should still succeed with null date
      expect(res.status).toBe(200);
    });
  });

  describe('Data Consistency', () => {
    test('totalActivities equals sum of counts', async () => {
      requireAuth();

      const res = await adminRequest('/api/admin/stats/heatmap?type=hourly');
      const data = await res.json();

      const calculatedTotal = data.data.reduce(
        (sum: number, point: { count: number }) => sum + point.count,
        0
      );
      expect(data.metadata.totalActivities).toBe(calculatedTotal);
    });

    test('maxCount matches highest count in data', async () => {
      requireAuth();

      const res = await adminRequest('/api/admin/stats/heatmap?type=hourly');
      const data = await res.json();

      const calculatedMax = Math.max(
        0,
        ...data.data.map((point: { count: number }) => point.count)
      );
      expect(data.metadata.maxCount).toBe(calculatedMax);
    });

    test('same activity type gives consistent results', async () => {
      requireAuth();

      const res1 = await adminRequest(
        '/api/admin/stats/heatmap?type=hourly&activityType=trades'
      );
      const res2 = await adminRequest(
        '/api/admin/stats/heatmap?type=hourly&activityType=trades'
      );

      const data1 = await res1.json();
      const data2 = await res2.json();

      // Total should be the same (or very close if data changes during test)
      expect(data1.metadata.totalActivities).toBe(
        data2.metadata.totalActivities
      );
    });
  });

  describe('Edge Cases', () => {
    test('handles empty activity gracefully', async () => {
      requireAuth();

      // Use a far future date range where there's no data
      const futureDate = new Date('2030-01-01');
      const res = await adminRequest(
        `/api/admin/stats/heatmap?type=calendar&startDate=${futureDate.toISOString()}&endDate=${futureDate.toISOString()}`
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.data)).toBe(true);
    });

    test('handles concurrent requests', async () => {
      requireAuth();

      const requests = [
        adminRequest('/api/admin/stats/heatmap?type=hourly&activityType=all'),
        adminRequest(
          '/api/admin/stats/heatmap?type=hourly&activityType=trades'
        ),
        adminRequest(
          '/api/admin/stats/heatmap?type=calendar&activityType=posts'
        ),
        adminRequest(
          '/api/admin/stats/heatmap?type=calendar&activityType=messages'
        ),
      ];

      const responses = await Promise.all(requests);

      for (const res of responses) {
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.metadata).toBeDefined();
      }
    });

    test('very long query parameters are handled safely', async () => {
      requireAuth();

      const longValue = 'a'.repeat(10000);
      const res = await adminRequest(
        `/api/admin/stats/heatmap?type=${longValue}`
      );

      expect(res.status).toBeLessThan(500);
    });
  });

  describe('Intensity Calculation', () => {
    test('intensity scales correctly between 0 and 1', async () => {
      requireAuth();

      const res = await adminRequest('/api/admin/stats/heatmap?type=hourly');
      const data = await res.json();

      const maxCount = data.metadata.maxCount;
      if (maxCount > 0) {
        for (const point of data.data) {
          const expectedIntensity = point.count / maxCount;
          expect(point.intensity).toBeCloseTo(expectedIntensity, 10);
        }
      }
    });

    test('all intensities are 0 when maxCount is 0', async () => {
      requireAuth();

      const res = await adminRequest('/api/admin/stats/heatmap?type=hourly');
      const data = await res.json();

      if (data.metadata.maxCount === 0) {
        for (const point of data.data) {
          expect(point.intensity).toBe(0);
        }
      }
    });
  });
});

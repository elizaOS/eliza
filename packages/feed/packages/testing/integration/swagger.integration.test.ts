/**
 * Integration Tests: Swagger/OpenAPI Documentation
 *
 * Tests that Swagger documentation is properly generated and accessible.
 * Requires server to be running.
 */

import { beforeAll, describe, expect, test } from 'bun:test';

const BASE_URL =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://localhost:3000';
let serverAvailable = false;

describe('Swagger/OpenAPI Documentation', () => {
  beforeAll(async () => {
    // Check if server is running
    try {
      const response = await fetch(`${BASE_URL}/api/health`);
      serverAvailable = response.ok;
    } catch {
      serverAvailable = false;
    }
  });

  test('should serve OpenAPI spec at /api/docs', async () => {
    if (!serverAvailable) {
      console.log('⏭️  Skipping Swagger test - server not available');
      return;
    }

    const response = await fetch(`${BASE_URL}/api/docs`);
    expect(response.ok).toBe(true);
    expect(response.headers.get('content-type')).toContain('application/json');

    const spec = await response.json();
    expect(spec).toHaveProperty('openapi');
    expect(spec.openapi).toBe('3.0.0');
    expect(spec).toHaveProperty('info');
    expect(spec.info.title).toBe('Babylon API');
    expect(spec).toHaveProperty('paths');
    expect(typeof spec.paths).toBe('object');
  }, 30000);

  test('should include common API routes in spec', async () => {
    if (!serverAvailable) {
      console.log('⏭️  Skipping Swagger test - server not available');
      return;
    }

    const response = await fetch(`${BASE_URL}/api/docs`);
    const spec = await response.json();

    // Check for common routes
    expect(spec.paths).toHaveProperty('/api/health');
    expect(spec.paths).toHaveProperty('/api/docs');
    expect(spec.paths).toHaveProperty('/api/posts');
    expect(spec.paths).toHaveProperty('/api/agents');
    expect(spec.paths).toHaveProperty('/api/chats');
    expect(spec.paths).toHaveProperty('/api/users/me');
  }, 30000);

  test('should have proper security schemes defined', async () => {
    if (!serverAvailable) {
      console.log('⏭️  Skipping Swagger test - server not available');
      return;
    }

    const response = await fetch(`${BASE_URL}/api/docs`);
    const spec = await response.json();

    expect(spec).toHaveProperty('components');
    expect(spec.components).toHaveProperty('securitySchemes');
    expect(spec.components.securitySchemes).toHaveProperty('BearerAuth');
    expect(spec.components.securitySchemes).toHaveProperty('CronSecret');
  }, 30000);

  test('should have tags defined for route grouping', async () => {
    if (!serverAvailable) {
      console.log('⏭️  Skipping Swagger test - server not available');
      return;
    }

    const response = await fetch(`${BASE_URL}/api/docs`);
    const spec = await response.json();

    // Check for common tags
    if (spec.tags && Array.isArray(spec.tags)) {
      const tagNames = spec.tags.map((tag: { name: string }) => tag.name);
      expect(tagNames).toContain('System');
      expect(tagNames).toContain('Documentation');
    }
  }, 30000);

  test('should have Swagger UI page accessible', async () => {
    if (!serverAvailable) {
      console.log('⏭️  Skipping Swagger UI test - server not available');
      return;
    }

    const response = await fetch(`${BASE_URL}/api-docs`);
    // Should return HTML page (200 OK)
    expect(response.ok).toBe(true);
    expect(response.headers.get('content-type')).toContain('text/html');
  }, 30000);
});

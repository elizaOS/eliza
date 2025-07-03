/**
 * Version endpoint tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import express from 'express';
import { createVersionRouter } from '../version';
import packageJson from '../../../../package.json';

describe('Version API', () => {
  let app: express.Application;
  let server: any;
  let port: number;

  // Helper function to make requests
  const getVersion = async () => {
    const response = await fetch(`http://localhost:${port}/api/system/version`);
    return {
      status: response.status,
      body: await response.json(),
    };
  };

  // Helper for non-GET requests
  const makeRequest = async (method: string, path: string = '/api/system/version') => {
    const response = await fetch(`http://localhost:${port}${path}`, { method });
    return response;
  };

  beforeEach((done) => {
    app = express();
    app.use('/api/system/version', createVersionRouter());

    // Find an available port
    server = app.listen(0, () => {
      port = server.address().port;
      done();
    });
  });

  afterEach((done) => {
    server.close(done);
  });

  describe('GET /api/system/version', () => {
    it('should return version information with status 200', async () => {
      const { status, body } = await getVersion();

      expect(status).toBe(200);
      expect(body).toHaveProperty('version');
      expect(body).toHaveProperty('source');
      expect(body).toHaveProperty('timestamp');
      expect(body).toHaveProperty('environment');
      expect(body).toHaveProperty('uptime');
      expect(body.error).toBeUndefined();
    });

    it('should return the correct version from package.json', async () => {
      const { body } = await getVersion();
      expect(body.version).toBe(packageJson.version);
    });

    it('should return source as "server"', async () => {
      const { body } = await getVersion();
      expect(body.source).toBe('server');
    });

    it('should return a valid ISO timestamp', async () => {
      const { body } = await getVersion();
      const timestamp = new Date(body.timestamp);
      expect(timestamp.toISOString()).toBe(body.timestamp);
      expect(timestamp.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('should return the correct environment', async () => {
      const originalEnv = process.env.NODE_ENV;

      // Test default environment
      delete process.env.NODE_ENV;
      const { body: body1 } = await getVersion();
      expect(body1.environment).toBe('development');

      // Test production environment
      process.env.NODE_ENV = 'production';
      const { body: body2 } = await getVersion();
      expect(body2.environment).toBe('production');

      // Restore original environment
      process.env.NODE_ENV = originalEnv;
    });

    it('should return a numeric uptime value', async () => {
      const { body } = await getVersion();
      expect(typeof body.uptime).toBe('number');
      expect(body.uptime).toBeGreaterThan(0);
      expect(body.uptime).toBeLessThanOrEqual(process.uptime());
    });

    it('should handle multiple concurrent requests', async () => {
      const requests = Array(10)
        .fill(null)
        .map(() => getVersion());
      const results = await Promise.all(requests);

      results.forEach(({ status, body }) => {
        expect(status).toBe(200);
        expect(body.version).toBe(packageJson.version);
        expect(body.source).toBe('server');
      });
    });

    it('should return consistent data structure', async () => {
      const { body } = await getVersion();
      const keys = Object.keys(body).sort();
      expect(keys).toEqual(['environment', 'source', 'timestamp', 'uptime', 'version']);
    });
  });

  describe('Error handling', () => {
    it('should handle non-existent routes', async () => {
      const response = await makeRequest('GET', '/api/system/version/invalid');
      expect(response.status).toBe(404);
    });

    it('should only accept GET requests', async () => {
      const methods = ['POST', 'PUT', 'DELETE'];

      for (const method of methods) {
        const response = await makeRequest(method);
        expect(response.status).toBe(404);
      }
    });
  });
});

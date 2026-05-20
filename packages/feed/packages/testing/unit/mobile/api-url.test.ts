import { afterEach, describe, expect, it } from 'bun:test';

/**
 * Tests for the apiUrl() utility that resolves relative API paths
 * to absolute URLs for cross-origin mobile support.
 *
 * The function reads NEXT_PUBLIC_API_URL at module load time, so we
 * need to set the env var BEFORE importing. We use dynamic import
 * + cache busting to test different env configurations.
 */

// Helper: import a fresh copy of apiUrl with a specific env var value
async function importApiUrl(
  baseUrl: string | undefined
): Promise<(path: string) => string> {
  // Set env before import
  if (baseUrl !== undefined) {
    process.env.NEXT_PUBLIC_API_URL = baseUrl;
  } else {
    delete process.env.NEXT_PUBLIC_API_URL;
  }

  // Bust the module cache so the env var is re-read
  const cacheBuster = `?t=${Date.now()}-${Math.random()}`;
  const mod = await import(
    `../../../../apps/web/src/utils/api-url.ts${cacheBuster}`
  );
  return mod.apiUrl;
}

describe('apiUrl', () => {
  const originalEnv = process.env.NEXT_PUBLIC_API_URL;

  afterEach(() => {
    // Restore original env
    if (originalEnv !== undefined) {
      process.env.NEXT_PUBLIC_API_URL = originalEnv;
    } else {
      delete process.env.NEXT_PUBLIC_API_URL;
    }
  });

  describe('when NEXT_PUBLIC_API_URL is not set (web mode)', () => {
    it('returns relative paths unchanged', async () => {
      const apiUrl = await importApiUrl(undefined);
      expect(apiUrl('/api/posts')).toBe('/api/posts');
    });

    it('returns root path unchanged', async () => {
      const apiUrl = await importApiUrl(undefined);
      expect(apiUrl('/')).toBe('/');
    });

    it('returns empty string unchanged', async () => {
      const apiUrl = await importApiUrl(undefined);
      expect(apiUrl('')).toBe('');
    });

    it('returns absolute URLs unchanged', async () => {
      const apiUrl = await importApiUrl(undefined);
      expect(apiUrl('https://example.com/foo')).toBe('https://example.com/foo');
    });
  });

  describe('when NEXT_PUBLIC_API_URL is empty string', () => {
    it('returns paths unchanged', async () => {
      const apiUrl = await importApiUrl('');
      expect(apiUrl('/api/posts')).toBe('/api/posts');
    });
  });

  describe('when NEXT_PUBLIC_API_URL is set (mobile mode)', () => {
    it('prepends base URL to relative paths', async () => {
      const apiUrl = await importApiUrl('https://play.feed.market');
      expect(apiUrl('/api/posts')).toBe(
        'https://play.feed.market/api/posts'
      );
    });

    it('prepends base URL to paths with query params', async () => {
      const apiUrl = await importApiUrl('https://play.feed.market');
      expect(apiUrl('/api/posts?limit=10&cursor=abc')).toBe(
        'https://play.feed.market/api/posts?limit=10&cursor=abc'
      );
    });

    it('does not double-prefix absolute http URLs', async () => {
      const apiUrl = await importApiUrl('https://play.feed.market');
      expect(apiUrl('https://other.com/api/foo')).toBe(
        'https://other.com/api/foo'
      );
    });

    it('does not double-prefix absolute https URLs', async () => {
      const apiUrl = await importApiUrl('https://play.feed.market');
      expect(apiUrl('http://localhost:3000/api/foo')).toBe(
        'http://localhost:3000/api/foo'
      );
    });

    it('strips trailing slashes from base URL', async () => {
      const apiUrl = await importApiUrl('https://play.feed.market/');
      expect(apiUrl('/api/posts')).toBe(
        'https://play.feed.market/api/posts'
      );
    });

    it('strips multiple trailing slashes from base URL', async () => {
      const apiUrl = await importApiUrl('https://play.feed.market///');
      expect(apiUrl('/api/posts')).toBe(
        'https://play.feed.market/api/posts'
      );
    });

    it('handles staging URL', async () => {
      const apiUrl = await importApiUrl('https://staging.feed.market');
      expect(apiUrl('/api/health')).toBe(
        'https://staging.feed.market/api/health'
      );
    });

    it('handles path without leading slash', async () => {
      const apiUrl = await importApiUrl('https://play.feed.market');
      // This is technically a misuse but should still produce a valid URL
      expect(apiUrl('api/posts')).toBe('https://play.feed.market/api/posts');
    });
  });

  describe('template literal paths (from fetch calls)', () => {
    it('handles interpolated paths', async () => {
      const apiUrl = await importApiUrl('https://play.feed.market');
      const agentId = 'agent-123';
      expect(apiUrl(`/api/agents/${agentId}/chat`)).toBe(
        'https://play.feed.market/api/agents/agent-123/chat'
      );
    });

    it('handles URL-encoded params', async () => {
      const apiUrl = await importApiUrl('https://play.feed.market');
      const identifier = 'did:privy:abc%3A123';
      expect(apiUrl(`/api/profiles/resolve/${identifier}`)).toBe(
        `https://play.feed.market/api/profiles/resolve/${identifier}`
      );
    });
  });
});

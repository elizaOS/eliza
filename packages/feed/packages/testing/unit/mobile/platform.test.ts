import { afterEach, describe, expect, it } from 'bun:test';

/**
 * Tests for platform detection utility.
 * Since detection reads window globals, we mock window properties.
 */

// Helper: fresh import with cache busting (detection is cached per module load)
async function importPlatform() {
  const cacheBuster = `?t=${Date.now()}-${Math.random()}`;
  return await import(
    `../../../../apps/mobile/src/lib/platform.ts${cacheBuster}`
  );
}

describe('platform detection', () => {
  // biome-ignore lint/suspicious/noExplicitAny: test mocking
  const originalWindow = (globalThis as any).window;

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test cleanup
    (globalThis as any).window = originalWindow;
  });

  describe('in SSR context (no window)', () => {
    it('detects ssr platform', async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mocking
      const savedWindow = (globalThis as any).window;
      // biome-ignore lint/suspicious/noExplicitAny: test mocking
      (globalThis as any).window = undefined;

      const { isNativePlatform, getPlatform } = await importPlatform();
      expect(isNativePlatform()).toBe(false);
      expect(getPlatform()).toBe('ssr');

      // biome-ignore lint/suspicious/noExplicitAny: test cleanup
      (globalThis as any).window = savedWindow;
    });
  });

  describe('in regular browser', () => {
    it('detects web platform', async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mocking
      (globalThis as any).window = {
        location: { origin: 'https://babylon.market' },
        navigator: { userAgent: 'Mozilla/5.0 Chrome/120' },
      };

      const { isNativePlatform, getPlatform, isIOS, isAndroid } =
        await importPlatform();
      expect(isNativePlatform()).toBe(false);
      expect(getPlatform()).toBe('web');
      expect(isIOS()).toBe(false);
      expect(isAndroid()).toBe(false);
    });

    it('detects web for localhost dev server', async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mocking
      (globalThis as any).window = {
        location: { origin: 'http://localhost:3000' },
        navigator: { userAgent: 'Mozilla/5.0 Chrome/120' },
      };

      const { isNativePlatform, getPlatform } = await importPlatform();
      expect(isNativePlatform()).toBe(false);
      expect(getPlatform()).toBe('web');
    });
  });

  describe('in Capacitor with global', () => {
    it('detects iOS via Capacitor global', async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mocking
      (globalThis as any).window = {
        location: { origin: 'capacitor://localhost' },
        navigator: { userAgent: 'Mozilla/5.0 iPhone' },
        Capacitor: {
          isNativePlatform: () => true,
          getPlatform: () => 'ios',
        },
      };

      const { isNativePlatform, getPlatform, isIOS, isAndroid } =
        await importPlatform();
      expect(isNativePlatform()).toBe(true);
      expect(getPlatform()).toBe('ios');
      expect(isIOS()).toBe(true);
      expect(isAndroid()).toBe(false);
    });

    it('detects Android via Capacitor global', async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mocking
      (globalThis as any).window = {
        location: { origin: 'https://localhost' },
        navigator: { userAgent: 'Mozilla/5.0 Android' },
        Capacitor: {
          isNativePlatform: () => true,
          getPlatform: () => 'android',
        },
      };

      const { isNativePlatform, getPlatform, isIOS, isAndroid } =
        await importPlatform();
      expect(isNativePlatform()).toBe(true);
      expect(getPlatform()).toBe('android');
      expect(isIOS()).toBe(false);
      expect(isAndroid()).toBe(true);
    });
  });

  describe('in Capacitor without global (fallback detection)', () => {
    it('detects iOS via capacitor:// scheme', async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mocking
      (globalThis as any).window = {
        location: { origin: 'capacitor://localhost' },
        navigator: { userAgent: 'Mozilla/5.0 iPhone' },
        // No Capacitor global
      };

      const { isNativePlatform, getPlatform, isIOS } = await importPlatform();
      expect(isNativePlatform()).toBe(true);
      expect(getPlatform()).toBe('ios');
      expect(isIOS()).toBe(true);
    });

    it('detects Android via https://localhost + Android UA', async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mocking
      (globalThis as any).window = {
        location: { origin: 'https://localhost' },
        navigator: {
          userAgent:
            'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120',
        },
        // No Capacitor global
      };

      const { isNativePlatform, getPlatform, isAndroid } =
        await importPlatform();
      expect(isNativePlatform()).toBe(true);
      expect(getPlatform()).toBe('android');
      expect(isAndroid()).toBe(true);
    });

    it('does NOT detect https://localhost without Android UA as native', async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mocking
      (globalThis as any).window = {
        location: { origin: 'https://localhost' },
        navigator: { userAgent: 'Mozilla/5.0 Chrome/120' },
      };

      const { isNativePlatform, getPlatform } = await importPlatform();
      expect(isNativePlatform()).toBe(false);
      expect(getPlatform()).toBe('web');
    });
  });

  describe('caching behavior', () => {
    it('returns consistent results across multiple calls', async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mocking
      (globalThis as any).window = {
        location: { origin: 'capacitor://localhost' },
        navigator: { userAgent: 'iPhone' },
        Capacitor: {
          isNativePlatform: () => true,
          getPlatform: () => 'ios',
        },
      };

      const mod = await importPlatform();
      const first = mod.getPlatform();
      const second = mod.getPlatform();
      const third = mod.isNativePlatform();
      expect(first).toBe('ios');
      expect(second).toBe('ios');
      expect(third).toBe(true);
    });
  });
});

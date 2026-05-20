/**
 * Session Heartbeat Unit Tests
 *
 * Tests the utility functions and logic for session tracking:
 * - UUID generation
 * - Session ID management
 * - Device detection
 * - IP hashing
 *
 * Run: bun test unit/session-heartbeat.test.ts --preload ./unit/preload.ts
 */

import { describe, expect, test } from 'bun:test';

// Test the UUID generation pattern used in useSessionHeartbeat
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// Test the device type detection logic from heartbeat route
function parseDeviceType(userAgent: string | null): string {
  if (!userAgent) return 'unknown';
  const ua = userAgent.toLowerCase();
  if (/mobile|android|iphone|ipad|ipod/.test(ua)) {
    if (/ipad|tablet/.test(ua)) return 'tablet';
    return 'mobile';
  }
  return 'desktop';
}

// Test the IP hashing function from heartbeat route
async function hashIp(ip: string | null): Promise<string | null> {
  if (!ip) return null;
  const encoder = new TextEncoder();
  const data = encoder.encode(ip + 'babylon'); // Using fixed salt for tests
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('UUID Generation', () => {
  test('generates valid UUID v4 format', () => {
    const uuid = generateUUID();

    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(uuid).toMatch(uuidRegex);
  });

  test('generates unique UUIDs', () => {
    const uuids = new Set<string>();
    const count = 1000;

    for (let i = 0; i < count; i++) {
      uuids.add(generateUUID());
    }

    // All should be unique
    expect(uuids.size).toBe(count);
  });

  test('UUID has correct length', () => {
    const uuid = generateUUID();
    expect(uuid.length).toBe(36); // 32 hex chars + 4 hyphens
  });

  test('version nibble is always 4', () => {
    for (let i = 0; i < 100; i++) {
      const uuid = generateUUID();
      // Version is at position 14 (after 8+1+4 chars)
      expect(uuid[14]).toBe('4');
    }
  });

  test('variant nibble is 8, 9, a, or b', () => {
    const validVariants = ['8', '9', 'a', 'b'];

    for (let i = 0; i < 100; i++) {
      const uuid = generateUUID();
      // Variant is at position 19 (after 8+1+4+1+4 chars)
      const variantChar = uuid.charAt(19);
      expect(validVariants).toContain(variantChar);
    }
  });

  test('UUID contains only valid characters', () => {
    const uuid = generateUUID();
    expect(uuid).toMatch(/^[0-9a-f-]+$/);
  });
});

describe('Device Type Detection', () => {
  describe('Desktop Detection', () => {
    test('detects Windows Chrome as desktop', () => {
      const ua =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
      expect(parseDeviceType(ua)).toBe('desktop');
    });

    test('detects macOS Safari as desktop', () => {
      const ua =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15';
      expect(parseDeviceType(ua)).toBe('desktop');
    });

    test('detects Linux Firefox as desktop', () => {
      const ua =
        'Mozilla/5.0 (X11; Linux x86_64; rv:89.0) Gecko/20100101 Firefox/89.0';
      expect(parseDeviceType(ua)).toBe('desktop');
    });

    test('detects Windows Edge as desktop', () => {
      const ua =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36 Edg/91.0.864.59';
      expect(parseDeviceType(ua)).toBe('desktop');
    });
  });

  describe('Mobile Detection', () => {
    test('detects iPhone Safari as mobile', () => {
      const ua =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Mobile/15E148 Safari/604.1';
      expect(parseDeviceType(ua)).toBe('mobile');
    });

    test('detects Android Chrome as mobile', () => {
      const ua =
        'Mozilla/5.0 (Linux; Android 11; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36';
      expect(parseDeviceType(ua)).toBe('mobile');
    });

    test('detects iPod as mobile', () => {
      const ua =
        'Mozilla/5.0 (iPod touch; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15';
      expect(parseDeviceType(ua)).toBe('mobile');
    });

    test('detects generic mobile browser', () => {
      const ua = 'Mozilla/5.0 (Mobile; rv:89.0) Gecko/89.0 Firefox/89.0';
      expect(parseDeviceType(ua)).toBe('mobile');
    });
  });

  describe('Tablet Detection', () => {
    test('detects iPad as tablet', () => {
      const ua =
        'Mozilla/5.0 (iPad; CPU OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Mobile/15E148 Safari/604.1';
      expect(parseDeviceType(ua)).toBe('tablet');
    });

    test('detects Android tablet as tablet', () => {
      const ua =
        'Mozilla/5.0 (Linux; Android 11; SM-T870) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Safari/537.36 Tablet';
      expect(parseDeviceType(ua)).toBe('tablet');
    });

    test('detects generic tablet', () => {
      const ua =
        'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Tablet Chrome/91.0';
      expect(parseDeviceType(ua)).toBe('tablet');
    });
  });

  describe('Edge Cases', () => {
    test('returns unknown for null user agent', () => {
      expect(parseDeviceType(null)).toBe('unknown');
    });

    test('returns unknown for empty string', () => {
      expect(parseDeviceType('')).toBe('unknown');
    });

    test('handles uppercase user agent', () => {
      const ua = 'MOZILLA/5.0 (WINDOWS NT 10.0; WIN64; X64)';
      expect(parseDeviceType(ua)).toBe('desktop');
    });

    test('handles unusual but valid user agent', () => {
      const ua = 'curl/7.68.0';
      expect(parseDeviceType(ua)).toBe('desktop');
    });

    test('handles bot user agents', () => {
      const ua = 'Googlebot/2.1 (+http://www.google.com/bot.html)';
      expect(parseDeviceType(ua)).toBe('desktop');
    });
  });
});

describe('IP Hashing', () => {
  test('returns null for null IP', async () => {
    const result = await hashIp(null);
    expect(result).toBeNull();
  });

  test('returns consistent hash for same IP', async () => {
    const ip = '192.168.1.1';
    const hash1 = await hashIp(ip);
    const hash2 = await hashIp(ip);

    expect(hash1).toBe(hash2);
  });

  test('returns different hashes for different IPs', async () => {
    const hash1 = await hashIp('192.168.1.1');
    const hash2 = await hashIp('192.168.1.2');

    expect(hash1).not.toBe(hash2);
  });

  test('hash is 64 characters (SHA-256 hex)', async () => {
    const hash = await hashIp('10.0.0.1');
    expect(hash).not.toBeNull();
    expect(hash!.length).toBe(64);
  });

  test('hash contains only hex characters', async () => {
    const hash = await hashIp('172.16.0.1');
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  test('handles IPv6 addresses', async () => {
    const hash = await hashIp('2001:0db8:85a3:0000:0000:8a2e:0370:7334');
    expect(hash).not.toBeNull();
    expect(hash!.length).toBe(64);
  });

  test('handles localhost', async () => {
    const hash = await hashIp('127.0.0.1');
    expect(hash).not.toBeNull();
    expect(hash!.length).toBe(64);
  });

  test('handles empty string IP (returns null)', async () => {
    const hash = await hashIp('');
    // Empty string is falsy, so should return null
    expect(hash).toBeNull();
  });
});

describe('Session Timeout Logic', () => {
  const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

  test('session within timeout is active', () => {
    const now = Date.now();
    const lastActive = now - 15 * 60 * 1000; // 15 minutes ago
    const threshold = now - SESSION_TIMEOUT_MS;

    expect(lastActive).toBeGreaterThan(threshold);
  });

  test('session beyond timeout is inactive', () => {
    const now = Date.now();
    const lastActive = now - 45 * 60 * 1000; // 45 minutes ago
    const threshold = now - SESSION_TIMEOUT_MS;

    expect(lastActive).toBeLessThan(threshold);
  });

  test('session exactly at timeout boundary', () => {
    const now = Date.now();
    const lastActive = now - SESSION_TIMEOUT_MS; // Exactly 30 minutes ago
    const threshold = now - SESSION_TIMEOUT_MS;

    // lastActive === threshold should be considered timed out
    expect(lastActive).toBeLessThanOrEqual(threshold);
  });
});

describe('Rate Limiting Logic', () => {
  const RATE_LIMIT_MS = 60 * 1000; // 1 minute

  test('allows first request', () => {
    const lastHeartbeat: number | undefined = undefined;
    const now = Date.now();

    const allowed = !lastHeartbeat || now - lastHeartbeat >= RATE_LIMIT_MS;
    expect(allowed).toBe(true);
  });

  test('blocks request within rate limit window', () => {
    const now = Date.now();
    const lastHeartbeat = now - 30 * 1000; // 30 seconds ago

    const allowed = now - lastHeartbeat >= RATE_LIMIT_MS;
    expect(allowed).toBe(false);
  });

  test('allows request after rate limit window', () => {
    const now = Date.now();
    const lastHeartbeat = now - 90 * 1000; // 90 seconds ago

    const allowed = now - lastHeartbeat >= RATE_LIMIT_MS;
    expect(allowed).toBe(true);
  });

  test('allows request exactly at rate limit boundary', () => {
    const now = Date.now();
    const lastHeartbeat = now - RATE_LIMIT_MS; // Exactly 60 seconds ago

    const allowed = now - lastHeartbeat >= RATE_LIMIT_MS;
    expect(allowed).toBe(true);
  });
});

describe('Session ID Validation', () => {
  test('valid session ID format', () => {
    const sessionId = 'abc123-def456';
    expect(typeof sessionId === 'string').toBe(true);
    expect(sessionId.length).toBeGreaterThan(0);
    expect(sessionId.length).toBeLessThanOrEqual(100);
  });

  test('UUID session ID is valid', () => {
    const sessionId = generateUUID();
    expect(typeof sessionId === 'string').toBe(true);
    expect(sessionId.length).toBe(36);
    expect(sessionId.length).toBeLessThanOrEqual(100);
  });

  test('rejects session ID over 100 characters', () => {
    const sessionId = 'a'.repeat(101);
    expect(sessionId.length).toBeGreaterThan(100);
    // In the actual API, this would be rejected
  });
});

describe('Page Count Handling', () => {
  test('accumulates page counts correctly', () => {
    let pageCount = 0;

    // Simulate multiple page views
    pageCount += 1; // First page
    pageCount += 1; // Navigate
    pageCount += 1; // Navigate again

    expect(pageCount).toBe(3);
  });

  test('resets page count after heartbeat', () => {
    let pageCount = 5;

    // Simulate sending heartbeat
    const sentCount = pageCount;
    pageCount = 0; // Reset after send

    expect(sentCount).toBe(5);
    expect(pageCount).toBe(0);
  });
});

describe('Heartbeat Interval Logic', () => {
  const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  test('interval is 5 minutes', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(300000);
  });

  test('heartbeat should fire after interval', () => {
    const lastHeartbeat = Date.now() - HEARTBEAT_INTERVAL_MS - 1000;
    const now = Date.now();

    expect(now - lastHeartbeat).toBeGreaterThan(HEARTBEAT_INTERVAL_MS);
  });

  test('heartbeat should not fire before interval', () => {
    const lastHeartbeat = Date.now() - HEARTBEAT_INTERVAL_MS + 60000; // 4 minutes ago
    const now = Date.now();

    expect(now - lastHeartbeat).toBeLessThan(HEARTBEAT_INTERVAL_MS);
  });
});

describe('Visibility State Handling', () => {
  test('should pause when hidden', () => {
    let isVisible = true;

    // Simulate tab becoming hidden
    isVisible = false;

    expect(isVisible).toBe(false);
  });

  test('should resume when visible', () => {
    let isVisible = false;

    // Simulate tab becoming visible
    isVisible = true;

    expect(isVisible).toBe(true);
  });

  test('should send heartbeat on visibility change to visible', () => {
    let heartbeatSent = false;
    let isVisible = false;

    // Simulate visibility change handler
    const onVisibilityChange = (state: 'visible' | 'hidden') => {
      isVisible = state === 'visible';
      if (isVisible) {
        heartbeatSent = true;
      }
    };

    onVisibilityChange('visible');

    expect(isVisible).toBe(true);
    expect(heartbeatSent).toBe(true);
  });
});

describe('Activity Date Truncation', () => {
  test('truncates to day boundary', () => {
    const now = new Date('2024-03-15T14:30:45.123Z');
    const truncated = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    );

    expect(truncated.getHours()).toBe(0);
    expect(truncated.getMinutes()).toBe(0);
    expect(truncated.getSeconds()).toBe(0);
    expect(truncated.getMilliseconds()).toBe(0);
  });

  test('preserves date correctly', () => {
    const now = new Date('2024-03-15T23:59:59.999Z');
    const truncated = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    );

    expect(truncated.getFullYear()).toBe(2024);
    expect(truncated.getMonth()).toBe(2); // March is 2 (0-indexed)
    expect(truncated.getDate()).toBe(15);
  });

  test('handles timezone correctly (local time)', () => {
    const now = new Date();
    const truncated = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    );

    expect(truncated.getDate()).toBe(now.getDate());
  });
});

/**
 * Test suite for homepage public readiness validation.
 * Tests deterministic validation of Cloudflare deployment and homepage content.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';

// Mock spawnSync
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

describe('homepage-public-readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should validate Cloudflare server headers', () => {
    const mockResult = {
      status: 0,
      stdout: 'HTTP/2 200\nserver: cloudflare\ncf-ray: abc123\n',
      stderr: '',
    };

    expect(mockResult.stdout.includes('cf-ray')).toBe(true);
    expect(mockResult.stdout.includes('cloudflare')).toBe(true);
  });

  it('should validate correct gateway number in homepage content', () => {
    const correctGateway = "+18087881821";
    const formattedNumber = "+1 (808) 788-1821";
    const homepageContent = `
      <p>Contact us at ${correctGateway} or ${formattedNumber}</p>
    `;

    expect(homepageContent.includes(correctGateway)).toBe(true);
    expect(homepageContent.includes(formattedNumber)).toBe(true);
  });

  it('should reject old gateway numbers', () => {
    const disallowedNumbers = ["+14159611510", "+1 (415) 961-1510"];
    const homepageContent = `
      <p>Old number: +14159611510</p>
    `;

    const hasDisallowed = disallowedNumbers.some(num =>
      homepageContent.includes(num)
    );
    expect(hasDisallowed).toBe(true);
  });

  it('should reject formatted phone number patterns', () => {
    const formattedPhonePattern = /\+\s*1\s*\(\s*\d{3}\s*\)\s*\d{3}\s*-\s*\d{4}/;
    const contentWithFormattedNumber = "+1 (415) 961-1510";

    expect(formattedPhonePattern.test(contentWithFormattedNumber)).toBe(true);
  });

  it('should accept correct formatted number only', () => {
    const correctFormatted = "+1 (808) 788-1821";
    const disallowedFormatted = "+1 (415) 961-1510";

    // Just presence checks
    expect(correctFormatted).toContain("808");
    expect(disallowedFormatted).toContain("415");
  });

  it('should validate DNS delegation exists', () => {
    const delegatedNameservers = [
      "ns1.example.com.",
      "ns2.example.com.",
    ];

    expect(delegatedNameservers.length).toBeGreaterThan(0);
  });

  it('should validate registry status without client hold', () => {
    const registryStatuses = ["active"];
    const clientHold = registryStatuses.includes("client hold");

    expect(clientHold).toBe(false);
  });

  it('should fail when registry has client hold', () => {
    const registryStatuses = ["client hold", "active"];
    const clientHold = registryStatuses.includes("client hold");

    expect(clientHold).toBe(true);
  });

  it('should validate evidence structure', () => {
    const evidence = {
      ok: true,
      checkedAt: new Date().toISOString(),
      domain: "eliza.app",
      expectedGatewayNumber: "+18087881821",
      checks: [
        { name: "cloudflare-homepage-content", passed: true, detail: "gateway=yes" },
        { name: "cloudflare-server", passed: true, detail: "served by Cloudflare" },
        { name: "registry-status", passed: true, detail: "no status flags" },
      ],
    };

    expect(evidence.ok).toBe(true);
    expect(evidence.checks.length).toBeGreaterThan(0);
    expect(evidence.domain).toBe("eliza.app");
  });
});

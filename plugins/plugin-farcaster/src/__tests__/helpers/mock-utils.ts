import { vi } from 'vitest';
import { UUID } from '@elizaos/core';

// Helper to create a valid UUID
export function createTestUUID(value: string = 'test'): UUID {
  // Create a valid UUID v4 format
  const hash = value.padEnd(8, '0').substring(0, 8);
  return `${hash}-0000-4000-8000-000000000000` as UUID;
}

// Helper to get the mocked Neynar client instance
export function getMockNeynarClient() {
  // Since we're using vi.fn().mockImplementation, the mock is the return value of the vi.fn() call
  const { NeynarAPIClient } = require('@neynar/nodejs-sdk');
  // The mock implementation returns the mocked object directly
  return new NeynarAPIClient({ apiKey: 'test-key' });
}

// Helper to create mock functions that TypeScript will accept
export function createMockFunctions() {
  return {
    getTimeline: Object.assign(
      vi.fn().mockResolvedValue({ timeline: [] }),
      { mockResolvedValue: vi.fn(), mockRejectedValue: vi.fn() }
    ),
    sendCast: Object.assign(
      vi.fn().mockResolvedValue([]),
      { mockResolvedValue: vi.fn(), mockRejectedValue: vi.fn() }
    ),
    getCast: Object.assign(
      vi.fn().mockResolvedValue(null),
      { mockResolvedValue: vi.fn(), mockRejectedValue: vi.fn() }
    ),
  };
} 
import { describe, expect, it } from 'bun:test';
import { createMockRuntime } from './test-utils';

describe('Debug Mock Runtime', () => {
  it('should have getSetting method', () => {
    const runtime = createMockRuntime();

    console.log('Runtime object keys:', Object.keys(runtime));
    console.log('getSetting method exists:', typeof runtime.getSetting);
    console.log('getSetting result for NGROK_AUTH_TOKEN:', runtime.getSetting('NGROK_AUTH_TOKEN'));

    expect(typeof runtime.getSetting).toBe('function');
    expect(runtime.getSetting('NGROK_AUTH_TOKEN')).toBeDefined();
  });
});

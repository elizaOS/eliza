/**
 * End-to-end tests for @elizaos/plugin-blockrun
 *
 * Tests the complete flow:
 * 1. Plugin initialization
 * 2. Wallet provider returning address and balance
 * 3. BLOCKRUN_CHAT action making real API calls with x402 payments
 *
 * Requires BASE_CHAIN_WALLET_KEY environment variable with funded wallet.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { blockrunPlugin, blockrunChatAction, blockrunWalletProvider } from '../index';

// Mock runtime for testing
function createMockRuntime(settings: Record<string, string> = {}) {
  return {
    agentId: 'test-agent-001',
    getSetting: (key: string) => settings[key] || process.env[key],
    character: {
      name: 'TestAgent',
      system: 'You are a helpful AI assistant.',
    },
    composeState: async () => ({}),
    useModel: async () => '',
  };
}

// Mock message
function createMockMessage(text: string) {
  return {
    id: 'msg-001',
    content: { text },
    userId: 'user-001',
    roomId: 'room-001',
    createdAt: Date.now(),
  };
}

describe('BlockRun Plugin', () => {
  test('plugin exports correctly', () => {
    expect(blockrunPlugin).toBeDefined();
    expect(blockrunPlugin.name).toBe('blockrun');
    expect(blockrunPlugin.actions).toHaveLength(1);
    expect(blockrunPlugin.providers).toHaveLength(1);
  });

  test('action is named BLOCKRUN_CHAT', () => {
    expect(blockrunChatAction.name).toBe('BLOCKRUN_CHAT');
    expect(blockrunChatAction.similes).toContain('X402_CHAT');
  });

  test('provider is named BLOCKRUN_WALLET', () => {
    expect(blockrunWalletProvider.name).toBe('BLOCKRUN_WALLET');
  });
});

describe('Wallet Provider', () => {
  test('returns not configured when no key', async () => {
    const runtime = createMockRuntime({});
    const message = createMockMessage('test');

    const result = await blockrunWalletProvider.get(runtime as any, message as any);

    expect(result.data.configured).toBe(false);
    expect(result.text).toContain('not configured');
  });

  test('returns wallet info when key is set', async () => {
    const privateKey = process.env.BASE_CHAIN_WALLET_KEY;
    if (!privateKey) {
      console.log('Skipping: BASE_CHAIN_WALLET_KEY not set');
      return;
    }

    const runtime = createMockRuntime({ BASE_CHAIN_WALLET_KEY: privateKey });
    const message = createMockMessage('test');

    const result = await blockrunWalletProvider.get(runtime as any, message as any);

    expect(result.data.configured).toBe(true);
    expect(result.data.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(result.data.chain).toBe('base');
    expect(result.values.walletAddress).toBeDefined();
    console.log('Wallet address:', result.data.address);
    console.log('USDC balance:', result.values.usdcBalance);
  });
});

describe('BLOCKRUN_CHAT Action', () => {
  test('validate returns false without key', async () => {
    const runtime = createMockRuntime({});
    const isValid = await blockrunChatAction.validate(runtime as any);
    expect(isValid).toBe(false);
  });

  test('validate returns true with key', async () => {
    const privateKey = process.env.BASE_CHAIN_WALLET_KEY;
    if (!privateKey) {
      console.log('Skipping: BASE_CHAIN_WALLET_KEY not set');
      return;
    }

    const runtime = createMockRuntime({ BASE_CHAIN_WALLET_KEY: privateKey });
    const isValid = await blockrunChatAction.validate(runtime as any);
    expect(isValid).toBe(true);
  });

  test('handler returns error without prompt', async () => {
    const privateKey = process.env.BASE_CHAIN_WALLET_KEY;
    if (!privateKey) {
      console.log('Skipping: BASE_CHAIN_WALLET_KEY not set');
      return;
    }

    const runtime = createMockRuntime({ BASE_CHAIN_WALLET_KEY: privateKey });
    const message = createMockMessage(''); // empty prompt

    const result = await blockrunChatAction.handler(
      runtime as any,
      message as any,
      undefined,
      undefined,
      undefined
    );

    expect(result.success).toBe(false);
    expect(result.values.error).toBe('No prompt');
  });
});

describe('E2E: Real API Call', () => {
  const privateKey = process.env.BASE_CHAIN_WALLET_KEY;

  beforeAll(() => {
    if (!privateKey) {
      console.log('\n⚠️  BASE_CHAIN_WALLET_KEY not set - skipping E2E tests');
      console.log('Set it to run real API tests with x402 payments\n');
    }
  });

  test('make real x402 API call', async () => {
    if (!privateKey) {
      console.log('Skipping: BASE_CHAIN_WALLET_KEY not set');
      return;
    }

    const runtime = createMockRuntime({ BASE_CHAIN_WALLET_KEY: privateKey });
    const message = createMockMessage('What is 2 + 2? Reply with just the number.');

    console.log('\n🚀 Making real BlockRun API call with x402 payment...');
    const startTime = Date.now();

    const result = await blockrunChatAction.handler(
      runtime as any,
      message as any,
      undefined,
      { model: 'openai/gpt-4o-mini' },
      undefined
    );

    const duration = Date.now() - startTime;

    console.log('✅ Response:', result.text);
    console.log('⏱️  Latency:', duration, 'ms');
    console.log('📊 Model:', result.values.model);
    console.log('💰 Wallet:', result.values.walletAddress);

    expect(result.success).toBe(true);
    expect(result.text).toBeDefined();
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.values.model).toBe('openai/gpt-4o-mini');
  }, 30000); // 30 second timeout for API call

  test('make multiple API calls', async () => {
    if (!privateKey) {
      console.log('Skipping: BASE_CHAIN_WALLET_KEY not set');
      return;
    }

    const runtime = createMockRuntime({ BASE_CHAIN_WALLET_KEY: privateKey });
    const prompts = [
      'Say "hello" in French.',
      'What color is the sky?',
      'Name one planet.',
    ];

    console.log('\n🚀 Making 3 sequential API calls...');

    for (const prompt of prompts) {
      const message = createMockMessage(prompt);
      const result = await blockrunChatAction.handler(
        runtime as any,
        message as any,
        undefined,
        { model: 'openai/gpt-4o-mini' },
        undefined
      );

      console.log(`Q: ${prompt}`);
      console.log(`A: ${result.text}\n`);

      expect(result.success).toBe(true);
    }
  }, 60000); // 60 second timeout for multiple calls
});

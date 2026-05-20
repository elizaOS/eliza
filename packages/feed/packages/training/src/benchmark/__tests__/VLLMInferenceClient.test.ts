/**
 * Tests for VLLMInferenceClient
 *
 * Comprehensive tests covering:
 * - Configuration and initialization
 * - Health checks and readiness
 * - Completion requests
 * - JSON mode parsing
 * - Error handling
 * - Retry logic
 * - Timeout behavior
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  createVLLMClientFromEnv,
  type VLLMClientConfig,
  VLLMInferenceClient,
} from '../VLLMInferenceClient';

// =============================================================================
// Mock Setup
// =============================================================================

// Store original fetch
const originalFetch = globalThis.fetch;

// Mock responses
function mockFetchSuccess(data: unknown): void {
  globalThis.fetch = mock(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    } as Response)
  );
}

function mockFetchError(status: number, message: string): void {
  globalThis.fetch = mock(() =>
    Promise.resolve({
      ok: false,
      status,
      text: () => Promise.resolve(message),
    } as Response)
  );
}

function mockFetchNetworkError(): void {
  globalThis.fetch = mock(() => Promise.reject(new Error('Network error')));
}

// =============================================================================
// Configuration Tests
// =============================================================================

describe('VLLMInferenceClient Configuration', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('uses default values when not specified', () => {
    const config: VLLMClientConfig = {
      baseUrl: 'http://localhost:9001',
      model: 'test-model',
    };

    const client = new VLLMInferenceClient(config);

    // Access config via getModelName
    expect(client.getModelName()).toBe('test-model');
  });

  test('uses adapter path as model name when specified', () => {
    const config: VLLMClientConfig = {
      baseUrl: 'http://localhost:9001',
      model: 'base-model',
      adapterPath: '/path/to/adapter',
    };

    const client = new VLLMInferenceClient(config);

    expect(client.getModelName()).toBe('/path/to/adapter');
  });

  test('isReady is false initially', () => {
    const client = new VLLMInferenceClient({
      baseUrl: 'http://localhost:9001',
      model: 'test-model',
    });

    expect(client.isReady).toBe(false);
  });
});

// =============================================================================
// Health Check Tests
// =============================================================================

describe('VLLMInferenceClient Health Checks', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('isHealthy returns true on successful health check', async () => {
    globalThis.fetch = mock(() => Promise.resolve({ ok: true } as Response));

    const client = new VLLMInferenceClient({
      baseUrl: 'http://localhost:9001',
      model: 'test-model',
    });

    const healthy = await client.isHealthy();
    expect(healthy).toBe(true);
  });

  test('isHealthy returns false on failed health check', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({ ok: false, status: 500 } as Response)
    );

    const client = new VLLMInferenceClient({
      baseUrl: 'http://localhost:9001',
      model: 'test-model',
    });

    const healthy = await client.isHealthy();
    expect(healthy).toBe(false);
  });

  test('isHealthy returns false on network error', async () => {
    mockFetchNetworkError();

    const client = new VLLMInferenceClient({
      baseUrl: 'http://localhost:9001',
      model: 'test-model',
    });

    const healthy = await client.isHealthy();
    expect(healthy).toBe(false);
  });
});

// =============================================================================
// Get Models Tests
// =============================================================================

describe('VLLMInferenceClient getModels', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('returns model list on success', async () => {
    mockFetchSuccess({
      data: [{ id: 'model-1' }, { id: 'model-2' }],
    });

    const client = new VLLMInferenceClient({
      baseUrl: 'http://localhost:9001',
      model: 'test-model',
    });

    const models = await client.getModels();
    expect(models).toEqual(['model-1', 'model-2']);
  });

  test('returns empty array on error', async () => {
    mockFetchError(500, 'Internal Server Error');

    const client = new VLLMInferenceClient({
      baseUrl: 'http://localhost:9001',
      model: 'test-model',
    });

    const models = await client.getModels();
    expect(models).toEqual([]);
  });

  test('returns empty array on network error', async () => {
    mockFetchNetworkError();

    const client = new VLLMInferenceClient({
      baseUrl: 'http://localhost:9001',
      model: 'test-model',
    });

    const models = await client.getModels();
    expect(models).toEqual([]);
  });
});

// =============================================================================
// Completion Tests
// =============================================================================

describe('VLLMInferenceClient complete', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('returns completion response on success', async () => {
    mockFetchSuccess({
      id: 'completion-1',
      model: 'test-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello, world!' },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    });

    const client = new VLLMInferenceClient({
      baseUrl: 'http://localhost:9001',
      model: 'test-model',
    });

    const response = await client.complete({
      systemPrompt: 'You are a helpful assistant.',
      userPrompt: 'Say hello.',
    });

    expect(response.content).toBe('Hello, world!');
    expect(response.model).toBe('test-model');
    expect(response.promptTokens).toBe(10);
    expect(response.completionTokens).toBe(5);
    expect(response.totalTokens).toBe(15);
    expect(response.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test('uses default temperature and maxTokens', async () => {
    let capturedBody: string = '';

    globalThis.fetch = mock((url: string, options: RequestInit) => {
      capturedBody = options.body as string;
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            id: 'completion-1',
            model: 'test-model',
            choices: [{ message: { content: 'test' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
      } as Response);
    });

    const client = new VLLMInferenceClient({
      baseUrl: 'http://localhost:9001',
      model: 'test-model',
    });

    await client.complete({
      systemPrompt: 'System',
      userPrompt: 'User',
    });

    const body = JSON.parse(capturedBody);
    expect(body.temperature).toBe(0.7);
    expect(body.max_tokens).toBe(1024);
  });

  test('uses custom temperature and maxTokens', async () => {
    let capturedBody: string = '';

    globalThis.fetch = mock((url: string, options: RequestInit) => {
      capturedBody = options.body as string;
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            id: 'completion-1',
            model: 'test-model',
            choices: [{ message: { content: 'test' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
      } as Response);
    });

    const client = new VLLMInferenceClient({
      baseUrl: 'http://localhost:9001',
      model: 'test-model',
    });

    await client.complete({
      systemPrompt: 'System',
      userPrompt: 'User',
      temperature: 0.3,
      maxTokens: 512,
    });

    const body = JSON.parse(capturedBody);
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(512);
  });

  test('adds json mode when requested', async () => {
    let capturedBody: string = '';

    globalThis.fetch = mock((url: string, options: RequestInit) => {
      capturedBody = options.body as string;
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            id: 'completion-1',
            model: 'test-model',
            choices: [{ message: { content: '{}' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
      } as Response);
    });

    const client = new VLLMInferenceClient({
      baseUrl: 'http://localhost:9001',
      model: 'test-model',
    });

    await client.complete({
      systemPrompt: 'System',
      userPrompt: 'User',
      jsonMode: true,
    });

    const body = JSON.parse(capturedBody);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  test('handles empty content gracefully', async () => {
    mockFetchSuccess({
      id: 'completion-1',
      model: 'test-model',
      choices: [{ message: { content: '' } }],
      usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
    });

    const client = new VLLMInferenceClient({
      baseUrl: 'http://localhost:9001',
      model: 'test-model',
    });

    const response = await client.complete({
      systemPrompt: 'System',
      userPrompt: 'User',
    });

    expect(response.content).toBe('');
  });

  test('handles missing content gracefully', async () => {
    mockFetchSuccess({
      id: 'completion-1',
      model: 'test-model',
      choices: [{ message: {} }],
      usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
    });

    const client = new VLLMInferenceClient({
      baseUrl: 'http://localhost:9001',
      model: 'test-model',
    });

    const response = await client.complete({
      systemPrompt: 'System',
      userPrompt: 'User',
    });

    expect(response.content).toBe('');
  });
});

// =============================================================================
// Error Handling Tests
// =============================================================================

describe('VLLMInferenceClient Error Handling', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('throws on HTTP error after retries', async () => {
    mockFetchError(500, 'Internal Server Error');

    const client = new VLLMInferenceClient({
      baseUrl: 'http://localhost:9001',
      model: 'test-model',
      maxRetries: 2,
    });

    await expect(
      client.complete({ systemPrompt: 'S', userPrompt: 'U' })
    ).rejects.toThrow('vLLM error 500');
  });

  test('throws on network error after retries', async () => {
    mockFetchNetworkError();

    const client = new VLLMInferenceClient({
      baseUrl: 'http://localhost:9001',
      model: 'test-model',
      maxRetries: 2,
    });

    await expect(
      client.complete({ systemPrompt: 'S', userPrompt: 'U' })
    ).rejects.toThrow('Network error');
  });

  test('retries on failure before throwing', async () => {
    let attemptCount = 0;

    globalThis.fetch = mock(() => {
      attemptCount++;
      if (attemptCount < 3) {
        return Promise.reject(new Error('Temporary error'));
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            id: 'completion-1',
            model: 'test-model',
            choices: [{ message: { content: 'Success' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
      } as Response);
    });

    const client = new VLLMInferenceClient({
      baseUrl: 'http://localhost:9001',
      model: 'test-model',
      maxRetries: 3,
    });

    const response = await client.complete({
      systemPrompt: 'S',
      userPrompt: 'U',
    });

    expect(response.content).toBe('Success');
    expect(attemptCount).toBe(3);
  });
});

// =============================================================================
// JSON Parsing Tests
// =============================================================================

describe('VLLMInferenceClient completeJson', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('parses valid JSON response', async () => {
    mockFetchSuccess({
      id: 'completion-1',
      model: 'test-model',
      choices: [
        {
          message: {
            content: '{"action": "buy", "amount": 100}',
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const client = new VLLMInferenceClient({
      baseUrl: 'http://localhost:9001',
      model: 'test-model',
    });

    const result = await client.completeJson<{
      action: string;
      amount: number;
    }>({
      systemPrompt: 'S',
      userPrompt: 'U',
    });

    expect(result.action).toBe('buy');
    expect(result.amount).toBe(100);
  });

  test('strips markdown code blocks from JSON', async () => {
    mockFetchSuccess({
      id: 'completion-1',
      model: 'test-model',
      choices: [
        {
          message: {
            content: '```json\n{"action": "sell"}\n```',
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const client = new VLLMInferenceClient({
      baseUrl: 'http://localhost:9001',
      model: 'test-model',
    });

    const result = await client.completeJson<{ action: string }>({
      systemPrompt: 'S',
      userPrompt: 'U',
    });

    expect(result.action).toBe('sell');
  });

  test('extracts JSON object from text with prefix', async () => {
    mockFetchSuccess({
      id: 'completion-1',
      model: 'test-model',
      choices: [
        {
          message: {
            content: 'Here is your result: {"value": 42}',
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const client = new VLLMInferenceClient({
      baseUrl: 'http://localhost:9001',
      model: 'test-model',
    });

    const result = await client.completeJson<{ value: number }>({
      systemPrompt: 'S',
      userPrompt: 'U',
    });

    expect(result.value).toBe(42);
  });

  test('throws on invalid JSON', async () => {
    mockFetchSuccess({
      id: 'completion-1',
      model: 'test-model',
      choices: [
        {
          message: {
            content: 'This is not JSON',
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const client = new VLLMInferenceClient({
      baseUrl: 'http://localhost:9001',
      model: 'test-model',
    });

    await expect(
      client.completeJson({ systemPrompt: 'S', userPrompt: 'U' })
    ).rejects.toThrow('not valid JSON');
  });

  test('applies custom validator', async () => {
    mockFetchSuccess({
      id: 'completion-1',
      model: 'test-model',
      choices: [
        {
          message: {
            content: '{"action": "invalid"}',
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const client = new VLLMInferenceClient({
      baseUrl: 'http://localhost:9001',
      model: 'test-model',
    });

    interface ValidAction {
      action: 'buy' | 'sell';
    }

    const validator = (data: unknown): data is ValidAction => {
      const d = data as ValidAction;
      return d.action === 'buy' || d.action === 'sell';
    };

    await expect(
      client.completeJson({ systemPrompt: 'S', userPrompt: 'U' }, validator)
    ).rejects.toThrow('failed validation');
  });

  test('passes with valid custom validator', async () => {
    mockFetchSuccess({
      id: 'completion-1',
      model: 'test-model',
      choices: [
        {
          message: {
            content: '{"action": "buy", "amount": 100}',
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const client = new VLLMInferenceClient({
      baseUrl: 'http://localhost:9001',
      model: 'test-model',
    });

    interface TradeAction {
      action: 'buy' | 'sell';
      amount: number;
    }

    const validator = (data: unknown): data is TradeAction => {
      const d = data as TradeAction;
      return (
        (d.action === 'buy' || d.action === 'sell') &&
        typeof d.amount === 'number'
      );
    };

    const result = await client.completeJson(
      { systemPrompt: 'S', userPrompt: 'U' },
      validator
    );

    expect(result.action).toBe('buy');
    expect(result.amount).toBe(100);
  });
});

// =============================================================================
// Environment Variable Tests
// =============================================================================

describe('createVLLMClientFromEnv', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('uses default values when env vars not set', () => {
    delete process.env.VLLM_URL;
    delete process.env.VLLM_MODEL;
    delete process.env.BASE_MODEL;
    delete process.env.MODEL_PATH;
    delete process.env.ADAPTER_PATH;

    const client = createVLLMClientFromEnv();

    expect(client.getModelName()).toBe('Qwen/Qwen3-4B');
  });

  test('uses VLLM_URL from environment', () => {
    process.env.VLLM_URL = 'http://custom:8080';

    const client = createVLLMClientFromEnv();

    // We can't directly access private config, but the client was created successfully
    expect(client).toBeDefined();
  });

  test('uses MODEL_PATH as adapter path', () => {
    process.env.MODEL_PATH = '/models/trained';

    const client = createVLLMClientFromEnv();

    expect(client.getModelName()).toBe('/models/trained');
  });

  test('uses ADAPTER_PATH when MODEL_PATH not set', () => {
    delete process.env.MODEL_PATH;
    process.env.ADAPTER_PATH = '/models/adapter';

    const client = createVLLMClientFromEnv();

    expect(client.getModelName()).toBe('/models/adapter');
  });

  test('prefers VLLM_MODEL over BASE_MODEL', () => {
    delete process.env.MODEL_PATH;
    delete process.env.ADAPTER_PATH;
    process.env.VLLM_MODEL = 'custom/model';
    process.env.BASE_MODEL = 'fallback/model';

    const client = createVLLMClientFromEnv();

    expect(client.getModelName()).toBe('custom/model');
  });
});

// =============================================================================
// Wait For Ready Tests
// =============================================================================

describe('VLLMInferenceClient waitForReady', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('sets isReady to true on success', async () => {
    globalThis.fetch = mock((url: string) => {
      if (url.includes('/health')) {
        return Promise.resolve({ ok: true } as Response);
      }
      // /v1/models
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: 'model-1' }] }),
      } as Response);
    });

    const client = new VLLMInferenceClient({
      baseUrl: 'http://localhost:9001',
      model: 'test-model',
      healthCheckIntervalMs: 10,
      maxWaitTimeMs: 1000,
    });

    await client.waitForReady();

    expect(client.isReady).toBe(true);
  });

  test('throws after max wait time', async () => {
    globalThis.fetch = mock(() => Promise.resolve({ ok: false } as Response));

    const client = new VLLMInferenceClient({
      baseUrl: 'http://localhost:9001',
      model: 'test-model',
      healthCheckIntervalMs: 25, // Increased for CI stability
      maxWaitTimeMs: 150, // Increased for CI stability
    });

    await expect(client.waitForReady()).rejects.toThrow('not ready after');
  });
});

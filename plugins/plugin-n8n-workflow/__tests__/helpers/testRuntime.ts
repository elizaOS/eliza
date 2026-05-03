/**
 * E2E Test Runtime Helper
 *
 * Creates a lightweight runtime with REAL N8nWorkflowService and N8nApiClient,
 * but mock fetch (no real n8n server) and mock LLM (no real OpenRouter calls).
 *
 * Adapted from Sendo plugin's test-runtime pattern.
 */
import { mock } from 'bun:test';
import type { IAgentRuntime, Memory, State, ModelType } from '@elizaos/core';
import { N8nApiClient } from '../../src/utils/api';
import {
  N8nWorkflowService,
  N8N_WORKFLOW_SERVICE_TYPE,
} from '../../src/services/n8n-workflow-service';
import type { N8nWorkflowResponse } from '../../src/types/index';

export interface E2ETestConfig {
  /** Mock fetch responses keyed by URL pattern */
  fetchResponses?: Map<string, () => Response>;
  /** Default mock fetch response */
  defaultFetchResponse?: () => Response;
  /** Mock useModel responses by prompt type */
  useModelResponse?: (type: ModelType, params: any) => Promise<unknown>;
  /** Workflows to expose via provider state */
  workflows?: Array<{ id: string; name: string; active: boolean }>;
}

/**
 * Create a mock Response
 */
export function jsonResponse(status: number, body?: unknown): Response {
  const responseBody = body !== undefined ? JSON.stringify(body) : '';
  return new Response(responseBody, {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Setup a real N8nWorkflowService with mock fetch
 *
 * Returns the service, the runtime mock, and the fetch mock for assertions.
 */
export function createE2ERuntime(config: E2ETestConfig = {}) {
  // Create a mock fetch that routes by URL
  const fetchMock = mock((url: string, _options?: RequestInit) => {
    if (config.fetchResponses) {
      for (const [pattern, responseFn] of config.fetchResponses) {
        if (url.includes(pattern)) {
          return Promise.resolve(responseFn());
        }
      }
    }
    if (config.defaultFetchResponse) {
      return Promise.resolve(config.defaultFetchResponse());
    }
    return Promise.resolve(jsonResponse(200, {}));
  });

  // Replace global fetch
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as any;

  // Create real API client pointing at fake host
  const apiClient = new N8nApiClient('https://n8n.test', 'test-api-key');

  // Create real service with mocked internals
  const service = Object.create(N8nWorkflowService.prototype) as N8nWorkflowService;
  (service as any).apiClient = apiClient;
  (service as any).serviceConfig = {
    apiKey: 'test-api-key',
    host: 'https://n8n.test',
  };

  // In-memory cache for draft state machine
  const cache: Record<string, unknown> = {};

  // Create mock runtime with real service
  const runtime: IAgentRuntime = {
    agentId: 'agent-e2e',
    getService: mock((type: string) => {
      if (type === N8N_WORKFLOW_SERVICE_TYPE) return service;
      return null;
    }),
    getSetting: mock(() => null),
    useModel: config.useModelResponse || mock(() => Promise.resolve({})),
    getCache: mock((key: string) => Promise.resolve(cache[key])),
    setCache: mock((key: string, value: unknown) => {
      cache[key] = value;
      return Promise.resolve(true);
    }),
    deleteCache: mock((key: string) => {
      delete cache[key];
      return Promise.resolve(true);
    }),
    getEntityById: mock(() => Promise.resolve({ names: ['TestUser'] })),
  } as unknown as IAgentRuntime;

  // Wire the runtime into the service
  (service as any).runtime = runtime;

  // Create state with workflows from config
  const state: State = {
    data: {
      workflows: config.workflows || [],
    },
    values: {},
    text: '',
  } as State;

  function createMessage(text: string): Memory {
    return {
      id: 'msg-e2e',
      entityId: 'user-e2e',
      agentId: 'agent-e2e',
      roomId: 'room-e2e',
      content: { text },
      createdAt: Date.now(),
    } as Memory;
  }

  function createCallback() {
    return mock((_response: { text: string }) => Promise.resolve([]));
  }

  function cleanup() {
    globalThis.fetch = originalFetch;
  }

  return {
    runtime,
    service,
    apiClient,
    state,
    fetchMock,
    createMessage,
    createCallback,
    cleanup,
  };
}

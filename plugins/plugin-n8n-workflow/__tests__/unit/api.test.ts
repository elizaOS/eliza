import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { N8nApiClient } from '../../src/utils/api';
import { N8nApiError } from '../../src/types/index';
import {
  createValidWorkflow,
  createWorkflowResponse,
  createExecution,
  createCredential,
  createTag,
} from '../fixtures/workflows';

// ============================================================================
// Fetch mock setup
// ============================================================================

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock>;

function mockResponse(status: number, body?: unknown, statusText = 'OK'): Response {
  const responseBody = body !== undefined ? JSON.stringify(body) : '';
  return new Response(responseBody, {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  mockFetch = mock(() => Promise.resolve(mockResponse(200, {})));
  globalThis.fetch = mockFetch as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function getLastFetchCall(): { url: string; options: RequestInit } {
  const calls = mockFetch.mock.calls;
  const lastCall = calls[calls.length - 1] as [string, RequestInit];
  return { url: lastCall[0], options: lastCall[1] };
}

// ============================================================================
// Constructor
// ============================================================================

describe('N8nApiClient constructor', () => {
  test('sets base URL and strips trailing slash', () => {
    const client = new N8nApiClient('https://n8n.example.com/', 'key-123');
    // Verify by making a request and checking the URL
    mockFetch = mock(() => Promise.resolve(mockResponse(200, { data: [] })));
    globalThis.fetch = mockFetch as any;

    client.listWorkflows();

    const { url } = getLastFetchCall();
    expect(url).toStartWith('https://n8n.example.com/api/v1/');
    expect(url).not.toContain('//api');
  });

  test('sends API key in X-N8N-API-KEY header', async () => {
    const client = new N8nApiClient('https://n8n.example.com', 'my-secret-key');
    mockFetch = mock(() => Promise.resolve(mockResponse(200, { data: [] })));
    globalThis.fetch = mockFetch as any;

    await client.listWorkflows();

    const { options } = getLastFetchCall();
    expect((options.headers as Record<string, string>)['X-N8N-API-KEY']).toBe('my-secret-key');
  });
});

// ============================================================================
// Workflows
// ============================================================================

describe('N8nApiClient workflows', () => {
  const client = new N8nApiClient('https://n8n.test', 'key-123');

  test('createWorkflow sends POST /workflows with sanitized body', async () => {
    const workflow = createValidWorkflow();
    const responseData = createWorkflowResponse({ id: 'wf-new' });
    mockFetch = mock(() => Promise.resolve(mockResponse(200, responseData)));
    globalThis.fetch = mockFetch as any;

    const result = await client.createWorkflow(workflow);

    const { url, options } = getLastFetchCall();
    expect(url).toBe('https://n8n.test/api/v1/workflows');
    expect(options.method).toBe('POST');
    const body = JSON.parse(options.body as string);
    expect(body.name).toBe(workflow.name);
    expect(body.nodes).toHaveLength(workflow.nodes.length);
    expect(body.connections).toBeDefined();
    expect(body.settings).toBeDefined();
    // readOnly/internal fields must not be sent
    expect(body._meta).toBeUndefined();
    expect(body.active).toBeUndefined();
    expect(body.id).toBeUndefined();
    expect(body.createdAt).toBeUndefined();
    expect(body.updatedAt).toBeUndefined();
    expect(result.id).toBe('wf-new');
  });

  test('listWorkflows sends GET /workflows', async () => {
    const responseData = {
      data: [createWorkflowResponse()],
      nextCursor: 'abc',
    };
    mockFetch = mock(() => Promise.resolve(mockResponse(200, responseData)));
    globalThis.fetch = mockFetch as any;

    const result = await client.listWorkflows();

    const { url, options } = getLastFetchCall();
    expect(url).toBe('https://n8n.test/api/v1/workflows');
    expect(options.method).toBe('GET');
    expect(result.data).toHaveLength(1);
    expect(result.nextCursor).toBe('abc');
  });

  test('listWorkflows passes query params', async () => {
    mockFetch = mock(() => Promise.resolve(mockResponse(200, { data: [] })));
    globalThis.fetch = mockFetch as any;

    await client.listWorkflows({
      active: true,
      tags: ['user:123'],
      limit: 10,
      cursor: 'next',
    });

    const { url } = getLastFetchCall();
    expect(url).toContain('active=true');
    expect(url).toContain('tags=user%3A123');
    expect(url).toContain('limit=10');
    expect(url).toContain('cursor=next');
  });

  test('getWorkflow sends GET /workflows/{id}', async () => {
    const wf = createWorkflowResponse({ id: 'wf-42' });
    mockFetch = mock(() => Promise.resolve(mockResponse(200, wf)));
    globalThis.fetch = mockFetch as any;

    const result = await client.getWorkflow('wf-42');

    const { url } = getLastFetchCall();
    expect(url).toBe('https://n8n.test/api/v1/workflows/wf-42');
    expect(result.id).toBe('wf-42');
  });

  test('updateWorkflow sends PUT /workflows/{id} with sanitized body', async () => {
    const wf = createWorkflowResponse({ id: 'wf-42', name: 'Updated' });
    mockFetch = mock(() => Promise.resolve(mockResponse(200, wf)));
    globalThis.fetch = mockFetch as any;

    const workflow = createValidWorkflow({ name: 'Updated' });
    const result = await client.updateWorkflow('wf-42', workflow);

    const { url, options } = getLastFetchCall();
    expect(url).toBe('https://n8n.test/api/v1/workflows/wf-42');
    expect(options.method).toBe('PUT');
    const body = JSON.parse(options.body as string);
    expect(body.name).toBe('Updated');
    expect(body.settings).toBeDefined();
    expect(result.name).toBe('Updated');
  });

  test('deleteWorkflow sends DELETE /workflows/{id}', async () => {
    mockFetch = mock(() => Promise.resolve(mockResponse(204)));
    globalThis.fetch = mockFetch as any;

    await client.deleteWorkflow('wf-42');

    const { url, options } = getLastFetchCall();
    expect(url).toBe('https://n8n.test/api/v1/workflows/wf-42');
    expect(options.method).toBe('DELETE');
  });

  test('activateWorkflow sends POST /workflows/{id}/activate', async () => {
    const wf = createWorkflowResponse({ id: 'wf-42', active: true });
    mockFetch = mock(() => Promise.resolve(mockResponse(200, wf)));
    globalThis.fetch = mockFetch as any;

    const result = await client.activateWorkflow('wf-42');

    const { url, options } = getLastFetchCall();
    expect(url).toBe('https://n8n.test/api/v1/workflows/wf-42/activate');
    expect(options.method).toBe('POST');
    expect(result.active).toBe(true);
  });

  test('deactivateWorkflow sends POST /workflows/{id}/deactivate', async () => {
    const wf = createWorkflowResponse({ id: 'wf-42', active: false });
    mockFetch = mock(() => Promise.resolve(mockResponse(200, wf)));
    globalThis.fetch = mockFetch as any;

    const result = await client.deactivateWorkflow('wf-42');

    const { url } = getLastFetchCall();
    expect(url).toBe('https://n8n.test/api/v1/workflows/wf-42/deactivate');
    expect(result.active).toBe(false);
  });

  test('updateWorkflowTags sends PUT /workflows/{id}/tags with [{id}] array', async () => {
    const tags = [createTag({ id: 'tag-1' }), createTag({ id: 'tag-2' })];
    mockFetch = mock(() => Promise.resolve(mockResponse(200, tags)));
    globalThis.fetch = mockFetch as any;

    await client.updateWorkflowTags('wf-42', ['tag-1', 'tag-2']);

    const { url, options } = getLastFetchCall();
    expect(url).toBe('https://n8n.test/api/v1/workflows/wf-42/tags');
    expect(options.method).toBe('PUT');
    expect(JSON.parse(options.body as string)).toEqual([{ id: 'tag-1' }, { id: 'tag-2' }]);
  });
});

// ============================================================================
// Credentials
// ============================================================================

describe('N8nApiClient credentials', () => {
  const client = new N8nApiClient('https://n8n.test', 'key-123');

  test('createCredential sends POST /credentials', async () => {
    const cred = createCredential({ id: 'cred-new' });
    mockFetch = mock(() => Promise.resolve(mockResponse(200, cred)));
    globalThis.fetch = mockFetch as any;

    const result = await client.createCredential({
      name: 'Gmail',
      type: 'gmailOAuth2Api',
      data: { token: 'abc' },
    });

    const { url, options } = getLastFetchCall();
    expect(url).toBe('https://n8n.test/api/v1/credentials');
    expect(options.method).toBe('POST');
    expect(result.id).toBe('cred-new');
  });

  test('deleteCredential sends DELETE /credentials/{id}', async () => {
    mockFetch = mock(() => Promise.resolve(mockResponse(204)));
    globalThis.fetch = mockFetch as any;

    await client.deleteCredential('cred-42');

    const { url, options } = getLastFetchCall();
    expect(url).toBe('https://n8n.test/api/v1/credentials/cred-42');
    expect(options.method).toBe('DELETE');
  });
});

// ============================================================================
// Executions
// ============================================================================

describe('N8nApiClient executions', () => {
  const client = new N8nApiClient('https://n8n.test', 'key-123');

  test('listExecutions sends GET /executions', async () => {
    mockFetch = mock(() =>
      Promise.resolve(mockResponse(200, { data: [createExecution()], nextCursor: 'c1' }))
    );
    globalThis.fetch = mockFetch as any;

    const result = await client.listExecutions();

    const { url } = getLastFetchCall();
    expect(url).toBe('https://n8n.test/api/v1/executions');
    expect(result.data).toHaveLength(1);
  });

  test('listExecutions passes query params', async () => {
    mockFetch = mock(() => Promise.resolve(mockResponse(200, { data: [] })));
    globalThis.fetch = mockFetch as any;

    await client.listExecutions({
      workflowId: 'wf-1',
      status: 'error',
      limit: 5,
      cursor: 'page2',
    });

    const { url } = getLastFetchCall();
    expect(url).toContain('workflowId=wf-1');
    expect(url).toContain('status=error');
    expect(url).toContain('limit=5');
    expect(url).toContain('cursor=page2');
  });

  test('getExecution sends GET /executions/{id}', async () => {
    const exec = createExecution({ id: 'exec-55' });
    mockFetch = mock(() => Promise.resolve(mockResponse(200, exec)));
    globalThis.fetch = mockFetch as any;

    const result = await client.getExecution('exec-55');

    const { url } = getLastFetchCall();
    expect(url).toBe('https://n8n.test/api/v1/executions/exec-55');
    expect(result.id).toBe('exec-55');
  });

  test('deleteExecution sends DELETE /executions/{id}', async () => {
    mockFetch = mock(() => Promise.resolve(mockResponse(204)));
    globalThis.fetch = mockFetch as any;

    await client.deleteExecution('exec-55');

    const { url, options } = getLastFetchCall();
    expect(url).toBe('https://n8n.test/api/v1/executions/exec-55');
    expect(options.method).toBe('DELETE');
  });
});

// ============================================================================
// Tags
// ============================================================================

describe('N8nApiClient tags', () => {
  const client = new N8nApiClient('https://n8n.test', 'key-123');

  test('listTags sends GET /tags', async () => {
    mockFetch = mock(() => Promise.resolve(mockResponse(200, { data: [createTag()] })));
    globalThis.fetch = mockFetch as any;

    const result = await client.listTags();

    const { url } = getLastFetchCall();
    expect(url).toBe('https://n8n.test/api/v1/tags');
    expect(result.data).toHaveLength(1);
  });

  test('createTag sends POST /tags', async () => {
    const tag = createTag({ id: 'tag-new', name: 'user:abc' });
    mockFetch = mock(() => Promise.resolve(mockResponse(200, tag)));
    globalThis.fetch = mockFetch as any;

    const result = await client.createTag('user:abc');

    const { url, options } = getLastFetchCall();
    expect(url).toBe('https://n8n.test/api/v1/tags');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body as string)).toEqual({ name: 'user:abc' });
    expect(result.name).toBe('user:abc');
  });

  test('getOrCreateTag returns existing tag', async () => {
    const existingTag = createTag({ name: 'user:abc' });
    mockFetch = mock(() => Promise.resolve(mockResponse(200, { data: [existingTag] })));
    globalThis.fetch = mockFetch as any;

    const result = await client.getOrCreateTag('user:abc');

    expect(result.name).toBe('user:abc');
    // Should only call listTags (1 call), not createTag
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('getOrCreateTag creates new tag when not found', async () => {
    const newTag = createTag({ id: 'tag-new', name: 'user:xyz' });
    // First call: listTags returns empty, second call: createTag
    let callCount = 0;
    mockFetch = mock(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(mockResponse(200, { data: [] }));
      }
      return Promise.resolve(mockResponse(200, newTag));
    });
    globalThis.fetch = mockFetch as any;

    const result = await client.getOrCreateTag('user:xyz');

    expect(result.name).toBe('user:xyz');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// Error handling
// ============================================================================

describe('N8nApiClient error handling', () => {
  const client = new N8nApiClient('https://n8n.test', 'key-123');

  test('throws N8nApiError on 404', async () => {
    mockFetch = mock(() =>
      Promise.resolve(mockResponse(404, { message: 'Workflow not found' }, 'Not Found'))
    );
    globalThis.fetch = mockFetch as any;

    try {
      await client.getWorkflow('nonexistent');
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(error).toBeInstanceOf(N8nApiError);
      expect((error as N8nApiError).statusCode).toBe(404);
      expect((error as N8nApiError).message).toContain('Workflow not found');
    }
  });

  test('throws N8nApiError on 401', async () => {
    mockFetch = mock(() =>
      Promise.resolve(mockResponse(401, { message: 'Unauthorized' }, 'Unauthorized'))
    );
    globalThis.fetch = mockFetch as any;

    try {
      await client.listWorkflows();
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(N8nApiError);
      expect((error as N8nApiError).statusCode).toBe(401);
    }
  });

  test('throws N8nApiError on 500', async () => {
    mockFetch = mock(() =>
      Promise.resolve(
        mockResponse(500, { message: 'Internal Server Error' }, 'Internal Server Error')
      )
    );
    globalThis.fetch = mockFetch as any;

    try {
      await client.createWorkflow(createValidWorkflow());
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(N8nApiError);
      expect((error as N8nApiError).statusCode).toBe(500);
    }
  });

  test('throws N8nApiError on network failure', async () => {
    mockFetch = mock(() => Promise.reject(new Error('ECONNREFUSED')));
    globalThis.fetch = mockFetch as any;

    try {
      await client.listWorkflows();
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(N8nApiError);
      expect((error as N8nApiError).message).toContain('ECONNREFUSED');
      expect((error as N8nApiError).statusCode).toBeUndefined();
    }
  });

  test('handles empty 200 response for void operations', async () => {
    mockFetch = mock(() => Promise.resolve(new Response('', { status: 200 })));
    globalThis.fetch = mockFetch as any;

    // Should not throw
    await client.deleteWorkflow('wf-42');
  });

  test('includes status text in error when no message in body', async () => {
    mockFetch = mock(() => Promise.resolve(mockResponse(403, {}, 'Forbidden')));
    globalThis.fetch = mockFetch as any;

    try {
      await client.listWorkflows();
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(N8nApiError);
      expect((error as N8nApiError).message).toContain('Forbidden');
    }
  });
});

// ============================================================================
// Content-Type and body handling
// ============================================================================

describe('N8nApiClient request format', () => {
  const client = new N8nApiClient('https://n8n.test', 'key-123');

  test('sends Content-Type: application/json', async () => {
    mockFetch = mock(() => Promise.resolve(mockResponse(200, { data: [] })));
    globalThis.fetch = mockFetch as any;

    await client.listWorkflows();

    const { options } = getLastFetchCall();
    expect((options.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  test('GET requests have no body', async () => {
    mockFetch = mock(() => Promise.resolve(mockResponse(200, { data: [] })));
    globalThis.fetch = mockFetch as any;

    await client.listWorkflows();

    const { options } = getLastFetchCall();
    expect(options.body).toBeUndefined();
  });

  test('POST requests serialize body as JSON', async () => {
    mockFetch = mock(() => Promise.resolve(mockResponse(200, createWorkflowResponse())));
    globalThis.fetch = mockFetch as any;

    const workflow = createValidWorkflow();
    await client.createWorkflow(workflow);

    const { options } = getLastFetchCall();
    const parsed = JSON.parse(options.body as string);
    expect(parsed.name).toBe(workflow.name);
    expect(parsed.nodes).toHaveLength(workflow.nodes.length);
    expect(parsed.settings).toBeDefined();
  });
});

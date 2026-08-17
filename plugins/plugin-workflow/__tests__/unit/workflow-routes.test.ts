/** Exercises the authenticated native workflow status boundary without a Smithers gateway. */

import { describe, expect, test } from 'bun:test';
import type http from 'node:http';
import type { AgentRuntime } from '@elizaos/core';
import { handleWorkflowRoutes } from '../../src/routes/workflow-routes';
import { EMBEDDED_WORKFLOW_SERVICE_TYPE } from '../../src/services/embedded-workflow-service';
import { WORKFLOW_SERVICE_TYPE } from '../../src/services/workflow-service';

describe('native workflow routes', () => {
  test('reports the elizaOS Cloud-owned smthrs runtime contract', async () => {
    let response: unknown;
    const runtime = {
      agentId: '00000000-0000-4000-8000-000000000001',
      getService: (type: string) =>
        type === WORKFLOW_SERVICE_TYPE || type === EMBEDDED_WORKFLOW_SERVICE_TYPE ? {} : null,
    } as unknown as AgentRuntime;

    await handleWorkflowRoutes({
      req: {} as http.IncomingMessage,
      res: {} as http.ServerResponse,
      method: 'GET',
      pathname: '/api/workflow/status',
      runtime,
      principalId: 'owner',
      json: (_res, body) => {
        response = body;
      },
    });

    expect(response).toEqual({
      mode: 'cloud',
      host: 'eliza-cloud',
      status: 'ready',
      cloudConnected: true,
      localEnabled: false,
      platform: 'cloud',
      cloudHealth: 'healthy',
      engine: 'smthrs',
    });
  });

  test('rejects illegal percent-encoding in workflow and execution ids before service calls', async () => {
    const calls: string[] = [];
    const runtime = {
      agentId: '00000000-0000-4000-8000-000000000001',
      getService: (type: string) =>
        type === WORKFLOW_SERVICE_TYPE || type === EMBEDDED_WORKFLOW_SERVICE_TYPE
          ? {
              getWorkflow: async () => {
                calls.push('getWorkflow');
                return {};
              },
              getExecutionDetail: async () => {
                calls.push('getExecutionDetail');
                return {};
              },
              getWorkflowExecutions: async () => {
                calls.push('getWorkflowExecutions');
                return [];
              },
              restoreWorkflowRevision: async () => {
                calls.push('restoreWorkflowRevision');
                return {};
              },
            }
          : null,
    } as unknown as AgentRuntime;

    for (const pathname of [
      '/api/workflow/workflows/%',
      '/api/workflow/executions/%',
      '/api/workflow/workflows/%2',
      '/api/workflow/executions/%ZZ',
    ]) {
      calls.length = 0;
      let status: number | undefined;
      let body: unknown;
      await handleWorkflowRoutes({
        req: {} as http.IncomingMessage,
        res: {} as http.ServerResponse,
        method: 'GET',
        pathname,
        runtime,
        principalId: 'owner',
        json: (_res, payload, code) => {
          body = payload;
          status = code;
        },
      });
      expect(status).toBe(400);
      expect(body).toEqual({
        error: 'Path segment is not valid percent-encoding',
      });
      expect(calls).toEqual([]);
    }
  });

  test('still loads a canonically encoded workflow id', async () => {
    const seen: string[] = [];
    const runtime = {
      agentId: '00000000-0000-4000-8000-000000000001',
      getService: (type: string) =>
        type === WORKFLOW_SERVICE_TYPE
          ? {
              getWorkflow: async (id: string) => {
                seen.push(id);
                return { id };
              },
            }
          : type === EMBEDDED_WORKFLOW_SERVICE_TYPE
            ? {}
            : null,
    } as unknown as AgentRuntime;

    let status: number | undefined;
    let body: unknown;
    await handleWorkflowRoutes({
      req: {} as http.IncomingMessage,
      res: {} as http.ServerResponse,
      method: 'GET',
      pathname: '/api/workflow/workflows/wf%2Dprod',
      runtime,
      principalId: 'owner',
      json: (_res, payload, code) => {
        body = payload;
        status = code;
      },
    });

    expect(status).toBeUndefined();
    expect(seen).toEqual(['wf-prod']);
    expect(body).toEqual({ id: 'wf-prod' });
  });
});

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
});

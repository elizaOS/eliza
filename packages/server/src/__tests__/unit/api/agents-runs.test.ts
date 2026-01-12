import { describe, it, expect, beforeEach } from 'bun:test';
import express from 'express';
import type { UUID, IAgentRuntime, Log } from '@elizaos/core';
import { createAgentRunsRouter } from '../../../api/agents/runs';

type LogEntry = {
  type: string;
  createdAt: Date;
  body: Record<string, any>;
};

// Mock runtime interface for testing
interface MockRuntime extends Pick<IAgentRuntime, 'getLogs'> {
  getMemories: (params: any) => Promise<any[]>;
  getRoomsForParticipant: (entityId: UUID) => Promise<UUID[]>;
}

function makeRuntimeWithLogs(logs: LogEntry[], defaultEntityId: UUID): MockRuntime {
  return {
    getLogs: async (_params: any): Promise<Log[]> => {
      return logs.map((log) => ({
        entityId: (log.body.entityId as UUID) || defaultEntityId,
        roomId: log.body.roomId as UUID | undefined,
        type: log.type,
        createdAt: log.createdAt,
        body: log.body,
      }));
    },
    getMemories: async (_params: any) => [], // Return empty array for messages
    getRoomsForParticipant: async (_entityId: UUID) => [],
  };
}

// Helper to simulate requests without real HTTP server
async function simulateRequest(
  app: express.Application,
  method: string,
  path: string
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    let responseStatus = 200;
    let responseBody: any = null;
    let responseSent = false;

    const req: any = {
      method: method.toUpperCase(),
      url: path,
      path,
      originalUrl: path,
      query: {},
      params: {},
      headers: {},
      get: () => '',
    };

    const res: any = {
      status(code: number) {
        if (!responseSent) {
          responseStatus = code;
        }
        return this;
      },
      json(data: any) {
        if (!responseSent) {
          responseSent = true;
          responseBody = data;
          resolve({ status: responseStatus, body: data });
        }
        return this;
      },
      send(data: any) {
        if (!responseSent) {
          responseSent = true;
          responseBody = data;
          resolve({ status: responseStatus, body: data });
        }
        return this;
      },
      setHeader: () => {},
      set: () => {},
      end() {
        if (!responseSent) {
          responseSent = true;
          resolve({ status: responseStatus, body: responseBody });
        }
      },
    };

    const next = (err?: Error) => {
      if (!responseSent) {
        responseStatus = err ? 500 : 404;
        responseBody = { error: err?.message || 'Not found' };
        resolve({ status: responseStatus, body: responseBody });
      }
    };

    try {
      app(req, res, next as any);
    } catch (error) {
      if (!responseSent) {
        resolve({ status: 500, body: { error: error instanceof Error ? error.message : 'Error' } });
      }
    }
  });
}

describe('Agent Runs API', () => {
  let app: express.Application;

  const agentId = '00000000-0000-0000-0000-000000000001' as UUID;
  const roomId = '00000000-0000-0000-0000-000000000002' as UUID;
  const runId = '00000000-0000-0000-0000-00000000abcd' as UUID;
  const messageId = '00000000-0000-0000-0000-00000000dcba' as UUID;

  const baseTime = Date.now();

  const logs: LogEntry[] = [
    // Run lifecycle
    {
      type: 'run_event',
      createdAt: new Date(baseTime + 0),
      body: { runId, status: 'started', messageId, roomId, entityId: agentId, startTime: baseTime },
    },
    {
      type: 'run_event',
      createdAt: new Date(baseTime + 3000),
      body: {
        runId,
        status: 'completed',
        messageId,
        roomId,
        entityId: agentId,
        endTime: baseTime + 3000,
        duration: 3000,
      },
    },
    // Action started + completed
    {
      type: 'action_event',
      createdAt: new Date(baseTime + 500),
      body: { runId, actionId: 'act-1', actionName: 'REPLY', messageId },
    },
    {
      type: 'action',
      createdAt: new Date(baseTime + 2000),
      body: {
        runId,
        action: 'REPLY',
        actionId: 'act-1',
        result: { success: true },
        promptCount: 2,
      },
    },
    // Model call
    {
      type: 'useModel:TEXT_LARGE',
      createdAt: new Date(baseTime + 1200),
      body: { runId, modelType: 'TEXT_LARGE', executionTime: 420, provider: 'test' },
    },
    // Evaluator
    {
      type: 'evaluator',
      createdAt: new Date(baseTime + 2500),
      body: { runId, evaluator: 'goal_tracker' },
    },
    // Embedding event (failed)
    {
      type: 'embedding_event',
      createdAt: new Date(baseTime + 2600),
      body: { runId, status: 'failed', memoryId: 'mem-1' },
    },
  ];

  // Mock ElizaOS for testing
  type MockElizaOS = {
    getAgent: (id: UUID) => MockRuntime | null;
  };

  const mockElizaOS: MockElizaOS = {
    getAgent: (id: UUID) => {
      if (id === agentId) {
        return makeRuntimeWithLogs(logs, agentId);
      }
      return null;
    },
  };

  beforeEach(() => {
    app = express();
    app.use('/api/agents', createAgentRunsRouter(mockElizaOS as any));
  });

  it('GET /api/agents/:agentId/runs should return aggregated runs', async () => {
    const response = await simulateRequest(
      app,
      'GET',
      `/api/agents/${agentId}/runs?roomId=${roomId}`
    );

    expect(response.status).toBe(200);
    const body = response.body;

    expect(Array.isArray(body.data.runs)).toBe(true);
    expect(body.data.runs.length).toBeGreaterThan(0);
    const run = body.data.runs[0];

    expect(run.runId).toBe(runId);
    expect(run.status).toBe('completed');
    expect(run.counts.actions).toBeGreaterThanOrEqual(1);
    expect(run.counts.modelCalls).toBeGreaterThanOrEqual(1);
    expect(run.counts.evaluators).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/agents/:agentId/runs/:runId should return a timeline', async () => {
    const response = await simulateRequest(
      app,
      'GET',
      `/api/agents/${agentId}/runs/${runId}?roomId=${roomId}`
    );

    expect(response.status).toBe(200);
    const body = response.body;

    expect(body.data.summary.runId).toBe(runId);
    expect(body.data.summary.status).toBe('completed');
    expect(Array.isArray(body.data.events)).toBe(true);
    // Should include RUN_STARTED and RUN_ENDED
    const types = body.data.events.map((e: any) => e.type);
    expect(types).toContain('RUN_STARTED');
    expect(types).toContain('RUN_ENDED');
  });
});

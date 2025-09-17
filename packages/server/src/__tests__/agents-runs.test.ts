import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import express from 'express';
import type { UUID } from '@elizaos/core';
import { createAgentRunsRouter } from '../api/agents/runs';

type LogEntry = {
  type: string;
  createdAt: Date;
  body: Record<string, any>;
};

function makeRuntimeWithLogs(logs: LogEntry[]) {
  return {
    getLogs: async (_params: any) => logs,
  } as any;
}

describe('Agent Runs API', () => {
  let app: express.Application;
  let server: any;
  let port: number;

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

  const agents = new Map<UUID, any>([[agentId, makeRuntimeWithLogs(logs)]]);

  beforeEach((done) => {
    app = express();
    app.use('/api/agents', createAgentRunsRouter(agents));

    server = app.listen(0, () => {
      port = server.address().port;
      done();
    });
  });

  afterEach((done) => {
    server.close(done);
  });

  it('GET /api/agents/:agentId/runs should return aggregated runs', async () => {
    const response = await fetch(
      `http://localhost:${port}/api/agents/${agentId}/runs?roomId=${roomId}`
    );
    expect(response.status).toBe(200);
    const body = await response.json();

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
    const response = await fetch(
      `http://localhost:${port}/api/agents/${agentId}/runs/${runId}?roomId=${roomId}`
    );
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.data.summary.runId).toBe(runId);
    expect(body.data.summary.status).toBe('completed');
    expect(Array.isArray(body.data.events)).toBe(true);
    // Should include RUN_STARTED and RUN_ENDED
    const types = body.data.events.map((e: any) => e.type);
    expect(types).toContain('RUN_STARTED');
    expect(types).toContain('RUN_ENDED');
  });
});

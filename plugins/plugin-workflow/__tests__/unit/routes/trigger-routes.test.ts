import { describe, expect, test } from 'bun:test';
import type { IAgentRuntime, Task } from '@elizaos/core';
import {
  handleTriggerRoutes,
  type TriggerRouteContext,
  type TriggerSummary,
} from '../../../src/trigger-routes';

/**
 * WI-2 (#12177): the `/api/heartbeats` alias is retired. `handleTriggerRoutes`
 * must NOT claim `/api/heartbeats` (returns false so the server 404s it), and
 * `/api/triggers` must still work and respond with only the `triggers` key
 * (no duplicate `heartbeats` key).
 */

interface CapturedResponse {
  status: number;
  body: unknown;
}

function makeCtx(
  overrides: Partial<TriggerRouteContext> & {
    method: string;
    pathname: string;
  }
): { ctx: TriggerRouteContext; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, body: undefined };
  const res = {} as TriggerRouteContext['res'];

  const summary: TriggerSummary = {
    id: '00000000-0000-0000-0000-000000000001' as TriggerSummary['id'],
    taskId: '00000000-0000-0000-0000-000000000002' as TriggerSummary['taskId'],
    displayName: 'Morning report',
    instructions: 'Run workflow wf-1',
    triggerType: 'cron',
    enabled: true,
    wakeMode: 'inject_now',
    createdBy: 'api',
    runCount: 0,
    kind: 'workflow',
    workflowId: 'wf-1',
  };

  const task = { id: summary.taskId, name: 'TRIGGER_DISPATCH' } as Task;

  const ctx: TriggerRouteContext = {
    method: overrides.method,
    pathname: overrides.pathname,
    req: {} as TriggerRouteContext['req'],
    res,
    runtime: {} as IAgentRuntime,
    readJsonBody: async () => ({}),
    json: (_res, body, status = 200) => {
      captured.status = status;
      captured.body = body;
    },
    error: (_res, message, status = 500) => {
      captured.status = status;
      captured.body = { error: message };
    },
    executeTriggerTask: async () => ({ status: 'success', taskDeleted: false }),
    getTriggerHealthSnapshot: async () => ({
      triggersEnabled: true,
      activeTriggers: 1,
      disabledTriggers: 0,
      totalExecutions: 0,
      totalFailures: 0,
      totalSkipped: 0,
    }),
    getTriggerLimit: () => 100,
    listTriggerTasks: async () => [task],
    readTriggerConfig: () => null,
    readTriggerRuns: () => [],
    taskToTriggerSummary: () => summary,
    triggersFeatureEnabled: () => true,
    buildTriggerConfig: () => summary as never,
    buildTriggerMetadata: () => ({}),
    normalizeTriggerDraft: () => ({ draft: undefined }),
    DISABLED_TRIGGER_INTERVAL_MS: 60_000,
    TRIGGER_TASK_NAME: 'TRIGGER_DISPATCH',
    TRIGGER_TASK_TAGS: ['queue', 'repeat', 'trigger'],
    ...overrides,
  };

  return { ctx, captured };
}

describe('handleTriggerRoutes — heartbeat alias retired (WI-2)', () => {
  test('GET /api/heartbeats is not claimed (falls through to 404)', async () => {
    const { ctx, captured } = makeCtx({
      method: 'GET',
      pathname: '/api/heartbeats',
    });
    const handled = await handleTriggerRoutes(ctx);
    expect(handled).toBe(false);
    // Nothing was written — the server layer produces the 404.
    expect(captured.status).toBe(0);
  });

  test('GET /api/heartbeats/health is not claimed either', async () => {
    const { ctx, captured } = makeCtx({
      method: 'GET',
      pathname: '/api/heartbeats/health',
    });
    const handled = await handleTriggerRoutes(ctx);
    expect(handled).toBe(false);
    expect(captured.status).toBe(0);
  });

  test('GET /api/triggers still works and returns only the triggers key', async () => {
    const { ctx, captured } = makeCtx({
      method: 'GET',
      pathname: '/api/triggers',
    });
    const handled = await handleTriggerRoutes(ctx);
    expect(handled).toBe(true);
    expect(captured.status).toBe(200);
    const body = captured.body as { triggers?: unknown; heartbeats?: unknown };
    expect(Array.isArray(body.triggers)).toBe(true);
    expect((body.triggers as unknown[]).length).toBe(1);
    // The retired dual key must be gone.
    expect('heartbeats' in body).toBe(false);
  });

  test('GET /api/triggers/health still works', async () => {
    const { ctx, captured } = makeCtx({
      method: 'GET',
      pathname: '/api/triggers/health',
    });
    const handled = await handleTriggerRoutes(ctx);
    expect(handled).toBe(true);
    expect(captured.status).toBe(200);
    expect((captured.body as { triggersEnabled: boolean }).triggersEnabled).toBe(true);
  });
});

describe('POST /api/triggers — kind parsing (WI-3)', () => {
  test("rejects an unknown kind with a 'workflow' or 'prompt' message", async () => {
    const { ctx, captured } = makeCtx({
      method: 'POST',
      pathname: '/api/triggers',
      readJsonBody: async () => ({ kind: 'text', workflowId: 'wf-1' }) as never,
    });
    const handled = await handleTriggerRoutes(ctx);
    expect(handled).toBe(true);
    expect(captured.status).toBe(400);
    expect((captured.body as { error: string }).error).toContain("'workflow' or 'prompt'");
  });

  test("requires workflowId when kind is 'workflow'", async () => {
    const { ctx, captured } = makeCtx({
      method: 'POST',
      pathname: '/api/triggers',
      readJsonBody: async () => ({ kind: 'workflow' }) as never,
    });
    const handled = await handleTriggerRoutes(ctx);
    expect(handled).toBe(true);
    expect(captured.status).toBe(400);
    expect((captured.body as { error: string }).error).toContain('workflowId is required');
  });

  test("requires instructions when kind is 'prompt'", async () => {
    const { ctx, captured } = makeCtx({
      method: 'POST',
      pathname: '/api/triggers',
      readJsonBody: async () =>
        ({ kind: 'prompt', triggerType: 'cron', cronExpression: '0 9 * * *' }) as never,
    });
    const handled = await handleTriggerRoutes(ctx);
    expect(handled).toBe(true);
    expect(captured.status).toBe(400);
    expect((captured.body as { error: string }).error).toContain('instructions is required');
  });
});

describe("PUT /api/triggers/:id — switching to prompt kind (WI-3 review fix #1)", () => {
  // A stored workflow trigger whose instructions are the synthesized default.
  const workflowCurrent = {
    version: 1,
    triggerId: '00000000-0000-0000-0000-000000000002',
    displayName: 'Morning report',
    instructions: 'Run workflow wf-1',
    triggerType: 'cron',
    enabled: true,
    wakeMode: 'inject_now',
    createdBy: 'api',
    cronExpression: '0 9 * * *',
    runCount: 0,
    kind: 'workflow',
    workflowId: 'wf-1',
  };

  function putCtx(
    body: Record<string, unknown>,
    current: Record<string, unknown> = workflowCurrent,
  ) {
    const built = makeCtx({
      method: 'PUT',
      pathname: '/api/triggers/00000000-0000-0000-0000-000000000002',
      readJsonBody: async () => body as never,
      readTriggerConfig: () => current as never,
    });
    return built;
  }

  test('switching a workflow trigger to prompt WITHOUT instructions → 400', async () => {
    const { ctx, captured } = putCtx({ kind: 'prompt' });
    const handled = await handleTriggerRoutes(ctx);
    expect(handled).toBe(true);
    expect(captured.status).toBe(400);
    expect((captured.body as { error: string }).error).toContain(
      "instructions is required when kind is 'prompt'",
    );
  });

  test('switching a workflow trigger to prompt WITH instructions passes the kind guard', async () => {
    // normalizeTriggerDraft is stubbed to return no draft, so the handler stops
    // at the generic "Invalid update" 400 AFTER the instructions guard — proving
    // the instructions guard did NOT trip.
    const { ctx, captured } = putCtx({
      kind: 'prompt',
      instructions: 'Summarize my calendar every morning',
    });
    const handled = await handleTriggerRoutes(ctx);
    expect(handled).toBe(true);
    expect(captured.status).toBe(400);
    expect((captured.body as { error: string }).error).not.toContain(
      "instructions is required when kind is 'prompt'",
    );
  });

  test('a same-kind prompt→prompt update without instructions does NOT trip the guard', async () => {
    const promptCurrent = {
      ...workflowCurrent,
      instructions: 'Existing prompt instructions',
      kind: 'prompt',
      workflowId: undefined,
    };
    const { ctx, captured } = putCtx({ kind: 'prompt' }, promptCurrent);
    const handled = await handleTriggerRoutes(ctx);
    expect(handled).toBe(true);
    // Falls through to the generic invalid-update path, not the instructions 400.
    expect((captured.body as { error: string }).error).not.toContain(
      "instructions is required when kind is 'prompt'",
    );
  });
});

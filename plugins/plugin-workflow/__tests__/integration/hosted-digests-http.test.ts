import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeNextCronRunAtMs, ModelType, ServiceType, TaskService } from '@elizaos/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { registerTriggerTaskWorker } from '../../../../packages/agent/src/triggers/runtime.ts';
import { createRealTestRuntime } from '../../../../packages/app/test/helpers/real-runtime.ts';
import { embeddedExecutions, embeddedWorkflows, hostedResults } from '../../src/db/schema';
import { workflowPlugin } from '../../src/index';
import { handleWorkflowRoutes } from '../../src/routes/workflow-routes';
import type { EmbeddedWorkflowService } from '../../src/services/embedded-workflow-service';
import { digestDeliveryProjection } from '../../src/services/hosted-digest';
import { DIGEST_REVIEW_REQUIRED_TEXT } from '../../src/services/hosted-digest-policy';
import { compilePhoneWorkflowV3 } from '../../src/services/phone-workflow-compiler-v3';
import { PHONE_COMPILER_KEY, PHONE_SPEC_KEY } from '../../src/services/phone-workflow-spec';
import { resolveSmithersWorkflowDir } from '../../src/services/smithers-runtime';

/** A real runtime on a disk PGlite with the workflow plugin and a loopback model. */
async function hostedDigestHost() {
  const directory = await mkdtemp(join(tmpdir(), 'hosted-digest-e2e-')),
    owned: string[] = [];
  let cleanupAgent = '';
  let state: Awaited<ReturnType<typeof createRealTestRuntime>> | undefined,
    server: http.Server | undefined,
    origin = '',
    modelCalls = 0;
  const boot = async () => {
    state = await createRealTestRuntime({
      characterName: 'HostedDigestFixture',
      pgliteDir: directory,
      removePgliteDirOnCleanup: false,
      plugins: [
        workflowPlugin,
        {
          name: 'synthetic-digest-model',
          description: 'Loopback HTTP provider fixture',
          models: {
            [ModelType.TEXT_LARGE]: async (_runtime, params) => {
              const response = await fetch(origin + '/provider', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ prompt: params.prompt }),
              });
              if (!response.ok) throw Error('Fixture provider failed');
              return response.text();
            },
          },
        },
      ],
    });
    cleanupAgent = state.runtime.agentId;
    registerTriggerTaskWorker(state.runtime);
    if (!state.runtime.getService(ServiceType.TASK))
      await state.runtime.registerService(TaskService);
    server = http.createServer((req, res) => {
      void (async () => {
        if (req.url === '/provider') {
          let body = '';
          for await (const chunk of req) body += chunk;
          const data = JSON.parse(body);
          expect(data.prompt).toContain('snapshot');
          modelCalls++;
          res.end(
            'Snapshot observed at the reviewed time: synthetic task remains open. No current phone data was read.'
          );
          return;
        }
        const token = req.headers.authorization;
        if (
          token !== 'Bearer fixture-owner' &&
          token !== 'Bearer fixture-other' &&
          token !== 'Bearer paging-owner'
        ) {
          res.writeHead(401);
          res.end('{}');
          return;
        }
        await handleWorkflowRoutes({
          req,
          res,
          method: req.method!,
          pathname: new URL(req.url!, 'http://localhost').pathname,
          runtime: state!.runtime,
          principalId:
            token === 'Bearer fixture-owner'
              ? 'fixture-owner'
              : token === 'Bearer paging-owner'
                ? 'paging-owner'
                : 'fixture-other',
          json: (r, value, status = 200) => {
            r.writeHead(status, { 'content-type': 'application/json' });
            r.end(JSON.stringify(value));
          },
        });
      })().catch((error) => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(error) }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as any).port}`;
  };
  const stop = async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve()))
      );
      server = undefined;
    }
    await state?.cleanup();
    state = undefined;
  };
  const call = async (path: string, body?: unknown, owner = 'fixture-owner') => {
    const response = await fetch(origin + '/api/workflow' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer ' + owner, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const cleanup = async () => {
    await stop();
    for (const id of owned)
      await rm(resolveSmithersWorkflowDir(cleanupAgent, id), {
        recursive: true,
        force: true,
      }).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  };
  return {
    boot,
    stop,
    call,
    cleanup,
    owned,
    get runtime() {
      return state!.runtime;
    },
    get engine() {
      return state!.runtime.getService<EmbeddedWorkflowService>('embedded_workflow_service')!;
    },
    get modelCalls() {
      return modelCalls;
    },
  };
}

const snapshot = () => ({
  id: randomUUID(),
  kind: 'tasks',
  label: 'Explicit synthetic tasks',
  text: 'Synthetic task remains open. This is an explicitly reviewed snapshot.',
  observedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  confirmed: true,
});

test('core runs a local time inside a DST gap one gap later and a repeated time once', () => {
  // 02:30 does not exist on the spring-forward day; core runs it one gap later (03:30 EDT)
  // instead of skipping that day (trigger-scheduling cronMatches, #37576).
  expect(
    computeNextCronRunAtMs('30 2 * * *', Date.parse('2027-03-14T06:59:00Z'), 'America/New_York')
  ).toBe(Date.parse('2027-03-14T07:30:00Z'));
  expect(
    computeNextCronRunAtMs('30 1 * * *', Date.parse('2027-11-07T04:59:00Z'), 'America/New_York')
  ).toBe(Date.parse('2027-11-07T05:30:00Z'));
  expect(
    computeNextCronRunAtMs('30 1 * * *', Date.parse('2027-11-07T05:31:00Z'), 'America/New_York')
  ).toBe(Date.parse('2027-11-08T06:30:00Z'));
});

// Real wall-clock recurrence, not manual fire or a fake phone-presence flag. The
// occurrence is the next minute boundary at least 60 s away, so both loops are
// saved and the runtime restarted before it; the poll ends 60 s after it.
test('two actual scheduled hosted digests survive restart and reconnect with one persisted result each', async () => {
  const host = await hostedDigestHost();
  const { boot, stop, call, owned } = host;
  try {
    await boot();
    const input = snapshot();
    const oversizedUnicodeId = randomUUID();
    expect(
      (await call('/hosted/sources', { ...input, id: oversizedUnicodeId, text: '界'.repeat(5300) }))
        .status
    ).toBe(400);
    expect((await call('/hosted/sources')).body.sources).toHaveLength(0);
    const source = (await call('/hosted/sources', input)).body.source;
    expect(source.revision).toMatch(/^[a-f0-9]{64}$/);
    expect((await call('/hosted/sources')).body.sources[0].text).toBeUndefined();
    expect((await call('/hosted/sources', input)).body.source.revision).toBe(source.revision);
    const scheduledAt = Math.ceil((Date.now() + 60000) / 60000) * 60000,
      localTime = new Date(scheduledAt).toISOString().slice(11, 16),
      receipts: any[] = [];
    for (const template of ['morning', 'evening']) {
      const body = {
        mutationId: randomUUID(),
        confirmed: true,
        spec: {
          version: 1,
          template,
          sourceId: source.id,
          sourceRevision: source.revision,
          timeZone: 'UTC',
          localTime,
          enabled: true,
        },
      };
      const saved = await call('/hosted/loops', body);
      expect(saved.status).toBe(200);
      receipts.push(saved.body.receipt);
      owned.push(saved.body.receipt.workflowId);
      expect((await call('/hosted/loops', body)).body.receipt).toEqual(saved.body.receipt);
    }
    expect((await call('/hosted/loops', undefined, 'fixture-other')).body.loops).toHaveLength(0);
    const tasks = await host.runtime.getTasks({
      agentIds: [host.runtime.agentId],
      tags: ['trigger'],
    });
    expect(
      tasks.filter((t) => owned.includes(String((t.metadata?.trigger as any)?.workflowId)))
    ).toHaveLength(2);
    // Close real runtime and disk database before admission; recreated TaskService
    // must consume the persisted schedules without recreating or manually firing them.
    await stop();
    await boot();
    const deadline = scheduledAt + 60000;
    let entries: any[] = [];
    while (Date.now() < deadline) {
      entries = (await call('/hosted/results?clientId=phone-fixture')).body.entries;
      if (entries.length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.runId)).size).toBe(2);
    expect(host.modelCalls).toBe(2);
    for (const entry of entries) {
      expect(entry.status).toBe('finished');
      expect(entry.scheduledAt).toBe(new Date(scheduledAt).toISOString());
      expect(entry.source.type).toBe('explicit_snapshot');
      expect(JSON.stringify(entry.output)).toContain('synthetic task');
    }
    for (const receipt of receipts) {
      const before = entries.find((e) => e.workflowId === receipt.workflowId);
      const repeated = await Promise.all(
        [1, 2].map(() =>
          host.engine.startWorkflow(receipt.workflowId, {
            mode: 'trigger',
            triggerData: { scheduledAtMs: scheduledAt, workflowVersionId: receipt.versionId },
          })
        )
      );
      expect(repeated.map((r) => r.id)).toEqual([before.runId, before.runId]);
    }
    expect(host.modelCalls).toBe(2);
    expect(
      (await call('/hosted/results?clientId=phone-fixture', undefined, 'fixture-other')).body
        .entries
    ).toHaveLength(0);
    expect(
      (
        await call(
          '/hosted/results/ack',
          { clientId: 'phone-fixture', cursor: entries[1].cursor, runId: entries[1].runId },
          'fixture-other'
        )
      ).status
    ).toBe(404);
    // A disconnected reader sees the identical durable page until its local commit is acknowledged.
    expect((await call('/hosted/results?clientId=phone-fixture')).body.entries).toEqual(entries);
    expect(
      (
        await call('/hosted/results/ack', {
          clientId: 'phone-fixture',
          cursor: entries[1].cursor,
          runId: entries[1].runId,
        })
      ).status
    ).toBe(200);
    await stop();
    await boot();
    expect((await call('/hosted/results?clientId=phone-fixture')).body.entries).toHaveLength(0);
    expect((await call('/hosted/results?clientId=new-phone')).body.entries).toHaveLength(2);
    expect(host.modelCalls).toBe(2);
  } finally {
    await host.cleanup();
  }
}, 300000);

// Boundary admission uses the same real SQL engine on a fake Date: the clock
// starts one second after a minute boundary and only moves when a test moves it,
// so no check races a minute rollover or waits on the wall clock.
describe('hosted digest boundaries on a fixed clock', () => {
  let host: Awaited<ReturnType<typeof hostedDigestHost>>;
  let source: any, digest: any, currentMinute: number;
  const loopSpec = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    template: 'morning',
    sourceId: source.id,
    sourceRevision: source.revision,
    timeZone: 'UTC',
    localTime: new Date(currentMinute).toISOString().slice(11, 16),
    enabled: true,
    ...overrides,
  });
  const newLoop = async (overrides: Record<string, unknown> = {}) => {
    const saved = await host.call('/hosted/loops', {
      mutationId: randomUUID(),
      confirmed: true,
      spec: loopSpec(overrides),
    });
    expect(saved.status).toBe(200);
    host.owned.push(saved.body.receipt.workflowId);
    return saved.body.receipt;
  };
  const occurrence = (loop: { workflowId: string; versionId: string }) =>
    host.engine.startWorkflow(loop.workflowId, {
      mode: 'trigger',
      triggerData: { scheduledAtMs: currentMinute, workflowVersionId: loop.versionId },
    });
  const waitFinished = async (runId: string) => {
    let run = await host.engine.getExecution(runId);
    for (let i = 0; !run.finished && i < 1200; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      run = await host.engine.getExecution(runId);
    }
    return run;
  };

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    currentMinute = Math.ceil(Date.now() / 60000) * 60000;
    vi.setSystemTime(currentMinute + 1000);
    host = await hostedDigestHost();
    await host.boot();
    source = (await host.call('/hosted/sources', snapshot())).body.source;
    // One finished digest for the delivery and reconciliation checks.
    const run = await waitFinished((await occurrence(await newLoop())).id);
    expect(run.status).toBe('finished');
    digest = (await host.call('/hosted/results?clientId=setup-phone')).body.entries.find(
      (entry: { runId: string }) => entry.runId === run.id
    );
    expect(host.modelCalls).toBe(1);
  });

  afterAll(async () => {
    await host?.cleanup();
    vi.useRealTimers();
  });

  test('a missed, mismatched or manual occurrence does not run', async () => {
    const missed = await newLoop();
    const missedRun = await host.engine.startWorkflow(missed.workflowId, {
      mode: 'trigger',
      triggerData: { scheduledAtMs: currentMinute - 86400000, workflowVersionId: missed.versionId },
    });
    expect((missedRun.output as any).status).toBe('missed');
    expect(missedRun.finished).toBe(true);
    await expect(
      host.engine.startWorkflow(missed.workflowId, {
        mode: 'trigger',
        triggerData: { scheduledAtMs: currentMinute, workflowVersionId: randomUUID() },
      })
    ).rejects.toThrow();
    expect(
      (
        await host.call(`/workflows/${missed.workflowId}/run`, {
          submissionId: randomUUID(),
          expectedVersionId: missed.versionId,
          input: { hostedDigest: { scheduledAt: new Date(currentMinute).toISOString() } },
        })
      ).status
    ).toBe(409);
    expect(host.modelCalls).toBe(1);
  });

  test('an occurrence while an earlier run is still running is recorded as overlap', async () => {
    const overlap = await newLoop(),
      heldId = randomUUID(),
      held = {
        id: heldId,
        workflowId: overlap.workflowId,
        workflowVersionId: overlap.versionId,
        workflowName: 'Held synthetic occurrence',
        mode: 'trigger',
        status: 'running',
        finished: false,
        startedAt: new Date(currentMinute - 86400000).toISOString(),
        input: {},
        events: [],
        approvals: [],
      };
    await (host.runtime.db as any).insert(embeddedExecutions).values({
      agentId: host.runtime.agentId,
      id: heldId,
      workflowId: overlap.workflowId,
      status: 'running',
      mode: 'trigger',
      finished: false,
      startedAt: held.startedAt,
      execution: held,
    });
    expect(((await occurrence(overlap)).output as any).status).toBe('overlap');
    expect(host.modelCalls).toBe(1);
  });

  test('an expired or revoked source settles as unavailable and a paused loop refuses', async () => {
    const expiresAt = Date.now() + 60000;
    const expiring = (
      await host.call('/hosted/sources', {
        ...snapshot(),
        expiresAt: new Date(expiresAt).toISOString(),
      })
    ).body.source;
    const expiredLoop = await newLoop({
      sourceId: expiring.id,
      sourceRevision: expiring.revision,
    });
    vi.setSystemTime(expiresAt + 1000);
    expect(((await occurrence(expiredLoop)).output as any).status).toBe('unavailable');
    const input = snapshot();
    const revocable = (await host.call('/hosted/sources', input)).body.source;
    const request = {
      mutationId: randomUUID(),
      confirmed: true,
      spec: loopSpec({ sourceId: revocable.id, sourceRevision: revocable.revision }),
    };
    const revoked = (await host.call('/hosted/loops', request)).body.receipt;
    host.owned.push(revoked.workflowId);
    expect(
      (await host.call('/hosted/sources/revoke', { id: revocable.id, confirmed: true })).status
    ).toBe(200);
    expect((await host.call('/hosted/loops', request)).body.receipt).toEqual(revoked);
    expect((await host.call('/hosted/sources', input)).body.source.revoked).toBe(true);
    // A new loop cannot be saved on a revoked source.
    expect(
      (
        await host.call('/hosted/loops', {
          mutationId: randomUUID(),
          confirmed: true,
          spec: { ...request.spec, template: 'evening' },
        })
      ).status
    ).toBe(409);
    expect(((await occurrence(revoked)).output as any).status).toBe('unavailable');
    const paused = await host.call('/hosted/loops', {
      mutationId: randomUUID(),
      confirmed: true,
      id: revoked.workflowId,
      expectedVersionId: revoked.versionId,
      spec: { ...request.spec, enabled: false },
    });
    expect(paused.status).toBe(200);
    await expect(
      occurrence({ ...revoked, versionId: paused.body.receipt.versionId })
    ).rejects.toThrow();
    expect(host.modelCalls).toBe(1);
  });

  test('delivery projects oversized outputs and pages large results', async () => {
    const large = { ...digest, runId: randomUUID(), output: { text: '界'.repeat(190000) } };
    const projected = digestDeliveryProjection(large);
    expect((projected.output as any).status).toBe('retained_in_workflow_history');
    expect(large.output.text).toHaveLength(190000);
    for (let i = 0; i < 14; i++) {
      const runId = randomUUID();
      await (host.runtime.db as any).insert(hostedResults).values({
        agentId: host.runtime.agentId,
        ownerId: 'paging-owner',
        runId,
        workflowId: digest.workflowId,
        result: { ...digest, cursor: undefined, runId, output: { text: '界'.repeat(40000) } },
      });
    }
    let delivered = 0;
    while (delivered < 14) {
      const page = (
        await host.call('/hosted/results?clientId=paging-phone', undefined, 'paging-owner')
      ).body.entries;
      expect(page.length).toBeGreaterThan(0);
      expect(page.length).toBeLessThan(14);
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThan(1000000);
      delivered += page.length;
      const last = page[page.length - 1];
      expect(
        (
          await host.call(
            '/hosted/results/ack',
            { clientId: 'paging-phone', cursor: last.cursor, runId: last.runId },
            'paging-owner'
          )
        ).status
      ).toBe(200);
    }
    expect(delivered).toBe(14);
    expect(host.modelCalls).toBe(1);
  });

  // The hosted delivery moves with the SQL run, without rerunning inference.
  test('a lost terminal receipt reconciles from the finished native run', async () => {
    const terminal = await host.engine.getExecution(digest.runId);
    const {
      output: _lostOutput,
      error: _lostError,
      nextRunId: _lostNextRunId,
      ...retained
    } = terminal;
    const provisional = { ...retained, status: 'cancelled' as const, finished: true };
    const terminalWhere = and(
      eq(embeddedExecutions.agentId, host.runtime.agentId),
      eq(embeddedExecutions.id, terminal.id)
    );
    await (host.runtime.db as any)
      .update(embeddedExecutions)
      .set({
        status: 'cancelled',
        finished: true,
        execution: provisional,
      })
      .where(terminalWhere);
    const resultWhere = and(
      eq(hostedResults.agentId, host.runtime.agentId),
      eq(hostedResults.runId, terminal.id)
    );
    await (host.runtime.db as any)
      .update(hostedResults)
      .set({
        result: { ...digest, status: 'cancelled', output: null },
      })
      .where(resultWhere);
    await expect(host.engine.cancelExecution(terminal.id)).rejects.toMatchObject({
      statusCode: 409,
      response: { code: 'WORKFLOW_TERMINAL_RESULT_UNAVAILABLE', nativeStatus: 'finished' },
    });
    const reconciled = await host.engine.getExecution(terminal.id);
    expect(reconciled.status).toBe('failed');
    expect(reconciled.output).toBeUndefined();
    const reconciledRows = await (host.runtime.db as any)
      .select()
      .from(hostedResults)
      .where(resultWhere);
    expect(reconciledRows).toHaveLength(1);
    expect(reconciledRows[0].result.status).toBe('failed');
    expect(reconciledRows[0].result.error).toBe(reconciled.error?.message);
    expect(await host.engine.cancelExecution(terminal.id)).toEqual(reconciled);
    // A delayed cancellation reconciliation cannot replace a newer terminal winner.
    const internals = host.engine as unknown as {
      saveExecution(execution: typeof terminal, expected: typeof terminal): Promise<void>;
    };
    await internals.saveExecution(
      { ...provisional, status: 'failed', error: { message: 'stale' } },
      provisional
    );
    expect(await host.engine.getExecution(terminal.id)).toEqual(reconciled);
    expect(
      (await host.call('/hosted/results?clientId=reconciled-phone')).body.entries.find(
        (entry: { runId: string }) => entry.runId === terminal.id
      )
    ).toMatchObject({ status: 'failed', error: reconciled.error?.message });
    expect(host.modelCalls).toBe(1);
  });

  test('digests saved before a compiler update keep running; altered sources settle as not run', async () => {
    const rewrite = async (workflowId: string, change: (workflow: any) => void) => {
      const db = host.runtime.db as any,
        where = and(
          eq(embeddedWorkflows.agentId, host.runtime.agentId),
          eq(embeddedWorkflows.id, workflowId)
        );
      const [row] = await db.select().from(embeddedWorkflows).where(where);
      const workflow = structuredClone(row.workflow);
      change(workflow);
      await db.update(embeddedWorkflows).set({ workflow }).where(where);
    };
    const upgradeMinute = Math.floor(Date.now() / 60000) * 60000;
    const current = (
      await host.call('/hosted/sources', {
        ...snapshot(),
      })
    ).body.source;
    const upgradeLoop = async (template: string) => {
      const saved = await host.call('/hosted/loops', {
        mutationId: randomUUID(),
        confirmed: true,
        spec: {
          version: 1,
          template,
          sourceId: current.id,
          sourceRevision: current.revision,
          timeZone: 'UTC',
          localTime: new Date(upgradeMinute).toISOString().slice(11, 16),
          enabled: true,
        },
      });
      expect(saved.status).toBe(200);
      host.owned.push(saved.body.receipt.workflowId);
      return saved.body.receipt;
    };
    const compiler3 = await upgradeLoop('morning');
    const listed = (await host.call(`/workflows/${compiler3.workflowId}`)).body;
    expect(listed.description).toBe(
      'Summarises the snapshot you shared when the phone is on at the scheduled time.'
    );
    expect(
      (await host.call('/workflows')).body.workflows.find((w: any) => w.id === compiler3.workflowId)
        .description
    ).toBe(listed.description);
    await rewrite(compiler3.workflowId, (workflow) => {
      const source = compilePhoneWorkflowV3(JSON.parse(workflow.metadata[PHONE_SPEC_KEY]));
      expect(source).not.toBe(workflow.source);
      workflow.source = source;
      workflow.metadata[PHONE_COMPILER_KEY] = 'phone-workflow-compiler-3';
    });
    const upgraded = await waitFinished(
      (
        await host.engine.startWorkflow(compiler3.workflowId, {
          mode: 'trigger',
          triggerData: { scheduledAtMs: upgradeMinute, workflowVersionId: compiler3.versionId },
        })
      ).id
    );
    expect(upgraded.status).toBe('finished');
    expect(JSON.stringify(upgraded.output)).toContain('synthetic task');
    expect(host.modelCalls).toBe(2);
    await rewrite(compiler3.workflowId, (workflow) => {
      workflow.description = 'My own description';
    });
    expect((await host.call(`/workflows/${compiler3.workflowId}`)).body.description).toBe(
      'My own description'
    );
    const tampered = await upgradeLoop('evening');
    await rewrite(tampered.workflowId, (workflow) => {
      workflow.source += '\n// unreviewed executable source';
    });
    const stopped = await host.engine.startWorkflow(tampered.workflowId, {
      mode: 'trigger',
      triggerData: { scheduledAtMs: upgradeMinute, workflowVersionId: tampered.versionId },
    });
    expect(stopped.finished).toBe(true);
    expect(stopped.output).toMatchObject({
      status: 'unavailable',
      text: DIGEST_REVIEW_REQUIRED_TEXT,
    });
    expect(
      (await host.call('/hosted/results?clientId=upgrade-phone')).body.entries.filter(
        (entry: any) => entry.workflowId === tampered.workflowId
      )
    ).toMatchObject([
      { runId: stopped.id, status: 'unavailable', output: { text: DIGEST_REVIEW_REQUIRED_TEXT } },
    ]);
    expect((await host.call(`/workflows/${tampered.workflowId}`)).body.active).toBe(true);
    expect(
      (await host.runtime.getTasks({ agentIds: [host.runtime.agentId], tags: ['trigger'] })).filter(
        (t) => String((t.metadata?.trigger as any)?.workflowId) === tampered.workflowId
      )
    ).toHaveLength(1);
    expect(host.modelCalls).toBe(2);
  });
});

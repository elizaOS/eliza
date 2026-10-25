import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeNextCronRunAtMs, ModelType, ServiceType, TaskService } from '@elizaos/core';
import { and, eq } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { registerTriggerTaskWorker } from '../../../../packages/agent/src/triggers/runtime.ts';
import { createRealTestRuntime } from '../../../../packages/app/test/helpers/real-runtime.ts';
import { embeddedExecutions, hostedResults } from '../../src/db/schema';
import { workflowPlugin } from '../../src/index';
import { handleWorkflowRoutes } from '../../src/routes/workflow-routes';
import type { EmbeddedWorkflowService } from '../../src/services/embedded-workflow-service';
import { digestDeliveryProjection } from '../../src/services/hosted-digest';
import { resolveSmithersWorkflowDir } from '../../src/services/smithers-runtime';

test('two actual scheduled hosted digests survive restart and reconnect with one persisted result each', async () => {
  let cleanupAgent = '';
  const directory = await mkdtemp(join(tmpdir(), 'hosted-digest-e2e-')),
    owned: string[] = [];
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
  try {
    expect(
      computeNextCronRunAtMs('30 2 * * *', Date.parse('2027-03-14T06:59:00Z'), 'America/New_York')
    ).toBe(Date.parse('2027-03-15T06:30:00Z'));
    expect(
      computeNextCronRunAtMs('30 1 * * *', Date.parse('2027-11-07T04:59:00Z'), 'America/New_York')
    ).toBe(Date.parse('2027-11-07T05:30:00Z'));
    expect(
      computeNextCronRunAtMs('30 1 * * *', Date.parse('2027-11-07T05:31:00Z'), 'America/New_York')
    ).toBe(Date.parse('2027-11-08T06:30:00Z'));
    await boot();
    const input = {
      id: randomUUID(),
      kind: 'tasks',
      label: 'Explicit synthetic tasks',
      text: 'Synthetic task remains open. This is an explicitly reviewed snapshot.',
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      confirmed: true,
    };
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
    // Real wall-clock recurrence, not manual fire or a fake phone-presence flag.
    const scheduledAt = Math.floor(Date.now() / 60000) * 60000 + 120000,
      localTime = new Date(scheduledAt).toISOString().slice(11, 16),
      receipts: any[] = [],
      requests: any[] = [];
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
      requests.push(body);
      const saved = await call('/hosted/loops', body);
      expect(saved.status).toBe(200);
      receipts.push(saved.body.receipt);
      owned.push(saved.body.receipt.workflowId);
      expect((await call('/hosted/loops', body)).body.receipt).toEqual(saved.body.receipt);
    }
    expect((await call('/hosted/loops', undefined, 'fixture-other')).body.loops).toHaveLength(0);
    const tasks = await state!.runtime.getTasks({
      agentIds: [state!.runtime.agentId],
      tags: ['trigger'],
    });
    expect(
      tasks.filter((t) => owned.includes(String((t.metadata?.trigger as any)?.workflowId)))
    ).toHaveLength(2);
    // Close real runtime and disk database before admission; recreated TaskService
    // must consume the persisted schedules without recreating or manually firing them.
    await stop();
    await boot();
    const deadline = scheduledAt + 90000;
    let entries: any[] = [];
    while (Date.now() < deadline) {
      entries = (await call('/hosted/results?clientId=phone-fixture')).body.entries;
      if (entries.length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.runId)).size).toBe(2);
    expect(modelCalls).toBe(2);
    for (const entry of entries) {
      expect(entry.status).toBe('finished');
      expect(entry.scheduledAt).toBe(new Date(scheduledAt).toISOString());
      expect(entry.source.type).toBe('explicit_snapshot');
      expect(JSON.stringify(entry.output)).toContain('synthetic task');
    }
    const engine = state!.runtime.getService<EmbeddedWorkflowService>('embedded_workflow_service')!;
    for (const receipt of receipts) {
      const before = entries.find((e) => e.workflowId === receipt.workflowId);
      const repeated = await Promise.all(
        [1, 2].map(() =>
          engine.startWorkflow(receipt.workflowId, {
            mode: 'trigger',
            triggerData: { scheduledAtMs: scheduledAt, workflowVersionId: receipt.versionId },
          })
        )
      );
      expect(repeated.map((r) => r.id)).toEqual([before.runId, before.runId]);
    }
    expect(modelCalls).toBe(2);
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
    expect(modelCalls).toBe(2);
    // Boundary admission uses the same real SQL engine. These are separate from
    // the two primary wall-clock scheduled executions above.
    const freshEngine = state!.runtime.getService<EmbeddedWorkflowService>(
      'embedded_workflow_service'
    )!;
    const currentMinute = Math.floor(Date.now() / 60000) * 60000;
    const boundarySpec = {
      version: 1,
      template: 'morning',
      sourceId: source.id,
      sourceRevision: source.revision,
      timeZone: 'UTC',
      localTime: new Date(currentMinute).toISOString().slice(11, 16),
      enabled: true,
    };
    const newLoop = async () => {
      const value = (
        await call('/hosted/loops', {
          mutationId: randomUUID(),
          confirmed: true,
          spec: boundarySpec,
        })
      ).body.receipt;
      owned.push(value.workflowId);
      return value;
    };
    const missed = await newLoop();
    const missedRun = await freshEngine.startWorkflow(missed.workflowId, {
      mode: 'trigger',
      triggerData: { scheduledAtMs: currentMinute - 86400000, workflowVersionId: missed.versionId },
    });
    expect((missedRun.output as any).status).toBe('missed');
    expect(missedRun.finished).toBe(true);
    await expect(
      freshEngine.startWorkflow(missed.workflowId, {
        mode: 'trigger',
        triggerData: { scheduledAtMs: currentMinute, workflowVersionId: randomUUID() },
      })
    ).rejects.toThrow();
    expect(
      (
        await call(`/workflows/${missed.workflowId}/run`, {
          submissionId: randomUUID(),
          expectedVersionId: missed.versionId,
          input: { hostedDigest: { scheduledAt: new Date(currentMinute).toISOString() } },
        })
      ).status
    ).toBe(409);
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
    await (state!.runtime.db as any).insert(embeddedExecutions).values({
      agentId: state!.runtime.agentId,
      id: heldId,
      workflowId: overlap.workflowId,
      status: 'running',
      mode: 'trigger',
      finished: false,
      startedAt: held.startedAt,
      execution: held,
    });
    const overlapRun = await freshEngine.startWorkflow(overlap.workflowId, {
      mode: 'trigger',
      triggerData: { scheduledAtMs: currentMinute, workflowVersionId: overlap.versionId },
    });
    expect((overlapRun.output as any).status).toBe('overlap');
    const expiresAt = Date.now() + 2500;
    const expiring = (
      await call('/hosted/sources', {
        ...input,
        id: randomUUID(),
        observedAt: new Date().toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
      })
    ).body.source;
    const expiredLoop = (
      await call('/hosted/loops', {
        mutationId: randomUUID(),
        confirmed: true,
        spec: { ...boundarySpec, sourceId: expiring.id, sourceRevision: expiring.revision },
      })
    ).body.receipt;
    owned.push(expiredLoop.workflowId);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiresAt - Date.now() + 20)));
    const expiredRun = await freshEngine.startWorkflow(expiredLoop.workflowId, {
      mode: 'trigger',
      triggerData: { scheduledAtMs: currentMinute, workflowVersionId: expiredLoop.versionId },
    });
    expect((expiredRun.output as any).status).toBe('unavailable');
    const revoked = await newLoop();
    expect((await call('/hosted/sources/revoke', { id: source.id, confirmed: true })).status).toBe(
      200
    );
    expect((await call('/hosted/loops', requests[0])).body.receipt).toEqual(receipts[0]);
    expect((await call('/hosted/sources', input)).body.source.revoked).toBe(true);
    const unavailable = await freshEngine.startWorkflow(revoked.workflowId, {
      mode: 'trigger',
      triggerData: { scheduledAtMs: currentMinute, workflowVersionId: revoked.versionId },
    });
    expect((unavailable.output as any).status).toBe('unavailable');
    const paused = await call('/hosted/loops', {
      mutationId: randomUUID(),
      confirmed: true,
      id: revoked.workflowId,
      expectedVersionId: revoked.versionId,
      spec: { ...boundarySpec, enabled: false },
    });
    expect(paused.status).toBe(200);
    await expect(
      freshEngine.startWorkflow(revoked.workflowId, {
        mode: 'trigger',
        triggerData: {
          scheduledAtMs: currentMinute,
          workflowVersionId: paused.body.receipt.versionId,
        },
      })
    ).rejects.toThrow();
    expect(modelCalls).toBe(2);

    expect(
      (
        await call('/hosted/loops', {
          mutationId: randomUUID(),
          confirmed: true,
          spec: {
            version: 1,
            template: 'morning',
            sourceId: source.id,
            sourceRevision: source.revision,
            timeZone: 'UTC',
            localTime,
            enabled: true,
          },
        })
      ).status
    ).toBe(409);
    // Reconcile a lost host terminal receipt against the real, already finished
    // native run. The hosted delivery must move with the SQL run, without rerunning inference.
    const terminal = await freshEngine.getExecution(entries[0].runId);
    const {
      output: _lostOutput,
      error: _lostError,
      nextRunId: _lostNextRunId,
      ...retained
    } = terminal;
    const provisional = { ...retained, status: 'cancelled' as const, finished: true };
    const terminalWhere = and(
      eq(embeddedExecutions.agentId, state!.runtime.agentId),
      eq(embeddedExecutions.id, terminal.id)
    );
    await (state!.runtime.db as any)
      .update(embeddedExecutions)
      .set({
        status: 'cancelled',
        finished: true,
        execution: provisional,
      })
      .where(terminalWhere);
    const resultWhere = and(
      eq(hostedResults.agentId, state!.runtime.agentId),
      eq(hostedResults.runId, terminal.id)
    );
    await (state!.runtime.db as any)
      .update(hostedResults)
      .set({
        result: { ...entries[0], status: 'cancelled', output: null },
      })
      .where(resultWhere);
    await expect(freshEngine.cancelExecution(terminal.id)).rejects.toMatchObject({
      statusCode: 409,
      response: { code: 'WORKFLOW_TERMINAL_RESULT_UNAVAILABLE', nativeStatus: 'finished' },
    });
    const reconciled = await freshEngine.getExecution(terminal.id);
    expect(reconciled.status).toBe('failed');
    expect(reconciled.output).toBeUndefined();
    const reconciledRows = await (state!.runtime.db as any)
      .select()
      .from(hostedResults)
      .where(resultWhere);
    expect(reconciledRows).toHaveLength(1);
    expect(reconciledRows[0].result.status).toBe('failed');
    expect(reconciledRows[0].result.error).toBe(reconciled.error?.message);
    expect(await freshEngine.cancelExecution(terminal.id)).toEqual(reconciled);
    // A delayed cancellation reconciliation cannot replace a newer terminal winner.
    const internals = freshEngine as unknown as {
      saveExecution(execution: typeof terminal, expected: typeof terminal): Promise<void>;
    };
    await internals.saveExecution(
      { ...provisional, status: 'failed', error: { message: 'stale' } },
      provisional
    );
    expect(await freshEngine.getExecution(terminal.id)).toEqual(reconciled);
    expect(
      (await call('/hosted/results?clientId=reconciled-phone')).body.entries.find(
        (entry: { runId: string }) => entry.runId === terminal.id
      )
    ).toMatchObject({ status: 'failed', error: reconciled.error?.message });
    expect(modelCalls).toBe(2);
    // Delivery projects oversized outputs without mutating the authoritative run.
    const large = { ...entries[0], runId: randomUUID(), output: { text: '界'.repeat(190000) } };
    const projected = digestDeliveryProjection(large);
    expect((projected.output as any).status).toBe('retained_in_workflow_history');
    expect(large.output.text).toHaveLength(190000);
    for (let i = 0; i < 14; i++) {
      const runId = randomUUID();
      await (state!.runtime.db as any).insert(hostedResults).values({
        agentId: state!.runtime.agentId,
        ownerId: 'paging-owner',
        runId,
        workflowId: entries[0].workflowId,
        result: { ...entries[0], cursor: undefined, runId, output: { text: '界'.repeat(40000) } },
      });
    }
    let delivered = 0;
    while (delivered < 14) {
      const page = (await call('/hosted/results?clientId=paging-phone', undefined, 'paging-owner'))
        .body.entries;
      expect(page.length).toBeGreaterThan(0);
      expect(page.length).toBeLessThan(14);
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThan(1000000);
      delivered += page.length;
      const last = page[page.length - 1];
      expect(
        (
          await call(
            '/hosted/results/ack',
            { clientId: 'paging-phone', cursor: last.cursor, runId: last.runId },
            'paging-owner'
          )
        ).status
      ).toBe(200);
    }
    expect(delivered).toBe(14);
  } finally {
    await stop();
    for (const id of owned)
      await rm(resolveSmithersWorkflowDir(cleanupAgent, id), {
        recursive: true,
        force: true,
      }).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

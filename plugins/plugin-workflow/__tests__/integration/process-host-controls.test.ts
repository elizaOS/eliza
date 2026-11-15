/** Real worker/control subprocesses with durable SQLite decisions across restarts. */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  controlSmithersRun,
  resolveSmithersWorkflowDir,
  runSmithersWorkflow,
} from '../../src/services/smithers-runtime';
import type { WorkflowDefinitionResponse } from '../../src/types/index';

for (const decision of ['deny', 'cancel'] as const) {
  test(`worker ${decision} remains durable across restart without executing guarded task`, async () => {
    const tenantId = `control-${randomUUID()}`;
    const id = 'guarded';
    const definition: WorkflowDefinitionResponse = {
      id,
      name: 'guarded control',
      active: true,
      language: 'tsx',
      steps: [],
      widgets: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      versionId: 'v1',
      source: `/** @jsxImportSource smthrs */
import {createSmithers} from 'smthrs/create'; import {approvalDecisionSchema} from 'smthrs'; import {z} from 'zod';
const {Workflow,Sequence,Approval,Task,smithers,outputs}=createSmithers({decision:approvalDecisionSchema,result:z.object({value:z.number()})},{dbPath:process.env.ELIZA_SMTHRS_DB_PATH});
export default smithers(()=><Workflow name="guarded"><Sequence><Approval id="gate" mode="approve" output={outputs.decision} request={{title:'Review synthetic task'}}/><Task id="effect" output={outputs.result} agent={globalThis.__elizaSmithers.agent}>Produce synthetic value.</Task></Sequence></Workflow>);`,
    };
    let calls = 0;
    const request = {
      tenantId,
      workflow: definition,
      runId: randomUUID(),
      mode: 'manual' as const,
      input: {},
      timeoutMs: 20000,
      generate: async () => {
        calls++;
        return '{"value":56}';
      },
    };
    try {
      const initial = await runSmithersWorkflow(request);
      expect(initial.status).toBe('waiting-approval');
      expect((await runSmithersWorkflow(request)).status).toBe('waiting-approval');
      expect(calls).toBe(0);
      const iteration = initial.events.find(
        (event) => event.nodeId === 'gate' && typeof event.iteration === 'number'
      )?.iteration;
      if (iteration === undefined) throw new Error('Missing durable approval iteration');
      expect(
        await controlSmithersRun(tenantId, id, { kind: 'status', runId: request.runId })
      ).toEqual({ status: 'waiting-approval' });
      await controlSmithersRun(
        tenantId,
        id,
        decision === 'cancel'
          ? { kind: 'cancel', runId: request.runId }
          : { kind: 'deny', runId: request.runId, nodeId: 'gate', iteration }
      );
      for (let restart = 0; restart < 2; restart++) {
        expect((await runSmithersWorkflow(request)).status).toBe(
          decision === 'cancel' ? 'cancelled' : 'failed'
        );
        expect(calls).toBe(0);
      }
    } finally {
      await rm(resolveSmithersWorkflowDir(tenantId, id), { recursive: true, force: true });
    }
  }, 100000);
}

test('status probe reads without creating a store or a run row', async () => {
  const tenantId = `status-${randomUUID()}`;
  const id = 'probe';
  const dir = resolveSmithersWorkflowDir(tenantId, id);
  try {
    expect(await controlSmithersRun(tenantId, id, { kind: 'status', runId: 'missing' })).toEqual({
      status: null,
    });
    await expect(stat(join(dir, 'runs.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });

    const database = new Database(join(dir, 'runs.sqlite'));
    database.exec(
      'CREATE TABLE _smithers_runs (run_id TEXT PRIMARY KEY, workflow_name TEXT, status TEXT)'
    );
    database.close();
    expect(await controlSmithersRun(tenantId, id, { kind: 'status', runId: 'missing' })).toEqual({
      status: null,
    });
    const reread = new Database(join(dir, 'runs.sqlite'), { readonly: true });
    try {
      expect(reread.query('SELECT COUNT(*) AS count FROM _smithers_runs').get()).toEqual({
        count: 0,
      });
    } finally {
      reread.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);

test('a hung control child is killed at its deadline', async () => {
  const tenantId = `hung-${randomUUID()}`;
  const id = 'hung';
  const scratch = await mkdtemp(join(tmpdir(), 'hung-control-'));
  const hung = join(scratch, 'hung.sh');
  await writeFile(hung, '#!/bin/sh\nexec sleep 60\n');
  await chmod(hung, 0o700);
  const previous = process.env.BUN_BIN;
  process.env.BUN_BIN = hung;
  const startedAt = Date.now();
  try {
    await expect(
      controlSmithersRun(tenantId, id, { kind: 'cancel', runId: 'any' }, { timeoutMs: 500 })
    ).rejects.toMatchObject({ code: 'SMTHRS_CONTROL_TIMEOUT' });
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  } finally {
    if (previous === undefined) delete process.env.BUN_BIN;
    else process.env.BUN_BIN = previous;
    await rm(scratch, { recursive: true, force: true });
    await rm(resolveSmithersWorkflowDir(tenantId, id), { recursive: true, force: true });
  }
}, 30000);

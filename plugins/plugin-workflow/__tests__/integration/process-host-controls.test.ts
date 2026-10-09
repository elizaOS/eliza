/** Real worker/control subprocesses with durable SQLite decisions across restarts. */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
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

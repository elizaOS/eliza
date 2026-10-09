import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../../src/db/schema';
import { handleWorkflowRoutes } from '../../src/routes/workflow-routes';
import { EmbeddedWorkflowService } from '../../src/services/embedded-workflow-service';
import { WorkflowService } from '../../src/services/workflow-service';

test('HTTP draft generation validates, repairs once, and never persists or schedules', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-submission-'));
  const db = new PGlite(directory);
  let server: http.Server | undefined;
  let embedded: EmbeddedWorkflowService | undefined;
  let workflowDirectory: string | undefined;
  try {
    await db.exec(`
    CREATE SCHEMA workflow;
    CREATE TABLE workflow.embedded_workflows (
      agent_id text NOT NULL,
      id text NOT NULL,
      name text NOT NULL,
      active boolean NOT NULL DEFAULT false,
      workflow jsonb NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      version_id text NOT NULL,
      PRIMARY KEY (agent_id, id)
    );
    CREATE TABLE workflow.workflow_revisions (
      agent_id text NOT NULL,
      id text NOT NULL,
      workflow_id text NOT NULL,
      version_id text NOT NULL,
      name text NOT NULL,
      active boolean NOT NULL DEFAULT false,
      workflow jsonb NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      captured_at text NOT NULL,
      operation text NOT NULL,
      PRIMARY KEY (agent_id, id),
      UNIQUE (agent_id, workflow_id, version_id)
    );
    CREATE TABLE workflow.embedded_executions (
      agent_id text NOT NULL,
      id text NOT NULL,
      workflow_id text NOT NULL,
      status text NOT NULL,
      mode text NOT NULL,
      finished boolean NOT NULL DEFAULT false,
      started_at text NOT NULL,
      stopped_at text,
      execution jsonb NOT NULL,
      idempotency_key text,
      PRIMARY KEY (agent_id, id)
    );
    CREATE TABLE workflow.embedded_tags (
      agent_id text NOT NULL,
      id text NOT NULL,
      name text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      PRIMARY KEY (agent_id, id),
      UNIQUE (agent_id, name)
    );

 CREATE TABLE workflow.manual_submissions(agent_id text NOT NULL,workflow_id text NOT NULL,submission_id text NOT NULL,owner_id text NOT NULL,version_id text NOT NULL,input jsonb NOT NULL,run_id text NOT NULL,PRIMARY KEY(agent_id,workflow_id,submission_id));`);
    let runtime: any;
    let scheduleWrites = 0;
    const boot = async () => {
      runtime = {
        agentId: '00000000-0000-4000-8000-000000000001',
        db: drizzle(db, { schema }),
        getTasks: async () => [],
        createTask: async () => {
          scheduleWrites++;
          throw new Error('Unexpected schedule');
        },
        emitEvent: async () => {},
        getService: (name: string) => (name === 'embedded_workflow_service' ? embedded : facade),
      };
      embedded = await EmbeddedWorkflowService.start(runtime);
      const facade = new WorkflowService(runtime);
      server = http.createServer((req, res) => {
        void handleWorkflowRoutes({
          req,
          res,
          method: req.method!,
          pathname: new URL(req.url!, 'http://localhost').pathname,
          runtime,
          principalId: req.headers['x-fixture-owner'] === 'other' ? 'other' : 'owner',
          json: (response, body, status = 200) => {
            if (req.headers['x-fixture-drop'] === '1' && status === 202) {
              response.destroy();
              return;
            }
            response.writeHead(status, { 'content-type': 'application/json' });
            response.end(JSON.stringify(body));
          },
        });
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${(server.address() as any).port}/api/workflow`;
    };
    const origin = await boot();
    const call = async (path: string, body?: unknown, owner = 'owner') => {
      const response = await fetch(origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'content-type': 'application/json',
          'x-fixture-owner': owner,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as any };
    };
    const valid =
      '/** @jsxImportSource smthrs */\nimport { createSmithers } from "smthrs/create";\nimport { approvalDecisionSchema } from "smthrs";\nimport { z } from "zod";\n\nconst { Workflow, Sequence, Approval, Task, smithers, outputs } = createSmithers(\n  { decision: approvalDecisionSchema, output: z.object({ value: z.number() }) },\n  { dbPath: process.env.ELIZA_SMTHRS_DB_PATH },\n);\nexport default smithers(() => (\n  <Workflow name="synthetic-arithmetic">\n    <Sequence>\n      <Approval id="review" output={outputs.decision} request={{\n        title: "Calculate?", summary: "Produce synthetic arithmetic after review.",\n        metadata: { approvalPresentation: {\n          version: 1, operation: "Compute", target: "Synthetic result", account: "Fixture owner",\n        } },\n      }} />\n      <Task id="arithmetic" output={outputs.output}>{{ value: 56 }}</Task>\n    </Sequence>\n  </Workflow>\n));\n';
    const invalid =
      '/** @jsxImportSource smthrs */\nimport { createSmithers } from "smthrs/create";\nimport { z } from "zod";\n\nconst smithers = createSmithers({\n  dbPath: process.env.ELIZA_SMTHRS_DB_PATH,\n});\n\nconst approvalDecisionSchema = z.object({\n  approved: z.boolean(),\n  reason: z.string().optional(),\n});\n\nconst outputSchema = z.object({\n  value: z.number(),\n});\n\nexport default smithers({\n  name: "Portable approval generation proof",\n  description: "Inactive test workflow demonstrating a single gate approval and deterministic task execution.",\n  inputSchema: z.object({}),\n  steps: [\n    {\n      id: "approval-gate",\n      label: "Approval Gate",\n      kind: "Approval",\n      description: "Asks whether to compute 7 times 8.",\n    },\n    {\n      id: "deterministic-task",\n      label: "Deterministic Task",\n      kind: "Task",\n      dependsOn: ["approval-gate"],\n      description: "Returns {value:56} deterministically.",\n    },\n  ],\n  widgets: [\n    {\n      id: "approval-widget",\n      title: "Approval Request",\n      description: "Displays the approval request details.",\n      surface: "main",\n      component: "ApprovalCard",\n      dataPath: "$.approval",\n    },\n    {\n      id: "result-widget",\n      title: "Computation Result",\n      description: "Displays the final computed value.",\n      surface: "main",\n      component: "ResultCard",\n      dataPath: "$.output",\n    },\n  ],\n  schedule: {\n    enabled: false,\n  },\n  run: async (ctx) => {\n    const approval = await ctx.approval({\n      id: "approval-gate",\n      title: "Calculate?",\n      summary: "Produce synthetic arithmetic after review.",\n      metadata: {\n        approvalPresentation: {\n          version: 1,\n          operation: "Compute",\n          target: "Synthetic result",\n          account: "Fixture owner",\n        },\n      },\n      schema: approvalDecisionSchema,\n    });\n\n    if (!approval.approved) {\n      throw new Error("Approval denied");\n    }\n\n    const result = await ctx.task({\n      id: "deterministic-task",\n      agent: globalThis.__elizaSmithers.agent,\n      prompt: "Return the exact JSON object {value:56}. Do not add any other text.",\n      schema: outputSchema,\n      retries: 2,\n    });\n\n    return result;\n  },\n});';
    const scenarios = [
      { name: 'valid', sources: [valid], status: 200, calls: 1 },
      { name: 'repair', sources: [invalid, valid], status: 200, calls: 2 },
      {
        name: 'exhaustion',
        sources: [invalid, invalid],
        status: 502,
        calls: 2,
      },
      {
        name: 'suppression',
        sources: ['// @ts-nocheck\n' + invalid, '// @ts-nocheck\n' + invalid],
        status: 502,
        calls: 2,
      },
      {
        name: 'foreign import',
        sources: ['import "node:fs";\n' + valid, 'import "node:fs";\n' + valid],
        status: 502,
        calls: 2,
      },
    ];
    for (const scenario of scenarios) {
      let calls = 0;
      runtime.useModel = async (_type: unknown, args: { prompt: string }) => {
        const index = calls++;
        if (index === 1) expect(args.prompt).toContain('Repair this rejected draft once');
        return JSON.stringify({
          name: scenario.name,
          description: 'Synthetic',
          language: 'tsx',
          source: scenario.sources[index],
          inputSchema: {},
          steps: [],
          widgets: [],
          schedule: { cron: '* * * * *', timezone: 'UTC', enabled: true },
        });
      };
      const result = await call('/workflows/generate', {
        prompt: 'Create a synthetic reviewed arithmetic workflow',
      });
      expect(result.status).toBe(scenario.status);
      expect(calls).toBe(scenario.calls);
      for (const table of ['embedded_workflows', 'workflow_revisions', 'embedded_executions']) {
        const count = await db.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM workflow.${table}`
        );
        expect(count.rows[0]?.count).toBe(0);
      }
      expect(scheduleWrites).toBe(0);
    }
    const oldPath = process.env.PATH;
    let unavailableCalls = 0;
    runtime.useModel = async () => {
      unavailableCalls++;
      return JSON.stringify({
        name: 'Unavailable',
        language: 'tsx',
        source: valid,
      });
    };
    try {
      process.env.PATH = '';
      const unavailable = await call('/workflows/generate', {
        prompt: 'Test compiler unavailable',
      });
      expect(unavailable.status).toBe(503);
      expect(unavailableCalls).toBe(1);
    } finally {
      process.env.PATH = oldPath;
    }
    expect(scheduleWrites).toBe(0);
    const compilerBin = join(directory, 'compiler-bin');
    await mkdir(compilerBin);
    for (const script of [
      '#!/bin/sh\nprintf \'{"ok":false,"diagnostics":[]}\'\n',
      '#!/bin/sh\nexec /bin/sleep 30\n',
      '#!/bin/sh\ni=0; while [ "$i" -lt 2000 ]; do printf "01234567890123456789"; i=$((i+1)); done\n',
    ]) {
      await writeFile(join(compilerBin, 'node'), script);
      await chmod(join(compilerBin, 'node'), 0o700);
      let calls = 0;
      runtime.useModel = async () => {
        calls++;
        return JSON.stringify({ name: 'Compiler failure', language: 'tsx', source: valid });
      };
      const savedPath = process.env.PATH;
      try {
        process.env.PATH = compilerBin;
        const response = await call('/workflows/generate', {
          prompt: 'Check bounded infrastructure failure',
        });
        expect(response.status).toBe(503);
        expect(calls).toBe(1);
      } finally {
        process.env.PATH = savedPath;
      }
    }
    expect(scheduleWrites).toBe(0);
  } finally {
    await embedded?.stop();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await db.close();
    await rm(directory, { recursive: true, force: true });
    if (workflowDirectory) await rm(workflowDirectory, { recursive: true, force: true });
  }
}, 180000);

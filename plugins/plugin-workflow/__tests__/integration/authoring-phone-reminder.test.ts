/**
 * Chat authoring of "a workflow called Alpha device test that sends me a reminder
 * to stretch every day at 3pm", as it failed on a phone (v609, 2026-11-18): the
 * author prompt invited a <UI> primitive without its props, the model put widget
 * manifest fields on it, and the one repair round fixed only the first property
 * TypeScript named. Generation is the only deterministic part here; the compiler
 * is the real one.
 */
import { expect, test } from 'bun:test';
import type { IAgentRuntime, Memory } from '@elizaos/core';
import { workflowAction } from '../../src/actions/workflow';
import {
  generationPrompt,
  WORKFLOW_DRAFT_NOT_APPLIED,
  WorkflowService,
} from '../../src/services/workflow-service';
import { checkWorkflowSource } from '../../src/services/workflow-source-check';
import { WorkflowApiError } from '../../src/types/index';

const header = `/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs/create";
import { z } from "zod";
const { Workflow, Sequence, Task, UI, smithers, outputs } = createSmithers({ output: z.object({ message: z.string(), action: z.string(), scheduledTime: z.string(), timeZone: z.string() }) }, { dbPath: process.env.ELIZA_SMTHRS_DB_PATH });
`;
const task =
  '<Task id="compose-reminder" output={outputs.output} retries={2}>{{ message: "Reminder: take a stretch break.", action: "stretch", scheduledTime: "15:00", timeZone: "America/New_York" }}</Task>';
const module = (ui: string) =>
  `${header}export default smithers(() => <Workflow name="daily-stretch-reminder"><Sequence>${task}${ui}</Sequence></Workflow>);\n`;
// The phone's first draft and its repair, verbatim JSX.
const phoneDraft = module(
  '<UI id="stretch-reminder" title="Stretch Reminder" dataPath="/output" />'
);
const phoneRepair = module('<UI title="Stretch Reminder" dataPath="/output" />');
const manifestOnly = module('');

function reply(source: string, name = 'Daily stretch reminder') {
  return JSON.stringify({
    name,
    description: 'Composes a stretch reminder; it appears in the run history.',
    language: 'tsx',
    source,
    inputSchema: { type: 'object', properties: {} },
    steps: [{ id: 'compose-reminder', label: 'Compose reminder', kind: 'task' }],
    widgets: [
      {
        id: 'stretch-reminder',
        title: 'Stretch Reminder',
        surface: 'phone',
        component: 'card',
        dataPath: '/output',
      },
    ],
    schedule: {
      cron: '0 15 * * *',
      timezone: 'America/New_York',
      enabled: true,
    },
  });
}

test('the author prompt keeps widget fields in the manifest and never invites <UI>', () => {
  const prompt = generationPrompt('Send me a reminder to stretch every day at 3pm', {
    timeZone: 'America/New_York',
  } as never);
  expect(prompt).not.toMatch(/\bUI, and TUI\b|\bTimer, UI\b/);
  expect(prompt).toContain('Do not render <UI> or <TUI> in source');
  expect(prompt).toContain('never as JSX props');
  expect(prompt).toContain('cannot message, notify or remind the owner');
  expect(prompt).toContain(
    'widgets: array of {id,title,description?,surface,component,dataPath?,actions?}'
  );
});

test('real compiler: manifest fields on <UI> fail one property at a time; the manifest-only module passes', async () => {
  const first = await checkWorkflowSource(phoneDraft);
  expect(first.join(' ')).toContain("Property 'id' does not exist");
  const second = await checkWorkflowSource(phoneRepair);
  expect(second.join(' ')).toContain("Property 'dataPath' does not exist");
  expect(await checkWorkflowSource(manifestOnly)).toEqual([]);
}, 120000);

test('repair asks for every unaccepted prop, and an exhausted draft is marked not applied', async () => {
  const prompts: string[] = [];
  let sources = [phoneDraft, phoneRepair];
  const runtime = {
    useModel: async (_type: unknown, args: { prompt: string }) => {
      prompts.push(args.prompt);
      return reply(sources[prompts.length - 1] ?? '');
    },
    getService: () => null,
  } as unknown as IAgentRuntime;
  const service = new WorkflowService(runtime);
  const error = await service
    .generateWorkflowDraft('Send me a reminder to stretch every day at 3pm', {
      timeZone: 'America/New_York',
    } as never)
    .then(
      () => null,
      (caught: unknown) => caught
    );
  expect(error).toBeInstanceOf(WorkflowApiError);
  expect((error as WorkflowApiError).response).toMatchObject({
    code: WORKFLOW_DRAFT_NOT_APPLIED,
  });
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain('remove every prop that the component does not accept');

  prompts.length = 0;
  sources = [manifestOnly];
  const draft = await service.generateWorkflowDraft(
    'Send me a reminder to stretch every day at 3pm',
    {
      timeZone: 'America/New_York',
    } as never
  );
  expect(prompts).toHaveLength(1);
  expect(draft.source).not.toContain('<UI');
  expect(draft.widgets?.[0]?.dataPath).toBe('/output');
}, 180000);

function handlerRuntime(service: unknown): IAgentRuntime {
  const owner = '00000000-0000-4000-8000-000000000010';
  return {
    agentId: '00000000-0000-4000-8000-000000000001',
    getSetting: (key: string) => (key === 'ELIZA_ADMIN_ENTITY_ID' ? owner : null),
    getService: () => service,
    logger: {
      warn: () => {},
      error: () => {},
      debug: () => {},
      info: () => {},
    },
  } as unknown as IAgentRuntime;
}
const message = {
  id: '00000000-0000-4000-8000-000000000020',
  entityId: '00000000-0000-4000-8000-000000000010',
  roomId: '00000000-0000-4000-8000-000000000030',
  content: {
    text: 'create a workflow called Alpha device test that sends me a reminder to stretch every day at 3pm',
  },
} as unknown as Memory;
// The exact planner call from the phone.
const parameters = {
  action: 'create',
  name: 'Alpha device test',
  seedPrompt: 'Send me a reminder to stretch every day at 3pm',
};

test('WORKFLOW create saves the name the owner gave, so chat can find it again', async () => {
  let saved: { name?: string } | undefined;
  const service = {
    // Create checks the owner's existing names first.
    listWorkflows: async () => [],
    generateWorkflowDraft: async () => JSON.parse(reply(manifestOnly)),
    deployWorkflowDefinition: async (draft: { name: string }) => {
      saved = draft;
      return {
        ...draft,
        id: 'wf-1',
        active: false,
        versionId: 'v1',
        updatedAt: '2026-11-18T04:30:26.000Z',
      };
    },
  };
  const result = await workflowAction.handler(handlerRuntime(service), message, undefined, {
    parameters,
  } as never);
  expect(result?.text).toContain('Alpha device test');
  expect(result?.success).toBe(true);
  expect(saved?.name).toBe('Alpha device test');
  // W1: the workflow cannot notify, so the planner must not be left to claim
  // "I'll remind you at 3pm".
  expect(result?.text).toContain('It can’t send you a notification');
  expect(result?.text).toContain('appears only in its run history');
});

test('WORKFLOW create adds no notification caveat to a request that asks for none', async () => {
  const service = {
    // Create checks the owner's existing names first.
    listWorkflows: async () => [],
    generateWorkflowDraft: async () => JSON.parse(reply(manifestOnly)),
    deployWorkflowDefinition: async (draft: { name: string }) => ({
      ...draft,
      id: 'wf-2',
      active: false,
      versionId: 'v1',
      updatedAt: '2026-11-18T04:30:26.000Z',
    }),
  };
  const result = await workflowAction.handler(
    handlerRuntime(service),
    {
      ...message,
      content: { text: 'create a workflow that summarizes my notes every evening' },
    } as Memory,
    undefined,
    {
      parameters: {
        action: 'create',
        name: 'Evening notes',
        seedPrompt: 'Summarize my notes every evening',
      },
    } as never
  );
  expect(result?.success).toBe(true);
  expect(result?.text).not.toContain('notification');
});

test('the WORKFLOW description says a chat-created workflow cannot remind the owner', () => {
  expect(workflowAction.description).toContain(
    'A chat-created workflow cannot message, notify or remind the owner'
  );
});

test('a rejected draft is reported as not applied, so the planner may author again', async () => {
  const service = {
    // Create checks the owner's existing names first.
    listWorkflows: async () => [],
    generateWorkflowDraft: async () => {
      throw new WorkflowApiError('Generated workflow failed semantic validation: TS2322', 502, {
        code: WORKFLOW_DRAFT_NOT_APPLIED,
      });
    },
    deployWorkflowDefinition: async () => {
      throw new Error('nothing may be saved');
    },
  };
  const result = await workflowAction.handler(handlerRuntime(service), message, undefined, {
    parameters,
  } as never);
  expect(result?.success).toBe(false);
  expect(result?.failureProvenance).toMatchObject({
    code: WORKFLOW_DRAFT_NOT_APPLIED,
    retryable: true,
  });
});

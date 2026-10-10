import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelType } from '@elizaos/core';
import { expect, test } from 'vitest';
import { createRealTestRuntime } from '../../../../packages/app/test/helpers/real-runtime.ts';
import { DeviceActionService } from '../../../plugin-assistant/src/services/device-actions/service.ts';
import { workflowPlugin } from '../../src/index';
import {
  EMBEDDED_WORKFLOW_SERVICE_TYPE,
  type EmbeddedWorkflowService,
} from '../../src/services/embedded-workflow-service';
import { configureHostedNativeSourceReader } from '../../src/services/hosted-native-source';
import { resolveSmithersWorkflowDir } from '../../src/services/smithers-runtime';

const zone = 'America/Los_Angeles';
const localTime = (at: number) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(at));

test('morning and evening loops share one native source with distinct reads, prompts and occurrences; an expired source pauses its loop until renewal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-evening-'));
  const requests: Array<Record<string, unknown>> = [];
  const prompts: string[] = [];
  const bindings = new Map<string, Record<string, unknown>>();
  configureHostedNativeSourceReader(async (request) => {
    const live = bindings.get(String(request.sourceId));
    if (!live) throw Error('Native source missing');
    for (const field of ['ownerId', 'agentId', 'installationId', 'enrollmentId', 'revision'])
      if (request[field] !== live[field]) throw Error('Native binding changed');
    if (request.action === 'describe')
      return {
        ...live,
        version: 1,
        revoked: false,
        expiresAt: new Date(Date.now() + 8 * 86400000).toISOString(),
        scope: {
          timeZone: zone,
          modelEgress: true,
          calendars: [{ id: '1', revision: 'b'.repeat(64) }],
          reminders: true,
          maximumItems: 200,
        },
      };
    requests.push(request);
    const evening = request.template === 'evening';
    return {
      sourceId: live.sourceId,
      sourceRevision: live.revision,
      occurrence: request.occurrence,
      ...(evening ? { template: 'evening' } : {}),
      observedAt: new Date().toISOString(),
      asOfDisplay: 'Oct 8, 2026, 6:00 PM PDT',
      timeZone: zone,
      events: [
        {
          id: 'standup',
          calendarId: '1',
          title: 'Shared calendar meeting',
          startDisplay: 'Oct 8, 2026, 8:00 AM PDT',
          endDisplay: 'Oct 8, 2026, 9:00 AM PDT',
        },
      ],
      reminders: [
        {
          id: 'open',
          title: 'Open reminder',
          dueAtDisplay: 'Oct 8, 2026, 5:00 PM PDT',
          status: 'scheduled',
        },
        ...(evening
          ? [
              {
                id: 'done',
                title: 'Completed reminder',
                dueAtDisplay: 'Oct 8, 2026, 9:00 AM PDT',
                status: 'completed',
              },
            ]
          : []),
      ],
    };
  });
  const state = await createRealTestRuntime({
    characterName: 'NativeEveningDigest',
    pgliteDir: directory,
    removePgliteDirOnCleanup: false,
    plugins: [
      workflowPlugin,
      {
        name: 'native-evening-fixture-model',
        description: 'No inference; records the typed model_draft request',
        models: {
          [ModelType.TEXT_LARGE]: async (_runtime, params) => {
            prompts.push(String(params.prompt));
            const instruction = String(JSON.parse(String(params.prompt)).instruction);
            return instruction.includes('evening brief') ? 'Evening recap.' : 'Morning plan.';
          },
        },
      },
    ],
  });
  const service = state.runtime.getService(
    EMBEDDED_WORKFLOW_SERVICE_TYPE
  ) as unknown as EmbeddedWorkflowService;
  const owner = 'fixture-owner';
  try {
    const device = new DeviceActionService(state.runtime),
      credential = {
        subjectUserId: state.runtime.agentId,
        installationId: randomUUID(),
        deviceKey: 'c'.repeat(64),
        capabilities: ['calendar.local-event.v1', 'reminders.local-record.v1'],
      };
    const enrollment = await device.register(credential, 'Native evening enrollment', 2, owner);
    const saveSource = async (expiresAt: number) => {
      const id = randomUUID(),
        live = {
          provider: 'native',
          ownerId: owner,
          agentId: state.runtime.agentId,
          installationId: credential.installationId,
          enrollmentId: enrollment.enrollmentId,
          sourceId: id,
          revision: randomUUID().replaceAll('-', '').padEnd(64, '0'),
        };
      bindings.set(id, live);
      return service.saveDigestSource(owner, {
        id,
        kind: 'tasks',
        label: 'Selected phone sources',
        observedAt: new Date().toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        confirmed: true,
        live,
      });
    };
    const minute = Math.floor(Date.now() / 60000) * 60000;
    const source = await saveSource(Date.now() + 3600000);
    const loop = (
      template: 'morning' | 'evening',
      sourceId: string,
      sourceRevision: string,
      extra: { id?: string; expectedVersionId?: string } = {}
    ) =>
      service.saveHostedDigest(
        owner,
        randomUUID(),
        {
          version: 1,
          template,
          sourceId,
          sourceRevision,
          timeZone: zone,
          localTime: localTime(minute),
          enabled: true,
        },
        extra.id,
        extra.expectedVersionId
      );
    const morning = await loop('morning', source.id, source.revision);
    const evening = await loop('evening', source.id, source.revision);
    const loops = await service.listHostedDigests(owner);
    expect(loops.map((row) => row.name).sort()).toEqual(['Evening brief', 'Morning digest']);
    expect(loops.every((row) => row.sourceState === 'current')).toBe(true);
    expect(await service.listHostedDigests('other-owner')).toEqual([]);
    const runMorning = await service.executeWorkflow(morning.workflowId, {
      mode: 'trigger',
      triggerData: { scheduledAtMs: minute, workflowVersionId: morning.versionId },
      throwOnError: false,
    });
    const runEvening = await service.executeWorkflow(evening.workflowId, {
      mode: 'trigger',
      triggerData: { scheduledAtMs: minute, workflowVersionId: evening.versionId },
      throwOnError: false,
    });
    expect(runMorning.error).toBeUndefined();
    expect(runEvening.error).toBeUndefined();
    expect(runMorning.status).toBe('finished');
    expect(runEvening.status).toBe('finished');
    // Each template is its own retained occurrence: a distinct run under its own idempotency key.
    expect(runMorning.id).not.toBe(runEvening.id);
    expect(runMorning.idempotencyKey).not.toBe(runEvening.idempotencyKey);
    expect(requests.map((request) => request.template ?? 'morning')).toEqual([
      'morning',
      'evening',
    ]);
    expect(requests[0]).not.toHaveProperty('template');
    const [morningPrompt, eveningPrompt] = prompts;
    expect(morningPrompt).toContain('morning brief');
    expect(morningPrompt).not.toContain('Completed reminder');
    expect(eveningPrompt).toContain('evening brief');
    expect(eveningPrompt).toContain('Only a supplied completed status records completion');
    expect(eveningPrompt).toContain('Completed reminder');
    expect(eveningPrompt).toContain('Shared calendar meeting');
    const results = (await service.digestResults(owner, 'evening-reader')).entries as Array<
      Record<string, any>
    >;
    expect(results.map((entry) => entry.runId).sort()).toEqual(
      [runMorning.id, runEvening.id].sort()
    );
    expect(new Set(results.map((entry) => entry.workflowId)).size).toBe(2);
    expect(results.every((entry) => entry.source.type === 'live_selected_native_read')).toBe(true);
    // A repeated trigger for the same occurrence returns the same run, with no second read.
    const repeated = await service.executeWorkflow(evening.workflowId, {
      mode: 'trigger',
      triggerData: { scheduledAtMs: minute, workflowVersionId: evening.versionId },
      throwOnError: false,
    });
    expect(repeated.id).toBe(runEvening.id);
    expect(requests).toHaveLength(2);

    // Expiry pauses the loop: one "Source expired" result, its schedule removed, no source read.
    const expiresAt = Date.now() + 10000;
    const expiring = await saveSource(expiresAt);
    const lapsing = await loop('morning', expiring.id, expiring.revision);
    const scheduled = async (workflowId: string) =>
      (await state.runtime.getTasks({ agentIds: [state.runtime.agentId], tags: ['trigger'] })).some(
        (task) =>
          (task.metadata?.trigger as { workflowId?: string } | undefined)?.workflowId === workflowId
      );
    expect(await scheduled(lapsing.workflowId)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiresAt - Date.now() + 50)));
    const reads = requests.length;
    const expired = await service.startWorkflow(lapsing.workflowId, {
      mode: 'trigger',
      triggerData: { scheduledAtMs: minute, workflowVersionId: lapsing.versionId },
    });
    expect(expired.output).toMatchObject({
      status: 'unavailable',
      sourceState: 'expired',
      paused: true,
      text: expect.stringContaining('Source expired'),
    });
    expect(requests).toHaveLength(reads);
    expect(await scheduled(lapsing.workflowId)).toBe(false);
    expect(
      (await service.listHostedDigests(owner)).find((row) => row.id === lapsing.workflowId)
    ).toMatchObject({ sourceState: 'expired', active: true });
    const lapsedResults = (
      (await service.digestResults(owner, 'expiry-reader')).entries as Array<Record<string, any>>
    ).filter((entry) => entry.workflowId === lapsing.workflowId);
    expect(lapsedResults).toHaveLength(1);
    expect(lapsedResults[0].status).toBe('unavailable');

    // Renewal reviews a new source and rebinds the same loop, which re-arms its schedule.
    const renewed = await saveSource(Date.now() + 7 * 86400000);
    const rebound = await loop('morning', renewed.id, renewed.revision, {
      id: lapsing.workflowId,
      expectedVersionId: lapsing.versionId,
    });
    expect(rebound.workflowId).toBe(lapsing.workflowId);
    expect(rebound.versionId).not.toBe(lapsing.versionId);
    expect(await scheduled(lapsing.workflowId)).toBe(true);
    expect(
      (await service.listHostedDigests(owner)).find((row) => row.id === lapsing.workflowId)
    ).toMatchObject({ sourceState: 'current', spec: { sourceId: renewed.id } });
    // Revocation has the same no-read pause, including the renewed schedule.
    await service.revokeDigestSource(owner, renewed.id);
    const revoked = await service.startWorkflow(rebound.workflowId, {
      mode: 'trigger',
      triggerData: { scheduledAtMs: minute, workflowVersionId: rebound.versionId },
    });
    expect(revoked.output).toMatchObject({
      status: 'unavailable',
      sourceState: 'revoked',
      paused: true,
    });
    expect(requests).toHaveLength(reads);
    expect(await scheduled(rebound.workflowId)).toBe(false);
    expect(
      (await service.listHostedDigests(owner)).find((row) => row.id === rebound.workflowId)
    ).toMatchObject({ sourceState: 'revoked' });
  } finally {
    const owned = await service.listWorkflows();
    const agent = state.runtime.agentId;
    await state.cleanup();
    for (const workflow of owned.data)
      await rm(resolveSmithersWorkflowDir(agent, workflow.id), { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
}, 180000);

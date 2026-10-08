import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Memory } from '@elizaos/core';
import { computeNextCronRunAtMs, ModelType } from '@elizaos/core';
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { expect, test } from 'vitest';
import { createRealTestRuntime } from '../../../../packages/app/test/helpers/real-runtime.ts';
import { testOutputPath } from '../../../../packages/scripts/lib/test-output';
import { DeviceActionService } from '../../../plugin-assistant/src/services/device-actions/service.ts';
import { workflowAction } from '../../src/actions/workflow';
import { typedMutations } from '../../src/db/schema';
import { workflowPlugin } from '../../src/index';
import { handleWorkflowRoutes } from '../../src/routes/workflow-routes';
import {
  EMBEDDED_WORKFLOW_SERVICE_TYPE,
  type EmbeddedWorkflowService,
} from '../../src/services/embedded-workflow-service';
import { HOSTED_SPEC } from '../../src/services/hosted-digest';
import {
  assertHostedNativeSource,
  configureHostedNativeSourceReader,
} from '../../src/services/hosted-native-source';
import { resolveSmithersWorkflowDir } from '../../src/services/smithers-runtime';

test('native selected source persists through HTTP; explicit dossier has one model pass and zero scheduler jobs, with revoke and owner fences', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-digest-http-'));
  let modelCalls = 0,
    reads = 0,
    revoked = false,
    revokeDuringRead = false;
  let state: Awaited<ReturnType<typeof createRealTestRuntime>> | undefined,
    server: http.Server | undefined;
  let live: Record<string, unknown> = {};
  configureHostedNativeSourceReader(async (request) => {
    for (const field of [
      'ownerId',
      'agentId',
      'installationId',
      'enrollmentId',
      'sourceId',
      'revision',
    ])
      if (request[field] !== live[field]) throw Error('Native binding changed');
    if (revoked) throw Error('Native source revoked');
    if (request.action === 'describe')
      return {
        ...live,
        version: 1,
        revoked: false,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        scope: {
          timeZone: 'America/Los_Angeles',
          modelEgress: true,
          calendars: [{ id: '1', revision: 'b'.repeat(64) }],
          reminders: true,
          maximumItems: 200,
        },
      };
    expect(Math.abs(Date.now() - Date.parse(String(request.occurrence)))).toBeLessThan(120000);
    reads++;
    if (revokeDuringRead) revoked = true;
    return {
      sourceId: live.sourceId,
      sourceRevision: live.revision,
      occurrence: request.occurrence,
      observedAt: '2026-10-08T19:30:00.000Z',
      asOfDisplay: 'Oct 8, 2026, 12:30 PM PDT',
      timeZone: 'America/Los_Angeles',
      secretMetadata: 'NATIVE_SECRET_SENTINEL',
      events: [
        {
          id: 'selected',
          calendarId: '1',
          title: 'Selected meeting',
          startDisplay: 'Oct 8, 2026, 8:00 AM PDT',
          endDisplay: 'Oct 8, 2026, 9:00 AM PDT',
          start: '2026-10-08T15:00:00.000Z',
          end: '2026-10-08T16:00:00.000Z',
        },
      ],
      reminders: [
        {
          id: 'reminder',
          title: 'Selected reminder',
          dueAtDisplay: 'Oct 8, 2026, 8:41 AM PDT',
          status: 'scheduled',
          dueAt: '2026-10-08T15:41:19.576Z',
        },
      ],
    };
  });
  const boot = () =>
    createRealTestRuntime({
      characterName: 'NativeDigestHTTP',
      pgliteDir: directory,
      removePgliteDirOnCleanup: false,
      plugins: [
        workflowPlugin,
        {
          name: 'native-digest-fixture-model',
          description: 'No inference; typed workflow provider fixture',
          models: {
            [ModelType.TEXT_LARGE]: async (_runtime, params) => {
              modelCalls++;
              if (modelCalls === 1) {
                const output = testOutputPath('native-morning');
                await mkdir(output, { recursive: true });
                await writeFile(
                  join(output, 'model-draft-request.json'),
                  JSON.stringify(
                    {
                      qualification: {
                        scope:
                          'Mac workflow fixture using synthetic selected Calendar and reminders',
                        inference: false,
                        phone: false,
                        cloudLatencyProof: false,
                      },
                      modelType: ModelType.TEXT_LARGE,
                      requestKeys: Object.keys(params),
                      request: params,
                      signalState: params.signal ? { aborted: params.signal.aborted } : null,
                      promptCharacters:
                        typeof params.prompt === 'string' ? params.prompt.length : null,
                      promptUtf8Bytes:
                        typeof params.prompt === 'string'
                          ? Buffer.byteLength(params.prompt, 'utf8')
                          : null,
                    },
                    null,
                    2
                  ) + '\n'
                );
              }

              const capturedPrompt = JSON.parse(String(params.prompt));
              const summaryInput = JSON.parse(capturedPrompt.sourceText);
              expect(summaryInput.asOf).toBe('Oct 8, 2026, 12:30 PM PDT');
              expect(summaryInput).not.toHaveProperty('observedAt');
              expect(params.prompt).not.toContain('2026-10-08T19:30:00.000Z');
              expect(capturedPrompt.instruction).toContain('does not prove completion');
              expect(params.prompt).toContain('Selected meeting');
              expect(params.prompt).toContain('Selected reminder');
              expect(params.prompt).not.toContain('UNSELECTED');
              expect(params.prompt).not.toContain('NATIVE_SECRET_SENTINEL');
              expect(params.prompt).not.toContain(String(live.revision));
              expect(params.prompt).not.toContain(String(live.sourceId));
              expect(params.prompt).not.toContain('calendarId');
              return 'Selected meeting and reminder.';
            },
          },
        },
      ],
    });
  try {
    state = await boot();
    const device = new DeviceActionService(state.runtime),
      credential = {
        subjectUserId: state.runtime.agentId,
        installationId: randomUUID(),
        deviceKey: 'b'.repeat(64),
        capabilities: ['calendar.local-event.v1', 'reminders.local-record.v1'],
      };
    const enrollment = await device.register(
      credential,
      'Native digest enrollment',
      2,
      'fixture-owner'
    );
    live = {
      provider: 'native',
      ownerId: 'fixture-owner',
      agentId: state.runtime.agentId,
      installationId: credential.installationId,
      enrollmentId: enrollment.enrollmentId,
      sourceId: randomUUID(),
      revision: 'a'.repeat(64),
    };
    server = http.createServer((req, res) => {
      void handleWorkflowRoutes({
        req,
        res,
        method: req.method!,
        pathname: new URL(req.url!, 'http://localhost').pathname,
        runtime: state!.runtime,
        principalId:
          req.headers.authorization === 'Bearer fixture-owner' ? 'fixture-owner' : 'other-owner',
        json: (r, value, status = 200) => {
          r.writeHead(status, { 'content-type': 'application/json' });
          r.end(JSON.stringify(value));
        },
      }).catch((error) => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(error) }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    const call = async (path: string, body?: unknown, owner = 'fixture-owner') => {
      const response = await fetch(origin + '/api/workflow' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: 'Bearer ' + owner, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as any };
    };
    const noSource = await workflowAction.handler(
      state.runtime,
      {
        id: randomUUID(),
        entityId: 'fixture-owner',
        agentId: state.runtime.agentId,
        roomId: randomUUID(),
        content: { text: 'Give me a dossier.' },
      } as unknown as Memory,
      undefined,
      { parameters: { action: 'dossier' } }
    );
    expect(noSource).toMatchObject({
      success: false,
      failureProvenance: { code: 'NATIVE_DOSSIER_SOURCE_REVIEW_REQUIRED' },
    });
    expect(noSource).toMatchObject({ text: expect.stringMatching(/choose.*calendar.*reminders/i) });
    expect(modelCalls).toBe(0);
    const input = {
      id: randomUUID(),
      kind: 'tasks',
      label: 'Selected native sources',
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      confirmed: true,
      live,
    };
    expect((await call('/hosted/sources', input, 'other-owner')).status).toBe(409);
    expect(reads).toBe(0);
    const saved = await call('/hosted/sources', input);
    expect(saved.status).toBe(200);
    const source = saved.body.source;
    expect((await call('/hosted/sources', input)).body.source.revision).toBe(source.revision);
    expect((await call('/hosted/sources')).body.sources[0]).toMatchObject({ id: input.id, live });
    const otherRuntime = await createRealTestRuntime({ characterName: 'OtherNativeDigestOwner' });
    try {
      await expect(
        assertHostedNativeSource(
          otherRuntime.runtime,
          'fixture-owner',
          live as unknown as import('../../src/services/hosted-native-source').HostedNativeSelection
        )
      ).rejects.toThrow('Native source host or owner unavailable');
      expect(reads).toBe(0);
    } finally {
      await otherRuntime.cleanup();
    }
    const before = await state.runtime.getTasks({});
    const request = {
      sourceId: source.id,
      sourceRevision: source.revision,
      mutationId: randomUUID(),
      confirmed: true,
    };
    expect((await call('/hosted/dossier', request, 'other-owner')).status).not.toBe(200);
    const started = await call('/hosted/dossier', request);
    expect(started.status).toBe(200);
    let service = state.runtime.getService(
      EMBEDDED_WORKFLOW_SERVICE_TYPE
    ) as unknown as EmbeddedWorkflowService;
    const executionId = started.body.execution.id;
    // Existing workflow service owns execution and persistence; wait for its actual worker.
    let execution = await service.getExecution(executionId);
    const deadline = Date.now() + 60000;
    while (!execution.finished && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      execution = await service.getExecution(executionId);
    }
    expect(execution.error).toBeUndefined();
    expect(execution.status).toBe('finished');
    expect((execution.input.hostedDigest as any).nativeReadReceipt).toMatchObject({
      sourceId: live.sourceId,
      sourceRevision: live.revision,
      secretMetadata: 'NATIVE_SECRET_SENTINEL',
      observedAt: '2026-10-08T19:30:00.000Z',
    });
    expect(modelCalls).toBe(1);
    expect(reads).toBe(1);
    expect((await call('/hosted/dossier', request)).body.execution.id).toBe(executionId);
    expect(modelCalls).toBe(1);
    // A later request must not reuse the helper definition's old creation instant.
    const db = state.runtime.adapter.db as NodePgDatabase;
    const [definition] = await db
      .select()
      .from(typedMutations)
      .where(
        and(
          eq(typedMutations.agentId, state.runtime.agentId),
          eq(typedMutations.workflowId, execution.workflowId)
        )
      );
    await db
      .update(typedMutations)
      .set({
        receipt: { ...definition.receipt, appliedAt: new Date(Date.now() - 300000).toISOString() },
      })
      .where(
        and(
          eq(typedMutations.agentId, state.runtime.agentId),
          eq(typedMutations.mutationId, definition.mutationId)
        )
      );
    const chatMessage = {
      id: randomUUID(),
      entityId: 'fixture-owner',
      agentId: state.runtime.agentId,
      roomId: randomUUID(),
      content: { text: 'Give me a dossier from my reviewed phone sources.' },
    } as unknown as Memory;
    const chat = await workflowAction.handler(state.runtime, chatMessage, undefined, {
      parameters: { action: 'dossier' },
    });
    expect(chat).toMatchObject({
      success: true,
      text: 'Selected meeting and reminder.',
      data: { manualOnly: true },
    });
    expect(modelCalls).toBe(2);
    const repeatedChat = await workflowAction.handler(state.runtime, chatMessage, undefined, {
      parameters: { action: 'dossier' },
    });
    expect(repeatedChat).toMatchObject({ success: true, text: 'Selected meeting and reminder.' });
    expect(modelCalls).toBe(2);
    const helpers = (await service.listWorkflows()).data.filter(
      (workflow) =>
        workflow.metadata?.[HOSTED_SPEC] &&
        JSON.parse(String(workflow.metadata[HOSTED_SPEC])).manualOnly
    );
    expect(helpers).toHaveLength(1);
    expect(chat).toMatchObject({ success: true });
    await expect(
      service.startReviewedWorkflow(
        helpers[0].id,
        randomUUID(),
        helpers[0].versionId,
        {},
        'fixture-owner',
        () => {}
      )
    ).rejects.toThrow('reviewed admission path');

    expect((await state.runtime.getTasks({})).map((task) => task.id).sort()).toEqual(
      before.map((task) => task.id).sort()
    );
    expect((await call('/hosted/loops')).body.loops).toEqual([]);
    expect((await call('/hosted/sources/revoke', { id: source.id, confirmed: true })).status).toBe(
      200
    );
    expect((await call('/hosted/dossier', request)).body.execution.id).toBe(executionId);
    expect(modelCalls).toBe(2);
    expect((await call('/hosted/dossier', { ...request, mutationId: randomUUID() })).status).toBe(
      409
    );
    expect(reads).toBe(2);
    const paused = await call('/hosted/loops', {
      spec: {
        version: 1,
        template: 'morning',
        sourceId: input.id,
        sourceRevision: source.revision,
        timeZone: 'America/Los_Angeles',
        localTime: '08:00',
        enabled: true,
      },
      mutationId: randomUUID(),
      confirmed: true,
    });
    // A revoked source must not gain new recurring authority by a schedule mutation.
    expect(paused.status).toBe(409);
    const next = await call('/hosted/sources', { ...input, id: randomUUID() });
    expect(next.status).toBe(200);
    const switched = await workflowAction.handler(state.runtime, chatMessage, undefined, {
      parameters: { action: 'dossier', sourceId: next.body.source.id },
    });
    expect(switched).toMatchObject({ success: false });
    expect(modelCalls).toBe(2);
    revokeDuringRead = true;
    const denied = await call('/hosted/dossier', {
      ...request,
      sourceId: next.body.source.id,
      sourceRevision: next.body.source.revision,
      mutationId: randomUUID(),
    });
    expect(denied.status).toBe(200);
    let failed = await service.getExecution(denied.body.execution.id);
    while (!failed.finished && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      failed = await service.getExecution(failed.id);
    }
    expect(failed.status).toBe('failed');
    expect(modelCalls).toBe(2);
    revoked = false;
    revokeDuringRead = false;
    const spec = {
      version: 1,
      template: 'morning',
      sourceId: next.body.source.id,
      sourceRevision: next.body.source.revision,
      timeZone: 'America/Los_Angeles',
      localTime: '08:00',
      enabled: false,
    };
    expect(
      (
        await call('/hosted/loops', {
          spec: { ...spec, template: 'evening', enabled: true },
          mutationId: randomUUID(),
          confirmed: true,
        })
      ).status
    ).toBe(400);
    const schedule = await call('/hosted/loops', {
      spec,
      mutationId: randomUUID(),
      confirmed: true,
    });
    expect(schedule.status).toBe(200);
    const edited = await call('/hosted/loops', {
      spec: { ...spec, localTime: '09:15' },
      id: schedule.body.receipt.workflowId,
      expectedVersionId: schedule.body.receipt.versionId,
      mutationId: randomUUID(),
      confirmed: true,
    });
    expect(edited.status).toBe(200);
    expect((await call('/hosted/loops')).body.loops).toHaveLength(1);
    expect((await call('/hosted/loops')).body.loops[0].spec).toMatchObject({
      localTime: '09:15',
      enabled: false,
      timeZone: 'America/Los_Angeles',
    });
    expect((await state.runtime.getTasks({})).map((task) => task.id).sort()).toEqual(
      before.map((task) => task.id).sort()
    );
    expect(
      computeNextCronRunAtMs('0 8 * * *', Date.parse('2026-03-08T07:00:00Z'), 'America/Los_Angeles')
    ).toBe(Date.parse('2026-03-08T15:00:00Z'));
    expect(
      computeNextCronRunAtMs('0 8 * * *', Date.parse('2026-11-01T07:00:00Z'), 'America/Los_Angeles')
    ).toBe(Date.parse('2026-11-01T16:00:00Z'));
    const minute = Math.floor(Date.now() / 60000) * 60000;
    const localTime = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(minute));
    const enabled = await call('/hosted/loops', {
      spec: { ...spec, localTime, enabled: true },
      id: edited.body.receipt.workflowId,
      expectedVersionId: edited.body.receipt.versionId,
      mutationId: randomUUID(),
      confirmed: true,
    });
    expect(enabled.status).toBe(200);
    const run = await service.executeWorkflow(enabled.body.receipt.workflowId, {
      mode: 'trigger',
      triggerData: { scheduledAtMs: minute, workflowVersionId: enabled.body.receipt.versionId },
      throwOnError: false,
    });
    expect(run.status).toBe('finished');
    expect(modelCalls).toBe(3);
    await state.cleanup();
    state = await boot();
    expect(state.runtime.agentId).toBe(live.agentId);
    service = state.runtime.getService(
      EMBEDDED_WORKFLOW_SERVICE_TYPE
    ) as unknown as EmbeddedWorkflowService;
    expect((await call('/hosted/loops')).body.loops[0].spec).toMatchObject({
      localTime,
      enabled: true,
    });
    const repeated = await service.executeWorkflow(enabled.body.receipt.workflowId, {
      mode: 'trigger',
      triggerData: { scheduledAtMs: minute, workflowVersionId: enabled.body.receipt.versionId },
      throwOnError: false,
    });
    expect(repeated.id).toBe(run.id);
    expect(modelCalls).toBe(3);
    await new DeviceActionService(state.runtime).revoke(credential);

    expect(
      (
        await call('/hosted/dossier', {
          ...request,
          sourceId: next.body.source.id,
          sourceRevision: next.body.source.revision,
          mutationId: randomUUID(),
        })
      ).status
    ).not.toBe(200);
    expect(modelCalls).toBe(3);
  } finally {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    const owned = state
      ? await (
          state.runtime.getService(
            EMBEDDED_WORKFLOW_SERVICE_TYPE
          ) as unknown as EmbeddedWorkflowService
        ).listWorkflows()
      : { data: [] };
    const agent = state?.runtime.agentId;
    await state?.cleanup();
    if (agent)
      for (const workflow of owned.data)
        await rm(resolveSmithersWorkflowDir(agent, workflow.id), { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);

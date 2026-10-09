import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeNextCronRunAtMs,
  getConnectorAccountManager,
  type IAgentRuntime,
  ModelType,
  ServiceType,
  TaskService,
} from '@elizaos/core';
import { expect, test } from 'vitest';
import { registerTriggerTaskWorker } from '../../../../packages/agent/src/triggers/runtime.ts';
import { createRealTestRuntime } from '../../../../packages/app/test/helpers/real-runtime.ts';
import { GoogleWorkspaceService } from '../../../plugin-google-workspace/src/service';
import { workflowPlugin } from '../../src/index';
import { handleWorkflowRoutes } from '../../src/routes/workflow-routes';
import type { EmbeddedWorkflowService } from '../../src/services/embedded-workflow-service';
import { readHostedGoogleSource } from '../../src/services/hosted-google-source';
import { resolveSmithersWorkflowDir } from '../../src/services/smithers-runtime';

const { Auth } = createRequire(
  new URL('../../../plugin-google-workspace/package.json', import.meta.url)
)('googleapis');

test('selected Google reads run through real HTTP after scheduler restart; revoked, expired and foreign grants fail closed', async () => {
  let cleanupAgent = '';
  const oldBase = process.env.ELIZA_MOCK_GOOGLE_BASE;
  let googleReads = 0,
    revoked = false,
    revokeDuringRead = false,
    large = false,
    longField = false;
  const account = {
    id: 'fixture-google',
    provider: 'google',
    role: 'OWNER',
    purpose: ['reading'],
    accessGate: 'open',
    status: 'connected' as const,
    externalId: 'synthetic-google-subject',
    ownerIdentityId: 'fixture-owner',
    ownerBindingId: 'fixture-binding',
    createdAt: 1,
    updatedAt: 1,
    metadata: { grantedCapabilities: ['gmail.read', 'calendar.read'] },
  };
  class FixtureGoogle extends GoogleWorkspaceService {
    static async start(runtime: IAgentRuntime) {
      return new FixtureGoogle(runtime, {
        credentialResolver: {
          getAuthClient: async (request) => {
            expect(request.accountId).toBe(account.id);
            expect(
              request.capabilities.every((c) => c === 'gmail.read' || c === 'calendar.read')
            ).toBe(true);
            const auth = new Auth.OAuth2Client();
            auth.setCredentials({
              access_token: 'SYNTHETIC-GOOGLE-READ-FIXTURE',
            });
            return auth;
          },
        },
      });
    }
  }

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
          name: 'fixture-google',
          description: 'Synthetic server Google auth with real provider HTTP',
          services: [FixtureGoogle],
        },
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
    getConnectorAccountManager(state.runtime).registerProvider({
      provider: 'google',
      listAccounts: async () => (revoked ? [{ ...account, status: 'revoked' }] : [account]),
    });
    state.runtime.adapter.findConnectorOwnerBinding = async () =>
      revoked
        ? null
        : {
            id: account.ownerBindingId,
            identityId: account.ownerIdentityId,
            connector: 'google',
            externalId: account.externalId,
            displayHandle: 'Synthetic fixture',
            instanceId: '',
            verifiedAt: 1,
          };

    registerTriggerTaskWorker(state.runtime);
    if (!state.runtime.getService(ServiceType.TASK))
      await state.runtime.registerService(TaskService);
    server = http.createServer((req, res) => {
      void (async () => {
        if (req.url?.startsWith('/gmail/') || req.url?.startsWith('/calendar/')) {
          expect(req.method).toBe('GET');
          expect(req.headers.authorization).toBe('Bearer SYNTHETIC-GOOGLE-READ-FIXTURE');
          googleReads++;
          const url = new URL(req.url, 'http://fixture');
          res.setHeader('content-type', 'application/json');
          if (revokeDuringRead) revoked = true;
          if (url.pathname === '/calendar/v3/users/me/calendarList') {
            res.end(
              JSON.stringify({
                items: [
                  {
                    id: 'fixture-calendar',
                    summary: 'Synthetic calendar',
                    accessRole: 'reader',
                    timeZone: 'UTC',
                  },
                ],
              })
            );
          } else if (url.pathname === '/gmail/v1/users/me/messages') {
            expect(url.searchParams.get('q')).toMatch(/^in:inbox after:\d+$/);
            res.end(
              JSON.stringify({
                messages: large
                  ? Array.from({ length: 12 }, (_, i) => ({ id: 'synthetic-message-' + i }))
                  : [{ id: 'synthetic-message' }],
              })
            );
          } else if (url.pathname.startsWith('/gmail/v1/users/me/messages/synthetic-message')) {
            expect(url.searchParams.get('format')).toBe('metadata');
            res.end(
              JSON.stringify({
                id: url.pathname.split('/').at(-1),
                snippet: longField
                  ? 'N'.repeat(513)
                  : large
                    ? 'N'.repeat(512)
                    : 'Synthetic inbox fixture',
                internalDate: String(Date.now()),
                payload: {
                  headers: [{ name: 'Subject', value: large ? 'S'.repeat(256) : 'Synthetic mail' }],
                },
              })
            );
          } else if (url.pathname === '/calendar/v3/calendars/fixture-calendar/events') {
            expect(url.searchParams.get('timeMin')).toBeTruthy();
            expect(url.searchParams.get('timeMax')).toBeTruthy();
            res.end(
              JSON.stringify({
                items: [
                  {
                    id: 'synthetic-event',
                    summary: 'Synthetic appointment',
                    start: { dateTime: new Date().toISOString() },
                    end: {
                      dateTime: new Date(Date.now() + 3600000).toISOString(),
                    },
                  },
                ],
              })
            );
          } else {
            res.writeHead(404);
            res.end('{}');
          }
          return;
        }
        if (req.url === '/provider') {
          let body = '';
          for await (const chunk of req) body += chunk;
          const data = JSON.parse(body);
          expect(data.prompt).toContain('live_selected_google_read');
          expect(data.prompt).toMatch(/Synthetic (inbox|appointment)/);
          modelCalls++;
          res.end(
            'Fresh selected Google read: synthetic task remains open. Provider scope and observation time are explicit.'
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
    process.env.ELIZA_MOCK_GOOGLE_BASE = origin;
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
      headers: {
        authorization: 'Bearer ' + owner,
        'content-type': 'application/json',
      },
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
    const offered = await call('/hosted/live-accounts');
    expect(offered.body.cloud).toBe('unattended_delegation_unavailable');
    expect(offered.body.accounts).toHaveLength(1);
    expect(
      (await call('/hosted/live-accounts', undefined, 'fixture-other')).body.accounts
    ).toHaveLength(0);
    const descriptor = offered.body.accounts[0];
    const foreignCalendars = await call(
      '/hosted/live-calendars',
      {
        accountId: descriptor.accountId,
        accountRevision: descriptor.accountRevision,
      },
      'fixture-other'
    );
    expect(foreignCalendars.status).toBe(409);
    expect(googleReads).toBe(0);
    const calendarList = await call('/hosted/live-calendars', {
      accountId: descriptor.accountId,
      accountRevision: descriptor.accountRevision,
    });
    expect(calendarList.status).toBe(200);
    expect(calendarList.body.calendars).toEqual([
      {
        calendarId: 'fixture-calendar',
        label: 'Synthetic calendar',
        timeZone: 'UTC',
      },
    ]);
    const setupReads = googleReads;

    const sources = [];
    const sourceRequests = [];
    for (const kind of ['email', 'calendar']) {
      const input = {
        id: randomUUID(),
        kind,
        label: 'Reviewed synthetic ' + kind,
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        confirmed: true,
        live: {
          provider: 'google',
          accountId: descriptor.accountId,
          accountRevision: descriptor.accountRevision,
          kind,
          windowHours: 24,
          maxItems: 10,
          ...(kind === 'calendar' ? { calendarId: 'fixture-calendar' } : {}),
        },
      };
      sourceRequests.push(input);
      const before = googleReads;
      expect((await call('/hosted/sources', input, 'fixture-other')).status).toBe(409);
      expect(
        (
          await call('/hosted/sources', {
            ...input,
            expiresAt: new Date(Date.now() - 1000).toISOString(),
          })
        ).status
      ).toBe(400);
      expect(googleReads).toBe(before);
      const saved = await call('/hosted/sources', input);
      expect(saved.status).toBe(200);
      sources.push(saved.body.source);
    }
    const source = sources[0];
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
          sourceId: sources[template === 'morning' ? 0 : 1].id,
          sourceRevision: sources[template === 'morning' ? 0 : 1].revision,
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
      expect(entry.source.type).toBe('live_selected_google_read');
      expect(JSON.stringify(entry.output)).toContain('synthetic task');
    }
    const engine = state!.runtime.getService<EmbeddedWorkflowService>('embedded_workflow_service')!;
    for (const receipt of receipts) {
      const before = entries.find((e) => e.workflowId === receipt.workflowId);
      const repeated = await Promise.all(
        [1, 2].map(() =>
          engine.startWorkflow(receipt.workflowId, {
            mode: 'trigger',
            triggerData: {
              scheduledAtMs: scheduledAt,
              workflowVersionId: receipt.versionId,
            },
          })
        )
      );
      expect(repeated.map((r) => r.id)).toEqual([before.runId, before.runId]);
    }
    expect(modelCalls).toBe(2);
    expect(googleReads).toBe(setupReads + 3);
    const expiresAt = new Date(Date.now() + 6000).toISOString();
    const expiring = await call('/hosted/sources', {
      id: randomUUID(),
      kind: 'email',
      label: 'Expiry fixture',
      observedAt: new Date().toISOString(),
      expiresAt,
      confirmed: true,
      live: source.live,
    });
    expect(expiring.status).toBe(200);
    const expiredLoop = await call('/hosted/loops', {
      mutationId: randomUUID(),
      confirmed: true,
      spec: {
        version: 1,
        template: 'morning',
        sourceId: expiring.body.source.id,
        sourceRevision: expiring.body.source.revision,
        timeZone: 'UTC',
        localTime: new Date().toISOString().slice(11, 16),
        enabled: true,
      },
    });
    expect(expiredLoop.status).toBe(200);
    owned.push(expiredLoop.body.receipt.workflowId);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Date.parse(expiresAt) - Date.now() + 50))
    );
    const expired = await engine.startWorkflow(expiredLoop.body.receipt.workflowId, {
      mode: 'trigger',
      triggerData: {
        scheduledAtMs: Math.floor(Date.now() / 60000) * 60000,
        workflowVersionId: expiredLoop.body.receipt.versionId,
      },
    });
    expect(expired.output).toMatchObject({ status: 'unavailable' });
    expect(googleReads).toBe(setupReads + 3);
    expect(modelCalls).toBe(2);
    longField = true;
    await expect(
      readHostedGoogleSource(state!.runtime, 'fixture-owner', { ...source.live, maxItems: 25 })
    ).rejects.toMatchObject({ statusCode: 422 });
    longField = false;
    large = true;
    await expect(
      readHostedGoogleSource(state!.runtime, 'fixture-owner', { ...source.live, maxItems: 25 })
    ).rejects.toMatchObject({ statusCode: 422 });
    large = false;
    const before = googleReads;
    await expect(
      readHostedGoogleSource(state!.runtime, 'fixture-other', source.live)
    ).rejects.toThrow();
    expect(googleReads).toBe(before);
    revokeDuringRead = true;
    await expect(
      readHostedGoogleSource(state!.runtime, 'fixture-owner', source.live)
    ).rejects.toThrow();
    const after = googleReads;
    await expect(
      readHostedGoogleSource(state!.runtime, 'fixture-owner', source.live)
    ).rejects.toThrow();
    expect(googleReads).toBe(after);
    expect((await call('/hosted/live-accounts')).body.accounts).toHaveLength(0);
    expect((await call('/hosted/sources', sourceRequests[0])).body.source.id).toBe(source.id);
    expect(googleReads).toBe(after);
    expect(
      (await call('/hosted/results?clientId=foreign', undefined, 'fixture-other')).body.entries
    ).toHaveLength(0);
  } finally {
    await stop();
    if (oldBase === undefined) delete process.env.ELIZA_MOCK_GOOGLE_BASE;
    else process.env.ELIZA_MOCK_GOOGLE_BASE = oldBase;
    for (const id of owned)
      await rm(resolveSmithersWorkflowDir(cleanupAgent, id), {
        recursive: true,
        force: true,
      }).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

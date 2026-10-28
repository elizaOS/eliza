import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DIGEST_MISSED_TEXT,
  DIGEST_RUN_WINDOW_MS,
  DigestInbox,
  type DigestLoop,
  type DigestResult,
  type DigestSource,
  type DigestStorage,
  digestLoopState,
  digestOccurrenceMissed,
  digestRan,
  digestRenewals,
  digestSourceState,
  digestStatusLabel,
  digestSummaryText,
  digestZoneNote,
  HOSTED_DIGEST_CLIENT_ROUTES,
  HostedDigestProtocol,
  HostedSourceRejected,
  latestRetainedBrief,
  missedRunNowOffers,
  parseDigestResult,
  RetainedBriefStore,
} from '../../src/client/hosted-digests';

const pluginRoot = join(import.meta.dir, '../..');
const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.UTC(2026, 9, 27, 7, 0);
let cursor = 0;
function result(overrides: Partial<DigestResult> & { status: string; at?: number }): DigestResult {
  cursor += 1;
  const at = overrides.at ?? T0 + cursor * 60000;
  const runId = overrides.runId ?? `run-${cursor}`;
  return parseDigestResult({
    cursor: overrides.cursor ?? cursor,
    runId,
    workflowId: overrides.workflowId ?? 'loop-morning',
    workflowVersionId: 'v1',
    templateVersion: 'hosted-digest-1',
    scheduledAt: iso(at),
    source: overrides.source ?? { id: 'src-1' },
    status: overrides.status,
    startedAt: iso(at),
    completedAt: overrides.completedAt ?? iso(at + 1000),
    output: overrides.output ?? `Brief ${runId}`,
    error: overrides.error ?? null,
  });
}

describe('occurrence policy shared by admission and clients', () => {
  test('one run window decides missed occurrences', () => {
    expect(DIGEST_RUN_WINDOW_MS).toBe(120000);
    expect(digestOccurrenceMissed(T0, T0 + 120000)).toBe(false);
    expect(digestOccurrenceMissed(T0, T0 + 120001)).toBe(true);
    // The agent's admission uses this same policy (no copied window or texts).
    const admission = readFileSync(join(pluginRoot, 'src/services/hosted-digest.ts'), 'utf8');
    expect(admission).toContain("from './hosted-digest-policy'");
    expect(admission).toContain('digestOccurrenceMissed(scheduledAt, now)');
    expect(admission).not.toMatch(
      /120000|scheduled time was missed|Source expired\. This schedule/
    );
    expect(digestSourceState({ revoked: true, expiresAt: iso(T0 + 1) }, T0)).toBe('revoked');
    expect(digestSourceState({ revoked: false, expiresAt: iso(T0) }, T0)).toBe('expired');
    expect(digestSourceState({ revoked: false, expiresAt: iso(T0 + 1) }, T0)).toBe('current');
  });
  test('records of occurrences that did not run are labelled and never runs', () => {
    for (const status of ['missed', 'overlap', 'unavailable']) {
      expect(digestRan({ status })).toBe(false);
      expect(digestStatusLabel(status)).not.toBe(status);
    }
    expect(digestStatusLabel('missed')).toBe('Missed — not run');
    for (const status of ['finished', 'failed', 'succeeded']) {
      expect(digestRan({ status })).toBe(true);
      expect(digestStatusLabel(status)).toBe(status);
    }
  });
});

describe('retained brief', () => {
  test('a missed record never replaces the last brief that ran', () => {
    const morning = result({ status: 'finished', output: 'Two meetings today.' });
    const missed = result({
      status: 'missed',
      output: { status: 'missed', text: DIGEST_MISSED_TEXT },
    });
    const overlap = result({ status: 'overlap' });
    const unavailable = result({ status: 'unavailable' });
    expect(latestRetainedBrief([morning, missed, overlap, unavailable], 'Eliza')).toEqual({
      summary: 'Two meetings today.',
      ranAt: morning.completedAt,
      agent: 'Eliza',
      status: 'finished',
    });
    expect(latestRetainedBrief([missed, unavailable])).toBeNull();
    expect(latestRetainedBrief(null)).toBeNull();
    const failed = result({ status: 'failed', error: 'Source expired' });
    expect(latestRetainedBrief([morning, missed, failed])?.summary).toBe('Source expired');
  });
  test('newest by completion, then cursor', () => {
    const a = result({ status: 'finished', output: 'A', completedAt: iso(T0 + 5000), cursor: 10 });
    const b = result({ status: 'finished', output: 'B', completedAt: iso(T0 + 4000), cursor: 11 });
    const c = result({ status: 'finished', output: 'C', completedAt: iso(T0 + 5000), cursor: 12 });
    expect(latestRetainedBrief([a, b])?.summary).toBe('A');
    expect(latestRetainedBrief([c, a, b])?.summary).toBe('C');
  });
  test('the store fences results to the bound account scope', () => {
    const store = new RetainedBriefStore();
    let notified = 0;
    const stop = store.subscribe(() => notified++);
    const brief = result({ status: 'finished', output: 'Owner A brief' });
    // Unscoped hosts keep working until a scope is bound.
    expect(store.remember([brief], { agent: 'Agent' })).toBe(true);
    expect(store.current()?.summary).toBe('Owner A brief');
    store.bind('owner-a');
    expect(store.current()).toBeNull();
    expect(store.remember([brief], { scope: 'owner-a' })).toBe(true);
    expect(store.current()?.agent).toBe('Your agent');
    // A late read for another account is ignored and leaves the current brief.
    const other = result({ status: 'finished', output: 'Owner B brief' });
    expect(store.remember([other], { scope: 'owner-b' })).toBe(false);
    expect(store.remember([other])).toBe(false);
    expect(store.current()?.summary).toBe('Owner A brief');
    store.bind('owner-b');
    expect(store.current()).toBeNull();
    const before = notified;
    store.bind('owner-b');
    expect(notified).toBe(before);
    stop();
    store.remember([other], { scope: 'owner-b' });
    expect(notified).toBe(before);
    expect(store.current()?.summary).toBe('Owner B brief');
  });
  test('after a disconnect unbinds the store, a late read for that account is ignored', () => {
    const store = new RetainedBriefStore();
    const brief = result({ status: 'finished', output: 'Owner A brief' });
    store.bind('owner-a');
    expect(store.remember([brief], { scope: 'owner-a' })).toBe(true);
    store.bind(null);
    expect(store.current()).toBeNull();
    // The read started before the disconnect finishes afterwards: it never reaches Home.
    expect(store.remember([brief], { scope: 'owner-a' })).toBe(false);
    expect(store.current()).toBeNull();
    // A host without account scopes still records its results.
    expect(store.remember([brief])).toBe(true);
    expect(store.current()?.summary).toBe('Owner A brief');
  });
});

function memoryStorage() {
  const slots = new Map<string, string>();
  const storage: DigestStorage = {
    read: async <T>(slot: string) => {
      const saved = slots.get(slot);
      return saved === undefined ? null : (JSON.parse(saved) as T);
    },
    write: async (slot, value) => {
      slots.set(slot, JSON.stringify(value));
    },
    remove: async (slot) => {
      slots.delete(slot);
    },
  };
  return { slots, storage };
}

describe('result inbox', () => {
  test('one retained record and one notice per occurrence across a lost acknowledgement', async () => {
    const stream = [result({ status: 'finished' }), result({ status: 'missed' })].map((r) => ({
      ...r,
    }));
    let acked = 0;
    let failAck = true;
    const calls: string[] = [];
    const protocol = new HostedDigestProtocol(async (path, body) => {
      calls.push(path.split('?')[0]);
      if (path.startsWith('/api/workflow/hosted/results/ack')) {
        if (failAck) {
          failAck = false;
          throw Error('lost ack');
        }
        acked = (body as { cursor: number }).cursor;
        return {};
      }
      return { entries: stream.filter((r) => r.cursor > acked) };
    });
    const { storage, slots } = memoryStorage();
    const notices: string[] = [];
    const inbox = new DigestInbox(
      storage,
      'scope-a',
      async (r) => {
        notices.push(r.runId);
      },
      () => 'client-a'
    );
    const signal = new AbortController().signal;
    await expect(inbox.sync(protocol, signal)).rejects.toThrow('lost ack');
    const history = await inbox.sync(protocol, signal);
    expect(history.map((r) => r.runId)).toEqual(stream.map((r) => r.runId));
    expect(notices).toEqual(stream.map((r) => r.runId));
    expect(acked).toBe(stream[1].cursor);
    expect([...slots.keys()].filter((k) => k.startsWith('scope-a:')).length).toBe(2);
    // Nothing new: no notice, no write of a changed record.
    await inbox.sync(protocol, signal);
    expect(notices.length).toBe(2);
    expect(
      calls.every((path) => HOSTED_DIGEST_CLIENT_ROUTES.some((route) => route.endsWith(path)))
    ).toBe(true);
  });
  test('a changed record with the same identity is refused, not overwritten', async () => {
    const original = result({ status: 'finished', output: 'Original' });
    let entries = [original];
    const protocol = new HostedDigestProtocol(async (path) =>
      path.includes('/ack') ? {} : { entries: entries.splice(0) }
    );
    const { storage } = memoryStorage();
    const inbox = new DigestInbox(storage, 'scope-b', undefined, () => 'client-b');
    await inbox.sync(protocol, new AbortController().signal);
    entries = [{ ...original, output: 'Rewritten' }];
    await expect(inbox.sync(protocol, new AbortController().signal)).rejects.toThrow(
      'Saved digest result changed'
    );
    expect((await inbox.history())[0].output).toBe('Original');
  });
});

describe('protocol', () => {
  test('every route the client calls is registered by the plugin', async () => {
    const routes = readFileSync(join(pluginRoot, 'src/plugin-routes.ts'), 'utf8');
    const registered = new Set(
      [...routes.matchAll(/type:\s*'(GET|POST|PUT|PATCH|DELETE)',\s*path:\s*'([^']+)'/g)].map(
        ([, method, path]) => `${method} ${path}`
      )
    );
    for (const route of HOSTED_DIGEST_CLIENT_ROUTES) expect(registered.has(route)).toBe(true);
    const calls = new Set<string>();
    const protocol = new HostedDigestProtocol(async (path, body) => {
      calls.add(`${body === undefined ? 'GET' : 'POST'} ${path.split('?')[0]}`);
      throw Error('recorded');
    });
    const signal = new AbortController().signal;
    const attempt = async (run: () => Promise<unknown>) => {
      try {
        await run();
      } catch {}
    };
    await attempt(() => protocol.capabilities(signal));
    await attempt(() => protocol.liveAccounts(signal));
    await attempt(() => protocol.liveCalendars({ accountId: 'a', accountRevision: 'r' }, signal));
    await attempt(() => protocol.sources(signal));
    await attempt(() => protocol.loops(signal));
    for (const path of ['sources', 'loops', 'sources/revoke', 'dossier'] as const)
      await attempt(() => protocol.mutate(path, {}, signal));
    await attempt(() => protocol.results('client', signal));
    await attempt(() => protocol.ack('client', { cursor: 1, runId: 'run' }, signal));
    expect([...calls].sort()).toEqual([...HOSTED_DIGEST_CLIENT_ROUTES].sort());
  });
  test('responses are validated and a rejected source is typed', async () => {
    const page = [
      result({ status: 'finished', cursor: 5 }),
      result({ status: 'finished', cursor: 4 }),
    ];
    const protocol = new HostedDigestProtocol(async (path) => {
      if (path.includes('/results')) return { entries: page };
      throw Object.assign(Error('refused'), {
        status: 409,
        code: 'HOSTED_SOURCE_NOT_SAVED',
        mutationId: 'src-9',
      });
    });
    const signal = new AbortController().signal;
    await expect(protocol.results('client', signal)).rejects.toThrow('Out of order result page');
    await expect(protocol.mutate('sources', { id: 'src-9' }, signal)).rejects.toBeInstanceOf(
      HostedSourceRejected
    );
    await expect(protocol.mutate('loops', { id: 'src-9' }, signal)).rejects.toThrow('refused');
    expect(() => parseDigestResult({ cursor: 0 })).toThrow();
  });
  test('capabilities report only what the agent advertises', async () => {
    const protocol = new HostedDigestProtocol(async () => ({
      hostedDigestProtocol: 1,
      hostedNativeSourceProtocol: 1,
    }));
    expect(await protocol.capabilities(new AbortController().signal)).toEqual({
      digests: true,
      nativeSources: true,
      nativeEvening: false,
      sourcePause: false,
      dossier: false,
    });
  });
});

describe('schedule presentation', () => {
  const nativeSource: DigestSource = {
    id: 'src-1',
    revision: 'rev-1',
    kind: 'tasks',
    label: 'Phone calendar',
    observedAt: iso(T0 - 3600000),
    expiresAt: iso(T0 + 3 * 86400000),
    revoked: false,
    live: {
      provider: 'native',
      ownerId: 'owner',
      agentId: 'agent',
      installationId: 'install',
      enrollmentId: 'enroll',
      sourceId: 'src-1',
      revision: 'a'.repeat(64),
    },
  };
  const loop: DigestLoop = {
    id: 'loop-morning',
    versionId: 'v1',
    name: 'Morning digest',
    active: true,
    removed: false,
    spec: {
      version: 1,
      template: 'morning',
      sourceId: 'src-1',
      sourceRevision: 'rev-1',
      timeZone: 'UTC',
      localTime: '07:00',
      enabled: true,
    },
  };
  test('a missed morning occurrence offers one reviewed Run now until something newer exists', () => {
    const missed = result({ status: 'missed', runId: 'missed-1' });
    const offers = missedRunNowOffers([missed], [loop], [nativeSource], T0);
    expect(offers.get('missed-1')?.mutationId).toBe('missed-run-now-missed-1');
    const newer = result({ status: 'finished' });
    expect(missedRunNowOffers([missed, newer], [loop], [nativeSource], T0).size).toBe(0);
    expect(
      missedRunNowOffers([missed], [{ ...loop, active: false }], [nativeSource], T0).size
    ).toBe(0);
  });
  test('renewal, loop state and time zone notes', () => {
    const expiring = { ...nativeSource, expiresAt: iso(T0 + 3600000) };
    expect(digestRenewals([expiring], [loop], T0).map((r) => r.state)).toEqual(['expiring']);
    expect(digestRenewals([nativeSource], [loop], T0)).toEqual([]);
    expect(digestLoopState(loop, [nativeSource], T0)).toBe('On');
    expect(digestLoopState(loop, [{ ...nativeSource, revoked: true }], T0, true)).toBe(
      'Source revoked — paused'
    );
    expect(digestLoopState(loop, [], T0)).toBe('Source expired — renew to resume');
    expect(digestZoneNote(loop, 'UTC', T0)).toBe('');
    expect(digestZoneNote(loop, 'America/New_York', T0)).toMatch(/^Runs at 07:00 UTC time/);
    expect(
      digestSummaryText({
        runId: 'r',
        output: [{ nodeId: 'typed-steps', runId: 'r', text: 'Typed' }],
        error: null,
      })
    ).toBe('Typed');
  });
});

/**
 * Browser-safe client of the scheduled digest (resident brief) routes under
 * `/api/workflow/hosted/*`, with the durable client-scoped result inbox and
 * the retained-brief selection a Home surface shows.
 *
 * The agent owns scheduling (TaskService triggers), admission and the result
 * stream; this module never schedules or runs a digest. A host injects the
 * authenticated request function and the private storage. Results are
 * committed locally before the server cursor advances, so a lost
 * acknowledgement replays the same records and never a workflow run.
 */
import {
  type DigestNotRunStatus,
  digestSourceState,
  isDigestNotRunStatus,
} from '../services/hosted-digest-policy';

export {
  DIGEST_MISSED_TEXT,
  DIGEST_NOT_RUN_STATUSES,
  DIGEST_OVERLAP_TEXT,
  DIGEST_PAUSED_TEXT,
  DIGEST_RUN_WINDOW_MS,
  DIGEST_SOURCE_UNAVAILABLE_TEXT,
  type DigestNotRunStatus,
  digestOccurrenceMissed,
  digestSourceState,
  isDigestNotRunStatus,
} from '../services/hosted-digest-policy';

export class HostedSourceRejected extends Error {
  constructor() {
    super('Source access changed before saving. Refresh accounts and review the source again.');
    this.name = 'HostedSourceRejected';
  }
}
export interface HostedLiveAccount {
  accountId: string;
  accountRevision: string;
  label: string;
  kinds: ('email' | 'calendar')[];
  expiresAt?: string;
}
export interface HostedLiveCalendar {
  calendarId: string;
  label: string;
  timeZone: string;
}
export interface HostedLiveSelection {
  provider: 'google';
  accountId: string;
  accountRevision: string;
  kind: 'email' | 'calendar';
  windowHours: number;
  maxItems: number;
  calendarId?: string;
}
export interface HostedNativeSelection {
  provider: 'native';
  ownerId: string;
  agentId: string;
  installationId: string;
  enrollmentId: string;
  sourceId: string;
  revision: string;
}
export type DigestTemplate = 'morning' | 'evening';
export interface DigestSource {
  id: string;
  revision: string;
  kind: string;
  label: string;
  observedAt: string;
  expiresAt: string;
  revoked: boolean;
  live?: HostedLiveSelection | HostedNativeSelection;
}
export interface DigestSpec {
  version: 1;
  template: DigestTemplate;
  sourceId: string;
  sourceRevision: string;
  timeZone: string;
  localTime: string;
  enabled: boolean;
}
export type DigestSourceState = 'current' | 'expired' | 'revoked';
export interface DigestCapabilities {
  digests: boolean;
  nativeSources: boolean;
  /** Agent accepts evening loops over a native phone source. */
  nativeEvening: boolean;
  /** Agent pauses a loop whose source lapsed and reports sourceState. */
  sourcePause: boolean;
  /** Agent advertises POST /api/workflow/hosted/dossier. */
  dossier: boolean;
}
export interface DigestLoop {
  id: string;
  versionId: string;
  name: string;
  active: boolean;
  removed: boolean;
  spec: DigestSpec;
  /** Why a loop is paused; agents without source pausing omit it. */
  sourceState?: DigestSourceState;
}
export interface DigestResult {
  cursor: number;
  runId: string;
  workflowId: string;
  workflowVersionId: string;
  templateVersion: string;
  scheduledAt: string;
  source: Record<string, unknown>;
  status: string;
  startedAt: string;
  completedAt: string;
  output: unknown;
  error: string | null;
}
/** Private, durable storage a host provides for the result inbox. */
export interface DigestStorage {
  read<T>(slot: string): Promise<T | null>;
  write(slot: string, value: unknown): Promise<void>;
  remove(slot: string): Promise<void>;
}
/** Authenticated request: GET without a body, POST with one. */
export type HostedDigestRequest = (
  path: string,
  body: unknown | undefined,
  signal: AbortSignal
) => Promise<unknown>;

/** Default and maximum reviewed source lifetime; renewal reviews a new source. */
export const DIGEST_SOURCE_MAX_HOURS = 168;
/** A bound source shows its renewal notice in its final 24 hours. */
export const DIGEST_RENEWAL_WINDOW_MS = 24 * 3600000;
/** Results retained on the device per scope. Server history is durable. */
export const DIGEST_RETAINED_RESULTS = 100;

/** A JSON object from the agent. Callers validate each field they read. */
// biome-ignore lint/suspicious/noExplicitAny: untrusted wire records are validated field by field
type WireRecord = Record<string, any>;
function object(value: unknown): WireRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Invalid hosted digest response');
  return value as WireRecord;
}
function id(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value))
    throw Error('Invalid digest identity');
  return value;
}
function date(value: unknown) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw Error('Invalid digest date');
  return value;
}
function boundedIdentity(value: unknown) {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > 256 ||
    Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw Error('Invalid live source identity');
  return value;
}
function revision(value: unknown) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw Error('Invalid live source revision');
  return value;
}
function liveSelection(value: unknown): HostedLiveSelection {
  const v = object(value);
  if (
    v.provider !== 'google' ||
    !['email', 'calendar'].includes(v.kind) ||
    !Number.isInteger(v.windowHours) ||
    v.windowHours < 1 ||
    v.windowHours > 168 ||
    !Number.isInteger(v.maxItems) ||
    v.maxItems < 1 ||
    v.maxItems > 25
  )
    throw Error('Invalid live source');
  return {
    provider: 'google',
    accountId: boundedIdentity(v.accountId),
    accountRevision: revision(v.accountRevision),
    kind: v.kind,
    windowHours: v.windowHours,
    maxItems: v.maxItems,
    ...(v.kind === 'calendar' ? { calendarId: boundedIdentity(v.calendarId) } : {}),
  };
}
const NATIVE_SELECTION_KEYS = [
  'provider',
  'ownerId',
  'agentId',
  'installationId',
  'enrollmentId',
  'sourceId',
  'revision',
];
function nativeSelection(value: unknown): HostedNativeSelection {
  const v = object(value);
  if (v.provider !== 'native' || Object.keys(v).some((k) => !NATIVE_SELECTION_KEYS.includes(k)))
    throw Error('Invalid native source');
  return {
    provider: 'native',
    ownerId: boundedIdentity(v.ownerId),
    agentId: boundedIdentity(v.agentId),
    installationId: boundedIdentity(v.installationId),
    enrollmentId: boundedIdentity(v.enrollmentId),
    sourceId: boundedIdentity(v.sourceId),
    revision: revision(v.revision),
  };
}

export function parseDigestResult(value: unknown): DigestResult {
  const v = object(value);
  if (
    !Number.isSafeInteger(v.cursor) ||
    v.cursor < 1 ||
    typeof v.status !== 'string' ||
    JSON.stringify(v).length > 200000
  )
    throw Error('Invalid digest result');
  return {
    cursor: v.cursor,
    runId: id(v.runId),
    workflowId: id(v.workflowId),
    workflowVersionId: id(v.workflowVersionId),
    templateVersion: id(v.templateVersion),
    scheduledAt: date(v.scheduledAt),
    source: object(v.source),
    status: v.status,
    startedAt: date(v.startedAt),
    completedAt: date(v.completedAt),
    output: v.output,
    error: typeof v.error === 'string' ? v.error : null,
  };
}

/** Owner-facing labels of occurrences recorded without running. */
const DIGEST_NOT_RUN_LABEL: Readonly<Record<DigestNotRunStatus, string>> = {
  missed: 'Missed — not run',
  overlap: 'Skipped — an earlier run was still active',
  unavailable: 'Not run — source unavailable',
};
/** True when the occurrence executed. A missed, overlapping or unavailable occurrence is a record, not a brief. */
export function digestRan(result: Pick<DigestResult, 'status'>): boolean {
  return !isDigestNotRunStatus(result.status);
}
/** Owner-facing state of one occurrence. Executed runs keep the agent's own status word. */
export function digestStatusLabel(status: string): string {
  return isDigestNotRunStatus(status) ? DIGEST_NOT_RUN_LABEL[status] : status;
}
/** The final summary, never typed-step source payloads or execution metadata. */
export function digestSummaryText(
  result: Pick<DigestResult, 'runId' | 'output' | 'error'>
): string {
  if (result.error) return result.error;
  const output = result.output;
  if (typeof output === 'string') return output;
  if (Array.isArray(output) && output.length === 1) {
    const value = output[0];
    if (
      value &&
      typeof value === 'object' &&
      value.nodeId === 'typed-steps' &&
      value.runId === result.runId &&
      typeof value.text === 'string'
    )
      return value.text;
  }
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const value = output as Record<string, unknown>;
    if (typeof value.summary === 'string') return value.summary;
    if (typeof value.text === 'string') return value.text;
  }
  return 'No readable summary was returned. Open execution details to inspect this result.';
}

export interface DigestRenewal {
  source: DigestSource;
  state: DigestSourceState | 'expiring';
  loops: DigestLoop[];
}
/** Sources that keep a loop running and need renewal now: expired, revoked, or within 24h of expiry. */
export function digestRenewals(
  sources: DigestSource[],
  loops: DigestLoop[],
  now = Date.now()
): DigestRenewal[] {
  const out: DigestRenewal[] = [];
  for (const source of sources) {
    const bound = loops.filter(
      (loop) => !loop.removed && loop.spec.enabled && loop.spec.sourceId === source.id
    );
    if (!bound.length) continue;
    const expiresAt = Date.parse(source.expiresAt);
    const reported = bound.find(
      (loop) => loop.sourceState && loop.sourceState !== 'current'
    )?.sourceState;
    const state: DigestRenewal['state'] =
      source.revoked || reported === 'revoked'
        ? 'revoked'
        : expiresAt <= now || reported === 'expired'
          ? 'expired'
          : expiresAt - now <= DIGEST_RENEWAL_WINDOW_MS
            ? 'expiring'
            : 'current';
    if (state !== 'current') out.push({ source, state, loops: bound });
  }
  return out;
}
/** Loop state shown to the owner. Only an agent that advertises pausing is described as paused. */
export function digestLoopState(
  loop: DigestLoop,
  sources: DigestSource[],
  now = Date.now(),
  pauses = false
): string {
  if (loop.removed) return 'Removed';
  if (!loop.spec.enabled || !loop.active) return 'Paused';
  const source = sources.find((s) => s.id === loop.spec.sourceId);
  const suffix = pauses ? ' — paused' : ' — renew to resume';
  if (loop.sourceState === 'revoked' || source?.revoked) return `Source revoked${suffix}`;
  if (loop.sourceState === 'expired' || !source || digestSourceState(source, now) === 'expired')
    return `Source expired${suffix}`;
  return 'On';
}

/** Minutes east of UTC for an IANA zone at an instant, or null for an unknown zone. */
function zoneOffsetMinutes(zone: string, at: number): number | null {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(at)
        .map((part) => [part.type, part.value])
    );
    const wall = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute)
    );
    return Math.round((wall - Math.floor(at / 60000) * 60000) / 60000);
  } catch {
    return null;
  }
}
/** A schedule keeps its reviewed time zone. Says so when the device clock is in a different one. */
export function digestZoneNote(
  loop: Pick<DigestLoop, 'spec' | 'removed'>,
  deviceZone: string,
  now = Date.now()
): string {
  if (loop.removed || !loop.spec.enabled || loop.spec.timeZone === deviceZone) return '';
  const reviewed = zoneOffsetMinutes(loop.spec.timeZone, now);
  const device = zoneOffsetMinutes(deviceZone, now);
  if (reviewed === null || device === null || reviewed === device) return '';
  return `Runs at ${loop.spec.localTime} ${loop.spec.timeZone} time, not this device’s current time zone (${deviceZone}). Review the schedule to change it.`;
}

/** One reviewed Run now offer for a missed occurrence; see {@link missedRunNowOffers}. */
export interface MissedRunNow {
  runId: string;
  sourceId: string;
  sourceRevision: string;
  sourceLabel: string;
  scheduledAt: string;
  /** Derived from the missed record: a repeat or retry returns the same run. */
  mutationId: string;
}
/** Agent submission identity for Run now of one missed record. Null when the record id cannot form one. */
export function missedRunNowMutationId(runId: string): string | null {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(runId) ? `missed-run-now-${runId}` : null;
}
/**
 * Explicit Run now for a missed scheduled digest. The missed record is never
 * replayed or changed and nothing runs automatically: the owner reviews and
 * confirms one new, separate run that reads the reviewed phone sources as they
 * are now. Offered only for the newest result of an active morning loop over a
 * current native source whose revision the loop is bound to, and only while no
 * newer result exists for that loop, that source, or any on-demand run.
 */
export function missedRunNowOffers(
  results: DigestResult[],
  loops: DigestLoop[],
  sources: DigestSource[],
  now = Date.now()
): Map<string, MissedRunNow> {
  const offers = new Map<string, MissedRunNow>();
  for (const result of results) {
    if (result.status !== 'missed') continue;
    const loop = loops.find((l) => l.id === result.workflowId);
    if (
      !loop ||
      loop.removed ||
      !loop.active ||
      !loop.spec.enabled ||
      loop.spec.template !== 'morning'
    )
      continue;
    const source = sources.find((s) => s.id === loop.spec.sourceId);
    if (
      !source ||
      source.revoked ||
      source.live?.provider !== 'native' ||
      source.revision !== loop.spec.sourceRevision
    )
      continue;
    if (
      !(Date.parse(source.expiresAt) > now) ||
      (loop.sourceState && loop.sourceState !== 'current')
    )
      continue;
    // Any newer on-demand run (never a listed loop) supersedes it too.
    const superseding = (other: DigestResult) =>
      other.workflowId === loop.id ||
      other.source?.id === source.id ||
      !loops.some((l) => l.id === other.workflowId);
    if (results.some((other) => other.cursor > result.cursor && superseding(other))) continue;
    const mutationId = missedRunNowMutationId(result.runId);
    if (!mutationId) continue;
    offers.set(result.runId, {
      runId: result.runId,
      sourceId: source.id,
      sourceRevision: source.revision,
      sourceLabel: source.label,
      scheduledAt: result.scheduledAt,
      mutationId,
    });
  }
  return offers;
}

// ---------------------------------------------------------------------------
// Retained brief
// ---------------------------------------------------------------------------

/** The brief a Home card shows: the newest retained result that ran. */
export interface RetainedDigestSummary {
  summary: string;
  ranAt: string;
  agent: string;
  status: string;
}
/**
 * The newest retained result that actually ran (by completion, then cursor).
 * A missed, overlapping or unavailable occurrence is a record and never
 * replaces the last brief; with only such records there is no brief.
 */
export function latestRetainedBrief(
  results: readonly DigestResult[] | null | undefined,
  agent = 'Your agent'
): RetainedDigestSummary | null {
  const latest = (results ?? []).filter(digestRan).reduce<DigestResult | null>((best, row) => {
    if (!best) return row;
    const a = Date.parse(row.completedAt);
    const b = Date.parse(best.completedAt);
    return a > b || (a === b && row.cursor > best.cursor) ? row : best;
  }, null);
  return latest
    ? {
        summary: digestSummaryText(latest).slice(0, 2000),
        ranAt: latest.completedAt,
        agent: agent.slice(0, 200) || 'Your agent',
        status: latest.status,
      }
    : null;
}

/**
 * Retained brief for the current account and agent. A host binds the scope of
 * its current connection (for example origin, owner and agent); results read
 * under another scope are ignored, and changing the scope clears the brief, so
 * a late read for a previous account can never reach the current Home.
 * Without any bound scope, unscoped results are accepted.
 */
export class RetainedBriefStore {
  private value: RetainedDigestSummary | null = null;
  private scope: string | null = null;
  private readonly listeners = new Set<() => void>();

  current(): RetainedDigestSummary | null {
    return this.value;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** Binds the current connection scope. A different scope clears the brief. */
  bind(scope: string | null): void {
    if (scope === this.scope) return;
    this.scope = scope;
    this.set(null);
  }
  /**
   * Records the newest brief that ran from results read under `scope`, or
   * clears it for `null`. Returns false when the results belong to another
   * scope and were ignored.
   */
  remember(
    results: readonly DigestResult[] | null,
    options: { agent?: string; scope?: string | null } = {}
  ): boolean {
    const scope = options.scope ?? null;
    if (this.scope !== null && scope !== this.scope) return false;
    this.set(results ? latestRetainedBrief(results, options.agent) : null);
    return true;
  }
  private set(next: RetainedDigestSummary | null): void {
    if (JSON.stringify(next) === JSON.stringify(this.value)) return;
    this.value = next;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A listener failure never blocks other listeners or the result inbox.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Protocol and inbox
// ---------------------------------------------------------------------------

/** Every mutation path under /api/workflow/hosted/. */
export type HostedDigestMutationPath = 'sources' | 'loops' | 'sources/revoke' | 'dossier';
/** Every delegation path under /api/workflow/hosted/cloud-delegation/. */
export type HostedDigestDelegationPath =
  | 'start'
  | 'complete'
  | 'status'
  | 'cancel'
  | 'revoke'
  | 'revocations';

export class HostedDigestProtocol {
  constructor(private readonly request: HostedDigestRequest) {}

  /** What this agent advertises. Older agents omit later flags, so the client neither offers nor claims them. */
  async capabilities(signal: AbortSignal): Promise<DigestCapabilities> {
    const v = object(await this.request('/api/workflow/status', undefined, signal));
    return {
      digests: v.hostedDigestProtocol === 1,
      nativeSources: v.hostedNativeSourceProtocol === 1,
      nativeEvening: v.hostedNativeSourceProtocol === 1 && v.hostedNativeEveningProtocol === 1,
      sourcePause: v.hostedDigestSourcePauseProtocol === 1,
      dossier: v.hostedDossierProtocol === 1,
    };
  }
  async available(signal: AbortSignal): Promise<boolean> {
    return (
      object(await this.request('/api/workflow/status', undefined, signal)).hostedDigestProtocol ===
      1
    );
  }
  async delegation(
    path: HostedDigestDelegationPath,
    body: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<WireRecord> {
    return object(
      await this.request(`/api/workflow/hosted/cloud-delegation/${path}`, body, signal)
    );
  }
  async liveAccounts(signal: AbortSignal): Promise<{ accounts: HostedLiveAccount[] }> {
    const v = object(await this.request('/api/workflow/hosted/live-accounts', undefined, signal));
    if (!Array.isArray(v.accounts) || v.accounts.length > 100) throw Error('Invalid live accounts');
    return {
      accounts: v.accounts.map((value) => {
        const a = object(value);
        if (
          !Array.isArray(a.kinds) ||
          !a.kinds.length ||
          a.kinds.length > 2 ||
          new Set(a.kinds).size !== a.kinds.length ||
          a.kinds.some((k: unknown) => k !== 'email' && k !== 'calendar') ||
          typeof a.label !== 'string' ||
          !a.label.length ||
          a.label.length > 200 ||
          (a.expiresAt !== undefined &&
            (typeof a.expiresAt !== 'string' || !Number.isFinite(Date.parse(a.expiresAt))))
        )
          throw Error('Invalid live account');
        return {
          accountId: boundedIdentity(a.accountId),
          accountRevision: revision(a.accountRevision),
          label: a.label,
          kinds: a.kinds,
          ...(typeof a.expiresAt === 'string' ? { expiresAt: a.expiresAt } : {}),
        };
      }),
    };
  }
  async liveCalendars(
    account: Pick<HostedLiveAccount, 'accountId' | 'accountRevision'>,
    signal: AbortSignal
  ): Promise<{ calendars: HostedLiveCalendar[]; truncated: boolean }> {
    const v = object(
      await this.request(
        '/api/workflow/hosted/live-calendars',
        { accountId: account.accountId, accountRevision: account.accountRevision },
        signal
      )
    );
    if (!Array.isArray(v.calendars) || v.calendars.length > 50 || typeof v.truncated !== 'boolean')
      throw Error('Invalid live calendars');
    return {
      truncated: v.truncated,
      calendars: v.calendars.map((value) => {
        const c = object(value);
        if (
          typeof c.label !== 'string' ||
          !c.label.length ||
          c.label.length > 256 ||
          typeof c.timeZone !== 'string' ||
          c.timeZone.length > 100
        )
          throw Error('Invalid live calendar');
        return {
          calendarId: boundedIdentity(c.calendarId),
          label: c.label,
          timeZone: c.timeZone,
        };
      }),
    };
  }
  async sources(signal: AbortSignal): Promise<DigestSource[]> {
    const values = object(
      await this.request('/api/workflow/hosted/sources', undefined, signal)
    ).sources;
    if (!Array.isArray(values) || values.length > 1000) throw Error('Invalid sources');
    return values.map((value) => {
      const v = object(value);
      return {
        id: id(v.id),
        revision: id(v.revision),
        kind: String(v.kind),
        label: String(v.label).slice(0, 200),
        observedAt: date(v.observedAt),
        expiresAt: date(v.expiresAt),
        revoked: v.revoked === true,
        ...(v.live === undefined
          ? {}
          : {
              live:
                object(v.live).provider === 'native'
                  ? nativeSelection(v.live)
                  : liveSelection(v.live),
            }),
      };
    });
  }
  async loops(signal: AbortSignal): Promise<DigestLoop[]> {
    const values = object(
      await this.request('/api/workflow/hosted/loops', undefined, signal)
    ).loops;
    if (!Array.isArray(values) || values.length > 1000) throw Error('Invalid loops');
    return values.map((value) => {
      const v = object(value);
      const sourceState = ['current', 'expired', 'revoked'].includes(v.sourceState)
        ? (v.sourceState as DigestSourceState)
        : undefined;
      const { sourceState: _reported, ...rest } = v;
      return {
        ...rest,
        id: id(v.id),
        versionId: id(v.versionId),
        ...(sourceState ? { sourceState } : {}),
      } as DigestLoop;
    });
  }
  async mutate(
    path: HostedDigestMutationPath,
    body: unknown,
    signal: AbortSignal
  ): Promise<WireRecord> {
    try {
      return object(await this.request(`/api/workflow/hosted/${path}`, body, signal));
    } catch (error) {
      const e = error as { status?: number; code?: string; mutationId?: string };
      if (
        path === 'sources' &&
        (e?.status === 409 || e?.status === 400) &&
        e.code === 'HOSTED_SOURCE_NOT_SAVED' &&
        e.mutationId === object(body).id
      )
        throw new HostedSourceRejected();
      throw error;
    }
  }
  async results(clientId: string, signal: AbortSignal): Promise<DigestResult[]> {
    const v = object(
      await this.request(
        `/api/workflow/hosted/results?clientId=${encodeURIComponent(id(clientId))}`,
        undefined,
        signal
      )
    );
    if (!Array.isArray(v.entries) || v.entries.length > 50) throw Error('Invalid result page');
    const entries = v.entries.map(parseDigestResult);
    if (entries.some((e, i) => i > 0 && e.cursor <= entries[i - 1].cursor))
      throw Error('Out of order result page');
    return entries;
  }
  async ack(
    clientId: string,
    result: Pick<DigestResult, 'cursor' | 'runId'>,
    signal: AbortSignal
  ): Promise<void> {
    await this.request(
      '/api/workflow/hosted/results/ack',
      { clientId, cursor: result.cursor, runId: result.runId },
      signal
    );
  }
}

/** Every request path the protocol can make, for route-registration checks. */
export const HOSTED_DIGEST_CLIENT_ROUTES: readonly string[] = Object.freeze([
  'GET /api/workflow/status',
  'GET /api/workflow/hosted/live-accounts',
  'POST /api/workflow/hosted/live-calendars',
  'GET /api/workflow/hosted/sources',
  'GET /api/workflow/hosted/loops',
  'POST /api/workflow/hosted/sources',
  'POST /api/workflow/hosted/loops',
  'POST /api/workflow/hosted/sources/revoke',
  'POST /api/workflow/hosted/dossier',
  'GET /api/workflow/hosted/results',
  'POST /api/workflow/hosted/results/ack',
]);

// JSON objects may arrive with a different property order after reconnect.
// Array order and every value remain part of the immutable receipt identity.
function sameResultValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object')
    return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameResultValue(value, right[index]))
    );
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && sameResultValue(a[key], b[key]))
  );
}

interface InboxIndex {
  clientId: string;
  ids: string[];
  pendingRemoval?: string[];
  pendingNotices?: string[];
}
const inboxQueues = new Map<string, Promise<unknown>>();

/**
 * Client-scoped result inbox. Callers are serialized per scope. Each result is
 * committed to private storage before the server cursor advances; a lost
 * acknowledgement replays the same records and never a run. `afterCommit`
 * (for example a result notice) runs at most until it succeeds once per
 * record and is retried after an interruption.
 */
export class DigestInbox {
  constructor(
    private readonly storage: DigestStorage,
    private readonly scope: string,
    private readonly afterCommit?: (result: DigestResult, signal: AbortSignal) => Promise<void>,
    private readonly createClientId: () => string = () => crypto.randomUUID()
  ) {}

  async history(): Promise<DigestResult[]> {
    const index = await this.storage.read<InboxIndex>(this.scope);
    if (!index) return [];
    const entries = await Promise.all(
      index.ids.map((run) => this.storage.read<DigestResult>(`${this.scope}:${run}`))
    );
    return entries.filter((v): v is DigestResult => v !== null).map(parseDigestResult);
  }

  sync(client: HostedDigestProtocol, signal: AbortSignal): Promise<DigestResult[]> {
    const work = (inboxQueues.get(this.scope) || Promise.resolve()).then(async () => {
      // Cancellation cannot undo a dispatched write; stop before the next
      // operation and let a later replay recover any committed record.
      const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
        signal.throwIfAborted();
        const value = await operation();
        signal.throwIfAborted();
        return value;
      };
      const storage: DigestStorage = {
        read: <T>(slot: string) => guarded(() => this.storage.read<T>(slot)),
        write: (slot, value) => guarded(() => this.storage.write(slot, value)),
        remove: (slot) => guarded(() => this.storage.remove(slot)),
      };
      let index = await storage.read<InboxIndex>(this.scope);
      if (!index) {
        index = { clientId: this.createClientId(), ids: [] };
        await storage.write(this.scope, index);
      }
      const current = index;
      // Recover cleanup after a lost ack or process exit; only evicted history is removed.
      for (const run of current.pendingRemoval ?? []) {
        if (!current.ids.includes(run)) await storage.remove(`${this.scope}:${run}`);
      }
      current.pendingRemoval = [];
      await storage.write(this.scope, current);
      const afterCommit = this.afterCommit;
      const drainNotices = async () => {
        if (!afterCommit) return;
        for (const run of [...(current.pendingNotices ?? [])]) {
          signal.throwIfAborted();
          const saved = current.ids.includes(run)
            ? await storage.read<DigestResult>(`${this.scope}:${run}`)
            : null;
          try {
            if (saved) await guarded(() => afterCommit(parseDigestResult(saved), signal));
          } catch {
            signal.throwIfAborted();
            continue;
          }
          current.pendingNotices = (current.pendingNotices ?? []).filter((id) => id !== run);
          await storage.write(this.scope, current);
        }
      };
      await drainNotices();
      for (let page = 0; page < 20; page++) {
        signal.throwIfAborted();
        const entries = await guarded(() => client.results(current.clientId, signal));
        if (!entries.length) break;
        for (const entry of entries) {
          const key = `${this.scope}:${entry.runId}`;
          const existing = await storage.read<DigestResult>(key);
          if (existing && !sameResultValue(existing, entry))
            throw Error('Saved digest result changed');
          if (!existing) await storage.write(key, entry);
          if (!current.ids.includes(entry.runId)) {
            current.ids.push(entry.runId);
            current.pendingNotices = [...new Set([...(current.pendingNotices ?? []), entry.runId])];
          }
        }
        const removed = current.ids.splice(
          0,
          Math.max(0, current.ids.length - DIGEST_RETAINED_RESULTS)
        );
        current.pendingNotices = (current.pendingNotices ?? []).filter((run) =>
          current.ids.includes(run)
        );
        current.pendingRemoval = [...new Set([...(current.pendingRemoval ?? []), ...removed])];
        await storage.write(this.scope, current);
        await drainNotices();
        signal.throwIfAborted();
        await guarded(() => client.ack(current.clientId, entries[entries.length - 1], signal));
        for (const run of current.pendingRemoval) await storage.remove(`${this.scope}:${run}`);
        current.pendingNotices = (current.pendingNotices ?? []).filter((run) =>
          current.ids.includes(run)
        );
        current.pendingRemoval = [];
        await storage.write(this.scope, current);
      }
      return guarded(() => this.history());
    });
    const tail = work.catch(() => {});
    inboxQueues.set(this.scope, tail);
    void tail.finally(() => {
      if (inboxQueues.get(this.scope) === tail) inboxQueues.delete(this.scope);
    });
    return work;
  }
}

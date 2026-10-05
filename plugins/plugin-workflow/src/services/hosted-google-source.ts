/** Read-only hosted inputs. Credentials stay in the existing Google service;
 * neither caller supplied account IDs nor OWNER role alone confer authority. */
import { createHash } from 'node:crypto';
import {
  type ConnectorAccount,
  getConnectorAccountManager,
  type IAgentRuntime,
} from '@elizaos/core';
import { WorkflowApiError } from '../types/index';

export interface HostedGoogleSelection {
  provider: 'google';
  accountId: string;
  accountRevision: string;
  kind: 'email' | 'calendar';
  windowHours: number;
  maxItems: number;
  calendarId?: string;
}
interface GoogleReads {
  listCalendarPage(input: {
    accountId: string;
    maxResults: number;
    minAccessRole: 'reader';
  }): Promise<{
    calendars: Array<{
      calendarId: string;
      summary?: string;
      timeZone?: string | null;
      accessRole?: string;
    }>;
    nextPageToken?: string | null;
  }>;
  searchMessages(input: { accountId: string; query: string; limit: number }): Promise<
    Array<{
      id: string;
      subject?: string;
      snippet?: string;
      receivedAt?: string;
      from?: { address?: string; email?: string; name?: string };
    }>
  >;
  listEventPage(input: {
    accountId: string;
    calendarId: string;
    timeMin: string;
    timeMax: string;
    maxResults: number;
    singleEvents: boolean;
    orderBy: 'startTime';
  }): Promise<{
    events: Array<{
      id: string;
      calendarId: string;
      title?: string;
      start?: string;
      end?: string;
      status?: string;
      isAllDay?: boolean;
    }>;
    nextPageToken?: string;
  }>;
}
interface CloudReads {
  list(owner: string): Promise<{
    accounts: Array<{
      accountId: string;
      accountRevision: string;
      label: string;
      kinds: string[];
      expiresAt: string;
    }>;
  }>;
  selected(
    owner: string,
    accountId: string,
    revision: string,
    kind: 'email' | 'calendar'
  ): Promise<{ grant: { expiresAt: number } }>;
  calendars(
    owner: string,
    accountId: string,
    revision: string
  ): ReturnType<GoogleReads['listCalendarPage']>;
  read(
    owner: string,
    selection: HostedGoogleSelection,
    now: number
  ): Promise<
    | Awaited<ReturnType<GoogleReads['searchMessages']>>
    | Awaited<ReturnType<GoogleReads['listEventPage']>>
  >;
}
function cloudService(runtime: IAgentRuntime) {
  return runtime.getService('cloud_google_delegation') as unknown as CloudReads | null;
}
function unavailable(): never {
  throw new WorkflowApiError(
    'Selected hosted Google source is unavailable; reconnect or review its owner and read grant',
    409
  );
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function identity(value: unknown, max = 256): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    Array.from(value).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
  );
}
export function validateHostedGoogleSelection(value: unknown): HostedGoogleSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable();
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (k) =>
        ![
          'provider',
          'accountId',
          'accountRevision',
          'kind',
          'windowHours',
          'maxItems',
          'calendarId',
        ].includes(k)
    ) ||
    v.provider !== 'google' ||
    !identity(v.accountId) ||
    v.accountId === 'default' ||
    typeof v.accountRevision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.accountRevision) ||
    !['email', 'calendar'].includes(String(v.kind)) ||
    !Number.isInteger(v.windowHours) ||
    Number(v.windowHours) < 1 ||
    Number(v.windowHours) > 168 ||
    !Number.isInteger(v.maxItems) ||
    Number(v.maxItems) < 1 ||
    Number(v.maxItems) > 25 ||
    (v.kind === 'calendar'
      ? !identity(v.calendarId) || v.calendarId === 'primary'
      : v.calendarId !== undefined)
  )
    unavailable();
  return {
    provider: 'google',
    accountId: v.accountId,
    accountRevision: v.accountRevision,
    kind: v.kind as 'email' | 'calendar',
    windowHours: Number(v.windowHours),
    maxItems: Number(v.maxItems),
    ...(v.kind === 'calendar' ? { calendarId: v.calendarId as string } : {}),
  };
}
function capabilities(account: ConnectorAccount) {
  const value = account.metadata?.grantedCapabilities;
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').sort() : [];
}
function accountRevision(account: ConnectorAccount) {
  return hash({
    id: account.id,
    ownerIdentityId: account.ownerIdentityId,
    ownerBindingId: account.ownerBindingId,
    externalId: account.externalId,
    status: account.status,
    role: account.role,
    purpose: [...account.purpose].sort(),
    accessGate: account.accessGate,
    updatedAt: account.updatedAt,
    capabilities: capabilities(account),
  });
}
function authorized(account: ConnectorAccount | null, owner: string): account is ConnectorAccount {
  return (
    !!account &&
    account.id !== 'default' &&
    account.provider === 'google' &&
    account.ownerIdentityId === owner &&
    !!account.ownerBindingId &&
    !!account.externalId &&
    account.status === 'connected' &&
    account.role === 'OWNER' &&
    ['open', 'owner_binding'].includes(account.accessGate) &&
    account.purpose.some((p) => p === 'reading' || p === 'automation')
  );
}
async function bound(runtime: IAgentRuntime, account: ConnectorAccount, owner: string) {
  const binding = await runtime.adapter.findConnectorOwnerBinding?.({
    connector: 'google',
    externalId: account.externalId!,
    ...(typeof account.metadata?.instanceId === 'string'
      ? { instanceId: account.metadata.instanceId }
      : {}),
  });
  return (
    !!binding &&
    binding.id === account.ownerBindingId &&
    binding.identityId === owner &&
    binding.connector === 'google' &&
    binding.externalId === account.externalId
  );
}
export async function listHostedGoogleSources(runtime: IAgentRuntime, owner: string) {
  const cloud = cloudService(runtime);
  let cloudAccounts: Awaited<ReturnType<CloudReads['list']>>['accounts'] = [],
    cloudState = 'unattended_delegation_unavailable';
  if (cloud)
    try {
      cloudAccounts = (await cloud.list(owner)).accounts;
      cloudState = 'explicit_delegation_available';
    } catch {}
  const service = runtime.getService('google');
  if (!service)
    return {
      available: false,
      reason: 'google_service_unavailable',
      accounts: cloudAccounts,
      cloud: cloudState,
    };
  const candidates = await getConnectorAccountManager(runtime).listAccounts('google');
  const accounts: ConnectorAccount[] = [];
  for (const account of candidates)
    if (authorized(account, owner) && (await bound(runtime, account, owner)))
      accounts.push(account);
  return {
    available: true,
    cloud: cloudState,
    accounts: [
      ...cloudAccounts,
      ...accounts
        .filter((a) => authorized(a, owner))
        .map((a) => ({
          accountId: a.id,
          accountRevision: accountRevision(a),
          label: a.label ?? a.displayHandle ?? 'Selected Google account',
          kinds: [
            ...(capabilities(a).includes('gmail.read') ? ['email'] : []),
            ...(capabilities(a).includes('calendar.read') ? ['calendar'] : []),
          ],
        }))
        .filter((a) => a.kinds.length > 0),
    ],
  };
}
export async function assertHostedGoogleSource(
  runtime: IAgentRuntime,
  owner: string,
  input: HostedGoogleSelection,
  validUntil?: number
) {
  const selected = validateHostedGoogleSelection(input);
  if (selected.accountId.startsWith('cloud:')) {
    const cloud = cloudService(runtime);
    if (!cloud) unavailable();
    const proof = await cloud.selected(
      owner,
      selected.accountId,
      selected.accountRevision,
      selected.kind
    );
    if (
      validUntil !== undefined &&
      (!Number.isFinite(validUntil) || validUntil > proof.grant.expiresAt)
    )
      unavailable();
    return selected;
  }
  const account = await getConnectorAccountManager(runtime).getAccount(
    'google',
    selected.accountId
  );
  if (
    !authorized(account, owner) ||
    !(await bound(runtime, account, owner)) ||
    accountRevision(account) !== selected.accountRevision ||
    !capabilities(account).includes(selected.kind === 'email' ? 'gmail.read' : 'calendar.read') ||
    !runtime.getService('google')
  )
    unavailable();
  return selected;
}
function text(value: unknown, max: number) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}
export async function readHostedGoogleSource(
  runtime: IAgentRuntime,
  owner: string,
  input: HostedGoogleSelection,
  options: { now?: number; signal?: AbortSignal } = {}
) {
  const selected = await assertHostedGoogleSource(runtime, owner, input);
  if (options.signal?.aborted) unavailable();
  const now = options.now ?? Date.now();
  const service = runtime.getService('google') as unknown as GoogleReads;
  const operation = selected.accountId.startsWith('cloud:')
    ? cloudService(runtime)!.read(owner, selected, now)
    : selected.kind === 'email'
      ? service.searchMessages({
          accountId: selected.accountId,
          query: `in:inbox after:${Math.floor((now - selected.windowHours * 3600000) / 1000)}`,
          limit: selected.maxItems,
        })
      : service.listEventPage({
          accountId: selected.accountId,
          calendarId: selected.calendarId!,
          timeMin: new Date(now).toISOString(),
          timeMax: new Date(now + selected.windowHours * 3600000).toISOString(),
          maxResults: selected.maxItems,
          singleEvents: true,
          orderBy: 'startTime',
        });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: Awaited<typeof operation>;
  try {
    result = await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new WorkflowApiError('Hosted Google read timed out', 504)),
          30000
        );
      }),
    ]);
  } catch {
    unavailable();
  } finally {
    clearTimeout(timer);
  }
  await assertHostedGoogleSource(runtime, owner, selected);
  if (options.signal?.aborted) unavailable();
  const rows = Array.isArray(result) ? result : result.events;
  if (!Array.isArray(rows) || rows.length > selected.maxItems) unavailable();
  const projectText = (value: unknown, max: number) => {
    if (typeof value === 'string' && value.length > max)
      throw new WorkflowApiError('Selected Google input exceeds the reviewed field limit', 422);
    return typeof value === 'string' ? value : '';
  };
  const items = rows.map((row) =>
    selected.kind === 'email'
      ? {
          id: projectText(row.id, 256),
          subject: projectText('subject' in row ? row.subject : '', 256),
          snippet: projectText('snippet' in row ? row.snippet : '', 512),
          receivedAt: projectText('receivedAt' in row ? row.receivedAt : '', 64),
        }
      : {
          id: projectText(row.id, 256),
          title: projectText('title' in row ? row.title : '', 256),
          start: projectText('start' in row ? row.start : '', 64),
          end: projectText('end' in row ? row.end : '', 64),
          status: projectText('status' in row ? row.status : '', 32),
        }
  );
  const observedAt = new Date(Date.now()).toISOString();
  const projection = {
    sourceType: 'live_selected_google_read',
    kind: selected.kind,
    observedAt,
    accountId: selected.accountId,
    ...(selected.calendarId ? { calendarId: selected.calendarId } : {}),
    windowHours: selected.windowHours,
    scope:
      selected.kind === 'email'
        ? 'inbox metadata and snippets only; no message bodies'
        : 'selected calendar events only',
    possiblyTruncated:
      rows.length >= selected.maxItems || (!Array.isArray(result) && !!result.nextPageToken),
    items,
  };
  const encoded = JSON.stringify(projection);
  // The selected input is model context: never drop rows or shorten fields to
  // fit the typed Read envelope. Fail explicitly so the owner can revise scope.
  if (encoded.length > 6000 || Buffer.byteLength(encoded, 'utf8') > 12000)
    throw new WorkflowApiError('Selected Google input exceeds the reviewed transfer limit', 422);
  return { observedAt, text: encoded };
}

/** Calendar names are read only after the owner explicitly chooses an account. */
export async function listHostedGoogleCalendars(
  runtime: IAgentRuntime,
  owner: string,
  input: unknown
) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) unavailable();
  const v = input as Record<string, unknown>;
  if (Object.keys(v).some((key) => !['accountId', 'accountRevision'].includes(key))) unavailable();
  const selected = validateHostedGoogleSelection({
    provider: 'google',
    accountId: v.accountId,
    accountRevision: v.accountRevision,
    kind: 'calendar',
    calendarId: 'calendar-list',
    windowHours: 1,
    maxItems: 1,
  });
  await assertHostedGoogleSource(runtime, owner, selected);
  const service = runtime.getService('google') as unknown as GoogleReads;
  let page: Awaited<ReturnType<GoogleReads['listCalendarPage']>>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    page = await Promise.race([
      selected.accountId.startsWith('cloud:')
        ? cloudService(runtime)!.calendars(owner, selected.accountId, selected.accountRevision)
        : service.listCalendarPage({
            accountId: selected.accountId,
            maxResults: 50,
            minAccessRole: 'reader',
          }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Read timeout')), 30000);
      }),
    ]);
  } catch {
    unavailable();
  } finally {
    clearTimeout(timer);
  }
  await assertHostedGoogleSource(runtime, owner, selected);
  if (!Array.isArray(page.calendars) || page.calendars.length > 50) unavailable();
  return {
    calendars: page.calendars
      .filter((calendar) => identity(calendar.calendarId) && calendar.calendarId !== 'primary')
      .map((calendar) => ({
        calendarId: calendar.calendarId,
        label: text(calendar.summary, 200) || calendar.calendarId,
        timeZone: text(calendar.timeZone, 100),
      })),
    truncated: !!page.nextPageToken,
  };
}

import type { IAgentRuntime } from '@elizaos/core';
import { WorkflowApiError } from '../types/index';
import { digestKeys, digestRecord, digestText } from './hosted-digest';

export interface HostedNativeSelection {
  provider: 'native';
  ownerId: string;
  agentId: string;
  installationId: string;
  enrollmentId: string;
  sourceId: string;
  revision: string;
}
type NativeSourceReader = (request: Record<string, unknown>) => Promise<unknown>;
// One physical app IPC connector, installed by trusted process bootstrap. It
// captures no owner, agent, grant or snapshot. Each call below validates the
// invoking runtime's agent and enrolled owner before the native host rechecks
// its current physical connection and durable grant.
let nativeReader: NativeSourceReader | undefined;
/** Trusted app bootstrap only. Neither a route nor a workflow supplies this callback. */
export function hostedNativeSourcesAvailable(): boolean {
  return nativeReader !== undefined;
}
export function configureHostedNativeSourceReader(reader: NativeSourceReader): void {
  if (nativeReader) throw new Error('Native source reader already configured');
  nativeReader = reader;
}
export function validateHostedNativeSelection(value: unknown): HostedNativeSelection {
  const v = digestRecord(value);
  digestKeys(v, [
    'provider',
    'ownerId',
    'agentId',
    'installationId',
    'enrollmentId',
    'sourceId',
    'revision',
  ]);
  if (v.provider !== 'native') throw new WorkflowApiError('Invalid native source provider', 400);
  const selected = {
    provider: 'native' as const,
    ownerId: digestText(v.ownerId, 256),
    agentId: digestText(v.agentId, 256),
    installationId: digestText(v.installationId, 256),
    enrollmentId: digestText(v.enrollmentId, 256),
    sourceId: digestText(v.sourceId, 256),
    revision: digestText(v.revision, 64),
  };
  if (!/^[a-f0-9]{64}$/.test(selected.revision))
    throw new WorkflowApiError('Invalid native source revision', 400);
  return selected;
}
export async function assertHostedNativeSource(
  runtime: IAgentRuntime,
  owner: string,
  selected: HostedNativeSelection,
  expiry = Date.now()
): Promise<Record<string, unknown>> {
  if (!nativeReader || selected.ownerId !== owner || selected.agentId !== runtime.agentId)
    throw new WorkflowApiError('Native source host or owner unavailable', 409);
  const bridge = runtime.getService('workflow_device_bridge') as unknown as {
    validateTarget(
      owner: string,
      target: { installationId: string; enrollmentId: string }
    ): Promise<void>;
  } | null;
  if (!bridge) throw new WorkflowApiError('Native enrollment service unavailable', 409);
  await bridge.validateTarget(owner, {
    installationId: selected.installationId,
    enrollmentId: selected.enrollmentId,
  });
  const result = digestRecord(await nativeReader({ ...selected, action: 'describe' }));
  for (const field of [
    'ownerId',
    'agentId',
    'installationId',
    'enrollmentId',
    'sourceId',
    'revision',
  ] as const)
    if (result[field] !== selected[field])
      throw new WorkflowApiError('Native source binding changed', 409);
  if (
    result.version !== 1 ||
    result.provider !== 'native' ||
    result.revoked !== false ||
    !Number.isFinite(Date.parse(String(result.expiresAt))) ||
    Date.parse(String(result.expiresAt)) <= Date.now() ||
    Date.parse(String(result.expiresAt)) < expiry
  )
    throw new WorkflowApiError('Native source consent expired or revoked', 409);
  const scope = digestRecord(result.scope);
  if (scope.modelEgress !== true)
    throw new WorkflowApiError('Native source model egress unavailable', 409);
  return result;
}
export async function readHostedNativeSource(
  runtime: IAgentRuntime,
  owner: string,
  selected: HostedNativeSelection,
  occurrence: string,
  signal: AbortSignal,
  template: 'morning' | 'evening' = 'morning'
) {
  const grant = await assertHostedNativeSource(runtime, owner, selected);
  signal.throwIfAborted();
  // The morning request shape is unchanged; only an evening read names its window.
  const snapshot = digestRecord(
    await nativeReader!({
      ...selected,
      action: 'read',
      occurrence,
      ...(template === 'evening' ? { template } : {}),
    })
  );
  signal.throwIfAborted();
  await assertHostedNativeSource(runtime, owner, selected);
  if (
    snapshot.sourceId !== selected.sourceId ||
    snapshot.sourceRevision !== selected.revision ||
    snapshot.occurrence !== occurrence ||
    !Array.isArray(snapshot.events) ||
    !Array.isArray(snapshot.reminders) ||
    !Number.isFinite(Date.parse(String(snapshot.observedAt))) ||
    (template === 'evening'
      ? snapshot.template !== 'evening'
      : snapshot.template !== undefined && snapshot.template !== 'morning')
  )
    throw new WorkflowApiError('Native source result binding changed', 409);
  // Morning reads list open reminders only; completed-today rows belong to the evening window.
  if (
    snapshot.reminders.some((value) => {
      const status = digestRecord(value).status;
      return status === 'cancelled' || (template !== 'evening' && status === 'completed');
    })
  )
    throw new WorkflowApiError('Native source result exceeds reviewed selection', 409);
  const scope = digestRecord(grant.scope);
  if (
    snapshot.timeZone !== scope.timeZone ||
    Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > 65536
  )
    throw new WorkflowApiError('Native source display scope changed', 409);
  const title = (value: unknown) => {
    if (typeof value !== 'string' || value.length > 1000 || value.includes('\0'))
      throw new WorkflowApiError('Invalid native source title', 409);
    return value;
  };
  if (
    !Array.isArray(scope.calendars) ||
    typeof scope.reminders !== 'boolean' ||
    !Number.isInteger(scope.maximumItems) ||
    Number(scope.maximumItems) < 1 ||
    Number(scope.maximumItems) > 200 ||
    snapshot.events.length + snapshot.reminders.length > Number(scope.maximumItems) ||
    (!scope.calendars.length && snapshot.events.length) ||
    (!scope.reminders && snapshot.reminders.length)
  )
    throw new WorkflowApiError('Native source result exceeds reviewed selection', 409);
  const selectedIds = new Set(
    scope.calendars.map((value) => digestText(digestRecord(value).id, 128))
  );
  if (snapshot.events.some((value) => !selectedIds.has(String(digestRecord(value).calendarId))))
    throw new WorkflowApiError('Native source returned an unselected calendar', 409);
  const summary = {
    timeZone: snapshot.timeZone,
    asOf: digestText(snapshot.asOfDisplay, 200),
    ...(scope.calendars.length
      ? {
          calendar: snapshot.events.map((value) => {
            const event = digestRecord(value);
            return {
              title: title(event.title),
              when: digestText(event.startDisplay, 200),
              ...(event.allDay === true
                ? { allDay: true, through: digestText(event.lastDateDisplay, 200) }
                : { ends: digestText(event.endDisplay, 200) }),
            };
          }),
        }
      : {}),
    ...(scope.reminders
      ? {
          reminders: snapshot.reminders.map((value) => {
            const reminder = digestRecord(value);
            return {
              title: title(reminder.title),
              due: digestText(reminder.dueAtDisplay, 200),
              status: digestText(reminder.status, 40),
            };
          }),
        }
      : {}),
  };
  return {
    text: JSON.stringify(summary),
    observedAt: String(snapshot.observedAt),
    receipt: snapshot,
  };
}

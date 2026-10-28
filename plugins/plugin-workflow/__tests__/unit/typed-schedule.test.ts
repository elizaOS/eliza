import { expect, test } from 'bun:test';
import { computeNextCronRunAtMs } from '@elizaos/core';
import {
  generatePhoneSpec,
  phoneGenerationInput,
} from '../../src/services/phone-workflow-generation';
import {
  PHONE_SPEC_KEY,
  phoneTriggerSchedule,
  phoneWorkflowCatalog,
  storedPhoneTimeTrigger,
  typedScheduleAdmission,
  validatePhoneSpec,
} from '../../src/services/phone-workflow-spec';

const weekdays = {
  kind: 'time' as const,
  localTime: '07:30',
  timeZone: 'America/New_York',
  days: [1, 2, 3, 4, 5],
};
const spec = {
  version: 1,
  name: 'Morning draft',
  description: '',
  trigger: weekdays,
  steps: [
    { id: 'read', kind: 'Read', operation: 'supplied_text', text: 'Agenda' },
    {
      id: 'draft',
      kind: 'Write',
      operation: 'compose_draft',
      source: 'read',
      prefix: 'Today: ',
      suffix: '',
    },
  ],
};

test('the catalog offers the reviewed local-time trigger and keeps provider triggers unavailable', () => {
  const triggers = phoneWorkflowCatalog(false).triggers;
  expect(triggers.slice(0, 2).map((t) => [t.kind, t.available])).toEqual([
    ['manual', true],
    ['time', true],
  ]);
  expect(triggers.slice(2).every((t) => !t.available)).toBe(true);
});

test('typed validation accepts exact time triggers and refuses other schedules as 400s', () => {
  expect(validatePhoneSpec(spec).trigger).toEqual(weekdays);
  for (const trigger of [
    { kind: 'schedule', cron: '0 7 * * *' },
    { ...weekdays, days: [5, 1] },
    { ...weekdays, timeZone: 'Mars/Olympus' },
  ]) {
    let status = 0;
    try {
      validatePhoneSpec({ ...spec, trigger });
    } catch (error) {
      status = (error as { statusCode?: number }).statusCode ?? -1;
    }
    expect(status).toBe(400);
  }
});

test('a stored typed definition yields its schedule only for a readable time trigger', () => {
  expect(storedPhoneTimeTrigger({ [PHONE_SPEC_KEY]: JSON.stringify(spec) })).toEqual(weekdays);
  expect(
    storedPhoneTimeTrigger({
      [PHONE_SPEC_KEY]: JSON.stringify({ ...spec, trigger: { kind: 'manual' } }),
    })
  ).toBeUndefined();
  expect(storedPhoneTimeTrigger({ [PHONE_SPEC_KEY]: '{"version":1,' })).toBeUndefined();
  expect(storedPhoneTimeTrigger(undefined)).toBeUndefined();
  expect(phoneTriggerSchedule(weekdays)).toEqual({
    cron: '30 7 * * 1,2,3,4,5',
    timezone: 'America/New_York',
    enabled: true,
  });
});

test('admission runs exact on-time occurrences and records late ones as missed', () => {
  // Monday 2026-10-26 07:30 in New York (EDT).
  const occurrence = Date.parse('2026-10-26T11:30:00.000Z');
  const ready = typedScheduleAdmission(
    weekdays,
    occurrence,
    occurrence + 90_000,
    computeNextCronRunAtMs
  );
  expect(ready).toEqual({
    scheduledAt: '2026-10-26T11:30:00.000Z',
    trigger: weekdays,
    status: 'ready',
    text: '',
  });
  const missed = typedScheduleAdmission(
    weekdays,
    occurrence,
    occurrence + 3 * 3_600_000,
    computeNextCronRunAtMs
  );
  expect(missed.status).toBe('missed');
  expect(missed.text).toContain('did not run');
  // Not an instant of the reviewed schedule: Sunday, a shifted minute, and a non-integer.
  for (const scheduledAt of [
    Date.parse('2026-10-25T11:30:00.000Z'),
    occurrence + 60_000,
    occurrence + 0.5,
  ])
    expect(() =>
      typedScheduleAdmission(weekdays, scheduledAt, scheduledAt, computeNextCronRunAtMs)
    ).toThrow('does not match');
  // After the November change to EST the same local time is 12:30 UTC.
  const est = Date.parse('2026-11-02T12:30:00.000Z');
  expect(typedScheduleAdmission(weekdays, est, est, computeNextCronRunAtMs).status).toBe('ready');
});

test('generation keeps the owner trigger and never accepts a model-supplied schedule', async () => {
  const input = phoneGenerationInput(
    { prompt: 'Make it shorter', operations: ['supplied_text', 'compose_draft'], existing: spec },
    ['supplied_text', 'compose_draft']
  );
  const prompts: string[] = [];
  const generated = await generatePhoneSpec(input, async (prompt) => {
    prompts.push(prompt);
    return JSON.stringify({ ...spec, trigger: { kind: 'manual' }, name: 'Shorter draft' });
  });
  expect(generated.trigger).toEqual(weekdays);
  expect(generated.name).toBe('Shorter draft');
  // The model sees neither the schedule nor the enrollment.
  expect(prompts[0]).not.toContain('America/New_York');
  const fresh = await generatePhoneSpec(
    phoneGenerationInput({ prompt: 'Draft', operations: ['supplied_text'] }, ['supplied_text']),
    async () =>
      JSON.stringify({
        version: 1,
        name: 'New',
        description: '',
        steps: [{ id: 'a', kind: 'Read', operation: 'supplied_text', text: 'x' }],
      })
  );
  expect(fresh.trigger).toEqual({ kind: 'manual' });
  await expect(
    generatePhoneSpec(input, async () => JSON.stringify({ ...spec, trigger: weekdays }))
  ).rejects.toThrow('supplied a schedule');
});

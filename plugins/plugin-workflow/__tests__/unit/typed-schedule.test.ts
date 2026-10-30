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

test('a reviewed local time skipped by a spring-forward transition is recorded as missed', () => {
  const daily = { ...weekdays, localTime: '02:30', days: [0, 1, 2, 3, 4, 5, 6] };
  // 2026-03-08 is the America/New_York spring-forward date: 02:00 EST jumps to 03:00 EDT.
  // The durable scheduler fires the skipped 02:30 one gap later, at 03:30 EDT (07:30Z).
  const shifted = Date.parse('2026-03-08T07:30:00Z');
  expect(
    computeNextCronRunAtMs('30 2 * * *', Date.parse('2026-03-07T12:00:00Z'), daily.timeZone)
  ).toBe(shifted);
  const skippedText =
    '02:30 did not occur on 2026-03-08 in America/New_York because the clocks moved forward. This occurrence did not run and will not run later.';
  // On time or late, the shifted occurrence is recorded as missed with the skipped local time; it never runs.
  for (const now of [shifted + 5_000, shifted + 3 * 3_600_000])
    expect(typedScheduleAdmission(daily, shifted, now, computeNextCronRunAtMs)).toEqual({
      scheduledAt: '2026-03-08T07:30:00.000Z',
      trigger: daily,
      status: 'missed',
      skippedLocalTime: '2026-03-08T02:30',
      text: skippedText,
    });
  // The next day's 02:30 exists and runs.
  const nextDay = Date.parse('2026-03-09T06:30:00Z');
  expect(computeNextCronRunAtMs('30 2 * * *', shifted, daily.timeZone)).toBe(nextDay);
  expect(
    typedScheduleAdmission(daily, nextDay, nextDay + 5_000, computeNextCronRunAtMs).status
  ).toBe('ready');
  // The fall-back (repeated hour) date runs its first 01:30 once; a time outside the
  // transition hour and a zone without DST are never skipped.
  const repeated = { ...daily, localTime: '01:30' };
  const firstRepeat = Date.parse('2026-11-01T05:30:00Z');
  expect(
    typedScheduleAdmission(repeated, firstRepeat, firstRepeat + 5_000, computeNextCronRunAtMs)
  ).toMatchObject({ status: 'ready' });
  const morning = Date.parse('2026-03-08T11:30:00Z');
  expect(
    typedScheduleAdmission(
      { ...daily, localTime: '07:30' },
      morning,
      morning + 5_000,
      computeNextCronRunAtMs
    ).status
  ).toBe('ready');
  const utc = Date.parse('2026-03-08T02:30:00Z');
  expect(
    typedScheduleAdmission({ ...daily, timeZone: 'UTC' }, utc, utc + 5_000, computeNextCronRunAtMs)
      .status
  ).toBe('ready');
  // Southern hemisphere: Pacific/Auckland skips 02:00-03:00 on 2026-09-27; 02:30 fires at 03:30 NZDT.
  const auckland = { ...daily, timeZone: 'Pacific/Auckland' };
  const aucklandShifted = computeNextCronRunAtMs(
    '30 2 * * *',
    Date.parse('2026-09-26T12:00:00Z'),
    auckland.timeZone
  )!;
  expect(new Date(aucklandShifted).toISOString()).toBe('2026-09-26T14:30:00.000Z');
  expect(
    typedScheduleAdmission(auckland, aucklandShifted, aucklandShifted, computeNextCronRunAtMs)
  ).toMatchObject({ status: 'missed', skippedLocalTime: '2026-09-27T02:30' });
});

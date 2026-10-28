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
  skippedTypedOccurrences,
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
  const nextDay = Date.parse('2026-03-09T06:30:00Z'); // 02:30 EDT on 2026-03-09
  expect(
    computeNextCronRunAtMs('30 2 * * *', Date.parse('2026-03-07T12:00:00Z'), daily.timeZone)
  ).toBe(nextDay);
  const armedBefore = Date.parse('2026-03-01T00:00:00Z');
  expect(skippedTypedOccurrences(daily, nextDay, armedBefore)).toEqual([
    {
      scheduledAt: '2026-03-08T07:30:00.000Z',
      trigger: daily,
      status: 'missed',
      skippedLocalTime: '2026-03-08T02:30',
      text: '02:30 did not occur on 2026-03-08 in America/New_York because the clocks moved forward. This occurrence did not run and will not run later.',
    },
  ]);
  // Armed after the skipped time: nothing to record.
  expect(skippedTypedOccurrences(daily, nextDay, Date.parse('2026-03-08T12:00:00Z'))).toEqual([]);
  // A day whose local time existed, and the fall-back (repeated hour) date, record nothing.
  expect(skippedTypedOccurrences(daily, Date.parse('2026-03-10T06:30:00Z'), armedBefore)).toEqual(
    []
  );
  expect(skippedTypedOccurrences(daily, Date.parse('2026-11-02T07:30:00Z'), armedBefore)).toEqual(
    []
  );
  // Times outside the transition hour and zones without DST never skip.
  expect(
    skippedTypedOccurrences(
      { ...daily, localTime: '07:30' },
      Date.parse('2026-03-09T11:30:00Z'),
      armedBefore
    )
  ).toEqual([]);
  expect(
    skippedTypedOccurrences(
      { ...daily, timeZone: 'UTC' },
      Date.parse('2026-03-09T02:30:00Z'),
      armedBefore
    )
  ).toEqual([]);
  // A weekly trigger looks back past the days it does not run on to the skipped Sunday.
  const sundaysAndWednesdays = { ...daily, days: [0, 3] };
  expect(
    skippedTypedOccurrences(
      sundaysAndWednesdays,
      Date.parse('2026-03-11T06:30:00Z'),
      armedBefore
    ).map((o) => o.skippedLocalTime)
  ).toEqual(['2026-03-08T02:30']);
  // Southern hemisphere: Pacific/Auckland skips 02:00-03:00 on 2026-09-27.
  const auckland = { ...daily, timeZone: 'Pacific/Auckland' };
  expect(
    skippedTypedOccurrences(auckland, Date.parse('2026-09-27T13:30:00Z'), armedBefore).map((o) => [
      o.skippedLocalTime,
      o.scheduledAt,
    ])
  ).toEqual([['2026-09-27T02:30', '2026-09-26T14:30:00.000Z']]);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isPhoneWorkflowLocalDay,
  phoneTriggerClockChangeNote,
  phoneWorkflowLocalDay,
  phoneWorkflowLocalDayBounds,
  phoneWorkflowOperationProtocol,
  phoneWorkflowRequiredProtocol,
  phoneWorkflowUsesDevice,
  validatePhoneWorkflowSpec,
  zoneOffsetMinutes,
} from "./phone-workflow.ts";
import {
  assertWorkflowOperation,
  parseWorkflowBinding,
  parseWorkflowPhoneReview,
  parseWorkflowRead,
  parseWorkflowReminderRead,
  validateWorkflowReadResult,
  type WorkflowPhoneReview,
  type WorkflowReminderReadOperation,
  workflowApprovalNotice,
  workflowCalendarRangeFitsLocalDays,
  workflowReminderDayIsCurrent,
  workflowSha,
} from "./workflow-device.ts";

const rejects = async (fn: () => unknown) => {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
};
const device = { installationId: "install-1", enrollmentId: "enroll-1" };
const scope = {
  window: "open_and_completed_today" as const,
  timeZone: "America/Los_Angeles",
  maximumItems: 3,
};
const spec = {
  device,
  version: 1 as const,
  name: "Evening reminders",
  description: "",
  trigger: { kind: "manual" as const },
  steps: [
    {
      id: "reminders",
      kind: "Read" as const,
      operation: "selected_reminders" as const,
      scope,
    },
    {
      id: "notify",
      kind: "Notify" as const,
      operation: "app_notification" as const,
      source: "reminders",
      title: "Today",
    },
  ],
};

test("a selected-reminders step is a reviewed device read with protocol 3", () => {
  const canonical = validatePhoneWorkflowSpec(spec);
  assert.deepEqual(canonical.steps[0], spec.steps[0]);
  assert.equal(phoneWorkflowUsesDevice(canonical), true);
  assert.equal(phoneWorkflowOperationProtocol("selected_reminders"), 3);
  assert.equal(phoneWorkflowOperationProtocol("app_notification"), 2);
  assert.equal(phoneWorkflowOperationProtocol("selected_notes"), 1);
  assert.equal(phoneWorkflowRequiredProtocol(canonical), 3);
  const bad = (step: Record<string, unknown>) =>
    assert.throws(() =>
      validatePhoneWorkflowSpec({
        ...spec,
        steps: [{ ...spec.steps[0], ...step }],
      }),
    );
  bad({ scope: { ...scope, window: "all_reminders" } });
  bad({ scope: { ...scope, timeZone: "Not/AZone" } });
  bad({ scope: { ...scope, maximumItems: 201 } });
  bad({ scope: { ...scope, maximumItems: 0 } });
  bad({ scope: { ...scope, day: "2026-10-08" } });
  bad({ scope: { ...scope, includeNotes: true } });
  bad({ notes: [] });
  // Without a verified enrollment the device read is refused.
  assert.throws(() =>
    validatePhoneWorkflowSpec({ ...spec, device: undefined }),
  );
});

test("owner-day bounds follow the reviewed zone across DST", () => {
  assert.equal(isPhoneWorkflowLocalDay("2026-02-30"), false);
  assert.equal(isPhoneWorkflowLocalDay("2026-10-08"), true);
  const la = phoneWorkflowLocalDayBounds("2026-10-08", "America/Los_Angeles");
  assert.equal(new Date(la.start).toISOString(), "2026-10-08T07:00:00.000Z");
  assert.equal(new Date(la.end).toISOString(), "2026-10-09T07:00:00.000Z");
  // Spring forward: a 23-hour day. Fall back: a 25-hour day.
  const spring = phoneWorkflowLocalDayBounds("2027-03-14", "America/New_York");
  assert.equal(spring.end - spring.start, 23 * 3_600_000);
  const autumn = phoneWorkflowLocalDayBounds("2026-11-01", "America/New_York");
  assert.equal(autumn.end - autumn.start, 25 * 3_600_000);
  assert.equal(
    new Date(autumn.start).toISOString(),
    "2026-11-01T04:00:00.000Z",
  );
  // A zone that skipped a whole day (Samoa, 2011-12-30) still yields ordered bounds.
  const samoa = phoneWorkflowLocalDayBounds("2011-12-31", "Pacific/Apia");
  assert.ok(samoa.end > samoa.start);
  assert.equal(
    phoneWorkflowLocalDay(Date.UTC(2026, 9, 8, 6, 59), "America/Los_Angeles"),
    "2026-10-07",
  );
  assert.equal(
    phoneWorkflowLocalDay(Date.UTC(2026, 9, 8, 7, 0), "America/Los_Angeles"),
    "2026-10-08",
  );
  assert.equal(zoneOffsetMinutes(Date.UTC(2026, 0, 1), "Asia/Kolkata"), 330);
  assert.throws(() => phoneWorkflowLocalDayBounds("2026-10-08", "Not/AZone"));
});

test("a scheduled time skipped by a forward clock change is named in the review text", () => {
  const now = Date.UTC(2027, 0, 15, 12);
  const note = (
    localTime: string,
    timeZone: string,
    days = [0, 1, 2, 3, 4, 5, 6],
  ) =>
    phoneTriggerClockChangeNote(
      { kind: "time", localTime, timeZone, days },
      now,
    );
  assert.equal(
    note("02:30", "America/New_York"),
    "On 2027-03-14 the clock in America/New_York moves forward from 02:00 to 03:00, so 02:30 does not occur and this workflow does not run that day.",
  );
  assert.match(
    note("02:00", "America/New_York"),
    /^On 2027-03-14 .* so 02:00 does not occur/,
  );
  assert.equal(note("03:00", "America/New_York"), "");
  assert.equal(note("01:45", "America/New_York"), "");
  assert.equal(note("02:30", "America/New_York", [1, 2, 3, 4, 5]), "");
  assert.equal(note("01:30", "America/New_York"), "");
  assert.equal(note("02:30", "UTC"), "");
  assert.equal(
    note("01:15", "Europe/London"),
    "On 2027-03-28 the clock in Europe/London moves forward from 01:00 to 02:00, so 01:15 does not occur and this workflow does not run that day.",
  );
  assert.equal(note("02:30", "Not/AZone"), "");
});

const row = async (
  id: string,
  title: string,
  dueAt: string,
  status: "open" | "completed",
  completedAt?: string,
) => ({
  id,
  revision: await workflowSha([id, title, dueAt, status, completedAt ?? null]),
  title,
  dueAt,
  status,
  ...(completedAt ? { completedAt } : {}),
});

test("selected reminder reads stay inside the reviewed owner-day window", async () => {
  const op = parseWorkflowReminderRead({
    type: "read_selected_reminders",
    ...scope,
    day: "2026-10-08",
  }) as WorkflowReminderReadOperation;
  assert.deepEqual(parseWorkflowRead(op), op);
  assert.equal(
    await rejects(() =>
      parseWorkflowReminderRead({ ...op, window: "all_reminders" }),
    ),
    true,
  );
  assert.equal(
    await rejects(() =>
      parseWorkflowReminderRead({ ...op, day: "2026-02-30" }),
    ),
    true,
  );
  assert.equal(
    await rejects(() => parseWorkflowReminderRead({ ...op, body: true })),
    true,
  );
  assert.equal(
    await rejects(() =>
      parseWorkflowReminderRead({ ...op, maximumItems: 1.5 }),
    ),
    true,
  );
  const open = await row("open", "Overdue", "2026-10-07T16:00:00.000Z", "open");
  const done = await row(
    "done",
    "Done today",
    "2026-10-08T15:00:00.000Z",
    "completed",
    "2026-10-08T20:00:00.000Z",
  );
  const result = await validateWorkflowReadResult(op, {
    kind: "reminders",
    reminders: [open, done],
  });
  assert.equal(result.kind, "reminders");
  assert.deepEqual(
    result.kind === "reminders" && result.reminders.map((r) => r.id),
    ["open", "done"],
  );
  const check = (reminders: unknown[]) =>
    rejects(() =>
      validateWorkflowReadResult(op, { kind: "reminders", reminders }),
    );
  // Due after the owner day ends.
  assert.equal(
    await check([
      await row("later", "Tomorrow", "2026-10-09T07:00:00.000Z", "open"),
    ]),
    true,
  );
  // Due at the last instant of the owner day is included.
  assert.equal(
    await check([
      await row("late", "Late", "2026-10-09T06:59:59.999Z", "open"),
    ]),
    false,
  );
  // Completed before the owner day began.
  assert.equal(
    await check([
      await row(
        "old",
        "Yesterday",
        "2026-10-07T15:00:00.000Z",
        "completed",
        "2026-10-08T06:59:59.000Z",
      ),
    ]),
    true,
  );
  assert.equal(await check([{ ...open, title: "Changed" }]), true);
  assert.equal(await check([{ ...open, body: "secret" }]), true);
  assert.equal(await check([open, done, open, done]), true);
  assert.equal(await check([open, open]), true);
  assert.equal(await check([{ ...open, status: "snoozed" }]), true);
});

test("a reminder read names only the current owner day", () => {
  const op = { day: "2026-10-08", timeZone: "America/Los_Angeles" };
  assert.equal(
    workflowReminderDayIsCurrent(op, Date.UTC(2026, 9, 8, 18)),
    true,
  );
  // Ten minutes after local midnight, a request raised just before it is still current.
  assert.equal(
    workflowReminderDayIsCurrent(op, Date.UTC(2026, 9, 9, 7, 10)),
    true,
  );
  assert.equal(
    workflowReminderDayIsCurrent(op, Date.UTC(2026, 9, 9, 8)),
    false,
  );
  assert.equal(
    workflowReminderDayIsCurrent(op, Date.UTC(2026, 9, 8, 6)),
    false,
  );
});

test("notes and calendar reads keep their exact selected scopes", async () => {
  const noteRevision = await workflowSha(["Title", "Body"]);
  const notes = parseWorkflowRead({
    type: "read_selected_notes",
    notes: [{ id: "note-1", revision: noteRevision }],
  });
  assert.deepEqual(
    await validateWorkflowReadResult(notes, {
      kind: "notes",
      notes: [
        { id: "note-1", revision: noteRevision, title: "Title", text: "Body" },
      ],
    }),
    {
      kind: "notes",
      notes: [
        { id: "note-1", revision: noteRevision, title: "Title", text: "Body" },
      ],
    },
  );
  assert.equal(
    await rejects(() =>
      validateWorkflowReadResult(notes, {
        kind: "notes",
        notes: [
          {
            id: "note-1",
            revision: noteRevision,
            title: "Title",
            text: "Edited",
          },
        ],
      }),
    ),
    true,
  );
  assert.equal(
    await rejects(() =>
      parseWorkflowRead({
        type: "read_selected_notes",
        notes: [
          { id: "a", revision: noteRevision },
          { id: "a", revision: noteRevision },
        ],
      }),
    ),
    true,
  );
  const range = parseWorkflowRead({
    type: "read_calendar_range",
    calendarIds: ["cal.primary"],
    start: "2026-10-08T07:00:00.000Z",
    end: "2026-10-09T07:00:00.000Z",
    timeZone: "America/Los_Angeles",
    maximumEvents: 2,
  });
  const event = {
    id: "evt:1",
    calendarId: "cal.primary",
    title: "Standup",
    start: "2026-10-08T16:00:00.000Z",
    end: "2026-10-08T16:15:00.000Z",
    allDay: false,
  };
  const revision = await workflowSha([
    event.id,
    event.calendarId,
    event.title,
    event.start,
    event.end,
    event.allDay,
  ]);
  const calendar = await validateWorkflowReadResult(range, {
    kind: "calendar",
    events: [{ ...event, revision }],
  });
  assert.equal(calendar.kind === "calendar" && calendar.events.length, 1);
  assert.equal(
    await rejects(() =>
      validateWorkflowReadResult(range, {
        kind: "calendar",
        events: [{ ...event, calendarId: "other", revision }],
      }),
    ),
    true,
  );
  // Seven local days across the autumn change are 7 days and 1 hour long.
  assert.equal(
    workflowCalendarRangeFitsLocalDays(
      "2026-10-30T04:00:00.000Z",
      "2026-11-06T05:00:00.000Z",
      "America/New_York",
    ),
    true,
  );
  assert.equal(
    workflowCalendarRangeFitsLocalDays(
      "2026-10-30T04:00:00.000Z",
      "2026-11-06T05:00:01.000Z",
      "America/New_York",
    ),
    false,
  );
});

async function reviewFixture() {
  const canonical = validatePhoneWorkflowSpec(spec);
  const specDigest = await workflowSha(canonical);
  const raw = {
    runId: "run-1",
    workflowId: "wf-1",
    versionId: "ver-1",
    specDigest,
    spec: canonical,
    status: "running",
    finished: false,
    cancellationRequestedAt: null,
  };
  const expected = { id: "run-1", workflowId: "wf-1", versionId: "ver-1" };
  return { raw, expected, specDigest };
}

test("a forged or swapped phone review is refused", async () => {
  const { raw, expected } = await reviewFixture();
  const review = await parseWorkflowPhoneReview(raw, expected);
  assert.equal(review.spec.device.installationId, "install-1");
  for (const forged of [
    { ...raw, runId: "run-2" },
    { ...raw, versionId: "ver-2" },
    { ...raw, workflowId: "wf-2" },
    { ...raw, specDigest: "b".repeat(64) },
    // A widened scope no longer matches the reviewed digest.
    {
      ...raw,
      spec: {
        ...raw.spec,
        steps: [
          { ...raw.spec.steps[0], scope: { ...scope, maximumItems: 200 } },
          raw.spec.steps[1],
        ],
      },
    },
    { ...raw, spec: { ...raw.spec, device: undefined } },
    { ...raw, finished: "no" },
  ])
    assert.equal(
      await rejects(() => parseWorkflowPhoneReview(forged, expected)),
      true,
    );
});

test("a step request must match the reviewed run, version, digest, device and scope", async () => {
  const { raw, expected, specDigest } = await reviewFixture();
  const review: WorkflowPhoneReview = await parseWorkflowPhoneReview(
    raw,
    expected,
  );
  const binding = parseWorkflowBinding({
    workflowId: "wf-1",
    versionId: "ver-1",
    runId: "run-1",
    stepId: "reminders",
    specDigest,
  });
  const now = Date.UTC(2026, 9, 8, 18);
  const op = { type: "read_selected_reminders", ...scope, day: "2026-10-08" };
  assertWorkflowOperation(review, binding, device, op, now);
  const refused = (changes: {
    review?: Partial<WorkflowPhoneReview>;
    binding?: Record<string, string>;
    target?: Record<string, string>;
    operation?: Record<string, unknown>;
    at?: number;
  }) =>
    rejects(() =>
      assertWorkflowOperation(
        { ...review, ...changes.review },
        { ...binding, ...changes.binding },
        { ...device, ...changes.target },
        { ...op, ...changes.operation },
        changes.at ?? now,
      ),
    );
  assert.equal(await refused({ operation: { maximumItems: 200 } }), true);
  assert.equal(await refused({ operation: { timeZone: "UTC" } }), true);
  assert.equal(await refused({ operation: { day: "2026-10-01" } }), true);
  assert.equal(await refused({ at: Date.UTC(2026, 9, 10) }), true);
  assert.equal(
    await refused({ operation: { type: "read_selected_notes" } }),
    true,
  );
  assert.equal(await refused({ binding: { runId: "run-2" } }), true);
  assert.equal(await refused({ binding: { versionId: "ver-2" } }), true);
  assert.equal(
    await refused({ binding: { specDigest: "c".repeat(64) } }),
    true,
  );
  assert.equal(await refused({ binding: { stepId: "missing" } }), true);
  assert.equal(await refused({ target: { enrollmentId: "enroll-2" } }), true);
  assert.equal(await refused({ review: { finished: true } }), true);
  assert.equal(
    await refused({
      review: { cancellationRequestedAt: "2026-10-08T18:00:00.000Z" },
    }),
    true,
  );
  const notify = { ...binding, stepId: "notify" };
  assertWorkflowOperation(
    review,
    notify,
    device,
    { type: "post_notification", title: "Today", body: "2 reminders" },
    now,
  );
  assert.equal(
    await rejects(() =>
      assertWorkflowOperation(
        review,
        notify,
        device,
        { type: "post_notification", title: "Other", body: "x" },
        now,
      ),
    ),
    true,
  );
  assert.equal(
    await rejects(() =>
      assertWorkflowOperation(
        review,
        notify,
        device,
        {
          type: "post_notification",
          title: "Today",
          body: "x",
          url: "https://example.com",
        },
        now,
      ),
    ),
    true,
  );
});

test("approval notice identity is the shared opaque route identity", async () => {
  const route = {
    scope: "workflow",
    origin: "https://agent.example",
    ownerId: "owner",
    agentId: "agent",
    workflowId: "wf-1",
    runId: "run-1",
    versionId: "ver-1",
  };
  const first = await workflowApprovalNotice(route as never, "proposal-1");
  const second = await workflowApprovalNotice(
    { ...route, runId: "run-2" } as never,
    "proposal-1",
  );
  assert.match(first.id, /^approval-[a-f0-9]{64}$/);
  assert.notEqual(first.id, second.id);
  assert.equal(first.id.includes("wf-1"), false);
});

test("WorkflowClient.phoneReview reads the run's review route and binds it to the run", async () => {
  const { WorkflowClient } = await import("./workflow-client.ts");
  const { raw } = await reviewFixture();
  const paths: string[] = [];
  const client = new WorkflowClient(async (path) => {
    paths.push(path);
    return raw;
  });
  const signal = new AbortController().signal;
  const review = await client.phoneReview(
    { id: "run-1", workflowId: "wf-1", versionId: "ver-1" },
    signal,
  );
  assert.equal(review.specDigest, raw.specDigest);
  assert.deepEqual(paths, ["/api/workflow/executions/run-1/phone-review"]);
  await assert.rejects(
    client.phoneReview(
      { id: "run-1", workflowId: "wf-1", versionId: "ver-9" },
      signal,
    ),
  );
});

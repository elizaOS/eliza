import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertPhoneWorkflowCapabilities,
  describePhoneWorkflowTrigger,
  PHONE_WORKFLOW_MAX_SPEC_BYTES,
  PhoneWorkflowSpecError,
  parsePhoneScheduledOccurrence,
  parsePhoneWorkflowCatalog,
  parsePhoneWorkflowSaveReceipt,
  phoneTimeTriggerCron,
  phoneWorkflowBytes,
  phoneWorkflowUsesDevice,
  validatePhoneWorkflowSpec,
  validatePhoneWorkflowTrigger,
} from "./phone-workflow.ts";

const base = {
  version: 1,
  name: "Morning draft",
  description: "",
  trigger: { kind: "manual" },
  steps: [
    { id: "read", kind: "Read", operation: "supplied_text", text: "x" },
    {
      id: "draft",
      kind: "Write",
      operation: "compose_draft",
      source: "read",
      prefix: "",
      suffix: "",
    },
  ],
};
const weekdays = {
  kind: "time",
  localTime: "07:30",
  timeZone: "America/New_York",
  days: [1, 2, 3, 4, 5],
};
const message = (task: () => unknown) => {
  try {
    task();
    return "";
  } catch (error) {
    assert.ok(error instanceof PhoneWorkflowSpecError);
    return (error as Error).message;
  }
};

test("manual and reviewed local-time triggers are the only trigger shapes", () => {
  assert.deepEqual(validatePhoneWorkflowSpec(base).trigger, { kind: "manual" });
  const scheduled = validatePhoneWorkflowSpec({ ...base, trigger: weekdays });
  assert.deepEqual(scheduled.trigger, weekdays);
  assert.notEqual(scheduled.trigger, weekdays);
  for (const trigger of [
    { kind: "schedule", cron: "0 7 * * *" },
    { kind: "cron", expression: "* * * * *" },
    { kind: "event" },
    { kind: "location", place: "home" },
  ])
    assert.equal(
      message(() => validatePhoneWorkflowSpec({ ...base, trigger })),
      "This workflow trigger is unavailable",
    );
  for (const trigger of [
    { kind: "time", t: 7 },
    { ...weekdays, localTime: "7:30" },
    { ...weekdays, localTime: "24:00" },
    { ...weekdays, timeZone: "PST8PDT-not-a-zone" },
    { ...weekdays, timeZone: "" },
    { ...weekdays, days: [] },
    { ...weekdays, days: [5, 1] },
    { ...weekdays, days: [1, 1] },
    { ...weekdays, days: [7] },
    { ...weekdays, days: [1.5] },
    { ...weekdays, days: [0, 1, 2, 3, 4, 5, 6, 6] },
  ])
    assert.equal(
      message(() => validatePhoneWorkflowSpec({ ...base, trigger })),
      trigger.kind === "time" && "t" in trigger
        ? "Unsupported workflow field"
        : "Choose a local time, a valid time zone and at least one day",
      JSON.stringify(trigger),
    );
  assert.equal(
    message(() =>
      validatePhoneWorkflowSpec({
        ...base,
        trigger: { kind: "manual", cron: "x" },
      }),
    ),
    "Unsupported workflow field",
  );
  assert.equal(
    message(() => validatePhoneWorkflowSpec({ ...base, trigger: undefined })),
    "Choose when this workflow runs",
  );
});

test("the normalizer keeps step, scope, size and enrollment bounds", () => {
  assert.equal(
    message(() =>
      validatePhoneWorkflowSpec({
        ...base,
        steps: Array.from({ length: 33 }, (_, index) => ({
          id: `s${index}`,
          kind: "Read",
          operation: "supplied_text",
          text: "x",
        })),
      }),
    ),
    "Add between 1 and 32 steps",
  );
  assert.equal(
    message(() =>
      validatePhoneWorkflowSpec({
        ...base,
        steps: [{ ...base.steps[1], source: "later" }, base.steps[0]],
      }),
    ),
    "Choose an earlier step as the input",
  );
  assert.equal(
    message(() =>
      validatePhoneWorkflowSpec({
        ...base,
        steps: [
          ...base.steps,
          {
            id: "send",
            kind: "Send",
            operation: "send_email",
            source: "draft",
          },
        ],
      }),
    ),
    "This workflow operation is unavailable",
  );
  const notify = {
    ...base,
    steps: [
      ...base.steps,
      {
        id: "notice",
        kind: "Notify",
        operation: "app_notification",
        source: "draft",
        title: "Result",
      },
    ],
  };
  assert.equal(
    message(() => validatePhoneWorkflowSpec(notify)),
    "A verified phone enrollment is required",
  );
  const device = { installationId: "install-1", enrollmentId: "enroll-1" };
  const enrolled = validatePhoneWorkflowSpec({ ...notify, device });
  assert.deepEqual(enrolled.device, device);
  assert.equal(phoneWorkflowUsesDevice(enrolled), true);
  assert.equal(phoneWorkflowUsesDevice(validatePhoneWorkflowSpec(base)), false);
  assert.equal(
    message(() =>
      validatePhoneWorkflowSpec({
        ...base,
        description: "x".repeat(PHONE_WORKFLOW_MAX_SPEC_BYTES),
      }),
    ),
    "Workflow draft exceeds 64 KiB",
  );
  assert.equal(
    message(() =>
      validatePhoneWorkflowSpec({
        ...base,
        device,
        steps: [
          {
            id: "calendar",
            kind: "Read",
            operation: "calendar_range",
            range: {
              calendarIds: ["7"],
              start: "2026-10-27T00:00:00.000Z",
              end: "2026-11-04T00:00:00.000Z",
              timeZone: "UTC",
              maximumEvents: 10,
            },
          },
        ],
      }),
    ),
    "Choose distinct calendars and a range of at most 7 days",
  );
  // A description of the byte limit uses UTF-8, as both the phone and the agent measure it.
  assert.equal(phoneWorkflowBytes({ text: "界" }), 14);
});

test("time triggers compile to a cron in their own zone and describe themselves", () => {
  assert.equal(phoneTimeTriggerCron(weekdays as never), "30 7 * * 1,2,3,4,5");
  assert.equal(
    phoneTimeTriggerCron({ ...weekdays, days: [0, 1, 2, 3, 4, 5, 6] } as never),
    "30 7 * * *",
  );
  assert.equal(
    phoneTimeTriggerCron({
      ...weekdays,
      localTime: "00:05",
      days: [0, 6],
    } as never),
    "5 0 * * 0,6",
  );
  assert.equal(
    message(() => phoneTimeTriggerCron({ kind: "manual" } as never)),
    "This workflow has no schedule",
  );
  assert.equal(
    describePhoneWorkflowTrigger(weekdays as never),
    "Weekdays at 07:30 (America/New_York)",
  );
  assert.equal(
    describePhoneWorkflowTrigger({ ...weekdays, days: [1, 3] } as never),
    "Mon, Wed at 07:30 (America/New_York)",
  );
  assert.equal(
    describePhoneWorkflowTrigger({ kind: "manual" }),
    "Only when you choose Run now",
  );
  assert.deepEqual(validatePhoneWorkflowTrigger({ kind: "manual" }), {
    kind: "manual",
  });
});

test("clients accept a catalog only within its bounds and require the reviewed trigger", () => {
  const body = {
    specVersion: 1,
    generationProtocol: 1,
    catalogRevision: "c1",
    compilerRevision: "k1",
    maximumSteps: 32,
    maximumSpecBytes: 65536,
    triggers: [
      { kind: "manual", available: true },
      { kind: "time", available: true, label: "At a set local time" },
      { kind: "event", available: false, reason: "Unavailable" },
    ],
    palette: [
      { kind: "Read", operations: [{ id: "supplied_text", available: true }] },
      { kind: "Write", operations: [{ id: "compose_draft", available: true }] },
    ],
  };
  const catalog = parsePhoneWorkflowCatalog(body);
  assert.equal(catalog.generationProtocol, 1);
  assert.deepEqual(catalog.triggers[1], {
    kind: "time",
    available: true,
    label: "At a set local time",
  });
  assert.equal(
    message(() => parsePhoneWorkflowCatalog({ ...body, maximumSteps: 64 })),
    "Unsupported workflow capabilities",
  );
  const manual = validatePhoneWorkflowSpec(base);
  const scheduled = validatePhoneWorkflowSpec({ ...base, trigger: weekdays });
  assertPhoneWorkflowCapabilities(manual, catalog);
  assertPhoneWorkflowCapabilities(scheduled, catalog);
  const manualOnly = parsePhoneWorkflowCatalog({
    ...body,
    triggers: [
      { kind: "manual", available: true },
      { kind: "time", available: false, reason: "Not implemented" },
    ],
  });
  assert.equal(
    message(() => assertPhoneWorkflowCapabilities(scheduled, manualOnly)),
    "Agent capabilities changed. Review the available steps again.",
  );
  assert.equal(
    message(() =>
      assertPhoneWorkflowCapabilities(
        manual,
        parsePhoneWorkflowCatalog({
          ...body,
          triggers: [{ kind: "time", available: true }],
        }),
      ),
    ),
    "Agent capabilities changed. Review the available steps again.",
  );
});

test("save receipts and scheduled occurrences are bound to their exact identity", () => {
  const expected = {
    mutationId: "11111111-1111-4111-8111-111111111111",
    specDigest: "d".repeat(64),
    compilerRevision: "k1",
  };
  const receipt = {
    ...expected,
    workflowId: "flow-1",
    operation: "create",
    previousVersionId: null,
    versionId: "version-1",
    appliedAt: "2026-10-27T00:00:00.000Z",
  };
  assert.equal(
    parsePhoneWorkflowSaveReceipt(receipt, expected).workflowId,
    "flow-1",
  );
  for (const changed of [
    { ...receipt, specDigest: "e".repeat(64) },
    { ...receipt, operation: "edit" },
    { ...receipt, previousVersionId: "version-0" },
  ])
    assert.equal(
      message(() => parsePhoneWorkflowSaveReceipt(changed, expected)),
      "Saved workflow receipt identity mismatch",
    );
  assert.equal(
    message(() =>
      parsePhoneWorkflowSaveReceipt(
        {
          ...receipt,
          operation: "edit",
          previousVersionId: "version-0",
          workflowId: "other",
        },
        { ...expected, workflowId: "flow-1", versionId: "version-0" },
      ),
    ),
    "Saved workflow receipt identity mismatch",
  );
  assert.equal(parsePhoneScheduledOccurrence(undefined), undefined);
  const occurrence = {
    scheduledAt: "2026-10-27T11:30:00.000Z",
    trigger: weekdays,
    status: "missed",
    text: "The scheduled time passed while the agent was not running. Nothing ran.",
  };
  assert.deepEqual(parsePhoneScheduledOccurrence(occurrence), occurrence);
  assert.equal(
    message(() =>
      parsePhoneScheduledOccurrence({ ...occurrence, status: "late" }),
    ),
    "Invalid scheduled occurrence",
  );
  assert.equal(
    message(() =>
      parsePhoneScheduledOccurrence({
        ...occurrence,
        trigger: { kind: "manual" },
      }),
    ),
    "Invalid scheduled occurrence",
  );
});

import { normalizeActionJsonSchema, validateSchema } from "@elizaos/core";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  __INTERNAL_normalizeNativeToolsForCall,
  __INTERNAL_restoreRecordArgToolCalls,
} from "../../../../plugin-openai/models/text.ts";
import {
  decodeToolArguments,
  envelopeToolSchema,
} from "../../../../plugin-openai/utils/cerebras-tool-argument-envelope.ts";
import {
  buildTaskCreatePlan,
  taskCreatePlanGuidance,
} from "./extract-task-plan";
import {
  parseNativeTaskCreatePlan,
  TASK_CREATE_PLAN_PARAMETER,
} from "./task-create-plan-parameter";

const plan = {
  mode: "create",
  requestKind: "reminder",
  title: "QA",
  description: null,
  cadenceKind: "once",
  dueInMinutes: 2,
  dueDate: null,
  dueInDays: null,
  dueWeekday: null,
  multiStep: false,
  nativeProjection: "in_app_only",
};
it.each(["in_app_only", "apple_reminders"])(
  "preserves projection %s in both semantic paths",
  (nativeProjection) => {
    expect(
      buildTaskCreatePlan({ ...plan, nativeProjection })?.nativeProjection,
    ).toBe(nativeProjection);
    expect(
      parseNativeTaskCreatePlan({ ...plan, nativeProjection })
        ?.nativeProjection,
    ).toBe(nativeProjection);
  },
);
it("requires a complete native alert-body decision and preserves explicit text", () => {
  const body =
    "Clock scope reminder QA, verification cdfaacf9.\nKeep this exact second line.";
  expect(
    parseNativeTaskCreatePlan({ ...plan, description: body })?.description,
  ).toBe(body);
  expect(
    parseNativeTaskCreatePlan({ ...plan, description: null })?.description,
  ).toBeNull();
  const { description: _description, ...missing } = plan;
  expect(parseNativeTaskCreatePlan(missing)).toBeNull();
  expect(parseNativeTaskCreatePlan({ ...plan, description: 17 })).toBeNull();
});
it("uses extraction for an unknown timed destination and rejects invalid projection", () => {
  const omitted = { ...plan, nativeProjection: undefined };
  expect(parseNativeTaskCreatePlan(omitted)).toBeNull();
  expect(buildTaskCreatePlan(omitted)?.nativeProjection).toBeNull();
  expect(
    parseNativeTaskCreatePlan({ ...plan, nativeProjection: "invalid" }),
  ).toBeNull();
  expect(
    buildTaskCreatePlan({ ...plan, nativeProjection: "invalid" }),
  ).toBeNull();
});

it.each([{ value: ["in_app_only"] }, { value: {} }, { value: 1 }])(
  "rejects non-string projection %j",
  ({ value: nativeProjection }) => {
    expect(buildTaskCreatePlan({ ...plan, nativeProjection })).toBeNull();
    expect(parseNativeTaskCreatePlan({ ...plan, nativeProjection })).toBeNull();
  },
);

// Use the actual native adapter sanitizer and strict normalizer before its
// qwen argument envelope; the provider schema can differ from source syntax.
function nativeSchema(schema: unknown) {
  const normalized = __INTERNAL_normalizeNativeToolsForCall(
    [{ name: "PLAN_FIXTURE", strict: true, parameters: schema }],
    { cerebrasMode: true, sanitizeUnicode: true },
  ).tools;
  const tool = normalized?.PLAN_FIXTURE as
    | { inputSchema?: { jsonSchema?: unknown } }
    | undefined;
  if (!tool?.inputSchema?.jsonSchema)
    throw Error("Missing native provider schema");
  return tool.inputSchema.jsonSchema;
}

it("keeps the optional native contract closed and discriminated through provider conversion", () => {
  const parameter = TASK_CREATE_PLAN_PARAMETER;
  const source = normalizeActionJsonSchema({ parameters: [parameter] });
  const normalized = nativeSchema(source);
  const wire = envelopeToolSchema(
    normalized as Parameters<typeof envelopeToolSchema>[0],
  );
  expect(source.required ?? []).not.toContain("createPlan");
  const enclosed = wire.properties?.arguments as typeof source;
  const nativePlan = (enclosed.properties?.createPlan ??
    {}) as typeof parameter.schema;
  expect(nativePlan?.anyOf).toHaveLength(2);
  for (const branch of nativePlan?.anyOf ?? []) {
    expect(branch.type).toBe("object");
    expect(branch.additionalProperties).toBe(false);
    expect(Object.keys(branch.properties ?? {}).sort()).toEqual(
      Object.keys(parameter.schema?.anyOf?.[0].properties ?? {}).sort(),
    );
  }
  for (const [schema, wrapped] of [
    [source, false],
    [normalized, false],
    [wire, true],
  ] as const) {
    const check = (value: unknown): string[] => {
      const input = wrapped ? { arguments: value } : value;
      if (schema === source) {
        const errors: string[] = [];
        validateSchema(source, input, "", errors);
        return errors;
      }
      // Provider schemas use JSON Schema type arrays for nullable numerics.
      // Validate the actual wire dialect, not core's authored scalar dialect.
      const result = z.fromJSONSchema(schema).safeParse(input);
      return result.success
        ? []
        : result.error.issues.map((issue) => issue.message);
    };

    const partial = {
      createPlan: { mode: "create", requestKind: "reminder", multiStep: false },
    };
    const partialErrors = check(partial);
    expect(partialErrors.length).toBeGreaterThan(0);

    const clockless = { createPlan: { ...plan, dueInMinutes: undefined } };
    const clocklessErrors = check(clockless);
    expect(clocklessErrors.length).toBeGreaterThan(0);
    expect(parseNativeTaskCreatePlan(clockless.createPlan)).toBeNull();
    for (const selector of [
      "dueDate",
      "dueInDays",
      "dueWeekday",
      "dueInMinutes",
    ]) {
      const missing: Record<string, unknown> = { ...plan };
      delete missing[selector];
      expect(check({ createPlan: missing }).length, selector).toBeGreaterThan(
        0,
      );
    }
    const omittedDestination = {
      createPlan: { ...plan, nativeProjection: undefined },
    };

    const omittedErrors = check(omittedDestination);
    expect(omittedErrors.length).toBeGreaterThan(0);
    for (const value of [
      {},
      { createPlan: { ...plan, nativeProjection: null } },
      { createPlan: plan },
      {
        createPlan: {
          mode: "respond",
          requestKind: "reminder",
          multiStep: false,
          response: "What should I remind you about?",
        },
      },
    ]) {
      expect(check(value), JSON.stringify(value)).toEqual([]);
    }
  }
  const branches = parameter.schema?.anyOf;
  const respond = branches?.find((branch) =>
    branch.properties?.mode.enum?.includes("respond"),
  );
  if (!respond?.properties) throw Error("Missing native response branch");
  const bytes = (schema: unknown) =>
    Buffer.byteLength(
      JSON.stringify(
        envelopeToolSchema(
          nativeSchema(schema) as Parameters<typeof envelopeToolSchema>[0],
        ),
      ),
    );
  expect({ nativePlanProviderSchemaBytes: bytes(source) }).toMatchSnapshot();
});

it("preserves explicit timing selectors through the real provider envelope and restoration", () => {
  const source = normalizeActionJsonSchema({
    parameters: [TASK_CREATE_PLAN_PARAMETER],
  });
  const normalized = __INTERNAL_normalizeNativeToolsForCall(
    [{ name: "PLAN_FIXTURE", strict: true, parameters: source }],
    { cerebrasMode: true, sanitizeUnicode: true },
  );
  const input = decodeToolArguments({ arguments: { createPlan: plan } });
  const restored = __INTERNAL_restoreRecordArgToolCalls(
    [
      {
        type: "tool-call",
        toolCallId: "timing-null",
        toolName: "PLAN_FIXTURE",
        input,
      },
    ],
    normalized.recordArgTransformsByTool,
  );
  expect(restored?.[0].arguments).toEqual({ createPlan: plan });
  const errors: string[] = [];
  validateSchema(source, restored?.[0].arguments, "", errors);
  expect(errors).toEqual([]);
  expect(parseNativeTaskCreatePlan(plan)?.dueInMinutes).toBe(2);
  expect(parseNativeTaskCreatePlan({ ...plan, dueInMinutes: null })).toBeNull();
  expect(
    parseNativeTaskCreatePlan({
      ...plan,
      dueInMinutes: null,
      timeOfDay: "18:30",
    })?.timeOfDay,
  ).toBe("18:30");
  expect(
    parseNativeTaskCreatePlan({
      ...plan,
      dueInMinutes: null,
      cadenceKind: "daily",
      windows: ["morning"],
    })?.cadenceKind,
  ).toBe("daily");
  // Existing direct callers retain the same semantic fallback/acceptance.
  const legacy = {
    ...plan,
    dueDate: undefined,
    dueInDays: undefined,
    dueWeekday: undefined,
  };
  expect(parseNativeTaskCreatePlan(legacy)).toEqual(
    buildTaskCreatePlan(legacy),
  );
});

it.each([
  { mode: "create", requestKind: "reminder", multiStep: false },
  { ...plan, title: undefined },
  { ...plan, cadenceKind: undefined },
  { mode: "respond", requestKind: "reminder", multiStep: false },
  { ...plan, dueInMinutes: undefined },
  { ...plan, dueInMinutes: undefined, windows: [] },
  { ...plan, dueInMinutes: undefined, timeOfDay: "29:99" },
  { ...plan, timeZone: "Not/AZone" },
  { ...plan, dueDate: "bad-date", dueInMinutes: undefined },
  { ...plan, dueDate: "2026-10-01" },
  { ...plan, cadenceKind: "daily" },
  { ...plan, title: "" },
  { ...plan, unknownPermission: true },
])(
  "keeps insufficient, ambiguous or invalid native plans on extraction fallback: %j",
  (value) => {
    expect(parseNativeTaskCreatePlan(value)).toBeNull();
  },
);

it.each([
  { ...plan, timeZone: "America/Los_Angeles", nativeProjection: "in_app_only" },
  { ...plan, dueInMinutes: undefined, timeOfDay: "18:30" },
  { ...plan, dueInMinutes: undefined, windows: ["morning"] },
  { ...plan, dueInMinutes: undefined, dueDate: "2026-10-02" },
  { ...plan, dueInMinutes: undefined, dueInDays: 0 },
  { ...plan, dueInMinutes: undefined, dueWeekday: 5, timeOfDay: "17:00" },
  { ...plan, dueInMinutes: undefined, cadenceKind: "unscheduled" },
  {
    ...plan,
    dueInMinutes: undefined,
    cadenceKind: "daily",
    windows: ["morning", "night"],
  },
  {
    ...plan,
    dueInMinutes: undefined,
    cadenceKind: "weekly",
    weekdays: [1, 4],
    timeOfDay: "09:00",
  },
  {
    ...plan,
    dueInMinutes: undefined,
    cadenceKind: "interval",
    everyMinutes: 30,
  },
  {
    ...plan,
    dueInMinutes: undefined,
    cadenceKind: "count_per_day",
    quotaTargetCount: 3,
    quotaUnit: "set",
    perOccurrenceWork: "25 pushups",
    checkInRequested: true,
    checkInWindows: ["evening"],
  },
  { ...plan, multiStep: true, description: "Outline, draft and proofread" },
  {
    mode: "respond",
    requestKind: "unspecified",
    multiStep: false,
    response: "When should I remind you?",
  },
])(
  "preserves the shared extractor semantics for complete plans: %j",
  (value) => {
    expect(parseNativeTaskCreatePlan(value)).toEqual(
      buildTaskCreatePlan(value),
    );
  },
);

it.each(["alarm", "reminder"])(
  "keeps a complete once %s with omitted projection on extraction",
  (requestKind) => {
    // Actual saved888 shape has title, cadence and dueInMinutes but no destination.
    expect(
      parseNativeTaskCreatePlan({
        mode: "create",
        requestKind,
        title: "Check the native projection",
        cadenceKind: "once",
        dueInMinutes: 2,
        multiStep: false,
      }),
    ).toBeNull();
  },
);
it.each([
  {
    mode: "respond",
    requestKind: "reminder",
    multiStep: false,
    response: "What should I remind you about?",
  },
  { ...plan, nativeProjection: null, requestKind: "unspecified" },
  {
    ...plan,
    nativeProjection: null,
    cadenceKind: "daily",
    dueInMinutes: undefined,
    windows: ["morning"],
  },
  {
    ...plan,
    nativeProjection: null,
    requestKind: "unspecified",
    cadenceKind: "unscheduled",
    dueInMinutes: undefined,
  },
])(
  "preserves native acceptance outside timed known destinations: %j",
  (value) => {
    expect(parseNativeTaskCreatePlan(value)).toEqual(
      buildTaskCreatePlan(value),
    );
  },
);

it.each([
  {
    name: "Travel missing alert-body decision",
    input: {
      mode: "create",
      requestKind: "reminder",
      nativeProjection: "in_app_only",
      title: "Check travel pouch",
      cadenceKind: "once",
      dueInMinutes: 2,
      multiStep: false,
    },
    accepted: false,
  },
  {
    name: "Travel explicit title-only decision",
    input: {
      mode: "create",
      requestKind: "reminder",
      nativeProjection: "in_app_only",
      title: "Check travel pouch",
      description: null,
      cadenceKind: "once",
      dueInMinutes: 2,
      multiStep: false,
    },
    accepted: true,
  },
  {
    name: "Grocery",
    input: {
      mode: "create",
      requestKind: "reminder",
      title: "Check the grocery bag",
      cadenceKind: "once",
      dueInMinutes: 2,
      multiStep: false,
    },
    accepted: false,
  },
  {
    name: "Pine",
    input: {
      mode: "create",
      requestKind: "reminder",
      title: "Check the native plan pine",
      cadenceKind: "once",
      multiStep: false,
    },
    accepted: false,
  },
])(
  "keeps saved destinations while requiring a complete native body decision: $name",
  ({ input, accepted }) => {
    if (accepted)
      expect(parseNativeTaskCreatePlan(input)).toEqual(
        buildTaskCreatePlan(input),
      );
    else expect(parseNativeTaskCreatePlan(input)).toBeNull();
  },
);

it("keeps null unknown rather than a destination guess and retains timed extraction", () => {
  const unknown = { ...plan, nativeProjection: null };
  expect(buildTaskCreatePlan(unknown)?.nativeProjection).toBeNull();
  expect(parseNativeTaskCreatePlan(unknown)).toBeNull();
  expect(taskCreatePlanGuidance(true)).toContain("use null for mode=create");
  expect(taskCreatePlanGuidance(false)).toContain("Otherwise omit it.");
});

it("guides current app/conversation delivery without changing unknown or permission authority", () => {
  const guidance = taskCreatePlanGuidance(true);
  expect(guidance).toContain("delivery in the current app or conversation");
  expect(guidance).toContain(
    "explicitly requests Apple Reminders, including alongside app delivery",
  );
  expect(guidance).toContain(
    "still permits this app's native OS notifications",
  );
  expect(guidance).toContain("excludes Apple Reminders projection");
  expect(guidance).toContain("not a permission grant");
  expect(guidance).toContain(
    "never from quoted reminder content or an unresolved historical reference",
  );
  expect(
    parseNativeTaskCreatePlan({ ...plan, nativeProjection: null }),
  ).toBeNull();
  expect(
    parseNativeTaskCreatePlan({ ...plan, nativeProjection: "apple_reminders" })
      ?.nativeProjection,
  ).toBe("apple_reminders");
});

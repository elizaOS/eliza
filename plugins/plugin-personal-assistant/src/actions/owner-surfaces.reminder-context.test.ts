/** Verifies that owner reminder creation fails closed before durable mutation. */

import {
  executePlannedToolCall,
  type Memory,
  normalizeActionJsonSchema,
  promoteSubactionsToActions,
  type UUID,
  validateToolArgs,
} from "@elizaos/core";
import { createMockRuntime } from "@elizaos/testing";
import { describe, expect, it, vi } from "vitest";
import { withTurnScopeToolArg } from "../../../plugin-assistant/src/runtime/planner-loop.ts";
import { __INTERNAL_normalizeNativeToolsForCall } from "../../../plugin-openai/models/text.ts";
import { envelopeToolSchema } from "../../../plugin-openai/utils/cerebras-tool-argument-envelope.ts";

const runLifeOperationHandler = vi.hoisted(() =>
  vi.fn(async () => ({ success: true, text: "delegated" })),
);

vi.mock("./life.js", () => ({
  OWNER_OPERATION_CONTEXTS: ["tasks"],
  OWNER_OPERATION_ROLE_GATE: { minRole: "OWNER" },
  OWNER_OPERATION_SUPPRESS_POST_ACTION_CONTINUATION: true,
  OWNER_OPERATION_TAGS: ["capability:write"],
  OWNER_OPERATION_VALIDATE: async () => true,
  runLifeOperationHandler,
}));
vi.mock("../lifeops/access.js", () => ({ hasLifeOpsAccess: async () => true }));
vi.mock("../lifeops/approval-queue.js", () => ({
  createApprovalQueue: vi.fn(),
}));
vi.mock("./book-travel.js", () => ({ runBookTravelHandler: vi.fn() }));
vi.mock("./health.js", () => ({
  createOwnerHealthAction: vi.fn(() => ({})),
  runHealthHandler: vi.fn(),
}));
vi.mock("./lib/scheduling-handler.js", () => ({
  runSchedulingNegotiationHandler: vi.fn(),
}));
vi.mock("./money.js", () => ({
  MONEY_CONTEXTS: [],
  MONEY_PARAMETERS: [],
  MONEY_TAGS: [],
  OWNER_FINANCE_SIMILES: [],
  runMoneyHandler: vi.fn(),
}));
vi.mock("./schedule.js", () => ({ runScheduleHandler: vi.fn() }));
vi.mock("./screen-time.js", () => ({
  createOwnerScreenTimeAction: vi.fn(() => ({})),
  runScreenTimeHandler: vi.fn(),
}));

const {
  ownerRemindersAction,
  ownerAlarmsAction,
  ownerTodosAction,
  ownerRoutinesAction,
  ownerGoalsAction,
} = await import("./owner-surfaces.js");

it("maps structured cancellation to an archive-only update without carrying unrelated changes", async () => {
  runLifeOperationHandler.mockClear();
  await ownerRemindersAction.handler(
    {} as never,
    { content: { text: "Cancel my sapphire reminder." } } as never,
    undefined,
    {
      parameters: {
        action: "cancel",
        target: "immutable-reminder-id",
        kind: "goal",
        title: "Unrequested replacement title",
        intent: "Reactivate and reschedule",
        details: {
          status: "active",
          time: "18:00",
          priority: 1,
          description: "Unrequested edit",
        },
      },
    },
  );
  expect(runLifeOperationHandler).toHaveBeenCalledOnce();
  expect(runLifeOperationHandler.mock.calls[0]?.[3]).toMatchObject({
    parameters: {
      action: "cancel",
      subaction: "update",
      kind: "definition",
      ownerSurface: "OWNER_REMINDERS",
      target: "immutable-reminder-id",
      details: { status: "archived" },
    },
  });
  expect(
    Object.keys(runLifeOperationHandler.mock.calls[0]?.[3].parameters),
  ).toEqual([
    "action",
    "subaction",
    "kind",
    "ownerSurface",
    "target",
    "details",
  ]);
});

it("exposes the complete plan only on definition creation and validates native fields", () => {
  const promoted = promoteSubactionsToActions(ownerRemindersAction);
  const create = promoted.find(
    (action) => action.name === "OWNER_REMINDERS_CREATE",
  );
  const review = promoted.find(
    (action) => action.name === "OWNER_REMINDERS_REVIEW",
  );
  const remove = promoted.find(
    (action) => action.name === "OWNER_REMINDERS_DELETE",
  );
  expect(create).toBeDefined();
  expect(review).toBeDefined();
  expect(remove).toBeDefined();
  if (!create || !review || !remove) return;
  const createPlan = {
    mode: "create",
    multiStep: false,
    nativeProjection: null,
    title: "Call Mom",
    description: null,
    requestKind: "reminder",
    cadenceKind: "once",
    dueInDays: 1,
    dueDate: null,
    dueWeekday: null,
    dueInMinutes: null,
    timeOfDay: "12:00",
  };
  expect(validateToolArgs(create, { createPlan }).valid).toBe(true);
  expect(
    validateToolArgs(create, {
      createPlan: { ...createPlan, nativeProjection: "in_app_only" },
    }).valid,
  ).toBe(true);
  expect(
    validateToolArgs(create, {
      createPlan: { ...createPlan, nativeProjection: "apple_reminders" },
    }).valid,
  ).toBe(true);
  expect(
    validateToolArgs(create, {
      createPlan: { ...createPlan, nativeProjection: undefined },
    }).valid,
  ).toBe(false);

  expect(
    validateToolArgs(create, {
      createPlan: { ...createPlan, timeOfDay: "29:99" },
    }).valid,
  ).toBe(false);
  expect(
    validateToolArgs(create, { createPlan: { ...createPlan, confirmed: true } })
      .valid,
  ).toBe(false);
  expect(validateToolArgs(review, { createPlan }).valid).toBe(false);
  expect(validateToolArgs(remove, { createPlan }).valid).toBe(false);
});

it("keeps creation and snooze arguments on their owning promoted operations", () => {
  const promoted = promoteSubactionsToActions(ownerRemindersAction);
  const create = promoted.find(
    (action) => action.name === "OWNER_REMINDERS_CREATE",
  );
  const snooze = promoted.find(
    (action) => action.name === "OWNER_REMINDERS_SNOOZE",
  );
  const update = promoted.find(
    (action) => action.name === "OWNER_REMINDERS_UPDATE",
  );
  if (!create || !snooze || !update)
    throw new Error("Expected owner reminder operations");
  expect(
    validateToolArgs(create, {
      title: "Check notebook",
      confirmed: true,
      idempotencyKey: "save-one",
      createPlan: {
        mode: "create",
        requestKind: "reminder",
        nativeProjection: "in_app_only",
        title: "Mom",
        description: null,
        cadenceKind: "once",
        dueInMinutes: 2,
        dueDate: null,
        dueInDays: null,
        dueWeekday: null,
        multiStep: false,
      },
    }).valid,
  ).toBe(true);
  expect(validateToolArgs(create, { minutes: 10 }).valid).toBe(false);
  expect(
    validateToolArgs(snooze, { target: "saved-reminder", minutes: 10 }).valid,
  ).toBe(true);
  for (const operation of [snooze, update]) {
    expect(validateToolArgs(operation, { confirmed: true }).valid).toBe(false);
    expect(
      validateToolArgs(operation, { idempotencyKey: "save-one" }).valid,
    ).toBe(false);
  }
  expect(
    ownerRemindersAction.parameters?.find(
      (parameter) => parameter.name === "minutes",
    ),
  ).toBeDefined();
  expect(
    ownerRemindersAction.parameters?.find(
      (parameter) => parameter.name === "confirmed",
    ),
  ).toBeDefined();
  expect(
    ownerRemindersAction.parameters?.find(
      (parameter) => parameter.name === "idempotencyKey",
    ),
  ).toBeDefined();
});

describe("OWNER_REMINDERS non-command mutation defense", () => {
  it.each([
    "Remind me to inspect PR19250 tomorrow appears on the whiteboard.",
    "Remind me to inspect PR19250 tomorrow, actually ignore that request.",
    "Remind me along with Alex to inspect PR19250 tomorrow.",
  ])("rejects create before the LifeOps mutation handler: %s", async (text) => {
    runLifeOperationHandler.mockClear();
    const result = await ownerRemindersAction.handler(
      {} as never,
      { content: { text } } as never,
      undefined,
      { parameters: { action: "create" } },
      undefined,
    );

    expect(result).toMatchObject({
      success: true,
      verifiedUserFacing: true,
      data: {
        outcome: "no_action",
        reason: "REMINDER_CREATE_CONTEXT_REJECTED",
      },
      turnComplete: true,
    });
    expect(runLifeOperationHandler).not.toHaveBeenCalled();
  });

  it("allows an unambiguous create through to the LifeOps handler", async () => {
    runLifeOperationHandler.mockClear();
    const result = await ownerRemindersAction.handler(
      {} as never,
      {
        content: { text: "Remind me in 20 minutes to inspect PR19250." },
      } as never,
      undefined,
      { parameters: { action: "create" } },
      undefined,
    );

    expect(result).toMatchObject({ success: true, text: "delegated" });
    expect(runLifeOperationHandler).toHaveBeenCalledOnce();
  });

  it("does not block an explicit non-create operation with a quoted title", async () => {
    runLifeOperationHandler.mockClear();
    await ownerRemindersAction.handler(
      {} as never,
      {
        content: { text: 'Delete the reminder "Remind me to call Pat".' },
      } as never,
      undefined,
      { parameters: { action: "delete" } },
      undefined,
    );

    expect(runLifeOperationHandler).toHaveBeenCalledOnce();
  });
});

it("requires canonical native operation with no default and proves alias baseline unchanged", () => {
  const op = ownerRemindersAction.parameters?.find(
    ({ name }) => name === "action",
  );
  expect(op?.required).toBe(true);
  expect(op?.schema.default).toBeUndefined();
  expect(op?.aliases).toBeUndefined();
  const baseline = {
    ...ownerRemindersAction,
    parameters: ownerRemindersAction.parameters?.map((p) =>
      p.name === "action" ? { ...p, required: false } : p,
    ),
  };
  for (const key of ["action", "subaction", "op", "operation"]) {
    expect(validateToolArgs(baseline, { [key]: "review" }).valid).toBe(
      key === "action",
    );
    expect(
      validateToolArgs(ownerRemindersAction, { [key]: "review" }).valid,
    ).toBe(key === "action");
  }
  expect(validateToolArgs(baseline, {}).valid).toBe(true);
  expect(validateToolArgs(ownerRemindersAction, {}).valid).toBe(false);
});

it.each([
  {},
  { action: "unknown" },
  { op: "review" },
  { action: "review", op: "delete" },
])(
  "rejects missing/unknown/conflicting native selectors before handler effects: %j",
  async (params) => {
    runLifeOperationHandler.mockClear();
    const runtime = createMockRuntime({ actions: [ownerRemindersAction] });
    const message = {
      id: crypto.randomUUID(),
      roomId: crypto.randomUUID(),
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      content: { text: "Review my reminders", source: "test" },
    } as Memory;
    const result = await executePlannedToolCall(
      runtime,
      { message, userRoles: ["OWNER"], activeContexts: ["tasks"] },
      { name: ownerRemindersAction.name, params },
      { actions: [ownerRemindersAction] },
    );
    expect(result.success).toBe(false);
    expect(result.data?.parameterErrors).toEqual(expect.any(Array));
    expect(runLifeOperationHandler).not.toHaveBeenCalled();
  },
);

it.each(["action", "subaction", "op", "operation"])(
  "keeps direct internal handler normalization for %s unchanged",
  async (key) => {
    runLifeOperationHandler.mockClear();
    await ownerRemindersAction.handler(
      {} as never,
      { content: { text: "Review my reminders" } } as never,
      undefined,
      { parameters: { [key]: " REVIEW " } } as never,
    );
    expect(runLifeOperationHandler).toHaveBeenCalledOnce();
    expect(runLifeOperationHandler.mock.calls[0]?.[3].parameters).toMatchObject(
      { action: "review", subaction: "review", kind: "definition" },
    );
  },
);
it("leaves direct internal unstructured routing available without inventing an operation", async () => {
  runLifeOperationHandler.mockClear();
  await ownerRemindersAction.handler(
    {} as never,
    { content: { text: "Do something with my reminders" } } as never,
    undefined,
    { parameters: {} } as never,
  );
  expect(runLifeOperationHandler).toHaveBeenCalledOnce();
  expect(
    runLifeOperationHandler.mock.calls[0]?.[3].parameters.action,
  ).toBeUndefined();
  expect(
    runLifeOperationHandler.mock.calls[0]?.[3].parameters.subaction,
  ).toBeUndefined();
});

it("requires a plan on promoted create while virtual action injection and non-create operations remain", async () => {
  const actions = promoteSubactionsToActions(ownerRemindersAction);
  const create = actions.find((a) => a.name === "OWNER_REMINDERS_CREATE");
  const review = actions.find((a) => a.name === "OWNER_REMINDERS_REVIEW");
  if (!create || !review) throw Error("Missing promoted operations");
  const plan = {
    mode: "create",
    multiStep: false,
    requestKind: "reminder",
    nativeProjection: "in_app_only",
    title: "Bag",
    description: null,
    cadenceKind: "once",
    dueInMinutes: 2,
    dueDate: null,
    dueInDays: null,
    dueWeekday: null,
  };
  expect(create.parameters?.find((p) => p.name === "action")?.required).toBe(
    false,
  );
  expect(
    create.parameters?.find((p) => p.name === "createPlan")?.required,
  ).toBe(true);
  expect(
    ownerRemindersAction.parameters?.find((p) => p.name === "createPlan")
      ?.required,
  ).toBe(false);
  expect(validateToolArgs(create, {}).valid).toBe(false);
  expect(validateToolArgs(review, {}).valid).toBe(true);
  expect(
    validateToolArgs(ownerRemindersAction, { action: "review" }).valid,
  ).toBe(true);
  expect(
    validateToolArgs(ownerRemindersAction, { action: "create" }).valid,
  ).toBe(true);
  runLifeOperationHandler.mockClear();
  const runtime = createMockRuntime({ actions });
  const message = {
    id: crypto.randomUUID() as UUID,
    roomId: crypto.randomUUID() as UUID,
    entityId: runtime.agentId,
    agentId: runtime.agentId,
    content: {
      text: "Remind me in two minutes to check the bag, in-app only.",
      source: "test",
    },
  } as Memory;
  const result = await executePlannedToolCall(
    runtime,
    { message, userRoles: ["OWNER"], activeContexts: ["tasks"] },
    { name: create.name, params: { createPlan: plan } },
    { actions },
  );
  expect(result.data?.parameterErrors).toBeUndefined();
  expect(runLifeOperationHandler).toHaveBeenCalledOnce();
  expect(runLifeOperationHandler.mock.calls[0]?.[3].parameters.action).toBe(
    "create",
  );
  expect(
    runLifeOperationHandler.mock.calls[0]?.[3].parameters.createPlan,
  ).toEqual(plan);
});

it.each([
  'Quote exactly: "Remind me in two minutes to check the bag."',
  "Suppose I say remind me tomorrow to check the bag.",
  "Remind me tomorrow to check the bag. Actually, never mind.",
])(
  "does not let required metadata bypass existing non-command context: %s",
  async (text) => {
    runLifeOperationHandler.mockClear();
    const result = await ownerRemindersAction.handler(
      {} as never,
      { content: { text } } as never,
      undefined,
      {
        parameters: {
          action: "create",
          createPlan: {
            mode: "create",
            requestKind: "reminder",
            nativeProjection: "in_app_only",
            title: "Bag",
            cadenceKind: "once",
            dueInMinutes: 2,
            dueDate: null,
            dueInDays: null,
            dueWeekday: null,
            multiStep: false,
          },
        },
      } as never,
    );
    expect(result?.data?.outcome).toBe("no_action");
    expect(runLifeOperationHandler).not.toHaveBeenCalled();
  },
);

it("pins actual normalized/enveloped required fields and metadata-only cost", () => {
  const baseline = {
    ...ownerRemindersAction,
    parameters: ownerRemindersAction.parameters?.map((p) =>
      p.name === "action" ? { ...p, required: false } : p,
    ),
  };
  const child = promoteSubactionsToActions(ownerRemindersAction).find(
    (a) => a.name === "OWNER_REMINDERS_CREATE",
  );
  if (!child) throw Error("Missing child");
  const normalized = __INTERNAL_normalizeNativeToolsForCall(
    [
      {
        name: ownerRemindersAction.name,
        strict: true,
        parameters: normalizeActionJsonSchema(ownerRemindersAction),
      },
      {
        name: child.name,
        strict: true,
        parameters: normalizeActionJsonSchema(child),
      },
      {
        name: "BASELINE",
        strict: true,
        parameters: normalizeActionJsonSchema(baseline),
      },
    ],
    { cerebrasMode: true, sanitizeUnicode: true },
  ).tools as Record<
    string,
    { inputSchema: { jsonSchema: Parameters<typeof envelopeToolSchema>[0] } }
  >;
  const parent = normalized[ownerRemindersAction.name].inputSchema.jsonSchema;
  const virtual = normalized[child.name].inputSchema.jsonSchema;
  const outer = envelopeToolSchema(parent);
  expect(parent.required).toEqual(["action"]);
  expect(
    ((parent.properties?.action ?? {}) as { default?: unknown }).default,
  ).toBeUndefined();
  expect(virtual.required).toEqual(["createPlan"]);
  expect(outer.required).toEqual(["arguments"]);
  expect(
    ((outer.properties?.arguments ?? {}) as typeof parent).required,
  ).toEqual(["action"]);
  expect(envelopeToolSchema(virtual).properties?.arguments).toEqual(virtual);
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  expect(
    size(outer) -
      size(envelopeToolSchema(normalized.BASELINE.inputSchema.jsonSchema)),
  ).toBe(8);
  const scoped = withTurnScopeToolArg([
    {
      name: "CURRENT_SCOPE",
      strict: true,
      parameters: normalizeActionJsonSchema(ownerRemindersAction),
    },
    {
      name: "BASELINE_SCOPE",
      strict: true,
      parameters: normalizeActionJsonSchema(baseline),
    },
  ]);
  const scopedTools = __INTERNAL_normalizeNativeToolsForCall(scoped, {
    cerebrasMode: true,
    sanitizeUnicode: true,
  }).tools as typeof normalized;
  expect(
    size(envelopeToolSchema(scopedTools.CURRENT_SCOPE.inputSchema.jsonSchema)) -
      size(
        envelopeToolSchema(scopedTools.BASELINE_SCOPE.inputSchema.jsonSchema),
      ),
  ).toBe(9);
});

it("allows promoted CREATE's existing respond plan and denies missing plan before effects", async () => {
  const child = promoteSubactionsToActions(ownerRemindersAction).find(
    (a) => a.name === "OWNER_REMINDERS_CREATE",
  );
  if (!child) throw Error("Missing create child");
  const plan = {
    mode: "respond",
    requestKind: "unspecified",
    multiStep: false,
    response: "What should I remind you about, and when?",
  };
  expect(validateToolArgs(child, { createPlan: plan }).valid).toBe(true);
  runLifeOperationHandler.mockClear();
  const runtime = createMockRuntime({ actions: [child] });
  const message = {
    id: crypto.randomUUID() as UUID,
    roomId: crypto.randomUUID() as UUID,
    entityId: runtime.agentId,
    agentId: runtime.agentId,
    content: { text: "Can you remind me?", source: "test" },
  } as Memory;
  const denied = await executePlannedToolCall(
    runtime,
    { message, userRoles: ["OWNER"], activeContexts: ["tasks"] },
    { name: child.name, params: {} },
    { actions: [child] },
  );
  expect(denied.success).toBe(false);
  expect(denied.data?.parameterErrors).toEqual(expect.any(Array));
  expect(runLifeOperationHandler).not.toHaveBeenCalled();
});

it.each([
  ["Reminders", ownerRemindersAction],
  ["Alarms", ownerAlarmsAction],
  ["Todos", ownerTodosAction],
  ["Routines", ownerRoutinesAction],
  ["Goals", ownerGoalsAction],
] as const)(
  "keeps the complete operation contract on %s including overrides",
  async (_label, action) => {
    const op = action.parameters?.find((p) => p.name === "action");
    expect(op?.required).toBe(true);
    expect(op?.schema.default).toBeUndefined();
    expect(op?.schema.enum).toContain("create");
    expect(op?.schema.enum).toContain("review");
    const baseline = {
      ...action,
      parameters: action.parameters?.map((p) =>
        p.name === "action" ? { ...p, required: false } : p,
      ),
    };
    for (const key of ["action", "subaction", "op", "operation"]) {
      expect(validateToolArgs(baseline, { [key]: "review" }).valid).toBe(
        key === "action",
      );
      expect(validateToolArgs(action, { [key]: "review" }).valid).toBe(
        key === "action",
      );
      runLifeOperationHandler.mockClear();
      await action.handler(
        {} as never,
        { content: { text: "Review my owner items" } } as never,
        undefined,
        { parameters: { [key]: "review" } } as never,
      );
      expect(runLifeOperationHandler).toHaveBeenCalledOnce();
      expect(runLifeOperationHandler.mock.calls[0]?.[3].parameters.action).toBe(
        "review",
      );
    }
    const normalized = __INTERNAL_normalizeNativeToolsForCall(
      [
        {
          name: action.name,
          strict: true,
          parameters: normalizeActionJsonSchema(action),
        },
      ],
      { cerebrasMode: true, sanitizeUnicode: true },
    ).tools as Record<
      string,
      { inputSchema: { jsonSchema: Parameters<typeof envelopeToolSchema>[0] } }
    >;
    const wire = normalized[action.name].inputSchema.jsonSchema;
    expect(wire.required).toEqual(["action"]);
    expect(
      ((wire.properties?.action ?? {}) as { enum?: unknown }).enum,
    ).toEqual(op?.schema.enum);
    expect(
      (envelopeToolSchema(wire).properties?.arguments ?? {}) as typeof wire,
    ).toMatchObject({ required: ["action"] });
    const children = promoteSubactionsToActions(action).filter(
      (a) => a.name !== action.name,
    );
    for (const child of children) {
      const plan = child.parameters?.find((p) => p.name === "createPlan");
      const isCreate = child.name.endsWith("_CREATE");
      if (action === ownerGoalsAction) expect(plan).toBeUndefined();
      else if (isCreate) expect(plan?.required).toBe(true);
      else expect(plan).toBeUndefined();
      expect(child.parameters?.find((p) => p.name === "action")?.required).toBe(
        false,
      );
    }
  },
);

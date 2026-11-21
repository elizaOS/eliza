/**
 * PROPOSE_DEVICE_ACTION and the planner's phone capability instruction are sent
 * on every planner call of a phone turn. They are written short: operation
 * forms that take the same arguments share a branch, and each rule is stated
 * once. These tests pin that the short form offers and accepts exactly what
 * the registered forms do, that it is the same bytes for the same turn, that
 * every phone-number field still says in full how a number is written, and
 * that it does not grow back.
 */
import {
  type Action,
  type ActionParameterSchema,
  actionToTool,
  ContextRegistry,
  type IAgentRuntime,
  type Memory,
  validateToolArgs,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createV5MessageContextObject } from "../message/context-assembly.ts";
import {
  deviceActionForCapabilities,
  offeredDeviceOperations,
  proposeDeviceAction,
} from "./action.ts";
import { mergeOperationBranches } from "./operation-union.ts";
import {
  DeviceActionService,
  setDeviceActionRequestMessage,
  withDeviceActionTurn,
} from "./service.ts";
import { deviceActionTools } from "./tools.ts";

/** The capabilities an Alpha phone negotiates. */
const PHONE_CAPABILITIES = [
  "calendar.local-event.v1",
  "notes.local-record.v1",
  "camera.capture-photo.v1",
  "camera.capture-lens.v1",
  "reminders.local-record.v2",
  "notes.list-filter.v1",
  "reminders.create.v1",
  "calendar.create.v1",
  "calendar.next-read.v1",
  "maps.selected-read.v1",
  "files.browser.v1",
  "browser.search.v1",
  "browser.tabs.v1",
  "browser.history.v1",
  "browser.find.v1",
  "browser.open-new-tab.v1",
  "calendar.availability-read.v1",
  "photos.library.v1",
  "calendar.named-read.v1",
  "clock.handoff.v1",
  "clock.handoff.v2",
  "views.telephony.v1",
  "sms.send.v1",
  "phone.dial.v1",
  "sms.latest-sender.v1",
  "phone.call.v1",
  "contacts.write.v1",
  "contacts.show.v1",
  "contacts.read.v1",
  "sms.compose.v1",
  "messages.read.v1",
  "voicemail.read.v1",
  "voicemail.delete.v1",
  "phone.keypad.v1",
  "sms.compose.v2",
  "contacts.write.v2",
];
/** The same phone before the second version of each two-version operation. */
const OLDER_PHONE_CAPABILITIES = PHONE_CAPABILITIES.filter(
  (capability) =>
    ![
      "camera.capture-lens.v1",
      "clock.handoff.v2",
      "sms.compose.v2",
      "contacts.write.v2",
    ].includes(capability),
).map((capability) =>
  capability === "reminders.local-record.v2"
    ? "reminders.local-record.v1"
    : capability,
);
/** With the capabilities an Alpha phone does not negotiate, so their forms are offered too. */
const EVERY_PHONE_CAPABILITY = [
  ...PHONE_CAPABILITIES,
  "contacts.lookup.v1",
  "notes.query.v1",
  "notes.search.v1",
  "notes.organize.v1",
  "photos.view.v1",
  "device.named-target.v1",
];
const PHONE_VIEWS = [
  "browser",
  "calendar",
  "camera",
  "contacts",
  "files",
  "home",
  "inbox",
  "maps",
  "messages",
  "notes",
  "phone",
  "photos",
  "reminders",
  "settings",
  "workflows",
];
/**
 * How a phone number is written. A model once wrote digits it was never given
 * and the phone called them, so every field that takes a number says this in
 * full.
 */
const PHONE_NUMBER_RULE =
  "A number the owner wrote in this message. When it appears as a __ELIZA_CONTACT_ reference, copy that whole reference exactly; never write digits you were not given. Otherwise 2 to 20 digits with an optional leading +, for example +14155550100 or 5550100.";

type Schema = ActionParameterSchema;
type SentTool = { name: string; description: string; parameters: Schema };
const operationBranches = (action: Action): Schema[] => [
  ...(action.parameters?.find((parameter) => parameter.name === "operation")
    ?.schema.anyOf ?? []),
];
const sentBranches = (tool: SentTool | undefined): Schema[] => [
  ...(tool?.parameters.properties?.operation.anyOf ?? []),
];
const operationTypes = (branches: readonly Schema[]): string[] =>
  branches.flatMap((branch) =>
    (branch.properties?.type?.enum ?? []).map(String),
  );
/** A tool as a provider is sent it: name, description and parameter schema. */
const asSent = (action: Action): SentTool => {
  const { name, description, parameters } = actionToTool(action).function;
  return { name, description, parameters: parameters as Schema };
};
const sentSize = ({ name, description, parameters }: SentTool) =>
  JSON.stringify({
    type: "function",
    function: { name, description, parameters },
  }).length;

/** Enough of JSON Schema to decide whether an operation schema takes a value. */
function accepts(schema: Schema, value: unknown): boolean {
  if (schema.anyOf && !schema.anyOf.some((branch) => accepts(branch, value)))
    return false;
  if (schema.enum && !schema.enum.includes(value as never)) return false;
  switch (schema.type) {
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
      const properties = schema.properties ?? {};
      const record = value as Record<string, unknown>;
      return (
        (schema.required ?? []).every((key) => Object.hasOwn(record, key)) &&
        Object.keys(record).every(
          (key) =>
            Object.hasOwn(properties, key) &&
            accepts(properties[key], record[key]),
        )
      );
    }
    case "array":
      return (
        Array.isArray(value) &&
        value.every((item) => accepts(schema.items ?? {}, item))
      );
    case "string":
      return typeof value === "string";
    case "integer":
    case "number":
      return (
        typeof value === "number" &&
        (schema.type === "number" || Number.isInteger(value)) &&
        (schema.minimum === undefined || value >= schema.minimum) &&
        (schema.maximum === undefined || value <= schema.maximum)
      );
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}
/** One value a schema takes: every field, or only the required ones. */
function sample(schema: Schema, all: boolean): unknown {
  if (schema.anyOf?.length) return sample(schema.anyOf[0], all);
  if (schema.enum?.length) return schema.enum[0];
  switch (schema.type) {
    case "object":
      return Object.fromEntries(
        Object.entries(schema.properties ?? {})
          .filter(([key]) => all || schema.required?.includes(key))
          .map(([key, property]) => [key, sample(property, all)]),
      );
    case "array":
      return [sample(schema.items ?? {}, all)];
    case "integer":
    case "number":
      return schema.minimum ?? 1;
    case "boolean":
      return true;
    case "null":
      return null;
    default:
      return "x";
  }
}
/**
 * Operations of every branch under every offered type, each with its near
 * misses: a type that does not belong to the shape, a missing field, an extra
 * field, and a value from another branch's enum.
 */
function corpus(branches: readonly Schema[]): Record<string, unknown>[] {
  const types = [...new Set(operationTypes(branches))];
  const enums = new Map<string, Set<unknown>>();
  for (const branch of branches)
    for (const [key, property] of Object.entries(branch.properties ?? {}))
      if (key !== "type" && property.type === "string" && property.enum)
        for (const value of property.enum)
          enums.set(key, (enums.get(key) ?? new Set()).add(value));
  const values: Record<string, unknown>[] = [];
  for (const branch of branches)
    for (const all of [false, true]) {
      const base = sample(branch, all) as Record<string, unknown>;
      for (const type of types) {
        const typed: Record<string, unknown> = { ...base, type };
        values.push(typed);
        for (const key of Object.keys(typed)) {
          if (key === "type") continue;
          const { [key]: _dropped, ...without } = typed;
          values.push(without);
          for (const value of enums.get(key) ?? [])
            values.push({ ...typed, [key]: value });
        }
        for (const [key, set] of enums)
          if (!Object.hasOwn(typed, key))
            values.push({ ...typed, [key]: [...set][0] });
        values.push({ ...typed, unexpected: 1 });
      }
    }
  return values;
}
/** Values the sent schema and the offered forms disagree on, and how many both take. */
function acceptanceDifference(
  offered: readonly Schema[],
  sent: readonly Schema[],
) {
  const differing: unknown[] = [];
  let accepted = 0;
  for (const value of [...corpus(offered), ...corpus(sent)]) {
    const expected = accepts({ anyOf: [...offered] }, value);
    if (expected) accepted++;
    if (accepts({ anyOf: [...sent] }, value) !== expected)
      differing.push(value);
  }
  return { differing, accepted };
}
/** The fields of a schema that take a phone number: a target's number and each listed number. */
function phoneNumberFields(schema: Schema): Schema[] {
  const fields: Schema[] = [];
  const properties = schema.properties ?? {};
  if (properties.kind?.enum?.includes("number") && properties.number)
    fields.push(properties.number);
  if (properties.phoneNumbers?.items)
    fields.push(properties.phoneNumbers.items);
  for (const child of [
    ...Object.values(properties),
    ...(schema.items ? [schema.items] : []),
    ...(schema.anyOf ?? []),
  ])
    fields.push(...phoneNumberFields(child));
  return fields;
}

const agentId = "11111111-1111-4111-8111-111111111111";
const owner = "22222222-2222-4222-8222-222222222222";
const canonical = (name: string, contexts: string[]): Action =>
  ({
    name,
    description: `${name} canonical service.`,
    contexts,
    parameters: [],
    validate: async () => true,
    handler: async () => ({ success: true }),
  }) as unknown as Action;

type Turn = {
  text: string;
  view: string;
  selected?: Record<string, string>;
  capabilities?: readonly string[];
  /** The device tools the planner is shown. */
  tools?: readonly Action[];
  /**
   * The planner pipeline scopes every action for the turn before the context
   * assembly, which scopes what it is handed again.
   */
  scopedByPipeline?: boolean;
  /** Canonical services the runtime registers beside the device tools. */
  services?: readonly Action[];
  phase?: "planning" | "response";
};

afterEach(() => vi.restoreAllMocks());

/** One authenticated owner turn on the phone, assembled by the message service. */
async function ownerTurn(turn: Turn) {
  const capabilities = turn.capabilities ?? PHONE_CAPABILITIES;
  const runtime = {
    agentId,
    character: { name: "Alpha", bio: [], system: "Answer." },
    contexts: new ContextRegistry([
      { id: "general", description: "General tasks" },
    ]),
    actions: [
      ...(turn.services ?? [
        canonical("NOTES", ["notes"]),
        canonical("CALENDAR", ["calendar"]),
        canonical("OWNER_REMINDERS", ["tasks"]),
      ]),
      proposeDeviceAction,
      ...deviceActionTools,
    ],
    providers: [],
    getSetting: () => null,
    getService: () => null,
    getRoom: async () => null,
    getModelRegistrations: () => [],
    reportError: vi.fn(),
    logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  } as unknown as IAgentRuntime;
  const message = {
    id: "33333333-3333-4333-8333-333333333333",
    agentId,
    entityId: owner,
    roomId: "55555555-5555-4555-8555-555555555555",
    content: {
      text: turn.text,
      source: "client_chat",
      channelType: "DM",
      metadata: {
        viewDelivery: "completed-action",
        viewClientId: "44444444-4444-4444-8444-444444444444",
        clientDevice: {
          context: {
            revision: 1,
            view: turn.view,
            sensitive: false,
            timeZone: "America/Los_Angeles",
            ...(turn.selected ? { selectedObject: turn.selected } : {}),
          },
        },
      },
    },
  } as unknown as Memory;
  vi.spyOn(DeviceActionService.prototype, "viewProfile").mockResolvedValue({
    version: 1,
    revision: "1",
    views: PHONE_VIEWS,
  });
  return withDeviceActionTurn(
    runtime,
    {
      subjectUserId: "owner-subject",
      installationId: "installation",
      deviceKey: "key",
      capabilities,
    } as never,
    async () => {
      setDeviceActionRequestMessage(runtime, message);
      const scope = [
        capabilities,
        message.content.metadata,
        { runtime, message },
      ] as const;
      const tools = turn.tools ?? [proposeDeviceAction];
      const context = await createV5MessageContextObject({
        runtime,
        message,
        state: { values: {}, data: {}, text: "" },
        userRoles: ["OWNER"],
        includeTools: turn.phase !== "response",
        providerPhase: turn.phase ?? "planning",
        selectedContexts: ["general"],
        preselectedActions: turn.scopedByPipeline
          ? tools.map((tool) => deviceActionForCapabilities(tool, ...scope))
          : tools,
      } as never);
      const instruction = context.events.find(
        (event) => event.id === "authenticated-phone-capability",
      ) as unknown as { content: string } | undefined;
      const sent = context.events.find(
        (event) => event.id === "tool:PROPOSE_DEVICE_ACTION",
      ) as unknown as { tool: SentTool } | undefined;
      return {
        instruction: String(instruction?.content ?? ""),
        /** The tool as the message service put it in the planner's context. */
        sent: sent && {
          name: sent.tool.name,
          description: sent.tool.description,
          parameters: sent.tool.parameters,
        },
        /** The same tool, kept as an action. */
        action: deviceActionForCapabilities(proposeDeviceAction, ...scope),
        /** The registered forms this turn offers, before they are merged. */
        offered: offeredDeviceOperations(proposeDeviceAction, ...scope),
      };
    },
    {
      isCurrent: () => true,
      requestCaller: {
        subjectUserId: "owner-subject",
        entityId: owner as never,
        role: "OWNER",
      },
    },
  );
}

const HOME: Turn = { text: "call mom", view: "home" };
const BROWSER_TAB: Turn = {
  text: "close this tab",
  view: "browser",
  selected: { kind: "browser-tab", id: "tab-1", revision: "3" },
};
/** The phone's own Notes store is selected, so its exact-record operations apply. */
const PHONE_NOTES: Turn = {
  text: "read me the first note",
  view: "notes",
  selected: {
    kind: "note-source",
    id: "phone-notes",
    revision: "a".repeat(64),
  },
};
const OWNER_TURNS: readonly Turn[] = [
  HOME,
  { text: "am I free tomorrow afternoon?", view: "calendar" },
  { text: "call 415-555-0100", view: "maps" },
  BROWSER_TAB,
  PHONE_NOTES,
  {
    text: "show only my voice notes",
    view: "notes",
    selected: { kind: "canonical-note-source", id: "notes", revision: "12" },
  },
  { text: "delete the contact Old Landlord", view: "contacts" },
  { text: "read me this voicemail", view: "phone" },
  { text: "take a picture", view: "camera" },
  { text: "find the lease pdf in my downloads", view: "files" },
  { text: "reply for me: sounds good, see you then", view: "messages" },
];
const turnName = (turn: Turn) =>
  turn.selected ? `${turn.view} with a ${turn.selected.kind}` : turn.view;

describe("PROPOSE_DEVICE_ACTION as it is sent to a model", () => {
  it.each([
    ["the phone's capabilities", PHONE_CAPABILITIES],
    ["a phone without the second-version forms", OLDER_PHONE_CAPABILITIES],
    ["every capability a phone can negotiate", EVERY_PHONE_CAPABILITY],
    ["an Eliza Clock-only executor", ["clock.alarms.v1"]],
    ["a Clock-only executor", ["clock.handoff.v1"]],
    ["a Clock-only executor with repeat days", ["clock.handoff.v2"]],
    ["no capability", []],
    ["a connection that negotiated none", undefined],
  ] as const)(
    "accepts exactly the offered operation forms for %s",
    (_name, capabilities) => {
      const offered = offeredDeviceOperations(
        proposeDeviceAction,
        capabilities,
      );
      const sent = operationBranches(
        deviceActionForCapabilities(proposeDeviceAction, capabilities),
      );
      const { differing, accepted } = acceptanceDifference(offered, sent);
      expect(differing.slice(0, 3)).toEqual([]);
      expect(accepted).toBeGreaterThan(0);
      expect(new Set(operationTypes(sent))).toEqual(
        new Set(operationTypes(offered)),
      );
      expect(sent.length).toBeLessThanOrEqual(offered.length);
    },
  );

  it("gets the verdict from argument validation that the offered forms get", () => {
    // A planned call is validated against the action the turn was scoped to,
    // so the merged branches are what decides whether its arguments run.
    const offered = offeredDeviceOperations(
      proposeDeviceAction,
      PHONE_CAPABILITIES,
    );
    const sent = deviceActionForCapabilities(
      proposeDeviceAction,
      PHONE_CAPABILITIES,
    );
    const unmerged: Action = {
      ...proposeDeviceAction,
      parameters: proposeDeviceAction.parameters?.map((parameter) =>
        parameter.name === "operation"
          ? { ...parameter, schema: { anyOf: offered } }
          : parameter,
      ),
    };
    const valid = (action: Action, operation: unknown) =>
      validateToolArgs(action, {
        operation,
        operationKey: "requested-operation",
        reason: "The owner asked for it",
      }).valid;
    // Every operation the offered forms take, and one near miss in seventeen:
    // the validator is far slower than the comparison above.
    const operations = [
      ...corpus(offered),
      ...corpus(operationBranches(sent)),
    ].filter(
      (operation, index) =>
        index % 17 === 0 || accepts({ anyOf: offered }, operation),
    );
    const verdicts = operations.map((operation) => valid(sent, operation));
    expect(
      operations
        .filter(
          (operation, index) => valid(unmerged, operation) !== verdicts[index],
        )
        .slice(0, 3),
    ).toEqual([]);
    expect(verdicts.filter(Boolean).length).toBeGreaterThan(100);
    expect(verdicts.filter((verdict) => !verdict).length).toBeGreaterThan(100);
  });

  it("shares a branch between forms that take the same arguments", () => {
    const offered = offeredDeviceOperations(
      proposeDeviceAction,
      PHONE_CAPABILITIES,
    );
    const sent = operationBranches(
      deviceActionForCapabilities(proposeDeviceAction, PHONE_CAPABILITIES),
    );
    expect(sent.length).toBeLessThan(offered.length);
    const sharing = (type: string) =>
      sent.find((branch) => operationTypes([branch]).includes(type));
    expect(operationTypes([sharing("phone_dial") ?? {}])).toEqual([
      "phone_dial",
      "phone_call",
    ]);
    // The two Clock set forms differ only in whether days is given.
    const set = sent.filter((branch) =>
      branch.properties?.action?.enum?.includes("set"),
    );
    expect(set).toHaveLength(1);
    expect(set[0].properties?.days).toBeDefined();
    expect(set[0].required).not.toContain("days");
    // A form with arguments of its own keeps its own branch. The message
    // service narrows open_view to the enrolled views by finding that branch.
    for (const type of ["sms_compose", "open_view"])
      expect(operationTypes([sharing(type) ?? {}])).toEqual([type]);
  });

  it("keeps every field required for a Clock-only executor, whose union can be a strict grammar", () => {
    const sent = operationBranches(
      deviceActionForCapabilities(proposeDeviceAction, ["clock.handoff.v2"]),
    );
    for (const branch of sent)
      expect(new Set(branch.required)).toEqual(
        new Set(Object.keys(branch.properties ?? {})),
      );
    // So setting an alarm keeps one form with days and one without.
    expect(
      sent.filter((branch) => branch.properties?.action?.enum?.includes("set")),
    ).toHaveLength(2);
    expect(sent).toHaveLength(4);
  });

  it("is compared on operations that tell a wider or a narrower branch apart", () => {
    const offered = offeredDeviceOperations(
      proposeDeviceAction,
      PHONE_CAPABILITIES,
    );
    const sent = operationBranches(
      deviceActionForCapabilities(proposeDeviceAction, PHONE_CAPABILITIES),
    );
    const changed = (
      type: string,
      change: (branch: Schema) => Schema,
    ): Schema[] =>
      sent.map((branch) =>
        operationTypes([branch]).includes(type) &&
        (type !== "clock_handoff" || branch.properties?.days)
          ? change(branch)
          : branch,
      );
    // A keypad takes an optional number; the latest-sender read takes nothing.
    const wider = changed("phone_keypad", (branch) => ({
      ...branch,
      properties: {
        ...branch.properties,
        type: { type: "string", enum: ["phone_keypad", "sms_latest_sender"] },
      },
    }));
    expect(acceptanceDifference(offered, wider).differing).toContainEqual({
      type: "sms_latest_sender",
      number: "x",
    });
    // A one-off alarm is set without days.
    const narrower = changed("clock_handoff", (branch) => ({
      ...branch,
      required: [...(branch.required ?? []), "days"],
    }));
    expect(acceptanceDifference(offered, narrower).differing).not.toEqual([]);
  });

  it.each(OWNER_TURNS.map((turn) => [turnName(turn), turn] as const))(
    "offers and accepts exactly the registered operation forms on an owner turn in %s",
    async (_name, turn) => {
      const { sent, action, offered } = await ownerTurn(turn);
      const branches = sentBranches(sent);
      // What is measured below is what the message service sent.
      expect(sent).toEqual(asSent(action));
      const { differing, accepted } = acceptanceDifference(offered, branches);
      expect(differing.slice(0, 3)).toEqual([]);
      expect(accepted).toBeGreaterThan(100);
      expect(new Set(operationTypes(branches))).toEqual(
        new Set(operationTypes(offered)),
      );
      expect(branches.length).toBeLessThan(offered.length);
    },
  );

  it("offers a selected phone note its exact-record operations", async () => {
    const { offered, action } = await ownerTurn(PHONE_NOTES);
    for (const branches of [offered, operationBranches(action)])
      expect(operationTypes(branches)).toEqual(
        expect.arrayContaining([
          "notes_read_selected",
          "notes_update",
          "notes_delete",
        ]),
      );
  });

  it.each([
    ["the phone's capabilities alone", undefined],
    ...OWNER_TURNS.map((turn) => [turnName(turn), turn] as const),
  ] as const)(
    "says in full how a phone number is written on every field that takes one, for %s",
    async (_name, turn) => {
      const branches = turn
        ? sentBranches((await ownerTurn(turn)).sent)
        : operationBranches(
            deviceActionForCapabilities(
              proposeDeviceAction,
              PHONE_CAPABILITIES,
            ),
          );
      // A call or dial target, a text target, a new contact's numbers, and the
      // numbers a contact change sets, adds and removes.
      const fields = phoneNumberFields({ anyOf: branches });
      expect(fields).toHaveLength(6);
      for (const field of fields)
        expect(field.description).toBe(PHONE_NUMBER_RULE);
      for (const type of [
        "phone_dial",
        "phone_call",
        "sms_compose",
        "contact_create",
        "contact_update",
      ]) {
        const [branch, ...others] = branches.filter((candidate) =>
          operationTypes([candidate]).includes(type),
        );
        expect(others).toEqual([]);
        expect(phoneNumberFields(branch).length).toBeGreaterThan(0);
      }
      // The keypad's optional number states its own form.
      expect(
        branches.find((branch) =>
          operationTypes([branch]).includes("phone_keypad"),
        )?.properties?.number.description,
      ).toBe(
        "Optional number to fill in. 2 to 20 digits with an optional leading +. Leave out for an empty keypad.",
      );
    },
  );

  it("is the same bytes for two requests in the same view", async () => {
    for (const [turn, other] of [
      [HOME, "what's Alex's number?"],
      [BROWSER_TAB, "go back"],
    ] as const) {
      const [first, second, again] = [
        await ownerTurn(turn),
        await ownerTurn({ ...turn, text: other }),
        await ownerTurn(turn),
      ];
      expect(JSON.stringify(second.sent)).toBe(JSON.stringify(first.sent));
      expect(JSON.stringify(again.sent)).toBe(JSON.stringify(first.sent));
      expect(again.instruction).toBe(first.instruction);
    }
  });

  it("is the same bytes when the planner pipeline has already scoped the action for the turn", async () => {
    for (const turn of [HOME, PHONE_NOTES]) {
      const registered = await ownerTurn(turn);
      const scoped = await ownerTurn({ ...turn, scopedByPipeline: true });
      expect(JSON.stringify(scoped.sent)).toBe(JSON.stringify(registered.sent));
      expect(scoped.instruction).toBe(registered.instruction);
    }
    // Every form a phone can be offered, reminders and exact records included.
    for (const capabilities of [PHONE_CAPABILITIES, EVERY_PHONE_CAPABILITY]) {
      const once = deviceActionForCapabilities(
        proposeDeviceAction,
        capabilities,
      );
      expect(
        JSON.stringify(asSent(deviceActionForCapabilities(once, capabilities))),
      ).toBe(JSON.stringify(asSent(once)));
    }
  });

  it("drops only the operations a narrower scope lacks from a branch several forms share", () => {
    const narrower = PHONE_CAPABILITIES.filter(
      (capability) => capability !== "voicemail.delete.v1",
    );
    const direct = operationBranches(
      deviceActionForCapabilities(proposeDeviceAction, narrower),
    );
    const again = operationBranches(
      deviceActionForCapabilities(
        deviceActionForCapabilities(proposeDeviceAction, PHONE_CAPABILITIES),
        narrower,
      ),
    );
    expect(operationTypes(again)).not.toContain("voicemail_delete_selected");
    // The reads that shared its branch are still offered.
    expect(new Set(operationTypes(again))).toEqual(
      new Set(operationTypes(direct)),
    );
    expect(acceptanceDifference(direct, again).differing.slice(0, 3)).toEqual(
      [],
    );
  });

  it("offers a one-off Clock set when a scoped action is narrowed to a phone that cannot repeat alarms", () => {
    const narrower = PHONE_CAPABILITIES.filter(
      (capability) => capability !== "clock.handoff.v2",
    );
    expect(PHONE_CAPABILITIES).toContain("clock.handoff.v2");
    const direct = operationBranches(
      deviceActionForCapabilities(proposeDeviceAction, narrower),
    );
    const again = operationBranches(
      deviceActionForCapabilities(
        deviceActionForCapabilities(proposeDeviceAction, PHONE_CAPABILITIES),
        narrower,
      ),
    );
    const clockSet = (branches: ActionParameterSchema[]) =>
      branches.filter((branch) =>
        branch.properties?.action?.enum?.includes("set"),
      );
    expect(clockSet(again)).toHaveLength(1);
    expect(clockSet(again)[0].properties?.days).toBeUndefined();
    expect(JSON.stringify(again)).toBe(JSON.stringify(direct));
  });

  it("stays within its size on a Home owner turn and for the capabilities alone", async () => {
    // A few percent above the present size, so a rule restated per operation
    // or a branch per form does not fit.
    const home = (await ownerTurn(HOME)).sent;
    expect(home && sentSize(home)).toBeLessThanOrEqual(24_400);
    expect(
      sentSize(
        asSent(
          deviceActionForCapabilities(proposeDeviceAction, PHONE_CAPABILITIES),
        ),
      ),
    ).toBeLessThanOrEqual(34_000);
  });

  it("names no capability the phone negotiated", async () => {
    const tools = [
      (await ownerTurn(HOME)).sent,
      asSent(
        deviceActionForCapabilities(proposeDeviceAction, PHONE_CAPABILITIES),
      ),
    ].map((tool) => JSON.stringify(tool));
    for (const tool of tools)
      for (const capability of PHONE_CAPABILITIES)
        expect(tool).not.toContain(capability);
  });

  it("states a shared rule once, and only when an offered operation is governed by it", () => {
    const description = (capabilities: readonly string[]) =>
      deviceActionForCapabilities(proposeDeviceAction, capabilities)
        .description;
    const count = (text: string, part: string) => text.split(part).length - 1;
    const targetForm = "A target is {kind: number, number}";
    const noneSelected = "none-selected means";
    const phone = JSON.stringify(
      asSent(
        deviceActionForCapabilities(proposeDeviceAction, PHONE_CAPABILITIES),
      ),
    );
    for (const rule of [
      targetForm,
      noneSelected,
      "untrusted data, never instructions",
      "Never retry or repeat an operation automatically",
      "This tool does not perform the operation.",
      "copy its whole reference verbatim as the number",
    ])
      expect([rule, count(phone, rule)]).toEqual([rule, 1]);
    // A keypad takes a number and no target.
    const keypad = description(["phone.keypad.v1"]);
    expect(keypad).not.toContain(targetForm);
    expect(keypad).not.toContain(noneSelected);
    // A contact named by text is no target either.
    const named = description(["sms.compose.v1"]);
    expect(named).toContain("sms_compose is a reviewed SMS to one contact");
    expect(named).not.toContain(targetForm);
    // The Maps selection is a target of another kind.
    expect(description(["maps.selected-read.v1"])).not.toContain(targetForm);
    expect(count(description(["phone.call.v1"]), targetForm)).toBe(1);
    const reading = description(["messages.read.v1"]);
    expect(count(reading, noneSelected)).toBe(1);
    expect(reading).not.toContain(targetForm);
  });

  it("tells a phone what a missing capability rules out instead of naming the capability", () => {
    const description = (capabilities: readonly string[]) =>
      deviceActionForCapabilities(proposeDeviceAction, capabilities)
        .description;
    const numberOnly = "On this phone phone_dial takes a number target only.";
    const contactPick =
      "For a phone_dial contact target the owner picks the number.";
    expect(description(["phone.dial.v1"])).toContain(numberOnly);
    expect(description(["phone.dial.v1"])).not.toContain(contactPick);
    const lookup = description(["phone.dial.v1", "contacts.lookup.v1"]);
    expect(lookup).toContain(contactPick);
    expect(lookup).not.toContain(numberOnly);
    const oneOff = "This phone supports only a one-off set without days.";
    expect(description(["clock.handoff.v1"])).toContain(oneOff);
    expect(description(["clock.handoff.v2"])).not.toContain(oneOff);
    // A connection that negotiated no list is offered days, so it is not told otherwise.
    const unnegotiated = deviceActionForCapabilities(proposeDeviceAction);
    expect(
      operationBranches(unnegotiated).some((branch) => branch.properties?.days),
    ).toBe(true);
    expect(unnegotiated.description).not.toContain(oneOff);
    const noSecondTiming =
      "This phone does not take timingVersion 2 targets or schedules with dueAt plus alertMinutes.";
    expect(description(["reminders.local-record.v1"])).toContain(
      noSecondTiming,
    );
    expect(description(["reminders.local-record.v2"])).not.toContain(
      noSecondTiming,
    );
  });

  it("gives a Clock-only executor the rules every operation shares", () => {
    const { description } = deviceActionForCapabilities(proposeDeviceAction, [
      "clock.handoff.v1",
    ]);
    for (const rule of [
      "This connection supports only the Clock handoff operations in this schema.",
      "The phone owner must explicitly review and approve",
      "This tool does not perform the operation. Do not report the proposal as completed.",
      "Never invent the phone timezone or substitute an approximate reminder for an alarm",
    ])
      expect(description).toContain(rule);
  });

  it("leaves the registered forms to the single-operation tools", () => {
    const registered = JSON.stringify(proposeDeviceAction.parameters);
    deviceActionForCapabilities(proposeDeviceAction, PHONE_CAPABILITIES);
    expect(JSON.stringify(proposeDeviceAction.parameters)).toBe(registered);
    // One operation per registered branch is how a single-operation tool
    // finds its form, and its fields describe themselves.
    for (const branch of operationBranches(proposeDeviceAction))
      expect(operationTypes([branch])).toHaveLength(1);
    for (const tool of deviceActionTools)
      expect(new Set(operationTypes(operationBranches(tool))).size).toBe(1);
    const search = deviceActionTools.find(
      (tool) => tool.name === "DEVICE_BROWSER_SEARCH",
    );
    expect(
      search && operationBranches(search)[0].properties?.query.description,
    ).toBe("The search words exactly as the user typed them in this message");
  });
});

describe("merging operation branches", () => {
  const text: Schema = { type: "string" };
  const branch = (
    type: string,
    fields: Record<string, Schema> = {},
    required = ["type", ...Object.keys(fields)],
  ): Schema => ({
    type: "object",
    additionalProperties: false,
    required,
    properties: { type: { type: "string", enum: [type] }, ...fields },
  });

  it("merges only branches whose whole difference is one field's values or one optional field", () => {
    for (const apart of [
      // A field of another type.
      [branch("a", { n: text }), branch("b", { n: { type: "integer" } })],
      // A field described differently.
      [
        branch("a", { n: { ...text, description: "A name" } }),
        branch("b", { n: { ...text, description: "A number" } }),
      ],
      // The same field, required by one and optional in the other.
      [branch("a", { n: text }), branch("b", { n: text }, ["type"])],
      // A branch that takes undeclared fields.
      [branch("a"), { ...branch("b"), additionalProperties: true }],
      // A longer branch that is also another operation.
      [branch("a"), branch("b", { n: text })],
      // Two more fields.
      [branch("a"), branch("a", { n: text, m: text })],
      // One more field that the longer branch leaves optional.
      [branch("a"), branch("a", { n: text }, ["type"])],
      // Something stated beside the fields.
      [branch("a"), { ...branch("b"), description: "Reviewed" }],
    ])
      expect(mergeOperationBranches(apart)).toEqual(apart);
  });

  it("gives no optional field to a union in which every field is required", () => {
    // Such a union can be decoded as a strict grammar; an optional field ends that.
    const pair = [branch("a"), branch("a", { n: text })];
    expect(mergeOperationBranches(pair)).toEqual(pair);
    const optional = branch("b", { m: text }, ["type"]);
    expect(mergeOperationBranches([...pair, optional])).toEqual([
      branch("a", { n: text }, ["type"]),
      optional,
    ]);
  });

  it("keeps a merged branch where its first member was, with the members in order", () => {
    expect(
      mergeOperationBranches([
        branch("a"),
        branch("x", { n: text }),
        branch("b"),
        branch("x"),
        branch("c"),
      ]),
    ).toEqual([
      {
        ...branch("a"),
        properties: { type: { type: "string", enum: ["a", "b", "x", "c"] } },
      },
      branch("x", { n: text }),
    ]);
  });
});

describe("the planner's phone capability instruction", () => {
  const selectedReminders = "Selected reminder read/update/complete";
  const selectedNotes = "Notes capability notes.local-record.v1 supports";
  const selectedEvents = "Calendar capability calendar.local-event.v1 is";
  const count = (text: string, part: string) => text.split(part).length - 1;

  it("explains a selected-record operation only on a turn where a device tool offers it", async () => {
    const home = (await ownerTurn(HOME)).instruction;
    for (const paragraph of [selectedReminders, selectedNotes, selectedEvents])
      expect(home).not.toContain(paragraph);
    // What a turn without the selection needs is still said.
    expect(home).toContain("No native note is selected in this turn.");
    expect(home).toContain(
      "Device reminder tools apply only to an explicitly selected native reminder source/record.",
    );
    const phoneNotes = (await ownerTurn(PHONE_NOTES)).instruction;
    expect(phoneNotes).toContain(selectedNotes);
    expect(phoneNotes).not.toContain(selectedReminders);
  });

  it("explains it when only a single-operation tool offers the operation", async () => {
    const tool = (name: string) =>
      deviceActionTools.filter((action) => action.name === name);
    const reminder = await ownerTurn({
      ...HOME,
      tools: tool("DEVICE_REMINDER_UPDATE"),
    });
    expect(reminder.instruction).toContain(selectedReminders);
    expect(reminder.instruction).toContain("Snooze means ten minutes");
    expect(reminder.instruction).not.toContain(selectedEvents);
    const event = await ownerTurn({
      ...HOME,
      tools: tool("DEVICE_CALENDAR_READ_SELECTED"),
    });
    expect(event.instruction).toContain(selectedEvents);
    expect(event.instruction).not.toContain(selectedReminders);
  });

  it("states who owns each store once", async () => {
    const { instruction } = await ownerTurn(HOME);
    expect(count(instruction, "Ordinary app Notes use")).toBe(1);
    expect(count(instruction, "the canonical CALENDAR service")).toBe(1);
    expect(count(instruction, "Ordinary reminders")).toBe(1);
    expect(count(instruction, "does not change")).toBe(1);
    // The boundaries no other sentence states are kept.
    expect(instruction).toContain(
      "native records must never fall back to runtime Notes records",
    );
    expect(instruction).toContain(
      "An explicit typed native Calendar source/event selection must not fall back to runtime records.",
    );
  });

  it("keeps the fixed ownership sentences where no device tool guidance states the rule", async () => {
    const { instruction } = await ownerTurn({ ...HOME, services: [] });
    for (const sentence of [
      "Use canonical NOTES for ordinary app Notes work.",
      "Use canonical app Calendar tools for ordinary app Calendar work.",
      "Notes or Calendar capability enrollment alone does not change record ownership.",
      "Ordinary app Notes use canonical NOTES, its owner-scoped runtime service/store and existing context.",
      "Ordinary app Calendar work uses the canonical CALENDAR service/store",
      "Ordinary reminders retain their canonical runtime-owned store",
    ])
      expect(instruction).toContain(sentence);
  });

  it("states the relationship-record boundary once, while routing and while planning", async () => {
    const boundary = "ENTITY and CONTACT";
    for (const phase of ["response", "planning"] as const) {
      const withAddressBook = (await ownerTurn({ ...HOME, phase })).instruction;
      expect(count(withAddressBook, boundary)).toBe(1);
      expect(withAddressBook).toContain(
        "ENTITY and CONTACT are the assistant's own relationship records, never the phone's address book, and never write it.",
      );
      // Without the address-book paragraph the route paragraph states it.
      const withoutAddressBook = (
        await ownerTurn({
          ...HOME,
          phase,
          capabilities: PHONE_CAPABILITIES.filter(
            (capability) => !capability.startsWith("contacts.write."),
          ),
        })
      ).instruction;
      expect(withoutAddressBook).toContain(
        "ENTITY and CONTACT are the assistant's own relationship records, never the phone's address book.",
      );
      expect(count(withoutAddressBook, boundary)).toBe(1);
    }
  });

  it("stays within its size on a Home owner turn", async () => {
    // A few percent above the present size, so a paragraph for an operation
    // the turn does not offer does not fit.
    expect((await ownerTurn(HOME)).instruction.length).toBeLessThanOrEqual(
      7_530,
    );
  });
});

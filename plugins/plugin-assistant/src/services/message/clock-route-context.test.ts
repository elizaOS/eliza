/**
 * A phone that negotiated a Clock capability sets, dismisses and snoozes its
 * alarms only through PROPOSE_DEVICE_ACTION, which the planner is offered in
 * the general context. "Wake me at 6:30 tomorrow" names no alarm: the first
 * stage routed it as a tasks request, where the planner had reminder, calendar
 * and trigger tools and no device tool, and a planner that did have the device
 * tool proposed a reminder. These tests pin the sentence that names the alarm
 * operation and its context wherever the first stage and the planner read it,
 * and the device tool's own rule for a request to be woken.
 */
import {
  type Action,
  ContextRegistry,
  type IAgentRuntime,
  type Memory,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deviceActionForCapabilities,
  proposeDeviceAction,
} from "../device-actions/action.ts";
import {
  DeviceActionService,
  setDeviceActionRequestMessage,
  withDeviceActionTurn,
} from "../device-actions/service.ts";
import { createV5MessageContextObject } from "./context-assembly.ts";

/** A phone with reminders, calendar, calls and texts, and no Clock. */
const WITHOUT_CLOCK = [
  "calendar.local-event.v1",
  "calendar.create.v1",
  "notes.local-record.v1",
  "reminders.local-record.v2",
  "reminders.create.v1",
  "phone.call.v1",
  "sms.compose.v1",
];
/** Each Clock negotiation and the one alarm operation it offers. */
const CLOCK_PHONES: ReadonlyArray<
  readonly [name: string, clock: readonly string[], operation: string]
> = [
  ["a Clock handoff", ["clock.handoff.v1"], "clock_handoff"],
  [
    "a Clock handoff with repeat days",
    ["clock.handoff.v1", "clock.handoff.v2"],
    "clock_handoff",
  ],
  ["its own alarms", ["clock.alarms.v1"], "clock_alarm"],
  // Owned alarms replace the handoff on a phone that advertises both.
  [
    "its own alarms beside a handoff",
    ["clock.alarms.v1", "clock.handoff.v2"],
    "clock_alarm",
  ],
];
const OPERATIONS = ["clock_handoff", "clock_alarm"];
const wakeRoute = (operation: string) =>
  `an alarm on this phone, including a request to be woken at a time, goes through PROPOSE_DEVICE_ACTION ${operation} in the general context.`;
const NOT_AN_ALARM =
  "A reminder, to-do, timer or calendar event is not an alarm.";
const WOKEN_IS_A_SET =
  "A request to be woken at a time is an alarm set, not a reminder.";
const count = (text: string, part: string) => text.split(part).length - 1;

const agentId = "11111111-1111-4111-8111-111111111111";
const owner = "22222222-2222-4222-8222-222222222222";
const ownerReminders = {
  name: "OWNER_REMINDERS",
  description: "Create a reminder in the owner's task store.",
  contexts: ["tasks"],
  parameters: [],
  validate: async () => true,
  handler: async () => ({ success: true }),
} as unknown as Action;

afterEach(() => vi.restoreAllMocks());

/** The phone capability instruction of one authenticated owner turn at Home. */
async function instruction(
  capabilities: readonly string[],
  stage: "first stage" | "planner" | "planner routed as tasks",
): Promise<string> {
  const runtime = {
    agentId,
    character: { name: "Alpha", bio: [], system: "Answer." },
    contexts: new ContextRegistry([
      { id: "general", description: "General tasks" },
      { id: "tasks", description: "Todos and reminders" },
    ]),
    actions: [ownerReminders, proposeDeviceAction],
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
      text: "Wake me at 6:30 tomorrow.",
      source: "client_chat",
      channelType: "DM",
      metadata: {
        viewDelivery: "completed-action",
        viewClientId: "44444444-4444-4444-8444-444444444444",
        clientDevice: {
          context: {
            revision: 1,
            view: "home",
            sensitive: false,
            timeZone: "America/Los_Angeles",
          },
        },
      },
    },
  } as unknown as Memory;
  vi.spyOn(DeviceActionService.prototype, "viewProfile").mockResolvedValue({
    version: 1,
    revision: "1",
    views: ["home", "reminders", "calendar"],
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
      const context = await createV5MessageContextObject({
        runtime,
        message,
        state: { values: {}, data: {}, text: "" },
        userRoles: ["OWNER"],
        includeTools: stage !== "first stage",
        providerPhase: stage === "first stage" ? "response" : "planning",
        ...(stage === "first stage"
          ? {}
          : stage === "planner"
            ? {
                selectedContexts: ["general"],
                preselectedActions: [proposeDeviceAction],
              }
            : {
                selectedContexts: ["tasks"],
                preselectedActions: [ownerReminders],
              }),
      } as never);
      // The planner routed as tasks is the turn the device tool is absent from.
      expect(
        context.events.some(
          (event) => event.id === "tool:PROPOSE_DEVICE_ACTION",
        ),
      ).toBe(stage === "planner");
      const event = context.events.find(
        (event) => event.id === "authenticated-phone-capability",
      ) as unknown as { content: string } | undefined;
      return String(event?.content ?? "");
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

describe("the Clock route in the phone capability instruction", () => {
  it.each(CLOCK_PHONES)(
    "sends a request to be woken on a phone with %s to its alarm operation in the general context",
    async (_name, clock, operation) => {
      const other = OPERATIONS.find((type) => type !== operation) as string;
      for (const capabilities of [[...WITHOUT_CLOCK, ...clock], clock])
        for (const stage of [
          "first stage",
          "planner",
          "planner routed as tasks",
        ] as const) {
          const text = await instruction(capabilities, stage);
          expect([stage, count(text, wakeRoute(operation))]).toEqual([
            stage,
            1,
          ]);
          expect([stage, count(text, NOT_AN_ALARM)]).toEqual([stage, 1]);
          // Only the operation this phone can be sent is named as the route.
          expect(text).not.toContain(wakeRoute(other));
        }
    },
  );

  it("names what each alarm operation can do and nothing it cannot", async () => {
    // A handoff asks the system Clock, which takes no change or deletion of
    // one alarm; the phone's own alarms take both.
    const handoff = await instruction(
      [...WITHOUT_CLOCK, "clock.handoff.v2"],
      "first stage",
    );
    expect(handoff).toContain(
      `Setting, dismissing or snoozing ${wakeRoute("clock_handoff")}`,
    );
    const owned = await instruction(
      [...WITHOUT_CLOCK, "clock.alarms.v1"],
      "first stage",
    );
    expect(owned).toContain(
      `Setting, changing, deleting, dismissing or snoozing ${wakeRoute("clock_alarm")}`,
    );
  });

  it("says nothing of alarms to a phone that negotiated no Clock capability", async () => {
    for (const stage of [
      "first stage",
      "planner",
      "planner routed as tasks",
    ] as const) {
      const text = await instruction(WITHOUT_CLOCK, stage);
      expect(text).not.toContain("woken");
      expect(text).not.toContain("is not an alarm");
      for (const operation of OPERATIONS)
        expect(text).not.toContain(`PROPOSE_DEVICE_ACTION ${operation}`);
    }
  });

  it("names a context the device tool is offered in", () => {
    expect(proposeDeviceAction.contexts).toContain("general");
  });
});

describe("the device tool's rule for a request to be woken", () => {
  const description = (capabilities: readonly string[]) =>
    deviceActionForCapabilities(proposeDeviceAction, capabilities).description;

  it.each(CLOCK_PHONES)(
    "is stated once beside the reminder operations of a phone with %s",
    (_name, clock, operation) => {
      const text = description([...WITHOUT_CLOCK, ...clock]);
      // The reminder forms the planner proposed instead are offered beside it.
      expect(text).toContain("reminder_create");
      expect(text).toContain(operation);
      expect(count(text, WOKEN_IS_A_SET)).toBe(1);
    },
  );

  it("is not stated to a phone that negotiated no Clock capability", () => {
    expect(description(WITHOUT_CLOCK)).not.toContain("woken");
  });
});

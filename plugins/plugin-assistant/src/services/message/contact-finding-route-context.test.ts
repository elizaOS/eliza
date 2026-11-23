/**
 * "Ping my brother" and "ring the dentist" ask for a text and a call and name
 * the person by a role. The first stage read them as a contact lookup and
 * chose the contacts context, and a planner that had the device tool proposed
 * contact_show, which returns nothing a call or text can use. phone_call and
 * sms_compose take the owner's words as the contact to find. These tests pin
 * the sentence that says so wherever the first stage and the planner read the
 * phone routes, the device tool's own rule, and that a phone is told each only
 * of the operations it negotiated.
 */
import {
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

const CALL = "phone.call.v1";
/** A text to a contact named by text. */
const TEXT_BY_NAME = "sms.compose.v1";
/** The same text with a target, which is a contact or a number. */
const TEXT_BY_TARGET = [TEXT_BY_NAME, "sms.compose.v2"];
const SHOW = "contacts.show.v1";

const BY_ROLE =
  "from the owner's words, a name or a role or relation such as my brother or the dentist,";
const NO_LOOKUP = "never needs a contact lookup first.";
const route = {
  both: `phone_call and sms_compose find the contact themselves ${BY_ROLE} so a call or text ${NO_LOOKUP}`,
  call: `phone_call finds the contact itself ${BY_ROLE} so a call ${NO_LOOKUP}`,
  text: `sms_compose finds the contact itself ${BY_ROLE} so a text ${NO_LOOKUP}`,
};
const REVIEWED =
  "The owner reviews each call, text and contact change on the phone.";

const TARGET_FORM = "its number is never returned.";
// The query is the role word alone: with the owner's phrase as the example the
// model wrote "my mom" and "the dentist", which the address book does not hold.
const QUERY_IS_ROLE_WORD =
  "the query is that word alone, brother for my brother or dentist for the dentist.";
const AT_ONCE = `at once with a contact target, also when the owner names them by a role or relation: ${QUERY_IS_ROLE_WORD} The phone finds the contact and the owner picks when several match.`;
const rule = {
  both: `To call or text a person, propose phone_call or sms_compose ${AT_ONCE}`,
  call: `To call a person, propose phone_call ${AT_ONCE}`,
  text: `To text a person, propose sms_compose ${AT_ONCE}`,
};
const NO_SHOW_FIRST = "Never propose contact_show first to look them up.";
const count = (text: string, part: string) => text.split(part).length - 1;

const agentId = "11111111-1111-4111-8111-111111111111";
const owner = "22222222-2222-4222-8222-222222222222";

afterEach(() => vi.restoreAllMocks());

/** The phone capability instruction of one authenticated owner turn at Home. */
async function instruction(
  capabilities: readonly string[],
  stage: "first stage" | "planner",
): Promise<string> {
  const runtime = {
    agentId,
    character: { name: "Alpha", bio: [], system: "Answer." },
    contexts: new ContextRegistry([
      { id: "general", description: "General tasks" },
      { id: "contacts", description: "People and address books" },
    ]),
    actions: [proposeDeviceAction],
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
      text: "Ping my brother and say happy birthday.",
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
    views: ["home", "phone", "messages", "contacts"],
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
        includeTools: stage === "planner",
        providerPhase: stage === "planner" ? "planning" : "response",
        ...(stage === "planner"
          ? {
              selectedContexts: ["general"],
              preselectedActions: [proposeDeviceAction],
            }
          : {}),
      } as never);
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

describe("the contact a call or text finds, in the phone capability instruction", () => {
  const STAGES = ["first stage", "planner"] as const;

  it.each(STAGES)(
    "is said once to the %s, among the phone routes and before the owner's review",
    async (stage) => {
      const text = await instruction(
        [CALL, ...TEXT_BY_TARGET, SHOW, "phone.keypad.v1"],
        stage,
      );
      expect(count(text, NO_LOOKUP)).toBe(1);
      // The routes end in a full stop, and the sentence follows them.
      expect(text).toContain(`. ${route.both} ${REVIEWED}`);
    },
  );

  it.each([
    ["only calls a contact", [CALL, SHOW], route.call],
    // A contact named by text is found by the phone as a target is.
    ["only texts a contact by name", [TEXT_BY_NAME, SHOW], route.text],
    ["only texts a target", [...TEXT_BY_TARGET, SHOW], route.text],
    ["calls and texts by name", [CALL, TEXT_BY_NAME], route.both],
  ] as const)(
    "names the operations of a phone that %s",
    async (_name, capabilities, sentence) => {
      for (const stage of STAGES) {
        const text = await instruction(capabilities, stage);
        expect([stage, count(text, NO_LOOKUP)]).toEqual([stage, 1]);
        expect(text).toContain(`. ${sentence} ${REVIEWED}`);
      }
    },
  );

  it("is not said to a phone whose call and text take only a number", async () => {
    // A dial handoff and a SIM send find no contact; the routes are still named.
    for (const stage of STAGES) {
      const text = await instruction(
        ["phone.dial.v1", "sms.send.v1", SHOW, "phone.keypad.v1"],
        stage,
      );
      expect(text).toContain(REVIEWED);
      expect(text).not.toContain("contact lookup first");
      expect(text).not.toContain("my brother");
    }
  });
});

describe("the device tool's rule for a person named by a role", () => {
  const description = (capabilities: readonly string[]) =>
    deviceActionForCapabilities(proposeDeviceAction, capabilities).description;

  it("follows the target form once, with the lookup it replaces, on a phone that calls, texts and shows contacts", () => {
    const text = description([CALL, ...TEXT_BY_TARGET, SHOW]);
    expect(text).toContain(`${TARGET_FORM} ${rule.both} ${NO_SHOW_FIRST}`);
    expect(count(text, AT_ONCE)).toBe(1);
    expect(count(text, NO_SHOW_FIRST)).toBe(1);
  });

  it.each([
    ["only calls", [CALL, SHOW], rule.call],
    ["only texts a target", [...TEXT_BY_TARGET, SHOW], rule.text],
    // sms_compose named by text takes a query, which is no contact target.
    ["calls, and texts by name", [CALL, TEXT_BY_NAME, SHOW], rule.call],
  ] as const)(
    "names only the operations offered with a contact target on a phone that %s",
    (_name, capabilities, sentence) => {
      const text = description(capabilities);
      expect(text).toContain(`${TARGET_FORM} ${sentence} ${NO_SHOW_FIRST}`);
      expect(count(text, AT_ONCE)).toBe(1);
    },
  );

  it("gives the role word alone as the query, never the owner's phrase for it", () => {
    for (const capabilities of [
      [CALL, ...TEXT_BY_TARGET, SHOW],
      [CALL, SHOW],
      [...TEXT_BY_TARGET, SHOW],
    ]) {
      const text = description(capabilities);
      expect(count(text, QUERY_IS_ROLE_WORD)).toBe(1);
      // "my brother" appears only as what the owner says, beside its query.
      expect(count(text, "my brother")).toBe(1);
      expect(count(text, "the dentist")).toBe(1);
      expect(text).not.toContain("such as my brother or the dentist");
    }
  });

  it("is not stated to a phone offered no call or text with a contact target", () => {
    for (const capabilities of [
      // A text to a contact named by text, and its own paragraph says so.
      [TEXT_BY_NAME, SHOW],
      // A dial this phone takes a number for, and a SIM send to exact numbers.
      ["phone.dial.v1", "sms.send.v1", SHOW],
      [SHOW],
    ]) {
      const text = description(capabilities);
      expect(text).toContain("contact_show opens Contacts");
      expect(text).not.toContain("at once with a contact target");
      expect(text).not.toContain(NO_SHOW_FIRST);
    }
    expect(description([TEXT_BY_NAME, SHOW])).toContain(
      "sms_compose is a reviewed SMS to one contact named by text; the phone resolves the name.",
    );
  });

  it("names contact_show only to a phone that is offered it", () => {
    const text = description([CALL, ...TEXT_BY_TARGET]);
    expect(text).toContain(rule.both);
    expect(text).not.toContain("contact_show");
  });

  it("leaves a request for a contact's number or details to contact_show", () => {
    // The rule is about a call or a text; showing a contact is still how the
    // owner is given a number.
    expect(description([CALL, ...TEXT_BY_TARGET, SHOW])).toContain(
      "Use it when the owner asks for a contact's number, email or details, or asks to find or show a named contact",
    );
  });
});

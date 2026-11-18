/**
 * v609 peer evidence: "text shaw saying ..." and "send a text to 415-302-4399
 * saying ..." were answered "Same block as before ... no messaging or SMS
 * connector": a simple Stage-1 reply repeated an earlier refusal from
 * history, so the planner never saw the phone's own SMS operation.
 */
import {
  AgentRuntime,
  attestAuthenticatedApiDeliveryAudience,
  getDirectActionRoutingRules,
  type Memory,
  runResponseHandlerEvaluators,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONTEXT_DEFINITIONS } from "../../runtime/default-contexts.ts";
import { BUILTIN_RESPONSE_HANDLER_EVALUATORS } from "../message/stage1-evaluators.ts";
import { deviceActionForCapabilities, proposeDeviceAction } from "./action.ts";
import {
  DeviceActionService,
  setDeviceActionRequestMessage,
  withDeviceActionTurn,
} from "./service.ts";
import { authoredTelephonyRequest } from "./telephony-request.ts";
import { registerDeviceTelephonyRouting } from "./tools.ts";

const TELEPHONY = [
  "phone.call.v1",
  "sms.compose.v1",
  "sms.compose.v2",
  "contacts.show.v1",
  "phone.keypad.v1",
];
const owner = "11111111-1111-4111-8111-111111111111",
  room = "22222222-2222-4222-8222-222222222222";
afterEach(() => vi.restoreAllMocks());

async function fixture(request: string, source = "client_chat") {
  const runtime = new AgentRuntime({
    character: {
      name: "Eliza",
      bio: [],
      settings: { ELIZA_ADMIN_ENTITY_ID: owner },
    },
    logLevel: "fatal",
  });
  runtime.contexts.tryRegisterMany(DEFAULT_CONTEXT_DEFINITIONS);
  vi.spyOn(runtime, "getRoom").mockResolvedValue({ worldId: "world" } as never);
  vi.spyOn(runtime, "getWorld").mockResolvedValue({
    id: "world",
    metadata: { roles: { [owner]: "OWNER" }, ownership: { ownerId: owner } },
  } as never);
  vi.spyOn(runtime, "getEntityById").mockResolvedValue(null);
  vi.spyOn(runtime, "getParticipantsForRoom").mockResolvedValue([
    owner,
    runtime.agentId,
  ]);
  runtime.registerAction(proposeDeviceAction);
  registerDeviceTelephonyRouting(runtime);
  const message = {
    id: "33333333-3333-4333-8333-333333333333",
    agentId: runtime.agentId,
    entityId: owner,
    roomId: room,
    content: { text: request, source, channelType: "DM" },
  } as Memory;
  await attestAuthenticatedApiDeliveryAudience(runtime, message, {
    kind: "owner_session",
    principalId: "fixture",
  });
  vi.spyOn(DeviceActionService.prototype, "viewProfile").mockResolvedValue(
    null,
  );
  const rule = getDirectActionRoutingRules(runtime).find(
    (r) => r.id === "device.telephony",
  );
  if (!rule) throw new Error("Expected the telephony route");
  return { runtime, message, rule };
}

async function inTurn<T>(
  f: Awaited<ReturnType<typeof fixture>>,
  capabilities: string[],
  run: () => Promise<T>,
): Promise<T> {
  const credential = {
    subjectUserId: "owner-subject",
    installationId: "installation",
    deviceKey: "device-key",
    capabilities,
  };
  return withDeviceActionTurn(
    f.runtime,
    credential,
    async () => {
      setDeviceActionRequestMessage(f.runtime, f.message);
      return run();
    },
    {
      requestCaller: {
        subjectUserId: credential.subjectUserId,
        entityId: owner,
        role: "OWNER",
      },
    },
  );
}

const refusalPlan = () => ({
  processMessage: "RESPOND",
  plan: {
    contexts: ["simple"],
    intents: [],
    candidateActions: [] as string[],
    parentActionHints: [],
    requiresTool: false,
    replyEffectStatus: "none",
    // The reply carried forward from conversation memory.
    reply: "Same block as before: no messaging or SMS connector.",
  },
});

describe("a whole-message call or text reaches the phone's own operation", () => {
  it.each([
    ["text shaw saying I'm running late", "text"],
    ["send a text to 415-302-4399 saying hello from Alpha", "text"],
    ["Text Sam Lee that the door is open", "text"],
    ["call 415-555-0100", "call"],
    ["please call mom", "call"],
    ["Call (415) 555-0100.", "call"],
  ])("promotes the repeated refusal for %s", async (request, kind) => {
    expect(authoredTelephonyRequest(request)).toBe(kind);
    const f = await fixture(request);
    const handler = refusalPlan();
    await inTurn(f, TELEPHONY, async () => {
      expect(f.rule.matches(request, f.message)).toBe(true);
      const evaluator = BUILTIN_RESPONSE_HANDLER_EVALUATORS.find(
        (e) => e.name === "core.direct_registered_capability_request",
      );
      if (!evaluator) throw new Error("Expected capability evaluator");
      await runResponseHandlerEvaluators({
        runtime: f.runtime,
        message: f.message,
        state: { text: "", values: {}, data: {} },
        messageHandler: handler,
        availableContexts: DEFAULT_CONTEXT_DEFINITIONS,
        userRoles: ["OWNER"],
        evaluators: [evaluator],
      } as never);
    });
    expect(handler.plan.requiresTool).toBe(true);
    expect(handler.plan.candidateActions).toContain("PROPOSE_DEVICE_ACTION");
    expect(handler.plan.contexts).toContain("phone");
  });

  it.each([
    "call me",
    "call it a day",
    "call Sam on WhatsApp",
    "call Sam tomorrow",
    "can you call?",
    "text Sam on Signal saying hi",
    "message Sam saying hi",
    "how do I text Sam saying hi?",
    "don't call mom",
    "who should I call",
  ])("leaves %s to the planner", (request) => {
    expect(authoredTelephonyRequest(request)).toBeUndefined();
  });

  it("claims nothing without the phone's call or SMS capability or off phone chat", async () => {
    const f = await fixture("call 415-555-0100");
    await inTurn(f, ["contacts.show.v1"], async () => {
      expect(f.rule.matches("call 415-555-0100", f.message)).toBe(false);
    });
    const other = await fixture("call 415-555-0100", "discord");
    await inTurn(other, TELEPHONY, async () => {
      expect(other.rule.matches("call 415-555-0100", other.message)).toBe(
        false,
      );
    });
  });
});

// v610: "change Test Alpha's number" and "delete the contact Test Alpha" were
// proposed for a name nobody in Contacts has. The phone checks the name before
// it offers a review; the agent, which cannot see the address book, must not
// claim the contact exists or that its change is ready.
describe("contact changes and deletions name a contact the agent cannot see", () => {
  it("tells the agent the phone looks the name up first", () => {
    const { description } = deviceActionForCapabilities(proposeDeviceAction, [
      "contacts.write.v1",
    ]);
    expect(description).toContain(
      "The phone looks up a change's or deletion's name before it offers the review, and when no contact matches it tells the owner instead",
    );
    expect(description).toContain("never say the contact exists");
  });
});

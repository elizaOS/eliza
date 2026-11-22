/**
 * v610 device evidence: "open the phone dialer" was answered "Let me open the
 * phone dialer." with a simple Stage-1 plan, and view navigation opened the
 * Phone view on Recents, because "dialer" is also a name of that view. The
 * phone_keypad operation (phone.keypad.v1) never ran.
 */
import {
  AgentRuntime,
  attestAuthenticatedApiDeliveryAudience,
  getDirectActionRoutingRules,
  type Memory,
  registerDirectActionRoutingRule,
  runResponseHandlerEvaluators,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  viewNavigationEvaluator,
  viewNavigationField,
} from "../../../../../packages/agent/src/runtime/view-navigation.ts";
import { DEFAULT_CONTEXT_DEFINITIONS } from "../../runtime/default-contexts.ts";
import { BUILTIN_RESPONSE_HANDLER_EVALUATORS } from "../message/stage1-evaluators.ts";
import { proposeDeviceAction } from "./action.ts";
import {
  DeviceActionService,
  setDeviceActionRequestMessage,
  withDeviceActionTurn,
} from "./service.ts";
import {
  authoredKeypadRequest,
  authoredTelephonyRequest,
} from "./telephony-request.ts";
import {
  registerDeviceKeypadRouting,
  registerDeviceTelephonyRouting,
} from "./tools.ts";

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

async function fixture(
  request: string,
  content: Partial<Memory["content"]> = {},
) {
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
  registerDeviceKeypadRouting(runtime);
  // The host's view route also claims "open the dialer": "dialer" and
  // "keypad" are aliases of Alpha's Phone view.
  registerDirectActionRoutingRule(runtime, {
    id: "views.explicit-navigation",
    actionNames: ["VIEWS_SHOW"],
    requiredActionTags: [],
    contexts: ["general"],
    matches: () => true,
  });
  const message = {
    id: "33333333-3333-4333-8333-333333333333",
    agentId: runtime.agentId,
    entityId: owner,
    roomId: room,
    content: {
      text: request,
      source: "client_chat",
      channelType: "VOICE_DM",
      ...content,
    },
  } as Memory;
  await attestAuthenticatedApiDeliveryAudience(runtime, message, {
    kind: "owner_session",
    principalId: "fixture",
  });
  vi.spyOn(DeviceActionService.prototype, "viewProfile").mockResolvedValue(
    null,
  );
  const rule = getDirectActionRoutingRules(runtime).find(
    (r) => r.id === "device.phone-keypad",
  );
  if (!rule) throw new Error("Expected the keypad route");
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

// The v610 Stage-1 plan: a simple reply that the host then turned into a
// Phone view switch.
const replyPlan = () => ({
  processMessage: "RESPOND",
  plan: {
    contexts: ["simple"],
    intents: ["open the phone dialer"],
    candidateActions: ["REPLY"] as string[],
    parentActionHints: [] as string[],
    requiresTool: false,
    replyEffectStatus: "pending",
    reply: "Let me open the phone dialer.",
  },
});
// The same judgment as direct navigation to the Phone view.
const viewPlan = () => ({
  processMessage: "RESPOND",
  plan: {
    contexts: ["general"],
    intents: ["open the phone view"],
    candidateActions: ["VIEWS_SHOW"] as string[],
    parentActionHints: [] as string[],
    requiresTool: true,
    replyEffectStatus: "pending",
    reply: "Opening Phone.",
  },
});

async function evaluate(
  f: Awaited<ReturnType<typeof fixture>>,
  handler: ReturnType<typeof replyPlan>,
) {
  const evaluator = BUILTIN_RESPONSE_HANDLER_EVALUATORS.find(
    (e) => e.name === "core.direct_registered_capability_request",
  );
  if (!evaluator) throw new Error("Expected capability evaluator");
  return runResponseHandlerEvaluators({
    runtime: f.runtime,
    message: f.message,
    state: { text: "", values: {}, data: {} },
    messageHandler: handler,
    availableContexts: DEFAULT_CONTEXT_DEFINITIONS,
    userRoles: ["OWNER"],
    evaluators: [evaluator],
  } as never);
}

describe("a whole-message keypad request opens the Phone keypad", () => {
  it.each([
    ["open the phone dialer", undefined],
    ["Open the dialer.", undefined],
    ["open the dial pad", undefined],
    ["open the dialpad", undefined],
    ["open the keypad", undefined],
    ["show me the keypad", undefined],
    ["bring up the dialer", undefined],
    ["Can you pull up my phone's keypad please?", undefined],
    ["open the dialer and type 415 302 4399", "4153024399"],
    ["dial pad with 4153024399", "4153024399"],
    ["open the keypad and enter +1 (415) 302-4399", "+14153024399"],
    ["open the dialer with 415-302-4399 filled in", "4153024399"],
  ])("promotes the reply and view plans for %s", async (request, number) => {
    expect(authoredKeypadRequest(request)).toEqual(number ? { number } : {});
    // Opening the keypad never dials.
    expect(authoredTelephonyRequest(request)).toBeUndefined();
    for (const plan of [replyPlan, viewPlan]) {
      const f = await fixture(request);
      const handler = plan();
      const result = await inTurn(f, TELEPHONY, async () => {
        expect(f.rule.matches(request, f.message)).toBe(true);
        expect(f.rule.wholeRequest?.matches(request, f.message)).toBe(true);
        return evaluate(f, handler);
      });
      expect(handler.plan.requiresTool).toBe(true);
      expect(handler.plan.candidateActions).toEqual(["PROPOSE_DEVICE_ACTION"]);
      expect(handler.plan.contexts).toContain("phone");
      expect(handler.plan.intents).toEqual([request]);
      expect(result.appliedPatches.flatMap((p) => p.changed)).toContain(
        "intentField:invalidate:visualContinuation",
      );
    }
  });

  it.each([
    // The Phone app itself stays view navigation.
    "open phone",
    "open the phone app",
    "show me the phone",
    // A call is the telephony route's, reviewed on the phone.
    "call mom",
    "dial 4153024399",
    "open the dialer and call mom",
    "open the dialer and dial 4153024399",
    // A question about call history, not a request for the keypad.
    "what's on my dialer history",
    // Settings for the dialer (the default-dialer role, Phone settings) are
    // another destination; claiming it would show the keypad instead.
    "open the dialer settings",
    // No verb and no number: a bare noun is not a request.
    "keypad",
    "the dialer",
    "don't open the keypad",
    "open the keypad tomorrow",
    "open the keypad with mom's number",
    // Not one dialable number as written.
    "open the keypad and type 1",
    "open the keypad and type 415 302 4399 and 5",
  ])("leaves %s alone", async (request) => {
    expect(authoredKeypadRequest(request)).toBeUndefined();
    const f = await fixture(request);
    await inTurn(f, TELEPHONY, async () => {
      expect(f.rule.matches(request, f.message)).toBe(false);
    });
  });

  it("claims nothing without the keypad capability, off phone chat or for another message", async () => {
    const request = "open the dialer";
    const f = await fixture(request);
    await inTurn(
      f,
      TELEPHONY.filter((c) => c !== "phone.keypad.v1"),
      async () => {
        expect(f.rule.matches(request, f.message)).toBe(false);
      },
    );
    const discord = await fixture(request, { source: "discord" });
    await inTurn(discord, TELEPHONY, async () => {
      expect(discord.rule.matches(request, discord.message)).toBe(false);
    });
    const group = await fixture(request, { channelType: "GROUP" });
    await inTurn(group, TELEPHONY, async () => {
      expect(group.rule.matches(request, group.message)).toBe(false);
    });
    // Another message than the owner's current request, such as history.
    const earlier = await fixture(request);
    await inTurn(earlier, TELEPHONY, async () => {
      expect(
        earlier.rule.matches(request, {
          ...earlier.message,
          content: { ...earlier.message.content },
        }),
      ).toBe(false);
    });
    // Outside the bound device turn there is no current request at all.
    expect(f.rule.matches(request, f.message)).toBe(false);
  });

  it("keeps the invalidated navigation judgment from opening the Phone view", async () => {
    const f = await fixture("open the phone dialer", {
      metadata: { viewClientId: "test-renderer", uiView: "chat" },
    });
    if (!viewNavigationField.handle)
      throw new Error("Expected navigation field handler");
    viewNavigationField.handle({
      runtime: f.runtime,
      message: f.message,
      senderRole: "OWNER",
      value: {
        disposition: "direct",
        viewId: "phone",
        reason: "The user asked to open the phone dialer.",
      },
      turnSignal: new AbortController().signal,
    } as never);
    const result = await viewNavigationEvaluator.evaluate({
      runtime: f.runtime,
      message: f.message,
      state: { data: { providers: {} } },
      userRoles: ["OWNER"],
      invalidatedScopeFields: new Set(["visualContinuation"]),
      messageHandler: {
        processMessage: "RESPOND",
        plan: {
          contexts: ["phone", "general"],
          intents: ["open the phone dialer"],
          candidateActions: ["PROPOSE_DEVICE_ACTION"],
          parentActionHints: [],
          requiresTool: true,
          replyEffectStatus: "pending",
        },
      },
    } as never);
    expect(result).toBeUndefined();
  });

  it("tells the first-stage judge that the dialer is the keypad operation", () => {
    expect(viewNavigationField.description).toContain(
      "opening the dialer, dial pad or keypad is that operation",
    );
  });

  it.each([
    // The model dropped the number the owner wrote.
    ["open the dialer and type 415 302 4399", {}, "4153024399"],
    // The model invented a number for an empty keypad.
    ["open the keypad", { number: "4155550100" }, undefined],
    ["dial pad with 4153024399", { number: "4155550100" }, "4153024399"],
  ])(
    "proposes the number the owner wrote for %s, not the model's",
    async (request, modelFields, number) => {
      const f = await fixture(request);
      const propose = vi
        .spyOn(DeviceActionService.prototype, "proposeWithOutcome")
        .mockRejectedValue(new Error("stop after proposing"));
      await inTurn(f, TELEPHONY, async () => {
        await expect(
          proposeDeviceAction.handler?.(f.runtime, f.message, undefined, {
            parameters: {
              operation: { type: "phone_keypad", ...modelFields },
              operationKey: "keypad-1",
              reason: "The owner asked for the keypad.",
            },
          } as never),
        ).rejects.toThrow("stop after proposing");
      });
      expect(propose).toHaveBeenCalledTimes(1);
      expect(propose.mock.calls[0]?.[1]).toEqual(
        number ? { type: "phone_keypad", number } : { type: "phone_keypad" },
      );
    },
  );
});

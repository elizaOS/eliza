/**
 * The v610 failure end to end through the response-handler runner: Stage 1
 * judged "open the phone dialer" direct navigation to the Phone view, whose
 * aliases include "dialer" and "keypad", and host.view-navigation issued
 * VIEWS show phone. With phone.keypad.v1 the keypad route runs first in the
 * same runner pass and the staged judgment no longer opens the view.
 */
import {
  AgentRuntime,
  attestAuthenticatedApiDeliveryAudience,
  type Memory,
  runResponseHandlerEvaluators,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { viewsAction } from "../../../../../packages/agent/src/actions/views.ts";
import {
  closeRuntimeViewRegistry,
  registerBuiltinViews,
  registerPluginViews,
} from "../../../../../packages/agent/src/api/views-registry.ts";
import {
  registerViewNavigationRoutingRule,
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
import { authoredTelephonyRequest } from "./telephony-request.ts";
import {
  registerDeviceKeypadRouting,
  registerDeviceTelephonyRouting,
} from "./tools.ts";

const owner = "11111111-1111-4111-8111-111111111111",
  room = "22222222-2222-4222-8222-222222222222";
const TELEPHONY = ["phone.call.v1", "contacts.show.v1", "phone.keypad.v1"];
const runtimes: AgentRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) closeRuntimeViewRegistry(runtime);
  vi.restoreAllMocks();
});

async function turn(request: string, capabilities: string[]) {
  const runtime = new AgentRuntime({
    character: {
      name: "Eliza",
      bio: [],
      settings: { ELIZA_ADMIN_ENTITY_ID: owner },
    },
    logLevel: "fatal",
  });
  runtimes.push(runtime);
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
  runtime.registerAction(viewsAction);
  runtime.registerAction(proposeDeviceAction);
  registerDeviceTelephonyRouting(runtime);
  registerDeviceKeypadRouting(runtime);
  registerBuiltinViews(runtime);
  // The host's own route: an explicit registered view name or alias.
  registerViewNavigationRoutingRule(runtime);
  // Alpha's Phone view, with its navigation aliases.
  await registerPluginViews(
    runtime,
    {
      name: "alpha-phone",
      views: [
        {
          id: "phone",
          label: "Phone",
          path: "/phone",
          bundleUrl: "/phone.js",
          navigationAliases: [
            "dialer",
            "calls",
            "recents",
            "voicemail",
            "keypad",
          ],
        },
      ],
    } as never,
    { pluginDir: process.cwd(), indexEmbeddings: false },
  );
  vi.spyOn(DeviceActionService.prototype, "viewProfile").mockResolvedValue(
    null,
  );
  const message = {
    id: "33333333-3333-4333-8333-333333333333",
    agentId: runtime.agentId,
    entityId: owner,
    roomId: room,
    content: {
      text: request,
      source: "client_chat",
      channelType: "VOICE_DM",
      metadata: { viewClientId: "client-1", viewDelivery: "completed-action" },
    },
  } as Memory;
  await attestAuthenticatedApiDeliveryAudience(runtime, message, {
    kind: "owner_session",
    principalId: "fixture",
  });
  // The v610 Stage-1 output: a simple reply and a direct Phone judgment.
  const handler = {
    processMessage: "RESPOND",
    plan: {
      contexts: ["simple"],
      intents: [request],
      candidateActions: ["REPLY"] as string[],
      parentActionHints: [] as string[],
      requiresTool: false,
      replyEffectStatus: "pending",
      reply: "Let me open the phone dialer.",
    } as Record<string, unknown>,
  };
  const credential = {
    subjectUserId: "owner-subject",
    installationId: "installation",
    deviceKey: "device-key",
    capabilities,
  };
  const evaluators = [
    ...BUILTIN_RESPONSE_HANDLER_EVALUATORS.filter(
      (e) => e.name === "core.direct_registered_capability_request",
    ),
    viewNavigationEvaluator,
  ];
  const result = await withDeviceActionTurn(
    runtime,
    credential,
    async () => {
      setDeviceActionRequestMessage(runtime, message);
      await viewNavigationField.handle?.({
        runtime,
        message,
        senderRole: "OWNER",
        state: { values: {}, data: {}, text: "" },
        value: {
          disposition: "direct",
          viewId: "phone",
          reason: "The user asked to open the phone dialer.",
        },
        parsed: {},
        turnSignal: new AbortController().signal,
      } as never);
      return runResponseHandlerEvaluators({
        runtime,
        message,
        state: { text: "", values: {}, data: {} },
        messageHandler: handler,
        availableContexts: DEFAULT_CONTEXT_DEFINITIONS,
        userRoles: ["OWNER"],
        evaluators,
      } as never);
    },
    {
      requestCaller: {
        subjectUserId: credential.subjectUserId,
        entityId: owner,
        role: "OWNER",
      },
    },
  );
  return { handler, result };
}

const PHONE_JUDGMENT = '"viewId":"phone"';

describe("the keypad route against the staged Phone navigation, in one runner pass", () => {
  it("reproduces v610 without phone.keypad.v1: the planner gets VIEWS and the Phone judgment", async () => {
    const { handler } = await turn(
      "open the phone dialer",
      TELEPHONY.filter((c) => c !== "phone.keypad.v1"),
    );
    expect(handler.plan.candidateActions).toContain("VIEWS");
    expect(handler.plan.candidateActions).not.toContain(
      "PROPOSE_DEVICE_ACTION",
    );
    expect(String(handler.plan.contextSlices)).toContain(PHONE_JUDGMENT);
  });

  it.each([
    "open the phone dialer",
    "open the dialer and type 415 302 4399",
    "take me to the keypad",
  ])(
    "with phone.keypad.v1, %s plans the keypad and no view switch",
    async (request) => {
      const { handler, result } = await turn(request, TELEPHONY);
      expect(handler.plan.deterministicToolCall).toBeUndefined();
      expect(handler.plan.candidateActions).toEqual(["PROPOSE_DEVICE_ACTION"]);
      expect(handler.plan.contexts).toContain("phone");
      expect(handler.plan.requiresTool).toBe(true);
      expect(handler.plan.reply).toBeFalsy();
      expect(result.activeEvaluators).toContain("host.view-navigation");
      expect(String(handler.plan.contextSlices ?? "")).not.toContain(
        PHONE_JUDGMENT,
      );
    },
  );

  it("leaves 'open the phone app' to view navigation", async () => {
    const { handler } = await turn("open the phone app", TELEPHONY);
    expect(handler.plan.candidateActions).toContain("VIEWS");
    expect(handler.plan.candidateActions).not.toContain(
      "PROPOSE_DEVICE_ACTION",
    );
    expect(String(handler.plan.contextSlices)).toContain(PHONE_JUDGMENT);
  });
});

describe("keypad nouns are not call targets", () => {
  it.each([
    "phone dialer",
    "phone keypad",
    "dial pad",
    "Dial pad.",
    "phone app",
  ])("the call route leaves %s alone", (request) => {
    expect(authoredTelephonyRequest(request)).toBeUndefined();
  });
  it.each([
    ["call mom", "call"],
    ["dial 4153024399", "call"],
    ["phone Sam Lee", "call"],
    ["call Padma", "call"],
    ["text Sam saying the dial pad is broken", "text"],
  ])("still claims %s", (request, kind) => {
    expect(authoredTelephonyRequest(request)).toBe(kind);
  });
});

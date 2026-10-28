import {
  AgentRuntime,
  attestAuthenticatedApiDeliveryAudience,
  getDirectActionRoutingRules,
  type Memory,
  promoteSubactionsToActions,
  runResponseHandlerEvaluators,
} from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import { viewsAction } from "../../../../../packages/agent/src/actions/views.ts";
import {
  closeRuntimeViewRegistry,
  registerBuiltinViews,
} from "../../../../../packages/agent/src/api/views-registry.ts";
import {
  viewNavigationEvaluator,
  viewNavigationField,
} from "../../../../../packages/agent/src/runtime/view-navigation.ts";
import { DEFAULT_CONTEXT_DEFINITIONS } from "../../runtime/default-contexts.ts";
import { collectV5PlannerCandidateActions } from "../message/action-surface.ts";
import { inferDirectCurrentRequestCandidateInference } from "../message/direct-action-heuristics.ts";
import { BUILTIN_RESPONSE_HANDLER_EVALUATORS } from "../message/stage1-evaluators.ts";
import {
  DeviceActionService,
  setDeviceActionRequestMessage,
  withDeviceActionTurn,
} from "./service.ts";
import {
  deviceActionTools,
  registerDeviceBrowserOpenRouting,
} from "./tools.ts";

const owner = "11111111-1111-4111-8111-111111111111",
  room = "22222222-2222-4222-8222-222222222222";
const runtimes: AgentRuntime[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) closeRuntimeViewRegistry(runtime);
});
async function fixture(request = "Open example.com.") {
  const runtime = new AgentRuntime({
    character: {
      name: "Device browser routing",
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
  const browser = deviceActionTools.find(
    (a) => a.name === "DEVICE_BROWSER_OPEN",
  );
  if (!browser) throw new Error("Expected browser action");
  for (const action of [browser, ...promoteSubactionsToActions(viewsAction)])
    runtime.registerAction(action);
  registerBuiltinViews(runtime);
  registerDeviceBrowserOpenRouting(runtime);
  const message = {
    id: "33333333-3333-4333-8333-333333333333",
    agentId: runtime.agentId,
    entityId: owner,
    roomId: room,
    content: {
      text: request,
      source: "client_chat",
      channelType: "DM",
      metadata: {
        clientDevice: {
          context: { view: "notes", revision: 1, sensitive: false },
        },
        viewClientId: "test-renderer",
        viewDelivery: "completed-action",
        uiView: "chat",
      },
    },
  } as Memory;
  await attestAuthenticatedApiDeliveryAudience(runtime, message, {
    kind: "owner_session",
    principalId: "fixture",
  });
  vi.spyOn(DeviceActionService.prototype, "viewProfile").mockResolvedValue(
    null,
  );
  const credential = {
    subjectUserId: "owner-subject",
    installationId: "installation",
    deviceKey: "device-key",
    capabilities: [],
  };
  return {
    runtime,
    message,
    browser,
    credential,
    rule: getDirectActionRoutingRules(runtime).find(
      (r) => r.id === "device.browser-open",
    ),
  };
}
it.each([
  "Open example.com.",
  "Please visit https://example.com/path?q=1",
  "Go to www.example.com",
])(
  "routes a complete native URL request to the existing reviewed operation: %s",
  async (request) => {
    const f = await fixture(request);
    await withDeviceActionTurn(
      f.runtime,
      f.credential,
      async () => {
        setDeviceActionRequestMessage(f.runtime, f.message);
        const execute = vi.spyOn(f.browser, "handler");
        expect(f.rule?.matches(request, f.message)).toBe(true);
        const handler = {
          processMessage: "RESPOND",
          plan: {
            contexts: ["general"],
            intents: [request],
            candidateActions: ["VIEWS_SHOW"],
            parentActionHints: [],
            requiresTool: true,
            replyEffectStatus: "pending",
            reply: "Opening Browser.",
          },
        };
        const evaluator = BUILTIN_RESPONSE_HANDLER_EVALUATORS.find(
          (e) => e.name === "core.direct_registered_capability_request",
        );
        if (!evaluator) throw new Error("Expected capability evaluator");
        const result = await runResponseHandlerEvaluators({
          runtime: f.runtime,
          message: f.message,
          state: { text: "", values: {}, data: {} },
          messageHandler: handler,
          availableContexts: DEFAULT_CONTEXT_DEFINITIONS,
          userRoles: ["OWNER"],
          evaluators: [evaluator],
        } as never);
        expect(handler.plan.candidateActions).toEqual(["DEVICE_BROWSER_OPEN"]);
        expect(handler.plan.intents).toEqual([request]);
        expect(result.appliedPatches.flatMap((p) => p.changed)).toContain(
          "intentField:invalidate:visualContinuation",
        );
        const admitted = await collectV5PlannerCandidateActions({
          runtime: f.runtime,
          message: f.message,
          state: { text: "", values: {}, data: {} },
          selectedContexts: handler.plan.contexts,
          candidateActions: handler.plan.candidateActions,
          intents: handler.plan.intents,
          userRoles: ["OWNER"],
        });
        expect(admitted.map((a) => a.name)).toContain("DEVICE_BROWSER_OPEN");
        expect(handler.plan).not.toHaveProperty("deterministicToolCall");
        expect(execute).not.toHaveBeenCalled();
        // The routing layer only exposes the original proposal tool; it never runs it.
        expect(
          f.browser.parameters?.find((p) => p.name === "operationKey")
            ?.required,
        ).toBe(true);
      },
      {
        requestCaller: {
          subjectUserId: f.credential.subjectUserId,
          entityId: owner,
          role: "OWNER",
        },
      },
    );
    expect(f.rule.matches(request, f.message)).toBe(false);
  },
);
it.each([
  "Open Notes",
  "Open example..com",
  "Open https://",
  "Open http://example.com",
  "Do not open example.com",
  "Open example.com and read its title",
  "If my note exists, open example.com",
  'Explain "open example.com"',
  "Open https://person:secret@example.com",
])(
  "does not claim ownership of unsupported or compound work: %s",
  async (request) => {
    const f = await fixture(request);
    await withDeviceActionTurn(
      f.runtime,
      f.credential,
      async () => {
        setDeviceActionRequestMessage(f.runtime, f.message);
        expect(f.rule.matches(request, f.message)).toBe(false);
      },
      {
        requestCaller: {
          subjectUserId: f.credential.subjectUserId,
          entityId: owner,
          role: "OWNER",
        },
      },
    );
  },
);
it("requires the bound current caller and the operation capability, not a native metadata hint", async () => {
  const f = await fixture();
  expect(f.rule.matches(String(f.message.content.text), f.message)).toBe(false);
  await withDeviceActionTurn(
    f.runtime,
    { ...f.credential, capabilities: ["clock.handoff.v1"] },
    async () => {
      setDeviceActionRequestMessage(f.runtime, f.message);
      expect(f.rule.matches(String(f.message.content.text), f.message)).toBe(
        false,
      );
    },
    {
      requestCaller: {
        subjectUserId: f.credential.subjectUserId,
        entityId: owner,
        role: "OWNER",
      },
    },
  );
  let current = true;
  await withDeviceActionTurn(
    f.runtime,
    f.credential,
    async () => {
      setDeviceActionRequestMessage(f.runtime, f.message);
      expect(
        f.rule.matches(String(f.message.content.text), { ...f.message }),
      ).toBe(false);
      current = false;
      expect(f.rule.matches(String(f.message.content.text), f.message)).toBe(
        false,
      );
    },
    {
      isCurrent: () => current,
      requestCaller: {
        subjectUserId: f.credential.subjectUserId,
        entityId: owner,
        role: "OWNER",
      },
    },
  );
  await withDeviceActionTurn(
    f.runtime,
    f.credential,
    async () => {
      expect(f.rule.matches(String(f.message.content.text), f.message)).toBe(
        false,
      );
    },
    {
      requestCaller: {
        subjectUserId: f.credential.subjectUserId,
        entityId: owner,
        role: "USER",
      },
    },
  );
});
it.each(["Open example.com.", "Open https://example.com."])(
  "prevents a resource from taking the view-only shortcut: %s",
  async (request) => {
    const f = await fixture(request);
    if (!viewNavigationField.handle)
      throw new Error("Expected navigation field handler");
    viewNavigationField.handle({
      runtime: f.runtime,
      message: f.message,
      senderRole: "OWNER",
      value: {
        disposition: "direct",
        viewId: "chat",
        reason: "Bad view-only model selection",
      },
      turnSignal: new AbortController().signal,
    } as never);
    const result = await viewNavigationEvaluator.evaluate({
      runtime: f.runtime,
      message: f.message,
      state: { data: { providers: {} } },
      userRoles: ["OWNER"],
      messageHandler: {
        processMessage: "RESPOND",
        plan: {
          contexts: ["general"],
          intents: [request],
          candidateActions: ["VIEWS_SHOW"],
          parentActionHints: [],
          requiresTool: true,
          replyEffectStatus: "pending",
          reply: "Opening Home.",
        },
      },
    } as never);
    expect(result?.deterministicToolCall).toBeUndefined();
    expect(result?.requiresTool).toBe(true);
  },
);

it.each([
  "Open the browser view at example.com.",
  "Open the browser view at https://example.com.",
])(
  "keeps a URL-bearing command out of the generic view fallback: %s",
  (request) => {
    expect(
      inferDirectCurrentRequestCandidateInference([viewsAction], request).names,
    ).toEqual([]);
    expect(
      inferDirectCurrentRequestCandidateInference(
        [viewsAction],
        "Open the browser view",
      ).names,
    ).toContain("VIEWS");
  },
);

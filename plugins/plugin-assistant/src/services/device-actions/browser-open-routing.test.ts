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
  "open youtube.com",
  "Open youtube.com.",
  "open youtube.com!",
  "open youtube.com, please",
  "please open youtube.com",
  "open youtube.com, would you?",
  "open youtube.com, thank you.",
  "visit nytimes.com",
  "navigate to nytimes.com",
  "Hey Eliza, open youtube.com.",
  "Hey Eliza. Open youtube.com.",
  "hey eliza open youtube.com",
  "Eliza, go to nytimes.com",
  "ok open youtube.com",
  "okay eliza, open youtube.com",
])("claims only the strict whole-message command: %s", async (request) => {
  const f = await fixture(request);
  await withDeviceActionTurn(
    f.runtime,
    f.credential,
    async () => {
      setDeviceActionRequestMessage(f.runtime, f.message);
      expect(f.rule.matches(request, f.message)).toBe(true);
      expect(f.rule.wholeRequest?.matches(request, f.message)).toBe(true);
    },
    {
      requestCaller: {
        subjectUserId: f.credential.subjectUserId,
        entityId: owner,
        role: "OWNER",
      },
    },
  );
});
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
  // Not the strict form: the planner judges these, never the router.
  "youtube.com",
  "can you open youtube.com for me?",
  "pull up nytimes.com",
  "open youtube.com now",
  "open youtube.com in a new tab",
  "Hey Luna, open youtube.com",
  // Earlier review rounds' false opens: none is claimed.
  "Tomorrow, open youtube.com",
  "Later, pull up nytimes.com",
  "Maybe, open youtube.com",
  "Hypothetically, open youtube.com",
  "Eliza later open youtube.com",
  "ok maybe open youtube.com",
  "at 5pm open youtube.com",
  "In five minutes, open youtube.com",
  "on Monday open youtube.com",
  "every morning open youtube.com",
  "is there a way to open youtube.com",
  "do I need to go to irs.gov?",
  "were you able to open youtube.com?",
  "I used to visit myspace.com",
  "yesterday you could open youtube.com",
  "my mom wants me to open youtube.com",
  "my boss keeps telling me to go to linkedin.com",
  "Step 3: go to example.com",
  "we arent going to open youtube.com",
  "probably open youtube.com",
  "hey eliza, never open youtube.com",
  "Don't open or visit youtube.com",
  "do not under any circumstances open youtube.com",
  "won't you open youtube.com?",
  "Open youtube.com. Tomorrow.",
  "open youtube.com, if you can",
  "take me to L.A.",
  "Hey Eliza, navigate to L.A.",
  "open L.A.",
  "Hey Eliza, take me to St.Louis",
  "can you open IMG_1234.heic",
  "open IMG_1234.heic",
  "Hey Eliza, open Recording.m4a",
  "show me 10.5",
  "open 3.14",
  "can you open Makefile.am",
  "can you open main.py",
  "open up main.py",
  "launch Spotify.app",
  "can you open script.pl",
  "open localhost:3000",
])(
  "does not claim ownership of unsupported, compound or non-strict work: %s",
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

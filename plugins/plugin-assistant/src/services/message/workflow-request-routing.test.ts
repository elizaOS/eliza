/**
 * "create a workflow called Alpha device test" failed on the Pixel (v610,
 * 2026-11-18) with "I couldn't prepare that request correctly. No action was
 * started." agent.log: "Stage-1 decision still conflicts after repair"
 * (STAGE1_ROUTING_CONFLICT). None of the phone's deterministic routes (Maps
 * travel-to, go-to-place and nearby, telephony, camera, browser, view
 * navigation) claims that message, and WORKFLOW had no route of its own, so
 * when Stage 1 repeated a contradictory decision after its one repair (a
 * clarification that still declared the create pending, or a direct
 * Workflows-view switch with no pending intent) the turn failed closed before
 * any route ran.
 */
import {
  AgentRuntime,
  attestAuthenticatedApiDeliveryAudience,
  ChannelType,
  ElizaError,
  getDirectActionRoutingRules,
  type IAgentRuntime,
  type Memory,
  ModelType,
  promoteSubactionsToActions,
  registerDirectActionRoutingRule,
  runResponseHandlerEvaluators,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { viewsAction } from "../../../../../packages/agent/src/actions/views.ts";
import {
  closeRuntimeViewRegistry,
  registerBuiltinViews,
  registerPluginViews,
} from "../../../../../packages/agent/src/api/views-registry.ts";
import { registerViewNavigationRoutingRule } from "../../../../../packages/agent/src/runtime/view-navigation.ts";
import { mapsPlugin } from "../../../../plugin-maps/src/plugin.ts";
import { registerWorkflowRequestRouting } from "../../../../plugin-workflow/src/actions/workflow-request.ts";
import {
  makeMessage,
  makeRuntime,
  makeState,
  runStage1,
  stage1Response,
  useModelCalls,
} from "../../__tests__/stage1/fixtures.ts";
import { DEFAULT_CONTEXT_DEFINITIONS } from "../../runtime/default-contexts.ts";
import {
  registerDeviceBrowserOpenRouting,
  registerDeviceCameraCaptureRouting,
  registerDeviceTelephonyRouting,
} from "../device-actions/tools.ts";
import { MessageFailures } from "./failures.ts";
import { BUILTIN_RESPONSE_HANDLER_EVALUATORS } from "./stage1-evaluators.ts";

const owner = "11111111-1111-4111-8111-111111111111",
  room = "22222222-2222-4222-8222-222222222222";
const runtimes: AgentRuntime[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) closeRuntimeViewRegistry(runtime);
});

const CREATE = "create a workflow called Alpha device test";
const RENAME = "rename the workflow Alpha device test to Alpha check";
const REMOVE = "delete the Alpha check workflow";

const workflowStub = () => ({
  name: "WORKFLOW",
  description: "Create, rename, list and remove workflows.",
  contexts: ["general", "automation", "tasks", "agent_internal"],
  contextGate: { anyOf: ["general", "automation", "tasks", "agent_internal"] },
  roleGate: { minRole: "OWNER" as const },
  validate: async () => true,
  handler: vi.fn(async () => ({ success: true, text: "Created." })),
});

/**
 * The phone's routes as v610 registers them. Its Workflows view is the
 * builtin Automations view ("workflows" is its navigation alias; Alpha maps
 * its legacy workflows id onto it).
 */
async function phoneFixture(text: string) {
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
  for (const action of [
    ...(mapsPlugin.actions ?? []),
    ...promoteSubactionsToActions(viewsAction),
    workflowStub(),
  ])
    runtime.registerAction(action as never);
  registerBuiltinViews(runtime);
  await registerPluginViews(
    runtime,
    {
      name: "test-phone-views",
      description: "Fixture phone views",
      views: [
        { id: "notes", label: "Notes", path: "/notes", bundleUrl: "/n.js" },
      ],
    },
    { pluginDir: process.cwd(), indexEmbeddings: false },
  );
  registerViewNavigationRoutingRule(runtime);
  await mapsPlugin.init?.({}, runtime);
  registerDeviceCameraCaptureRouting(runtime);
  registerDeviceBrowserOpenRouting(runtime);
  registerDeviceTelephonyRouting(runtime);
  registerWorkflowRequestRouting(runtime);
  const message = {
    id: "33333333-3333-4333-8333-333333333333",
    agentId: runtime.agentId,
    entityId: owner,
    roomId: room,
    content: {
      text,
      source: "client_chat",
      channelType: "DM",
      metadata: { viewClientId: "test-renderer", uiView: "home" },
    },
  } as Memory;
  await attestAuthenticatedApiDeliveryAudience(runtime, message, {
    kind: "owner_session",
    principalId: "fixture",
  });
  return { runtime, message };
}

function matchingRuleIds(runtime: IAgentRuntime, message: Memory): string[] {
  const text = String(message.content.text);
  return getDirectActionRoutingRules(runtime)
    .filter((rule) => rule.matches(text, message))
    .map((rule) => rule.id);
}

describe("which phone routes claim the workflow phrasings", () => {
  it.each([
    [CREATE, ["workflow.authored-request"]],
    [
      "Create a workflow called Alpha device test.",
      ["workflow.authored-request"],
    ],
    [RENAME, ["workflow.authored-request"]],
    [REMOVE, ["workflow.authored-request"]],
    ["list my workflows", ["workflow.authored-request"]],
    // A Workflows view exists, so these name it; WORKFLOW leaves them alone.
    ["show my workflows", ["views.explicit-navigation"]],
    ["open workflows", ["views.explicit-navigation"]],
  ])("%s", async (text, expected) => {
    const { runtime, message } = await phoneFixture(text);
    expect(matchingRuleIds(runtime, message)).toEqual(expected);
  });
});

describe("the workflow route owns the whole request whatever Stage 1 planned", () => {
  const evaluator = BUILTIN_RESPONSE_HANDLER_EVALUATORS.find(
    (entry) => entry.name === "core.direct_registered_capability_request",
  );
  const shapes = {
    // The Workflows view is where the phone builds workflows.
    viewSwitch: {
      contexts: ["general"],
      intents: ["Open the Workflows view"],
      candidateActions: ["VIEWS_SHOW"],
      requiresTool: true,
      replyEffectStatus: "pending",
      reply: "Opening Workflows.",
    },
    // A name alone read as a request still waiting on its steps.
    clarification: {
      contexts: ["simple"],
      intents: [],
      candidateActions: [],
      requiresTool: false,
      replyEffectStatus: "non_applied",
      reply: "What should Alpha device test do?",
    },
    automation: {
      contexts: ["automation"],
      intents: ["create a workflow named Alpha device test"],
      candidateActions: ["WORKFLOW"],
      requiresTool: true,
      replyEffectStatus: "pending",
      reply: "",
    },
  };
  it.each(
    [CREATE, RENAME, REMOVE].flatMap((text) =>
      Object.entries(shapes).map(
        ([shape, plan]) => [text, shape, plan] as const,
      ),
    ),
  )("%s (%s)", async (text, _shape, plan) => {
    if (!evaluator) throw new Error("Expected capability evaluator");
    const { runtime, message } = await phoneFixture(text);
    const handler = {
      processMessage: "RESPOND",
      plan: { ...structuredClone(plan), parentActionHints: [] },
    };
    await runResponseHandlerEvaluators({
      runtime,
      message,
      state: { text: "", values: {}, data: {} },
      messageHandler: handler,
      availableContexts: DEFAULT_CONTEXT_DEFINITIONS,
      userRoles: ["OWNER"],
      evaluators: [evaluator],
    } as never);
    expect(handler.plan.candidateActions).toEqual(["WORKFLOW"]);
    expect(handler.plan.requiresTool).toBe(true);
    expect(handler.plan.contexts).toContain("automation");
    expect(handler.plan.intents).toEqual([text]);
    expect(handler.plan.reply ?? "").toBe("");
  });
});

describe("a repeated Stage-1 routing conflict", () => {
  const conflicts = {
    // A clarification that still declares the create pending.
    nonAppliedWithIntent: () =>
      stage1Response({
        contexts: ["automation"],
        intents: ["create a workflow named Alpha device test"],
        candidateActionNames: ["WORKFLOW"],
        replyText: "What should the Alpha device test workflow do?",
        facts: ["The owner wants a workflow called Alpha device test"],
        extra: {
          replyEffectStatus: "non_applied",
          visualContinuation: { disposition: "none", viewId: "", reason: "" },
        },
      }),
    // A Workflows-view switch with no pending intent.
    navigationWithoutIntent: () =>
      stage1Response({
        contexts: ["general"],
        intents: [],
        candidateActionNames: ["VIEWS_SHOW"],
        replyText: "Opening Workflows.",
        extra: {
          replyEffectStatus: "pending",
          visualContinuation: {
            disposition: "direct",
            viewId: "workflows",
            reason: "Workflows are built in the Workflows view",
          },
        },
      }),
    stopWithPendingWork: () =>
      stage1Response({
        shouldRespond: "STOP",
        contexts: ["automation"],
        intents: ["create a workflow named Alpha device test"],
        candidateActionNames: ["WORKFLOW"],
        extra: { replyEffectStatus: "pending" },
      }),
  };

  function stage1Runtime(responses: unknown[], route: boolean) {
    const runtime = makeRuntime(responses);
    const action = workflowStub();
    // The fixture has no world, so it carries no role gate.
    runtime.actions = [{ ...action, roleGate: undefined }] as never;
    if (route) registerWorkflowRequestRouting(runtime);
    const evaluator = BUILTIN_RESPONSE_HANDLER_EVALUATORS.find(
      (entry) => entry.name === "core.direct_registered_capability_request",
    );
    if (!evaluator) throw new Error("Expected capability evaluator");
    runtime.responseHandlerEvaluators = [evaluator];
    return { runtime, handler: action.handler };
  }
  const state = () => ({
    ...makeState(),
    values: { availableContexts: "general, automation" },
  });

  it.each(Object.entries(conflicts))(
    "reproduces the v610 failure without a workflow route (%s)",
    async (_shape, conflict) => {
      const { runtime } = stage1Runtime([conflict(), conflict()], false);
      await expect(
        runStage1({
          runtime,
          message: makeMessage({ text: CREATE, channelType: ChannelType.DM }),
          state: state(),
        }),
      ).rejects.toMatchObject({ code: "STAGE1_ROUTING_CONFLICT" });
      expect(useModelCalls(runtime).map(([model]) => model)).toEqual([
        ModelType.RESPONSE_HANDLER,
        ModelType.RESPONSE_HANDLER,
      ]);
    },
  );

  it.each(
    [CREATE, RENAME, REMOVE].flatMap((text) =>
      Object.entries(conflicts).map(
        ([shape, conflict]) => [text, shape, conflict] as const,
      ),
    ),
  )("hands %s to WORKFLOW planning (%s)", async (text, _shape, conflict) => {
    const { runtime, handler } = stage1Runtime([conflict(), conflict()], true);
    const result = await runStage1({
      runtime,
      message: makeMessage({ text, channelType: ChannelType.DM }),
      state: state(),
      stage1DecisionOnly: true,
    } as never);
    expect(result.kind).not.toBe("direct_reply");
    expect(result.kind).not.toBe("terminal");
    const plan = result.messageHandler.plan;
    expect(plan.candidateActions).toEqual(["WORKFLOW"]);
    expect(plan.requiresTool).toBe(true);
    expect(plan.intents).toEqual([text]);
    expect(plan.reply ?? "").toBe("");
    // Routing only: the planner, not Stage 1, runs WORKFLOW.
    expect(handler).not.toHaveBeenCalled();
    expect(useModelCalls(runtime)).toHaveLength(2);
  });

  it("still fails closed when no route owns the whole request", async () => {
    const { runtime } = stage1Runtime(
      [conflicts.nonAppliedWithIntent(), conflicts.nonAppliedWithIntent()],
      true,
    );
    await expect(
      runStage1({
        runtime,
        message: makeMessage({
          text: "make a workflow that texts me every morning and turn it on",
          channelType: ChannelType.DM,
        }),
        state: state(),
      }),
    ).rejects.toMatchObject({ code: "STAGE1_ROUTING_CONFLICT" });
  });

  it("still fails closed when two routes claim the whole request", async () => {
    const { runtime } = stage1Runtime(
      [conflicts.nonAppliedWithIntent(), conflicts.nonAppliedWithIntent()],
      true,
    );
    runtime.actions = [
      ...(runtime.actions ?? []),
      {
        name: "OTHER_WORKFLOWS",
        description: "Another owner.",
        contexts: ["automation"],
        validate: async () => true,
        handler: vi.fn(),
      },
    ] as never;
    registerDirectActionRoutingRule(runtime, {
      id: "test.second-owner",
      actionNames: ["OTHER_WORKFLOWS"],
      requiredActionTags: [],
      contexts: ["automation"],
      matches: () => true,
      wholeRequest: { matches: () => true, invalidateFields: [] },
    });
    await expect(
      runStage1({
        runtime,
        message: makeMessage({ text: CREATE, channelType: ChannelType.DM }),
        state: state(),
      }),
    ).rejects.toMatchObject({ code: "STAGE1_ROUTING_CONFLICT" });
  });
});

describe("the conflicting draft behind a whole-request owner", () => {
  function ownerRuntime(responses: unknown[]) {
    const runtime = makeRuntime(responses);
    const action = workflowStub();
    runtime.actions = [{ ...action, roleGate: undefined }] as never;
    registerWorkflowRequestRouting(runtime);
    const evaluator = BUILTIN_RESPONSE_HANDLER_EVALUATORS.find(
      (entry) => entry.name === "core.direct_registered_capability_request",
    );
    if (!evaluator) throw new Error("Expected capability evaluator");
    runtime.responseHandlerEvaluators = [evaluator];
    return runtime;
  }
  const state = () => ({
    ...makeState(),
    values: { availableContexts: "general, automation" },
  });

  it("runs none of the draft's plugin field effects", async () => {
    // A plugin field (threadOps abort, networkAction SET_STATE, calendar
    // bindings) carried by the rejected draft must not act once the owner
    // takes the turn: before the owner path, the conflict ran no field at all.
    const conflict = () =>
      stage1Response({
        contexts: ["automation"],
        intents: ["create a workflow named Alpha device test"],
        candidateActionNames: ["WORKFLOW"],
        replyText: "What should it do?",
        extra: {
          replyEffectStatus: "non_applied",
          effectProbe: { op: "abort" },
          completionContext: { kind: "prior" },
          extract: { facts: ["The owner wants a workflow"] },
        },
      });
    const runtime = ownerRuntime([conflict(), conflict()]);
    const handle = vi.fn(() => undefined);
    runtime.responseHandlerFieldRegistry.register({
      name: "effectProbe",
      description: "Test field with an effect.",
      priority: 19,
      schema: { type: "object", properties: { op: { type: "string" } } },
      parse: (value: unknown) =>
        value && typeof value === "object" ? value : null,
      handle,
    } as never);
    const result = await runStage1({
      runtime,
      message: makeMessage({ text: CREATE, channelType: ChannelType.DM }),
      state: state(),
      stage1DecisionOnly: true,
    } as never);
    expect(handle).not.toHaveBeenCalled();
    const plan = result.messageHandler.plan;
    expect(plan.candidateActions).toEqual(["WORKFLOW"]);
    expect(plan.intents).toEqual([CREATE]);
    expect(plan.completionContext).toBeUndefined();
    expect(result.messageHandler.extract?.facts ?? []).toEqual([]);
  });

  it("fails closed when a second, unadmitted route also claims the whole request", async () => {
    // The capability evaluator treats two whole-request claimants as
    // ambiguous whatever their admission; the guard must not pick one.
    const conflict = () =>
      stage1Response({
        contexts: ["automation"],
        intents: ["create a workflow named Alpha device test"],
        candidateActionNames: ["WORKFLOW"],
        replyText: "What should it do?",
        extra: { replyEffectStatus: "non_applied" },
      });
    const runtime = ownerRuntime([conflict(), conflict()]);
    registerDirectActionRoutingRule(runtime, {
      id: "test.unadmitted-owner",
      actionNames: ["NOT_REGISTERED"],
      requiredActionTags: [],
      contexts: ["automation"],
      matches: () => true,
      wholeRequest: { matches: () => true, invalidateFields: [] },
    });
    await expect(
      runStage1({
        runtime,
        message: makeMessage({ text: CREATE, channelType: ChannelType.DM }),
        state: state(),
      }),
    ).rejects.toMatchObject({ code: "STAGE1_ROUTING_CONFLICT" });
  });
});

describe("the routing-conflict failure reply", () => {
  // agent.log classified the v610 failure as failureCause=transient. The reply
  // must stay a plain, unpersisted REPLY that no client or later turn can
  // read as an action that ran or should be replayed.
  it("names no action, no effect and no retryable transient", async () => {
    const runtime = makeRuntime([]);
    const message = makeMessage({ text: CREATE, channelType: ChannelType.DM });
    const result = await new MessageFailures().buildStructuredFailureReply(
      runtime,
      message,
      makeState(),
      "00000000-0000-0000-0000-000000000005" as never,
      "running the native tool message runtime",
      "transient",
      new ElizaError(
        "Stage-1 decision still conflicts after repair; retry with a consistent routing decision",
        { code: "STAGE1_ROUTING_CONFLICT" },
      ),
    );
    expect(result.responseContent).toMatchObject({
      text: "I couldn't prepare that request correctly. No action was started.",
      actions: ["REPLY"],
      doNotPersist: true,
      transient: false,
      failureKind: "handler_error",
    });
    expect(result.responseContent?.actions).not.toContain("WORKFLOW");
    expect(
      (result.responseContent as Record<string, unknown>).effectReceipts,
    ).toBeUndefined();
    expect(result.terminalFailure).toMatchObject({
      kind: "handler_error",
      code: "STAGE1_ROUTING_CONFLICT",
      transient: false,
    });
    // The canned reply needs no model call that could improvise a proposal.
    expect(useModelCalls(runtime)).toHaveLength(0);
  });
});

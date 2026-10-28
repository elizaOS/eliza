import { describe, expect, it } from "vitest";
import { evaluatePlannedReplyEgress } from "../services/message/egress-policy.ts";
import { preparedViewReply } from "../services/message/reply-policy.ts";
import { runPlannerLoop } from "./planner-loop.ts";

function navigation() {
  const id = "11111111-1111-4111-8111-111111111111";
  return {
    success: true,
    transcriptVisibility: "internal",
    modelReplyRequired: true,
    text: JSON.stringify({
      effect: "view_navigation",
      status: "prepared",
      viewId: "notes",
      path: "/notes",
      label: "Notes",
      stepId: "nav-step",
      handoffId: id,
    }),
    data: {
      awaitingDeviceExecution: true,
      navigation: {
        effect: "view_navigation",
        status: "prepared",
        viewId: "notes",
        path: "/notes",
        label: "Notes",
        stepId: "nav-step",
        handoffId: id,
      },
      values: {
        mode: "show",
        viewId: "notes",
        viewPath: "/notes",
        completedActionDelivered: false,
        completedActionHandoffId: id,
        navigationPrepared: true,
        navigationBinding: {
          requestId: id,
          clientId: "client-1",
          viewId: "notes",
          viewType: "gui",
          installationId: "install-1",
        },
      },
    },
  };
}
async function run(
  options: {
    mixed?: boolean;
    invalidBinding?: boolean;
    wrongHandoff?: boolean;
    defer?: boolean;
  } = {},
) {
  const toolResult = navigation();
  if (options.invalidBinding)
    toolResult.data.values.navigationBinding.viewId = "other";
  if (options.wrongHandoff)
    toolResult.data.values.navigationBinding.requestId =
      "22222222-2222-4222-8222-222222222222";
  let modelCalls = 0,
    evaluations = 0,
    executions = 0;
  const intents = options.mixed
    ? ["Open Notes", "Create a note"]
    : ["Open Notes"];
  const result = await runPlannerLoop({
    context: {
      id: "navigation-regression",
      events: [
        {
          id: "stage-one",
          type: "message_handler",
          source: "message-service",
          metadata: { plan: { intents } },
        },
      ],
    },
    deferInternalReplyRecoveryToCaller: options.defer ?? true,
    tools: [
      {
        name: "VIEWS_SHOW",
        parameters: {
          type: "object",
          properties: { view: { type: "string" } },
          required: ["view"],
        },
      },
    ],
    runtime: {
      useModel: async () => {
        modelCalls++;
        return modelCalls === 1
          ? {
              text: "",
              toolCalls: [
                {
                  id: "navigation-call",
                  name: "VIEWS_SHOW",
                  arguments: {
                    view: "notes",
                    navigationStepId: "nav-step",
                    eliza_turn_scope: "final",
                  },
                },
              ],
            }
          : JSON.stringify({
              completed: true,
              toolCalls: [],
              messageToUser: "Opening Notes.",
            });
      },
    },
    executeToolCall: async () => {
      executions++;
      return toolResult;
    },
    evaluate: async () => {
      evaluations++;
      return {
        success: true,
        decision: "FINISH",
        requestFullyCovered: true,
        replyEffectStatus: "none",
        messageToUser: "Notes is open.",
      };
    },
  } as never);
  return { result, modelCalls, evaluations, executions, toolResult, intents };
}
function held(
  h: Awaited<ReturnType<typeof run>>,
  reply: string,
  viewId = "notes",
) {
  return preparedViewReply({
    stageOne: {
      visualContinuation: { disposition: "direct", viewId },
      intents: h.intents,
    },
    effectStatus: "pending",
    reply,
    steps: h.result.trajectory.steps,
    allow: (text) =>
      evaluatePlannedReplyEgress({
        reply: text,
        providers: {
          VIEW_NAVIGATION: {
            data: {
              views: [{ id: "notes", label: "Notes" }],
              currentViewId: "chat",
            },
          },
        } as never,
        actionResults: [h.toolResult] as never,
        actions: [],
      }).verdict === "allow",
  });
}
describe("prepared navigation defers to existing host reply policy", () => {
  it("uses one planner plus evaluator and preserves unacknowledged state", async () => {
    const h = await run();
    expect(h.modelCalls).toBe(1);
    expect(h.evaluations).toBe(1);
    expect(h.executions).toBe(1);
    expect(h.result.replyRecoveryRequired).toBe(true);
    expect(h.result.finalMessage).toBeUndefined();
    expect(h.result.evaluator).toMatchObject({
      success: false,
      decision: "FINISH",
      requestFullyCovered: false,
      replyEffectStatus: "non_applied",
    });
    expect(held(h, "Opening Notes.")).toBe("Opening Notes.");
    expect(h.toolResult.data.values.completedActionDelivered).toBe(false);
  });
  it("does not use empty or mismatched prose, or premature completed wording", async () => {
    const h = await run();
    expect(held(h, "")).toBeUndefined();
    expect(held(h, "Opening Calendar.")).toBeUndefined();
    expect(held(h, "Opening Notes.", "calendar")).toBeUndefined();
    expect(held(h, "Notes is open.")).toBeUndefined();
    expect(h.result.replyRecoveryRequired).toBe(true);
  });
  it("keeps standalone fallback and mixed or invalid navigation out of the shortcut", async () => {
    for (const options of [
      { defer: false },
      { mixed: true },
      { invalidBinding: true },
      { wrongHandoff: true },
    ]) {
      const h = await run(options);
      expect(h.modelCalls).toBe(2);
      expect(h.executions).toBe(1);
      expect(h.result.replyRecoveryRequired).not.toBe(true);
    }
  });
});

import { describe, expect, it } from "vitest";
import { runPlannerLoop } from "./planner-loop.ts";

// Live tj-6941f5b0efa216: "make an event for today at 7am called qa teaa".
// The planner opened Calendar first with eliza_turn_scope=more_work_pending,
// the app renderer prepared that navigation, and the evaluator asked to
// CONTINUE to the create. The loop ended the turn on the prepared marker, so
// the create never ran and reply recovery could only fail.
function preparedNavigation() {
  const id = "11111111-1111-4111-8111-111111111111";
  return {
    success: true,
    transcriptVisibility: "internal",
    modelReplyRequired: true,
    text: JSON.stringify({
      effect: "view_navigation",
      status: "prepared",
      viewId: "calendar",
      path: "/calendar",
      label: "Calendar",
      handoffId: id,
    }),
    data: {
      awaitingDeviceExecution: true,
      navigation: {
        effect: "view_navigation",
        status: "prepared",
        viewId: "calendar",
        path: "/calendar",
        label: "Calendar",
        handoffId: id,
      },
      values: {
        mode: "show",
        viewId: "calendar",
        viewPath: "/calendar",
        completedActionDelivered: false,
        completedActionHandoffId: id,
        navigationPrepared: true,
        navigationBinding: {
          requestId: id,
          clientId: "client-1",
          viewId: "calendar",
          viewType: "gui",
          installationId: "install-1",
        },
      },
    },
  };
}

function durableDeviceRequest() {
  return {
    success: true,
    transcriptVisibility: "internal",
    modelReplyRequired: true,
    text: "Alarm request queued for the phone.",
    data: { awaitingDeviceExecution: true },
  };
}

const created = {
  success: true,
  transcriptVisibility: "internal",
  modelReplyRequired: true,
  text: "Created qa teaa.",
  effectReceipts: [
    {
      receiptId: "calendar-receipt-1",
      operation: "calendar.event.create",
      outcome: "applied",
      resource: { kind: "calendar.event", id: "event-1" },
    },
  ],
};

async function run(
  options: {
    scope?: "more_work_pending" | "final";
    first?: "navigation" | "device";
    decision?: "CONTINUE" | "FINISH";
    repeatNavigation?: boolean;
  } = {},
) {
  const executed: string[] = [];
  let planners = 0,
    evaluations = 0;
  const first = options.first === "device" ? "DEVICE_ACTION" : "VIEWS_SHOW";
  const result = await runPlannerLoop({
    context: {
      id: "prepared-navigation-pending-work",
      events: [
        {
          id: "stage-one",
          type: "message_handler",
          source: "message-service",
          metadata: { plan: { intents: ["create the event"] } },
        },
      ],
    },
    deferInternalReplyRecoveryToCaller: true,
    tools: [
      {
        name: first,
        parameters: { type: "object", properties: {} },
      },
      {
        name: "CALENDAR_CREATE_EVENT",
        parameters: { type: "object", properties: {} },
      },
    ],
    runtime: {
      useModel: async () => {
        planners++;
        if (planners === 1 || (planners === 2 && options.repeatNavigation))
          return {
            text: "",
            toolCalls: [
              {
                id: "first-call",
                name: first,
                arguments: {
                  view: "calendar",
                  eliza_turn_scope: options.scope ?? "more_work_pending",
                },
              },
            ],
          };
        if (planners === 2)
          return {
            text: "",
            toolCalls: [
              {
                id: "create-call",
                name: "CALENDAR_CREATE_EVENT",
                arguments: { title: "qa teaa", eliza_turn_scope: "final" },
              },
            ],
          };
        throw Error("unexpected planner call");
      },
    },
    executeToolCall: async (call: { name: string }) => {
      executed.push(call.name);
      if (call.name === "CALENDAR_CREATE_EVENT") return created;
      return options.first === "device"
        ? durableDeviceRequest()
        : preparedNavigation();
    },
    evaluate: async () => {
      evaluations++;
      return evaluations === 1 || options.repeatNavigation
        ? {
            success: true,
            decision: options.decision ?? "CONTINUE",
            requestFullyCovered: false,
            replyEffectStatus: "none",
            messageToUser: "",
            thought:
              "Calendar navigation is prepared; the event has not been created yet.",
          }
        : {
            success: true,
            decision: "FINISH",
            requestFullyCovered: true,
            replyEffectStatus: "applied",
            messageToUser: "Created qa teaa for 7am today.",
            effectReceiptIds: ["calendar-receipt-1"],
          };
    },
  } as never);
  return { result, executed, planners, evaluations };
}

describe("prepared app-view navigation with explicitly pending work", () => {
  it("replans the remaining independent work instead of ending the turn", async () => {
    const h = await run();
    expect(h.executed).toEqual(["VIEWS_SHOW", "CALENDAR_CREATE_EVENT"]);
    expect(h.planners).toBe(2);
    expect(h.evaluations).toBe(2);
    expect(h.result.status).toBe("finished");
    expect(h.result.replyRecoveryRequired).not.toBe(true);
    expect(h.result.evaluator).toMatchObject({
      decision: "FINISH",
      success: true,
    });
  });

  it("still ends partially when the planner declared the navigation final", async () => {
    const h = await run({ scope: "final" });
    expect(h.executed).toEqual(["VIEWS_SHOW"]);
    expect(h.result.evaluator).toMatchObject({
      decision: "FINISH",
      success: false,
      requestFullyCovered: false,
      replyEffectStatus: "non_applied",
    });
  });

  it("still ends partially on a model FINISH claim", async () => {
    const h = await run({ decision: "FINISH" });
    expect(h.executed).toEqual(["VIEWS_SHOW"]);
    expect(h.result.evaluator).toMatchObject({
      decision: "FINISH",
      success: false,
      requestFullyCovered: false,
    });
  });

  it("replans once: a repeated prepared navigation ends the turn", async () => {
    const h = await run({ repeatNavigation: true });
    expect(h.executed).toEqual(["VIEWS_SHOW", "VIEWS_SHOW"]);
    expect(h.evaluations).toBe(2);
    expect(h.result.evaluator).toMatchObject({
      decision: "FINISH",
      success: false,
      requestFullyCovered: false,
      replyEffectStatus: "non_applied",
    });
  });

  it("keeps a durable device request as a turn boundary", async () => {
    const h = await run({ first: "device" });
    expect(h.executed).toEqual(["DEVICE_ACTION"]);
    expect(h.result.evaluator).toMatchObject({
      decision: "FINISH",
      success: false,
      requestFullyCovered: false,
      replyEffectStatus: "non_applied",
    });
  });
});

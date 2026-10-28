import { describe, expect, it } from "vitest";
import { evaluatePlannedReplyEgress } from "../services/message/egress-policy.ts";
import { runPlannerLoop } from "./planner-loop.ts";

function fixture() {
  const id = "11111111-1111-4111-8111-111111111111";
  return {
    success: true,
    transcriptVisibility: "internal",
    modelReplyRequired: true,
    text: JSON.stringify({
      effect: "view_navigation",
      status: "prepared",
      viewId: "automations",
      label: "Automations",
      resolvedAlias: "workflows",
    }),
    data: {
      awaitingDeviceExecution: true,
      view: { id: "automations", installationId: "install-1" },
      navigation: {
        effect: "view_navigation",
        status: "prepared",
        viewId: "automations",
        label: "Automations",
        resolvedAlias: "workflows",
        handoffId: id,
      },
      values: {
        mode: "show",
        viewId: "automations",
        completedActionHandoffId: id,
        completedActionDelivered: false,
        navigationPrepared: true,
        navigationBinding: {
          requestId: id,
          clientId: "client-1",
          installationId: "install-1",
          viewId: "automations",
          viewType: "gui",
        },
      },
    },
  };
}
async function run(
  reply: string,
  options: {
    badBinding?: boolean;
    wrongInstallation?: boolean;
    approval?: boolean;
    effectfulDiscovery?: boolean;
    mixed?: boolean;
    registry?: boolean;
  } = {},
) {
  let planners = 0,
    evaluators = 0,
    executed = 0;
  let pendingPrompt = false;
  const nav = fixture();
  if (options.badBinding) nav.data.values.navigationBinding.viewId = "other";
  if (options.wrongInstallation) nav.data.view.installationId = "other";
  if (options.approval) Object.assign(nav.data, { requiresConfirmation: true });
  const turns = [
    {
      name: "DISCOVER_ACTIONS",
      result: {
        success: true,
        transcriptVisibility: "internal",
        modelReplyRequired: true,
        data: { readOnlyOperation: true },
      },
    },
    {
      name: "DISCOVER_ACTIONS",
      result: {
        success: true,
        transcriptVisibility: "internal",
        modelReplyRequired: true,
        data: { readOnlyOperation: true },
      },
    },
    { name: "VIEWS_SHOW", result: nav },
  ];
  if (options.effectfulDiscovery)
    Object.assign(turns[0].result, {
      effectReceipts: [{ outcome: "applied" }],
    });
  if (options.mixed)
    turns[0] = {
      name: "NOTES_LIST",
      result: {
        success: true,
        transcriptVisibility: "internal",
        modelReplyRequired: true,
        data: { readOnlyOperation: true },
      },
    };
  const context = {
    id: "pending-nav",
    events: [
      {
        id: "stage1",
        type: "message_handler",
        source: "message-service",
        metadata: {
          plan: {
            intents: options.mixed
              ? ["Open Workflows", "Read notes"]
              : ["Open Workflows"],
          },
        },
      },
      ...(options.registry === false
        ? []
        : [
            {
              id: "views",
              type: "provider",
              name: "VIEW_NAVIGATION",
              data: {
                views: [
                  {
                    id: "automations",
                    label: "Automations",
                    aliases: ["workflows"],
                  },
                  { id: "notes", label: "Notes" },
                ],
                currentViewId: "notes",
              },
            },
          ]),
    ],
  };
  const result = await runPlannerLoop({
    context,
    deferInternalReplyRecoveryToCaller: true,
    tools: [
      {
        name: "DISCOVER_ACTIONS",
        parameters: { type: "object", properties: {} },
      },
      { name: "VIEWS_SHOW", parameters: { type: "object", properties: {} } },
      { name: "NOTES_LIST", parameters: { type: "object", properties: {} } },
    ],
    runtime: {
      useModel: async (_type: unknown, args: { messages?: unknown }) => {
        const i = planners++;
        if (i < turns.length)
          return {
            text: "",
            toolCalls: [
              {
                id: "call-" + i,
                name: turns[i].name,
                arguments: { view: "workflows", eliza_turn_scope: "final" },
              },
            ],
          };
        pendingPrompt ||= JSON.stringify(args.messages ?? []).includes(
          "not yet confirmed on screen",
        );
        return JSON.stringify({
          completed: true,
          toolCalls: [],
          messageToUser: reply,
        });
      },
    },
    executeToolCall: () => turns[executed++].result,
    evaluate: () => {
      evaluators++;
      return {
        success: false,
        decision: "CONTINUE",
        requestFullyCovered: true,
        replyEffectStatus: "applied",
      };
    },
  } as never);
  return { result, planners, evaluators, executed, pendingPrompt, nav };
}
describe("fresh pending-navigation synthesis", () => {
  it("keeps one honest prospective reply after pure discovery without another rescue", async () => {
    const h = await run("Opening Workflows.");
    expect(h.planners).toBe(4);
    expect(h.evaluators).toBe(1);
    expect(h.executed).toBe(3);
    expect(h.pendingPrompt).toBe(true);
    expect(h.result.finalMessage).toBe("Opening Workflows.");
    expect(h.result.evaluator).toMatchObject({
      success: false,
      requestFullyCovered: false,
      replyEffectStatus: "non_applied",
    });
    expect(h.nav.data.values.completedActionDelivered).toBe(false);
  });
  it.each([
    "Workflows is open.",
    "Back on Workflows.",
    "Opening Notes.",
    "Notes is open. Opening Workflows.",
    "",
    "Opening Workflows. I saved your note.",
  ])("rejects ungrounded or empty synthesis: %s", async (reply) => {
    const h = await run(reply);
    expect(h.result.finalMessage).not.toBe(reply || "Opening Workflows.");
    expect(h.executed).toBe(3);
  });
  it("accepts a grounded current-view shorthand but rejects it before acknowledgment", () => {
    const check = (currentViewId: string | null) =>
      evaluatePlannedReplyEgress({
        reply: "Back on Workflows.",
        providers: {
          VIEW_NAVIGATION: {
            data: {
              views: [
                {
                  id: "automations",
                  label: "Automations",
                  aliases: ["workflows"],
                },
              ],
              currentViewId,
            },
          },
        } as never,
        actionResults: [],
        actions: [],
      });
    expect(check("automations").verdict).toBe("allow");
    expect(check(null)).toEqual({ verdict: "reject", kind: "view_navigation" });
  });
  it("does not hide effectful discovery as harmless routing", async () => {
    await expect(
      run("Opening Workflows.", { effectfulDiscovery: true }),
    ).rejects.toThrow("terminal_only_continuations");
  });
  it.each([
    { badBinding: true },
    { mixed: true },
    { registry: false },
    { wrongInstallation: true },
    { approval: true },
  ])(
    "retains normal validation for unavailable prepared context %j",
    async (options) => {
      const h = await run("Opening Workflows.", options);
      expect(h.result.finalMessage).not.toBe("Opening Workflows.");
      expect(h.executed).toBe(3);
    },
  );
});

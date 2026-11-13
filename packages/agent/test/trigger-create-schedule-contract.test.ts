import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { expect, it } from "vitest";
import { runPlannerLoop } from "../../../plugins/plugin-assistant/src/runtime/planner-loop.ts";
import { promoteSubactionsToActions } from "../../core/src/actions/promote-subactions.ts";
import { buildPlannerToolsFromActions } from "../../core/src/actions/to-tool.ts";
import { triggerAction } from "../src/actions/trigger.ts";

const SCHEDULE_FIELDS = [
  "delayMinutes",
  "delaySeconds",
  "scheduledAtIso",
  "cronExpression",
  "intervalMs",
];

type WireTool = {
  name: string;
  parameters?: { properties?: Record<string, { description?: string }> };
};

/** The tools the planner model receives when TRIGGER and TRIGGER_CREATE are both exposed. */
async function plannerWireTools(): Promise<WireTool[]> {
  const actions = promoteSubactionsToActions(triggerAction).filter((action) =>
    ["TRIGGER", "TRIGGER_CREATE"].includes(action.name),
  );
  const requests: { tools?: WireTool[] }[] = [];
  await runPlannerLoop({
    runtime: {
      getService: () => null,
      useModel: async (_type: string, params: object) => {
        requests.push(params as { tools?: WireTool[] });
        return { text: "Done." };
      },
    },
    context: { id: "trigger-create-wire", events: [] },
    tools: buildPlannerToolsFromActions(actions),
    executeToolCall: async () => {
      throw new Error("The model answered without a tool call");
    },
    evaluate: async () => ({
      success: true,
      decision: "FINISH",
      thought: "Done.",
      messageToUser: "Done.",
    }),
  });
  return requests[0]?.tools ?? [];
}

// Live tj-78e69a9e3ae00d (wire 2026-10-30T11:01:37Z): with TRIGGER beside it,
// every schedule field on TRIGGER_CREATE read "Use the identical full
// description of parameter ... on tool TRIGGER." while instructions and
// wakeMode kept their own text, and taskId/enabled (never read by create) were
// offered too. The planner sent displayName, instructions and wakeMode only.
it("TRIGGER_CREATE carries its own schedule fields and no fields create ignores", async () => {
  const tools = await plannerWireTools();
  const parent = tools.find((tool) => tool.name === "TRIGGER");
  const create = tools.find((tool) => tool.name === "TRIGGER_CREATE");
  const properties = create?.parameters?.properties ?? {};
  expect(Object.keys(properties)).not.toContain("taskId");
  expect(Object.keys(properties)).not.toContain("enabled");
  for (const field of SCHEDULE_FIELDS) {
    expect(properties[field]?.description).toBe(
      parent?.parameters?.properties?.[field]?.description,
    );
    expect(properties[field]?.description).not.toContain("on tool");
  }
});

// Live: all 30 reminder create calls in the QA trajectories wrote their fields
// in schema order. The 17 that missed the schedule opened with displayName,
// instructions or nothing, past the delay fields listed before them; no call
// sent a delay after those fields (tj-7471737298abb6 and tj-6eff78bef6be90
// errored that way with TRIGGER_CREATE alone and full descriptions shown).
it("TRIGGER_CREATE lists its schedule fields after every other field", async () => {
  const create = (await plannerWireTools()).find(
    (tool) => tool.name === "TRIGGER_CREATE",
  );
  const fields = Object.keys(create?.parameters?.properties ?? {}).filter(
    (field) => !field.startsWith("eliza_"),
  );
  expect(fields.slice(-SCHEDULE_FIELDS.length).sort()).toEqual(
    [...SCHEDULE_FIELDS].sort(),
  );
});

it("TRIGGER_LIST carries no create or reference fields", () => {
  const list = promoteSubactionsToActions(triggerAction).find(
    (action) => action.name === "TRIGGER_LIST",
  );
  expect(list?.parameters?.map((parameter) => parameter.name)).toEqual([
    "action",
  ]);
});

const runtime = {
  getSetting: () => undefined,
  enableAutonomy: false,
} as unknown as IAgentRuntime;
const message = {
  entityId: "00000000-0000-0000-0000-000000000001" as UUID,
  roomId: "00000000-0000-0000-0000-000000000002" as UUID,
  content: { text: "remind me to drink water in 15 minutes" },
} as Memory;

// Live tj-7471737298abb6: "Provide an explicit schedule before creating a
// trigger." named no field, and the planner resent the same unscheduled
// TRIGGER_CREATE four times before the turn errored.
it.each<Record<string, string>>([
  { displayName: "Drink water", instructions: "Time to drink water" },
  { displayName: "Drink water", triggerType: "once" },
  { triggerType: "cron" },
])(
  "MISSING_SCHEDULE names the field for each phrasing (%j)",
  async (parameters) => {
    const result = await triggerAction.handler(runtime, message, undefined, {
      parameters: { action: "create", ...parameters },
    });
    expect(result?.error).toBe("MISSING_SCHEDULE");
    for (const field of ["delayMinutes", "delaySeconds", "scheduledAtIso"])
      expect(result?.text).toContain(field);
    expect(result?.text).toContain("cronExpression for a repeat");
  },
);

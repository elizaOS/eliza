/** Pins the planner tool wire order: the tools offered on every request lead, the tools admitted per request follow by name, and REPLY, which changes within a turn, is last. */

import type { Action, ContextObject, ToolDefinition } from "@elizaos/core";
import { CORE_PLANNER_TERMINALS, DISCOVER_ACTIONS_NAME } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { runPlannerLoop } from "../../runtime/planner-loop.ts";
import { proposeDeviceAction } from "../device-actions/action.ts";
import { deviceActionTools } from "../device-actions/tools.ts";
import { collectPlannerTools } from "./planned-tool.ts";
import { createPlannerToolDiscoveryAction } from "./tool-discovery.ts";

const discovery = createPlannerToolDiscoveryAction([], () => {}, undefined, {
  deferNameIndex: true,
});
const stub = (name: string): Action => ({
  name,
  description: `${name} records.`,
  parameters: [
    {
      name: "query",
      description: `What to find in ${name}.`,
      required: false,
      schema: { type: "string" },
    },
  ],
  validate: async () => true,
  handler: async () => ({ success: true }),
});
// In name order CALENDAR and the single-operation device tool precede every
// head tool, MAPS_PLACE falls between IGNORE and the device tool, VIEWS is last.
const calendar = stub("CALENDAR");
const maps = stub("MAPS_PLACE");
const views = stub("VIEWS");
// Spread from the device tool, so it restates that tool's parameter descriptions.
const singleOperation = deviceActionTools.find(
  (action) => action.name === "DEVICE_CALENDAR_READ_NEXT",
) as Action;

const terminals = CORE_PLANNER_TERMINALS.map((tool) => tool.name);
// REPLY's schema differs between two planner requests of one turn (a held
// reply may be released with no text), so it follows every other tool.
const steady = terminals.filter((name) => name !== "REPLY");
const head = [...steady, DISCOVER_ACTIONS_NAME, proposeDeviceAction.name];

function contextFor(actions: readonly Action[]): ContextObject {
  return {
    id: "planner-tool-order",
    events: actions.map((action) => ({
      id: `tool:${action.name}`,
      type: "tool",
      tool: { name: action.name, action },
    })),
  };
}

function toolsFor(actions: readonly Action[]): ToolDefinition[] {
  return collectPlannerTools(contextFor(actions), undefined, {
    canonicalFamilies: true,
  });
}

const names = (tools: readonly ToolDefinition[]) =>
  tools.map((tool) => tool.name);

/** The tool definitions a model call carries for this planner surface. */
async function sentTools(tools: ToolDefinition[]): Promise<ToolDefinition[]> {
  const requests: { tools?: ToolDefinition[] }[] = [];
  await runPlannerLoop({
    runtime: {
      getService: () => null,
      useModel: async (_type: string, params: object) => {
        requests.push(JSON.parse(JSON.stringify(params)));
        return { text: "Ready." };
      },
    },
    context: { id: "planner-tool-order", events: [] },
    tools,
    executeToolCall: async () => ({ success: true }),
    evaluate: async () => ({
      success: true,
      decision: "FINISH",
      thought: "",
      messageToUser: "Ready.",
    }),
  });
  return requests[0]?.tools ?? [];
}

describe("planner tool wire order", () => {
  it("leads with IGNORE and STOP, then discovery, then the device tool, then every other tool by name, and ends with REPLY", () => {
    expect(steady).toEqual(["IGNORE", "STOP"]);
    expect(
      names(
        toolsFor([
          views,
          proposeDeviceAction,
          maps,
          singleOperation,
          discovery,
          calendar,
        ]),
      ),
    ).toEqual([
      ...head,
      calendar.name,
      singleOperation.name,
      maps.name,
      views.name,
      "REPLY",
    ]);
  });

  it("keeps the remaining head tools in the same order when one is not offered", () => {
    expect(names(toolsFor([views, proposeDeviceAction, calendar]))).toEqual([
      ...steady,
      proposeDeviceAction.name,
      calendar.name,
      views.name,
      "REPLY",
    ]);
    expect(names(toolsFor([views, discovery, calendar]))).toEqual([
      ...steady,
      DISCOVER_ACTIONS_NAME,
      calendar.name,
      views.name,
      "REPLY",
    ]);
    expect(names(toolsFor([views, calendar]))).toEqual([
      ...steady,
      calendar.name,
      views.name,
      "REPLY",
    ]);
  });

  it("keeps the head byte-identical and in front when a per-request tool is admitted", () => {
    const alone = toolsFor([discovery, proposeDeviceAction]).slice(
      0,
      head.length,
    );
    expect(names(alone)).toEqual(head);
    for (const admitted of [
      [calendar],
      [singleOperation],
      [maps],
      [views],
      [views, maps, singleOperation, calendar],
    ]) {
      const tools = toolsFor([...admitted, discovery, proposeDeviceAction]);
      expect(tools).toHaveLength(head.length + admitted.length + 1);
      expect(tools.at(-1)?.name).toBe("REPLY");
      expect(JSON.stringify(tools.slice(0, head.length))).toBe(
        JSON.stringify(alone),
      );
    }
  });

  it("gives the same tools for the same admitted set in any input order", () => {
    const admitted = [
      calendar,
      discovery,
      maps,
      proposeDeviceAction,
      singleOperation,
      views,
    ];
    const expected = JSON.stringify(toolsFor(admitted));
    const rotations = admitted.map((_, index) => [
      ...admitted.slice(index),
      ...admitted.slice(0, index),
    ]);
    for (const order of [...rotations, [...admitted].reverse()]) {
      expect(JSON.stringify(toolsFor(order))).toBe(expected);
      // The mid-turn reload after a discovery load passes the admitted actions directly.
      expect(
        JSON.stringify(
          collectPlannerTools(contextFor(admitted), order, {
            canonicalFamilies: true,
          }),
        ),
      ).toBe(expected);
    }
  });

  it("sends the head byte-identically when an admitted tool restates the device tool's parameters", async () => {
    const alone = await sentTools(toolsFor([discovery, proposeDeviceAction]));
    const sent = await sentTools(
      toolsFor([calendar, singleOperation, discovery, proposeDeviceAction]),
    );
    expect(names(sent).slice(0, head.length)).toEqual(head);
    expect(JSON.stringify(sent.slice(0, head.length))).toBe(
      JSON.stringify(alone.slice(0, head.length)),
    );
    // The repeated description is stated on the head tool, so the per-request
    // tool is the one that refers to it.
    const shared = sent.find((tool) => tool.name === singleOperation.name);
    expect(JSON.stringify(shared)).toContain(
      `on tool ${proposeDeviceAction.name}.`,
    );
  });
});

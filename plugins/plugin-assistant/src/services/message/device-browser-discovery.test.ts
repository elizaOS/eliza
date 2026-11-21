/**
 * v612 Alpha image, Browser in front, "switch to the example.com tab": Stage 1
 * routed the turn to the browser context and the planner searched
 * DISCOVER_ACTIONS for "browser tab switch to tab". The search was scoped to
 * browser, where only the native BROWSER commands (back, forward, reload) and
 * DEVICE_BROWSER_OPEN lived. PROPOSE_DEVICE_ACTION, the only tool with
 * browser_tab_switch, browser_tab_close, browser_tab_new, browser_find,
 * browser_search and browser_history, was not in that scope, so the agent told
 * the owner it could only go back, forward or reload.
 */
import type { Action } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("../device-actions/service.ts", async (original) => ({
  ...(await original<typeof import("../device-actions/service.ts")>()),
  getDeviceActionTurn: () => undefined,
}));

import { proposeDeviceAction } from "../device-actions/action.ts";
import { deviceActionTools } from "../device-actions/tools.ts";
import {
  actionDiscoveryContexts,
  inferActionSearchContexts,
  retrieveContextualPlannerActions,
} from "./action-surface";

// The phone's native BROWSER tool as the planner saw it on that turn.
const nativeBrowser = {
  name: "BROWSER",
  description:
    "Control the page that is showing in the requesting device's own browser. Only these commands are available: back, forward, reload. Do not offer any other browser command through this tool. Accepted dispatch does not prove website completion.",
  contexts: ["browser"],
  similes: [],
  parameters: [],
  validate: async () => true,
  handler: async () => undefined,
} as unknown as Action;
const actions = [proposeDeviceAction, nativeBrowser, ...deviceActionTools];

/** The planner's discovery: a query naming a domain is scoped to it. */
function discover(query: string, contexts?: readonly string[]): string[] {
  const scope = contexts ?? inferActionSearchContexts(actions, query);
  const scoped = scope.length
    ? actions.filter((action) =>
        actionDiscoveryContexts(action).some((context) =>
          scope.includes(context),
        ),
      )
    : actions;
  return retrieveContextualPlannerActions({
    actions: scoped,
    query,
    contexts: scope.length ? [...scope] : undefined,
  }).actions.map((action) => action.name);
}

describe("phone Browser control discovery", () => {
  it("finds the phone's own tab operation for a tab request routed as browser", () => {
    // The planner's own query on that turn, and the owner's words.
    for (const query of [
      "browser tab switch to tab",
      "switch to the example.com tab",
    ])
      expect(discover(query, ["browser"]), query).toContain(
        "DEVICE_BROWSER_TAB_SWITCH",
      );
  });

  it("finds each Browser control in the browser scope", () => {
    for (const [query, name] of [
      ["close the browser tab", "DEVICE_BROWSER_TAB_CLOSE"],
      ["new private browser tab", "DEVICE_BROWSER_TAB_NEW"],
      ["search the web for cheap flights", "DEVICE_BROWSER_SEARCH"],
      ["find the word domain on this page", "DEVICE_BROWSER_PAGE_SEARCH"],
    ] as const)
      expect(discover(query, ["browser"]), query).toContain(name);
  });

  it("still finds the typed open for an address the owner typed", () => {
    expect(
      discover("open example.com in a new browser tab", ["browser"]),
    ).toContain("DEVICE_BROWSER_OPEN");
  });

  it("leaves back, forward and reload to the native BROWSER commands in the browser scope", () => {
    // v612 answered "go back" honestly through BROWSER; no device tool competes.
    for (const query of ["go back", "go forward", "reload the page"]) {
      const found = discover(query, ["browser"]);
      expect(found[0], query).toBe("BROWSER");
      expect(
        deviceActionTools.some(
          (tool) => tool.name === "DEVICE_BROWSER_HISTORY",
        ),
      ).toBe(false);
    }
  });

  it("adds no Browser control tool to the general scope", () => {
    // PROPOSE_DEVICE_ACTION already offers these operations in general; six
    // more Browser tools there outranked web search for questions and "go back".
    const general = (list: readonly Action[]) =>
      list.filter((action) =>
        actionDiscoveryContexts(action).includes("general"),
      );
    const before = general(
      actions.filter(
        (action) =>
          !action.name.startsWith("DEVICE_BROWSER_") ||
          action.name === "DEVICE_BROWSER_OPEN",
      ),
    );
    expect(general(actions)).toEqual(before);
    for (const query of [
      "look up the capital of peru",
      "what is the weather",
      "go back",
      "switch to the example.com tab",
    ])
      expect(discover(query, ["general"]), query).toEqual(
        retrieveContextualPlannerActions({
          actions: before,
          query,
          contexts: ["general"],
        }).actions.map((action) => action.name),
      );
  });

  it("offers each Browser control only as its own operation, in the browser context", () => {
    const controls = deviceActionTools.filter(
      (tool) =>
        tool.name.startsWith("DEVICE_BROWSER_") &&
        tool.name !== "DEVICE_BROWSER_OPEN",
    );
    expect(controls.map((tool) => tool.name).sort()).toEqual([
      "DEVICE_BROWSER_PAGE_SEARCH",
      "DEVICE_BROWSER_SEARCH",
      "DEVICE_BROWSER_TAB_CLOSE",
      "DEVICE_BROWSER_TAB_NEW",
      "DEVICE_BROWSER_TAB_SWITCH",
    ]);
    for (const tool of controls) {
      expect(actionDiscoveryContexts(tool), tool.name).toEqual(["browser"]);
      expect(tool.tags, tool.name).toContain("domain:browser");
      const schema = tool.parameters?.find(
        (parameter) => parameter.name === "operation",
      )?.schema as { anyOf: { properties: { type: { enum: string[] } } }[] };
      expect(schema.anyOf, tool.name).toHaveLength(1);
    }
  });
});

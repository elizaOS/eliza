/**
 * "Open a new tab", routed to the browser context: the planner's first tool
 * list is picked by matching the request against each tool's name, description
 * and similes. DEVICE_BROWSER_OPEN speaks of a new tab for an address and was
 * the only match, a search for the empty tab found that tool again, and one
 * such turn proposed an open with an empty address. These tests pin that the
 * empty-tab tool is in the first list and in a search for the owner's words,
 * that an address in a new tab is offered the typed open and no empty tab,
 * and that the other Browser requests get the list they had.
 */
import type { Action, IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actionDiscoveryContexts,
  retrieveContextualPlannerActions,
} from "../message/action-surface.ts";
import { proposeDeviceAction } from "./action.ts";
import { DeviceActionService, withDeviceActionTurn } from "./service.ts";
import { deviceActionTools } from "./tools.ts";

const NEW_TAB = "DEVICE_BROWSER_TAB_NEW";
const OPEN = "DEVICE_BROWSER_OPEN";
/** The phone's device surface, from which both lists are picked. */
const deviceSurface: readonly Action[] = [
  proposeDeviceAction,
  ...deviceActionTools,
];
const NEW_TAB_WORDS = /\bnew tab\b|\bopen a tab\b/;
const withoutNewTabSimiles = deviceSurface.map((tool) => ({
  ...tool,
  similes: tool.similes?.filter((simile) => !NEW_TAB_WORDS.test(simile)),
}));
/** The planner's first tool list for a request the first stage routed to browser. */
const firstTools = (
  query: string,
  intent: string,
  tools: readonly Action[] = deviceSurface,
): string[] =>
  retrieveContextualPlannerActions({
    actions: tools,
    deferUnscopedBootstrap: true,
    query,
    intents: [intent],
    contexts: ["browser"],
  }).actions.map((action) => action.name);
/** What the planner's own search of the browser scope returns. */
const search = (
  query: string,
  tools: readonly Action[] = deviceSurface,
): string[] =>
  retrieveContextualPlannerActions({
    actions: tools.filter((tool) =>
      actionDiscoveryContexts(tool).includes("browser"),
    ),
    query,
    contexts: ["browser"],
  }).actions.map((action) => action.name);
/**
 * The device tools the action gate admits for the owner's message on a phone
 * with Browser tabs. Both lists are picked from the admitted tools only.
 */
async function admitted(text: string): Promise<Action[]> {
  const runtime = {
    agentId: "11111111-1111-4111-8111-111111111111",
    character: { name: "Alpha" },
    actions: deviceSurface,
  } as unknown as IAgentRuntime;
  const message = {
    entityId: "22222222-2222-4222-8222-222222222222",
    content: { text, source: "client_chat" },
  } as unknown as Memory;
  vi.spyOn(DeviceActionService.prototype, "viewProfile").mockResolvedValue(
    null,
  );
  return withDeviceActionTurn(
    runtime,
    {
      subjectUserId: "owner-subject",
      installationId: "installation",
      deviceKey: "key",
      capabilities: [
        "browser.search.v1",
        "browser.tabs.v1",
        "browser.history.v1",
        "browser.find.v1",
        "browser.open-new-tab.v1",
      ],
    } as never,
    async () => {
      const tools: Action[] = [];
      for (const tool of deviceSurface)
        if (await tool.validate?.(runtime, message)) tools.push(tool);
      return tools;
    },
  );
}

afterEach(() => vi.restoreAllMocks());

describe("the planner's Browser tools for a new tab", () => {
  it.each([
    ["Open a new tab.", "open a new browser tab"],
    ["open a tab", "open a browser tab"],
    ["new tab", "open a new tab"],
    ["Open a private tab.", "open a private browser tab"],
  ])("has the empty-tab tool in the first list for %j", (query, intent) => {
    expect(firstTools(query, intent)).toContain(NEW_TAB);
  });

  it("finds the empty-tab tool in a search for the owner's words", () => {
    for (const query of ["open a new tab", "open a new browser tab"])
      expect(search(query), query).toContain(NEW_TAB);
  });

  it("still leads with the typed open where the words of an address in a new tab match both tools", () => {
    // Those words hold the words of an empty tab too. Where both tools are
    // admitted the open is listed first; each description says which to use.
    expect(
      firstTools(
        "Open example.com in a new tab.",
        "open example.com in a new browser tab",
      )[0],
    ).toBe(OPEN);
    for (const query of [
      "open example.com in a new tab",
      "open example.com in a new browser tab",
    ])
      expect(search(query)[0], query).toBe(OPEN);
  });

  it.each([
    ["Open example.com in a new tab.", "open example.com in a new browser tab"],
    ["can you open example.com in a new tab?", "open example.com in a new tab"],
  ])(
    "offers only the typed open, in the first list and in a search, for %j",
    async (query, intent) => {
      // The request is an open of the address, which the proposal tool offers no
      // empty tab for. Its words alone would list the empty-tab tool as well.
      expect(firstTools(query, intent)).toEqual([OPEN, NEW_TAB]);
      const tools = await admitted(query);
      const names = tools.map((tool) => tool.name);
      expect(names).toContain(OPEN);
      expect(names).not.toContain(NEW_TAB);
      expect(firstTools(query, intent, tools)).toEqual([OPEN]);
      for (const words of [
        query,
        intent,
        "open example.com in a new tab",
        "open example.com in a new browser tab",
      ])
        expect(search(words, tools), words).toEqual([OPEN]);
    },
  );

  it.each([
    ["Open a new tab.", "open a new browser tab"],
    ["open a tab", "open a browser tab"],
    ["Open a private tab.", "open a private browser tab"],
    // A private tab for an address is not an open in a new tab.
    ["Open example.com in a private tab.", "open example.com privately"],
  ])(
    "still admits and lists the empty-tab tool for %j",
    async (query, intent) => {
      const tools = await admitted(query);
      expect(tools.map((tool) => tool.name)).toContain(NEW_TAB);
      expect(firstTools(query, intent, tools)).toContain(NEW_TAB);
    },
  );

  it("gives every other Browser request the first list it has without the new-tab similes", () => {
    expect(
      withoutNewTabSimiles.flatMap((tool) => tool.similes ?? []),
    ).not.toEqual(deviceSurface.flatMap((tool) => tool.similes ?? []));
    for (const [query, intent, tools] of [
      ["Close this tab.", "close the current browser tab", ["TAB_CLOSE"]],
      ["Open example.com.", "open example.com in the browser", ["OPEN"]],
      [
        'Find "refund" on this page.',
        'Find "refund" on the current browser page',
        ["PAGE_SEARCH", "SEARCH"],
      ],
      [
        "Search the web for flights to Lisbon.",
        "search the web for flights to Lisbon",
        ["OPEN", "SEARCH", "PAGE_SEARCH"],
      ],
    ] as const) {
      const picked = firstTools(query, intent);
      expect(picked, query).toEqual(
        firstTools(query, intent, withoutNewTabSimiles),
      );
      expect([...picked].sort(), query).toEqual(
        tools.map((name) => `DEVICE_BROWSER_${name}`).sort(),
      );
    }
  });
});

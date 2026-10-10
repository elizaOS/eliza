/** Discovery scope for routing tiers, current-task searches and query-named domains. */

import type { Action, Memory } from "@elizaos/core";
import { promoteSubactionsToActions } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { memoryAction } from "../../actions/memories.ts";
import { discoveryHarness } from "../__tests__/discovery-harness.ts";

const message = {
  content: { text: "Remember that my favorite tea is gyokuro." },
} as Memory;

// General-tagged create tools that compete with MEMORY_CREATE under a tier scope.
const generalCreates: Action[] = [
  ["OWNER_REMINDERS_CREATE", "Create a reminder for the owner"],
  ["OWNER_TODOS_CREATE", "Create a todo for the owner"],
  ["OWNER_GOALS_CREATE", "Create a goal for the owner"],
  ["NOTES_CREATE", "Create and save a note"],
].map(([name, description]) => ({
  name,
  description,
  contexts: ["general", "tasks"],
}));
const memoryOperations = [...promoteSubactionsToActions(memoryAction)];
const catalog = [...generalCreates, ...memoryOperations];

describe("discovery scope ignores routing tiers", () => {
  it("searches a general-only scope like an omitted one", async () => {
    const { call } = discoveryHarness(catalog, message);
    const query = "save durable fact remember favorite tea";
    const scoped = await call({ mode: "load", query, contexts: ["general"] });
    const omitted = await call({ mode: "load", query });
    expect(scoped?.success).toBe(true);
    expect(scoped?.data?.loadedTools).toContain("MEMORY_CREATE");
    expect(scoped?.data?.loadedTools).toEqual(omitted?.data?.loadedTools);
  });
});

// A domain word in the request or a planner query must not hide the tool that
// owns the build.
describe("search for a web page build", () => {
  const followUp = { content: { text: "go ahead" } } as Memory;
  const buildCatalog: Action[] = [
    {
      name: "TASKS",
      description:
        "Delegate coding work; build and host a web page with a live link.",
      routingHint: "a web page hosted at a live link -> TASKS",
      contexts: ["code", "automation", "agent_internal", "connectors"],
    },
    {
      name: "SHELL",
      description: "Run shell commands.",
      contexts: ["code", "terminal", "automation"],
    },
    {
      name: "WEB_FETCH",
      description: "Fetch a web page.",
      contexts: ["code", "terminal", "automation", "web"],
    },
    {
      name: "WEB_SEARCH",
      description: "Search the web.",
      contexts: ["code", "terminal", "automation", "web"],
    },
    {
      name: "ATTACHMENT",
      description: "Read an attachment or linked web page.",
      contexts: ["general", "files", "media", "messaging", "documents", "web"],
    },
    {
      name: "TERMINAL_SHELL",
      description: "Run one shell command in the terminal view.",
      contexts: ["terminal", "code", "files", "admin"],
    },
  ];
  const heldTools = [
    "ATTACHMENT",
    "DISCOVER_ACTIONS",
    "IGNORE",
    "REPLY",
    "STOP",
    "TERMINAL_SHELL",
    "WEB_FETCH",
    "WEB_SEARCH",
    "RESTORE_CONTEXT",
  ];
  const buildDiscovery = (exposed: string[]) =>
    discoveryHarness(buildCatalog, followUp, { exposed }).call;

  it("does not scope a direct build request to the web by its wording", async () => {
    const result = await discoveryHarness(
      buildCatalog,
      {
        content: {
          text: "build a web page explaining the plugin and deploy it",
        },
      } as Memory,
      {
        taskIntents: [
          "Build a web page explaining the plugin and deploy it as a live page",
        ],
        exposed: [...heldTools],
      },
    ).call({});
    expect(result?.data).not.toHaveProperty("inferredContexts");
    expect(result?.data?.loadedTools).toContain("TASKS");
  });

  // A planner query naming a domain whose members the planner already holds.
  const plannerQuery =
    "build deploy publish static web app page to example.test apps path";

  it("searches past a query-named domain whose scope holds only loaded tools", async () => {
    const exposed = [...heldTools];
    const result = await buildDiscovery(exposed)({ query: plannerQuery });
    expect(result?.data?.inferredContexts).toEqual(["web"]);
    expect(result?.data?.loadedTools).toEqual(
      expect.arrayContaining(["TASKS", "SHELL", "WEB_FETCH"]),
    );
    expect(exposed).toContain("TASKS");
  });

  // The scope answers the query while it still adds a tool: the same query
  // from a planner without WEB_FETCH loads the web reads and nothing else.
  it("keeps a planner query scoped to the domain it names while the scope adds a tool", async () => {
    const exposed = heldTools.filter((name) => name !== "WEB_FETCH");
    const result = await buildDiscovery(exposed)({ query: plannerQuery });
    expect(result?.data?.inferredContexts).toEqual(["web"]);
    const loaded = result?.data?.loadedTools as string[];
    expect(loaded).toContain("WEB_FETCH");
    for (const name of loaded)
      expect(
        buildCatalog.find((action) => action.name === name)?.contexts,
      ).toContain("web");
    expect(exposed).not.toContain("TASKS");
  });
});

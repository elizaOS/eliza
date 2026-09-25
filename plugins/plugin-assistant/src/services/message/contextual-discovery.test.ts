/** Exercises real tool retrieval, schema reads and fresh discovery admission without domain execution. */
import {
  type Action,
  AgentRuntime,
  type IAgentRuntime,
  type Memory,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { notesPlugin } from "../../../../plugin-notes/src/plugin";
import {
  collectV5PlannerCandidateActions,
  retrieveContextualPlannerActions,
} from "./action-surface";
import {
  collectDiscoveryCatalogActions,
  createPlannerToolDiscoveryAction,
} from "./tool-discovery";

const runtime = {} as IAgentRuntime;
const message = {} as Memory;

describe("contextual native discovery", () => {
  it("discovers gate-only domains while preserving required, forbidden and role terms", async () => {
    const runtime = new AgentRuntime({
      character: { name: "Context gates", bio: "Test" },
      logLevel: "fatal",
    });
    const actions: Action[] = [
      {
        name: "ANY",
        description: "Read notes",
        contextGate: { anyOf: ["notes", "blocked"], noneOf: ["blocked"] },
      },
      {
        name: "ALL",
        description: "Read notes and calendar",
        contextGate: { allOf: ["notes", "calendar"] },
      },
      {
        name: "CONTRADICTORY",
        description: "Unavailable",
        contextGate: { allOf: ["blocked"], noneOf: ["blocked"] },
      },
      {
        name: "OWNER_ONLY",
        description: "Private",
        contextGate: { anyOf: ["notes"], roleGate: { minRole: "OWNER" } },
      },
    ];
    runtime.actions.push(...actions);
    const currentMessage: Memory = {
      entityId: runtime.agentId,
      content: { text: "read my notes", channelType: "DM" },
    };
    const admitted = await collectV5PlannerCandidateActions({
      runtime,
      message: currentMessage,
      state: { text: "", values: {}, data: {} },
      discoverActions: true,
      userRoles: ["USER"],
    });
    expect(admitted.map((action) => action.name)).toEqual(["ANY", "ALL"]);
    expect(
      collectDiscoveryCatalogActions({
        actions,
        message: currentMessage,
        selectedContexts: ["general"],
        userRoles: ["USER"],
      }).map((action) => action.name),
    ).toEqual(["ANY", "ALL"]);
    expect(
      collectDiscoveryCatalogActions({
        actions,
        message: currentMessage,
        selectedContexts: ["blocked"],
        userRoles: ["USER"],
      }).map((action) => action.name),
    ).toEqual(["ALL"]);
  });

  it.each([
    [
      "tasks",
      "recap my day\nRead tracked progress",
      "BRIEF",
      "Summarize today's tracked progress and remaining tasks.",
    ],
    [
      "notes",
      "find my saved notes",
      "NOTES_LIST",
      "Search and list saved notes",
    ],
    [
      "calendar",
      "what is my next calendar event",
      "CALENDAR_NEXT_EVENT",
      "Read the next calendar event",
    ],
    [
      "memory",
      "search remembered facts",
      "MEMORY_SEARCH",
      "Search remembered facts",
    ],
    [
      "messaging",
      "read messages in the inbox",
      "MESSAGE_INBOX",
      "Read inbox messages",
    ],
    [
      "browser",
      "inspect the current browser tab",
      "BROWSER_INSPECT",
      "Inspect current browser tab",
    ],
    ["automation", "create a workflow", "WORKFLOW_CREATE", "Create a workflow"],
  ])(
    "retrieves %s operations from intent without name hints",
    (context, query, name, description) => {
      const operation: Action = { name, description, contexts: [context] };
      const unrelated: Action = {
        name: "UNRELATED",
        description: "Perform accounting",
        contexts: ["finance"],
      };
      const result = retrieveContextualPlannerActions({
        actions: [operation, unrelated],
        query,
        contexts: [context],
      });
      expect(result.map((action) => action.name)).toEqual([name]);
      expect(result[0]).toBe(operation);
    },
  );

  it.each([
    ["list notes", ["NOTES_LIST"]],
    ["find notes", ["NOTES_LIST"]],
    ["read my notes", ["NOTES_GET", "NOTES_LIST"]],
    ["edit a note", ["NOTES_PATCH", "NOTES_UPDATE"]],
    ["remove a note", ["NOTES_DELETE"]],
    ["create a note", ["NOTES_CREATE"]],
    ["list and delete notes", ["NOTES_DELETE", "NOTES_LIST"]],
  ])(
    "retrieves actual Notes operations for %s without sibling or view pollution",
    (query, expected) => {
      const actions: Action[] = [
        ...(notesPlugin.actions ?? []),
        {
          name: "CLOSE_ALL_VIEWS",
          contexts: ["notes"],
          description:
            "Close all views including notes; list of views is available.",
        },
      ];
      const result = retrieveContextualPlannerActions({
        actions,
        query,
        contexts: ["notes"],
      });
      expect(result.map((action) => action.name).sort()).toEqual(expected);
      for (const action of result) expect(actions).toContain(action);
    },
  );

  it.each([
    [["list saved notes"], ["NOTES_LIST"]],
    [
      ["list saved notes", "delete the selected note"],
      ["NOTES_DELETE", "NOTES_LIST"],
    ],
  ])(
    "ranks Notes operations from declared outcomes while retaining request evidence: %j",
    (intents, expected) => {
      const found = retrieveContextualPlannerActions({
        actions: notesPlugin.actions ?? [],
        query: "List my saved notes. Do not create or modify anything.",
        intents,
        contexts: ["notes"],
      });
      expect(found.map((action) => action.name).sort()).toEqual(expected);
    },
  );

  it("preserves mixed-domain work when one operation has no recognized verb", () => {
    const calendar: Action = {
      name: "AGENDA",
      contexts: ["calendar"],
      description: "Summarize calendar commitments",
    };
    const actions = [...(notesPlugin.actions ?? []), calendar];
    const found = retrieveContextualPlannerActions({
      actions,
      query: "list notes and summarize calendar. Do not create anything",
      intents: ["list notes", "summarize calendar"],
      contexts: ["notes", "calendar"],
    });
    expect(found.map((action) => action.name).sort()).toEqual([
      "AGENDA",
      "NOTES_LIST",
    ]);
    expect(found).toContain(calendar);
  });

  it("keeps ambiguous and unmatched operation wording discoverable", () => {
    const actions = notesPlugin.actions ?? [];
    const result = retrieveContextualPlannerActions({
      actions,
      query: "notes",
      contexts: ["notes"],
    });
    expect(result.map((action) => action.name)).toEqual(
      expect.arrayContaining([
        "NOTES_LIST",
        "NOTES_GET",
        "NOTES_CREATE",
        "NOTES_UPDATE",
        "NOTES_DELETE",
        "NOTES_PATCH",
      ]),
    );
  });

  it("scopes an unqualified Notes query using fresh registered domains", async () => {
    const browser: Action = {
      name: "BROWSER_GET",
      contexts: ["browser"],
      description: "Read and get the latest page body",
    };
    const calendar: Action = {
      name: "CALENDAR_GET",
      contextGate: { anyOf: ["calendar"] },
      description: "Read the next calendar event",
    };
    const actions = [...(notesPlugin.actions ?? []), browser, calendar];
    const discovery = createPlannerToolDiscoveryAction(
      actions,
      () => {},
      async () => actions,
    );
    const search = await discovery.handler?.(runtime, message, undefined, {
      parameters: { query: "notes read get latest note body" },
    });
    expect([...((search?.data?.loadedTools ?? []) as string[])].sort()).toEqual(
      ["NOTES_GET", "NOTES_LIST"],
    );
    expect(search?.data?.inferredContexts).toEqual(["notes"]);
    const mixed = await discovery.handler?.(runtime, message, undefined, {
      parameters: { query: "read notes and calendar" },
    });
    expect([...((mixed?.data?.loadedTools ?? []) as string[])].sort()).toEqual([
      "CALENDAR_GET",
      "NOTES_GET",
      "NOTES_LIST",
    ]);
    const global = await discovery.handler?.(runtime, message, undefined, {
      parameters: { query: "read get latest body" },
    });
    expect(global?.data?.loadedTools).toContain("BROWSER_GET");
    const explicit = await discovery.handler?.(runtime, message, undefined, {
      parameters: { query: "read notes", contexts: ["browser"] },
    });
    expect(explicit?.data?.loadedTools).toEqual(["BROWSER_GET"]);
    const catalog = await discovery.handler?.(runtime, message, undefined, {
      parameters: { names: [], mode: "describe" },
    });
    expect(JSON.stringify(catalog?.data)).toContain("BROWSER_GET");
  });

  it("matches whole registered domain phrases and keeps unknown operation wording", async () => {
    const archive: Action = {
      name: "ARCHIVE_INSPECT",
      contextGate: { anyOf: ["project-notes"] },
      description: "Inspect project notes",
    };
    const other: Action = {
      name: "OTHER_INSPECT",
      contexts: ["browser"],
      description: "Inspect project notes in a browser page",
    };
    const discovery = createPlannerToolDiscoveryAction(
      [archive, other],
      () => {},
    );
    const scoped = await discovery.handler?.(runtime, message, undefined, {
      parameters: { query: "inspect project notes" },
    });
    expect(scoped?.data?.loadedTools).toEqual(["ARCHIVE_INSPECT"]);
    expect(scoped?.data?.inferredContexts).toEqual(["project-notes"]);
    const noncontiguous = await discovery.handler?.(
      runtime,
      message,
      undefined,
      { parameters: { query: "inspect project meeting notes" } },
    );
    expect(noncontiguous?.data?.inferredContexts).toBeUndefined();
    expect(noncontiguous?.data?.loadedTools).toContain("OTHER_INSPECT");
  });

  it("loads gate-only contexts through query search and permits later incremental operations", async () => {
    const actions: Action[] = [
      {
        name: "RECORD_LIST",
        description: "List notes",
        contextGate: { anyOf: ["notes"] },
      },
      {
        name: "RECORD_DELETE",
        description: "Delete notes",
        contextGate: { allOf: ["notes", "general"] },
      },
    ];
    const loaded: Action[][] = [];
    const discovery = createPlannerToolDiscoveryAction(
      actions,
      (actions) => loaded.push(actions),
      async () => actions,
      { deferNameIndex: true },
    );
    const read = await discovery.handler?.(runtime, message, undefined, {
      parameters: { query: "list notes", contexts: ["notes"] },
    });
    expect(read?.data?.loadedTools).toEqual(["RECORD_LIST"]);
    const removal = await discovery.handler?.(runtime, message, undefined, {
      parameters: { query: "remove notes", contexts: ["notes"] },
    });
    expect(removal?.data?.loadedTools).toEqual(["RECORD_DELETE"]);
    expect(loaded).toEqual([[actions[0]], [actions[1]]]);
    const full = await discovery.handler?.(runtime, message, undefined, {
      parameters: { names: [], mode: "describe" },
    });
    expect(JSON.stringify(full?.data)).toContain("RECORD_LIST");
    expect(JSON.stringify(full?.data)).toContain("RECORD_DELETE");
  });

  it("prefers matching children without loading unrequested sibling schemas", () => {
    const actions: Action[] = [
      {
        name: "RECORDS",
        description: "Read stored records",
        subActions: ["RECORDS_READ", "RECORDS_DELETE"],
      },
      { name: "RECORDS_READ", description: "Read stored records" },
      { name: "RECORDS_DELETE", description: "Permanently destroy entries" },
    ];
    expect(
      retrieveContextualPlannerActions({ actions, query: "read" }).map(
        (action) => action.name,
      ),
    ).toEqual(["RECORDS_READ"]);
  });

  it("searches fresh authorized operations without names or domain effects", async () => {
    const loads: Action[][] = [];
    let executions = 0;
    let refreshes = 0;
    const action = (
      name: string,
      description: string,
      context: string,
    ): Action => ({
      name,
      description,
      contexts: [context],
      handler: async () => {
        executions++;
        return { success: true };
      },
    });
    const notes = action("NOTES_LIST", "Search saved notes by title", "notes");
    const calendar = action(
      "CALENDAR_NEXT_EVENT",
      "Find the next calendar event",
      "calendar",
    );
    const revoked = action("REVOKED", "Search private saved notes", "notes");
    const discovery = createPlannerToolDiscoveryAction(
      [notes, calendar, revoked],
      (actions) => loads.push(actions),
      async () => {
        refreshes++;
        return [notes, calendar];
      },
      { deferNameIndex: true },
    );
    const search = await discovery.handler?.(runtime, message, undefined, {
      parameters: { query: "saved notes" },
    });
    expect(search?.data?.loadedTools).toEqual(["NOTES_LIST"]);
    expect(search?.data?.completeMatches).toBe(true);
    expect(loads).toEqual([[notes]]);
    expect(refreshes).toBe(1);
    const described = await discovery.handler?.(runtime, message, undefined, {
      parameters: { contexts: ["calendar"], mode: "describe" },
    });
    expect(described?.data?.catalog).toEqual([
      expect.objectContaining({
        name: "CALENDAR_NEXT_EVENT",
        parameters: expect.any(Object),
      }),
    ]);
    expect(JSON.stringify(described)).not.toContain('"contexts"');
    expect(loads).toHaveLength(1);
    const noMatch = await discovery.handler?.(runtime, message, undefined, {
      parameters: { query: "quuxxyz" },
    });
    expect(noMatch?.data?.matchCount).toBe(0);
    expect(noMatch?.text).toContain("names=[]");
    expect(loads).toHaveLength(1);
    expect(executions).toBe(0);
    expect(discovery.description).not.toContain("NOTES_LIST");
    const invalid = await discovery.handler?.(runtime, message, undefined, {
      parameters: { query: "notes", names: [] },
    });
    expect(invalid?.success).toBe(false);
    const denied = await discovery.handler?.(runtime, message, undefined, {
      parameters: { names: ["REVOKED"] },
    });
    expect(denied?.success).toBe(false);
    expect(loads).toHaveLength(1);
  });
});

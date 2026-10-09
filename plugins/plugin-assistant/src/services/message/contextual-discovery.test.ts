/** Exercises real tool retrieval, schema reads and fresh discovery admission without domain execution. */
import {
  type Action,
  AgentRuntime,
  actionGateRejection,
  buildPlannerToolsFromActions,
  ContextRegistry,
  HOOK_MODES,
  type IAgentRuntime,
  type Memory,
  promoteSubactionsToActions,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { fileAction } from "../../../../plugin-coding-tools/src/actions/file.ts";
import { notesPlugin } from "../../../../plugin-notes/src/plugin";
import {
  briefAction,
  briefDeliveredImpressionsAction,
} from "../../../../plugin-personal-assistant/src/actions/brief.ts";
import { scheduledTaskAction } from "../../../../plugin-personal-assistant/src/actions/scheduled-task.ts";
import { createHouseholdOperationsAction } from "../../../../plugin-personal-assistant/src/lifeops/household-operations/action.ts";
import { createResourceCapacityAction } from "../../../../plugin-personal-assistant/src/lifeops/resource-capacity/action.ts";
import { messageAction } from "../../features/advanced-capabilities/actions/message.ts";
import { postAction } from "../../features/advanced-capabilities/actions/post.ts";
import { DEFAULT_CONTEXT_DEFINITIONS } from "../../runtime/default-contexts.ts";
import { runPlannerLoop } from "../../runtime/planner-loop.ts";
import {
  collectV5PlannerCandidateActions,
  inferActionSearchContexts,
  retrieveContextualPlannerActions,
} from "./action-surface";
import {
  collectDiscoveryCatalogActions,
  createPlannerToolDiscoveryAction,
} from "./tool-discovery";

const runtime = {} as IAgentRuntime;
const message = {} as Memory;
const sharedCalendarActions = [
  ...promoteSubactionsToActions(scheduledTaskAction),
  ...promoteSubactionsToActions(
    createHouseholdOperationsAction({ authorize: async () => true }),
  ),
  ...promoteSubactionsToActions(
    createResourceCapacityAction({ authorize: async () => true }),
  ),
];

describe("contextual native discovery", () => {
  it("keeps every lifecycle hook out of the catalog and planner while retaining default and explicit PLANNER actions", async () => {
    const currentRuntime = new AgentRuntime({
      character: { name: "Hook visibility", bio: "Test" },
      logLevel: "fatal",
    });
    const ordinary: Action = {
      name: "DEFAULT_READ",
      description: "Read records",
      contexts: ["general"],
      validate: async () => true,
      handler: async () => ({ success: true }),
    };
    currentRuntime.actions.push(
      ordinary,
      { ...ordinary, name: "EXPLICIT_READ", mode: "PLANNER" },
      ...HOOK_MODES.map((mode) => ({
        ...ordinary,
        name: `HOOK_${mode}`,
        mode,
      })),
      briefDeliveredImpressionsAction,
    );
    const currentMessage = {
      entityId: currentRuntime.agentId,
      content: { text: "Read records", channelType: "DM" },
    } as Memory;
    const catalog = collectDiscoveryCatalogActions({
      actions: currentRuntime.actions,
      message: currentMessage,
      selectedContexts: ["general"],
      userRoles: ["OWNER"],
    });
    expect(catalog.map((action) => action.name)).toEqual([
      "DEFAULT_READ",
      "EXPLICIT_READ",
    ]);
    const candidates = await collectV5PlannerCandidateActions({
      runtime: currentRuntime,
      message: currentMessage,
      state: { text: "", values: {}, data: {} },
      discoverActions: true,
      candidateActions: currentRuntime.actions.map((action) => action.name),
      userRoles: ["OWNER"],
    });
    expect(candidates.map((action) => action.name)).toEqual([
      "DEFAULT_READ",
      "EXPLICIT_READ",
    ]);
  });

  it.each(["briefing", "dossier"])(
    "discovers the existing BRIEF composer through the registered %s domain",
    async (domain) => {
      const contexts = new ContextRegistry();
      contexts.registerMany([...DEFAULT_CONTEXT_DEFINITIONS]);
      const currentRuntime = { ...runtime, contexts } as IAgentRuntime;
      const actions: Action[] = [
        briefAction,
        {
          name: "CONNECTOR_LIST",
          contexts: ["connectors"],
          description: "List configured connector accounts",
        },
      ];
      const discovery = createPlannerToolDiscoveryAction(
        actions,
        () => {},
        async () => actions,
      );
      const result = await discovery.handler?.(
        currentRuntime,
        message,
        undefined,
        {
          parameters: {
            query: `compose my daily ${domain}`,
            contexts: [domain],
          },
        },
      );
      expect(result?.data?.loadedTools).toEqual(["BRIEF"]);
    },
  );

  it.each([
    ["workflow create", "OWNER", "automation", true],
    [
      "WORKFLOW action create smthrs workflow definition",
      "OWNER",
      "automation",
      true,
    ],
    ["workflow create", "USER", "automation", false],
    ["workflow create", "OWNER", "browser", false],
    ["create a task", "OWNER", "automation", false],
    ["create a trigger", "OWNER", "automation", false],
  ] as const)(
    "discovers an authorized operation umbrella for %s (%s/%s)",
    async (query, role, context, expectsWorkflow) => {
      const actions: Action[] = [
        // Runtime catalog shape: the operation lives on an umbrella, while
        // the neighboring TASKS/TRIGGER operations are promoted children.
        {
          name: "WORKFLOW",
          contexts: ["general", "automation", "tasks", "agent_internal"],
          contextGate: {
            anyOf: ["general", "automation", "tasks", "agent_internal"],
          },
          roleGate: { minRole: "OWNER" },
          similes: ["CREATE_WORKFLOW", "WORKFLOW_CREATE", "EDIT_WORKFLOW"],
          description:
            "Create, edit, inspect, activate, run, cancel, and delete native Smithers workflows.",
        },
        {
          name: "TASKS_CREATE",
          contexts: ["code", "automation", "agent_internal", "connectors"],
          roleGate: { minRole: "USER" },
          similes: ["TASKS", "CREATE"],
          description: 'TASKS operation "create".',
        },
        {
          name: "TRIGGER_CREATE",
          contexts: ["automation", "tasks", "agent_internal"],
          roleGate: { minRole: "ADMIN" },
          similes: ["TRIGGER", "CREATE"],
          description: 'TRIGGER operation "create".',
        },
        {
          name: "UNRELATED",
          contexts: ["automation", "tasks", "agent_internal"],
          similes: ["CREATE"],
          description: "Create a workflow in an unrelated system",
        },
      ];
      const admitted = collectDiscoveryCatalogActions({
        actions,
        message,
        selectedContexts: [context],
        userRoles: [role],
      });
      const loaded: string[] = [];
      const discovery = createPlannerToolDiscoveryAction(admitted, (selected) =>
        loaded.push(...selected.map((action) => action.name)),
      );
      const result = await discovery.handler?.(runtime, message, undefined, {
        parameters: { query, contexts: [context] },
      });
      expect(result?.success).toBe(true);
      expect(loaded.includes("WORKFLOW")).toBe(expectsWorkflow);
      expect(loaded).not.toContain("UNRELATED");
      if (expectsWorkflow) {
        expect(loaded).toEqual(["WORKFLOW"]);
        expect(result?.data?.loadedTools).toEqual(["WORKFLOW"]);
      }
    },
  );

  it.each([
    ["message", ["MESSAGE"]],
    ["help with my messages", ["MESSAGE"]],
    ["Help with my messages.", ["MESSAGE"]],
    ["send a message", ["MESSAGE_SEND"]],
    ["search messages", ["MESSAGE_SEARCH"]],
    ["search my inbox", ["MESSAGE_SEARCH_INBOX"]],
    ["list inbox", ["MESSAGE_LIST_INBOX"]],
    ["send draft", ["MESSAGE_SEND_DRAFT"]],
    ["send drafts", ["MESSAGE_SEND_DRAFT"]],
    ["send scheduled drafts", ["MESSAGE_SCHEDULE_DRAFT_SEND"]],
    ['send "search and send draft" to Amy', ["MESSAGE_SEND"]],
    ["MESSAGE_SEND_DRAFT", ["MESSAGE_SEND_DRAFT"]],
    ["schedule draft send", ["MESSAGE_SCHEDULE_DRAFT_SEND"]],
    ["check my inbox", ["MESSAGE_LIST_INBOX", "MESSAGE_SEARCH_INBOX"]],
    ["triage messages", ["MESSAGE_TRIAGE"]],
  ])(
    "retrieves the requested messaging operation for %s",
    (query, expected) => {
      const actions = promoteSubactionsToActions(messageAction);
      const result = retrieveContextualPlannerActions({
        actions,
        query,
        contexts: ["messaging"],
      });
      expect(result.actions.map((action) => action.name).sort()).toEqual(
        expected,
      );
      for (const action of result.actions) expect(actions).toContain(action);
      // Selection never rewrites or removes the full discoverable registry.
      expect(actions.some((action) => action.name === "MESSAGE_SEND")).toBe(
        true,
      );
      expect(actions.some((action) => action.name === "MESSAGE_SEARCH")).toBe(
        true,
      );
    },
  );

  it.each([
    ["search messages", "send a message"],
    ["send a message", "send draft"],
  ])("retains independent outcomes %s and %s", (first, second) => {
    const actions = promoteSubactionsToActions(messageAction);
    const result = retrieveContextualPlannerActions({
      actions,
      query: `${first} and ${second}`,
      intents: [first, second],
      contexts: ["messaging"],
    });
    const expected = first.startsWith("search")
      ? ["MESSAGE_SEARCH", "MESSAGE_SEND"]
      : ["MESSAGE_SEND", "MESSAGE_SEND_DRAFT"];
    expect(result.actions.map((action) => action.name).sort()).toEqual(
      expected,
    );
  });

  it.each([
    ["messaging", "send a DM", "MESSAGE_SEND"],
    ["messaging", "search my inbox", "MESSAGE_SEARCH_INBOX"],
    ["social_posting", "send a public post", "POST_SEND"],
  ])("keeps %s operation ownership for %s", (context, query, expected) => {
    const actions = [
      ...promoteSubactionsToActions(messageAction),
      ...promoteSubactionsToActions(postAction),
    ];
    const result = retrieveContextualPlannerActions({
      actions,
      query,
      contexts: [context],
    });
    expect(result.actions.map((action) => action.name)).toEqual([expected]);
  });

  it("does not substitute a metadata-only umbrella for executable children", () => {
    const actions = promoteSubactionsToActions(messageAction).map((action) =>
      action.name === "MESSAGE" ? { ...action, handler: undefined } : action,
    );
    const result = retrieveContextualPlannerActions({
      actions,
      query: "message",
      contexts: ["messaging"],
    });
    expect(result.actions.length).toBeGreaterThan(0);
    expect(result.actions.some((action) => action.name === "MESSAGE")).toBe(
      false,
    );
    expect(
      result.actions.every((action) => typeof action.handler === "function"),
    ).toBe(true);
  });

  it("never reconstructs a missing family parent and preserves exact child hints", () => {
    const actions = promoteSubactionsToActions(messageAction);
    const child = actions.find(
      (action) => action.name === "MESSAGE_SEND_DRAFT",
    );
    if (!child) throw new Error("Registered send-draft operation is missing");
    const result = retrieveContextualPlannerActions({
      actions: actions.filter((action) => action.name !== "MESSAGE"),
      query: "message",
      contexts: ["messaging"],
      selectedActions: [child],
    });
    expect(result.actions).toContain(child);
    expect(result.actions.some((action) => action.name === "MESSAGE")).toBe(
      false,
    );
  });

  it.each([
    {
      query: "Read input.json and report product and verificationCode",
      intents: ["read input.json", "report product and verificationCode"],
    },
    {
      query:
        "Save the following text exactly, including its final newline, to /tmp/planner-readback/note.txt, then read the file and report its verification code:\nCHECK-2877\nSecond line: blue\nThird line: ready\n",
      intents: [
        "Write the exact provided text with its final newline to /tmp/planner-readback/note.txt",
        "Read the resulting file and report its verification code",
      ],
    },
    {
      query: "Read note.txt and report its reference code.",
      intents: ["Read note.txt", "Report its reference code"],
    },
  ])(
    "keeps FILE bootstrap scoped for readback identifiers: $query",
    async ({ query, intents }) => {
      const originalIntents = [...intents];
      const currentRuntime = new AgentRuntime({
        character: { name: "File field boundary", bio: "Test" },
        logLevel: "fatal",
      });
      currentRuntime.contexts.registerMany([...DEFAULT_CONTEXT_DEFINITIONS]);
      currentRuntime.actions.push(
        fileAction,
        {
          name: "TASKS_CREATE",
          contexts: ["code"],
          description: "Create coding tasks",
        },
        {
          name: "PLUGIN_READ_CONFIG",
          contexts: ["files", "settings"],
          description: "Read plugin configuration files",
        },
      );
      const admitted = await collectV5PlannerCandidateActions({
        runtime: currentRuntime,
        message: { content: { text: query, channelType: "DM" } } as Memory,
        state: { text: "", values: {}, data: {} },
        selectedContexts: ["files"],
        intents,
        userRoles: ["OWNER"],
      });
      expect(admitted.map((action) => action.name)).not.toContain(
        "TASKS_CREATE",
      );
      expect(
        retrieveContextualPlannerActions({
          actions: admitted,
          query,
          intents,
          contexts: ["files"],
          deferUnscopedBootstrap: true,
        }).actions,
      ).toEqual([fileAction]);
      expect(intents).toEqual(originalIntents);
    },
  );

  it.each([
    "Build the code in the repository",
    "Edit the code after reading note.txt",
    "Read note.txt and refactor the code",
  ])("keeps genuine pending programming work: %s", async (intent) => {
    const actions: Action[] = [
      fileAction,
      {
        name: "TASKS_CREATE",
        contexts: ["code"],
        description: "Create a coding task",
      },
    ];
    const selected = retrieveContextualPlannerActions({
      actions,
      query: intent,
      intents: [intent],
      contexts: ["files"],
      deferUnscopedBootstrap: true,
    }).actions;
    expect(selected.map((action) => action.name)).toContain("TASKS_CREATE");
  });

  it("preserves an explicit programming domain for editing verification code", () => {
    const codingAction: Action = {
      name: "TASKS_CREATE",
      contexts: ["code"],
      description: "Create a coding task",
    };
    const selected = retrieveContextualPlannerActions({
      actions: [fileAction, codingAction],
      query: "Edit verification code",
      intents: ["Edit verification code"],
      contexts: ["code"],
      deferUnscopedBootstrap: true,
    }).actions;
    expect(selected).toContain(codingAction);
  });

  it("defers ambiguous initial routing but preserves explicit hints and global discovery", async () => {
    const actions: Action[] = [
      { name: "FILE_READ", contexts: ["files"], description: "Read file" },
      {
        name: "TASKS_CREATE",
        contexts: ["code"],
        description: "Create coding tasks",
      },
    ];
    const query = "Read input.json without modifying the file";
    const args = {
      actions,
      query,
      intents: [query],
      contexts: [],
      deferUnscopedBootstrap: true,
    };
    expect(retrieveContextualPlannerActions(args).actions).toEqual([]);
    expect(
      retrieveContextualPlannerActions({
        ...args,
        selectedActions: [actions[0]],
      }).actions,
    ).toEqual([actions[0]]);
    const copiedSelection = retrieveContextualPlannerActions({
      ...args,
      selectedActions: [{ ...actions[0] }],
    });
    expect(copiedSelection.deferredCount).toBe(copiedSelection.matchCount - 1);

    expect(
      retrieveContextualPlannerActions({
        ...args,
        intents: [query, "inspect source code"],
      }).actions,
    ).toContain(actions[1]);
    expect(
      retrieveContextualPlannerActions({
        ...args,
        deferUnscopedBootstrap: false,
      }).actions.length,
    ).toBeGreaterThan(0);
    const discovery = createPlannerToolDiscoveryAction(
      actions,
      () => {},
      async () => actions,
    );
    const exact = await discovery.handler?.(runtime, message, undefined, {
      parameters: { query: "fileRead" },
    });
    expect(exact?.data?.loadedTools).toEqual(["FILE_READ"]);
  });

  it.each([
    ["report verificationCode", []],
    ["report verification_code", []],
    ["report verification-code", []],
    ["report verification.code", []],
    ["read /tmp/code/input.json", []],
    ["read /code", []],
    ["read code/", []],
    ["read code\\", []],
    ["read code/input.json", []],
    ["read C:\\code\\input.json", []],
    ["read sourceCode", []],
    ["inspect source code", ["code"]],
    ["inspect code.", ["code"]],
    ["code: inspect the repository", ["code"]],
    ["inspect (code), then report", ["code"]],
    ["read screen_time", ["screen_time"]],
    ["read screen time", ["screen_time"]],
    ["read app usage", ["screen_time"]],
    ["read screen_time_value", []],
    ["read screenTimeValue", []],
    ["read files and inspect source code", ["files", "code"]],
  ])("infers whole domain phrases from %s", (query, expected) => {
    const actions: Action[] = [
      {
        name: "FILE_READ",
        contexts: ["files"],
        description: "Read local files",
      },
      {
        name: "CODE_INSPECT",
        contexts: ["code"],
        description: "Inspect source code",
      },
      {
        name: "SCREEN_TIME_GET",
        contexts: ["screen_time"],
        description: "Read screen time",
      },
    ];
    expect(
      inferActionSearchContexts(actions, query, (context) =>
        context === "screen_time" ? ["app usage"] : [],
      ),
    ).toEqual(expected);
  });

  it("does not expand a file read into coding tools because of an output field identifier", () => {
    const read: Action = {
      name: "FILE_READ",
      contexts: ["files"],
      description: "Read file contents",
    };
    const code: Action = {
      name: "CODE_READ",
      contexts: ["code"],
      description: "Read source code",
    };
    const found = retrieveContextualPlannerActions({
      actions: [read, code],
      contexts: ["files"],
      query: "Read input.json and report product and verificationCode",
      intents: ["read input.json", "report product and verificationCode"],
    }).actions;
    expect(found).toEqual([read]);
  });

  it("recovers the authorized FILE owner from empty routing contexts and singular file intents", async () => {
    const currentRuntime = new AgentRuntime({
      character: { name: "File bootstrap", bio: "Test" },
      logLevel: "fatal",
    });
    currentRuntime.contexts.registerMany([...DEFAULT_CONTEXT_DEFINITIONS]);
    currentRuntime.actions.push(
      fileAction,
      {
        name: "PLUGIN_READ_CONFIG",
        contexts: ["files", "settings"],
        description: "Read plugin configuration files",
      },
      {
        name: "TASKS_CREATE",
        contexts: ["code"],
        description: "Create delegated coding tasks",
      },
    );
    const currentMessage = {
      content: {
        text: "Write /tmp/index.html, then read the file and report its contents.",
        channelType: "DM",
      },
    } as Memory;
    const args = {
      runtime: currentRuntime,
      message: currentMessage,
      state: { text: "", values: {}, data: {} },
      selectedContexts: [],
      intents: [
        "write file at /tmp/index.html",
        "read the saved file and report its contents",
      ],
      userRoles: ["OWNER" as const],
    };
    const admitted = await collectV5PlannerCandidateActions(args);
    expect(admitted.map((action) => action.name)).toEqual(["FILE"]);
    const denied = await collectV5PlannerCandidateActions({
      ...args,
      userRoles: ["USER"],
    });
    expect(denied.map((action) => action.name)).not.toContain("FILE");
    const prohibited = await collectV5PlannerCandidateActions({
      ...args,
      intents: ["Do not write a file"],
    });
    expect(prohibited.map((action) => action.name)).not.toContain("FILE");
  });

  it.each(["file", "filesystem", "directory", "directories"])(
    "discovers the FILE owner through its registered %s domain alias",
    async (noun) => {
      const contexts = new ContextRegistry();
      contexts.registerMany([...DEFAULT_CONTEXT_DEFINITIONS]);
      const currentRuntime = { ...runtime, contexts } as IAgentRuntime;
      const contact: Action = {
        name: "CONTACT_READ",
        contexts: ["contacts"],
        description: "Read a contact directory",
      };
      const delegated: Action = {
        name: "TASKS_CREATE",
        contexts: ["code"],
        description: "Create delegated coding tasks",
      };
      const actions = [
        fileAction,
        contact,
        delegated,
        {
          name: "PLUGIN_READ_CONFIG",
          contexts: ["files", "settings"],
          description: "Read plugin configuration files",
        },
      ];
      const discovery = createPlannerToolDiscoveryAction(
        actions,
        () => {},
        async () => actions,
      );
      const result = await discovery.handler?.(
        currentRuntime,
        message,
        undefined,
        { parameters: { query: `write ${noun} and read it` } },
      );
      expect(result?.data?.inferredContexts).toEqual(["files"]);
      expect(result?.data?.loadedTools).toEqual(["FILE"]);
      const mixed = await discovery.handler?.(
        currentRuntime,
        message,
        undefined,
        { parameters: { query: `read contacts and ${noun}` } },
      );
      expect(mixed?.data?.loadedTools).toEqual(
        expect.arrayContaining(["FILE", "CONTACT_READ"]),
      );
      const explicit = await discovery.handler?.(
        currentRuntime,
        message,
        undefined,
        {
          parameters: {
            query: "read contact directory",
            contexts: ["contacts"],
          },
        },
      );
      expect(explicit?.data?.loadedTools).toEqual(["CONTACT_READ"]);
      const exact = await discovery.handler?.(
        currentRuntime,
        message,
        undefined,
        { parameters: { names: ["TASKS_CREATE"] } },
      );
      expect(exact?.data?.loadedTools).toEqual(["TASKS_CREATE"]);
    },
  );
  it("admits the real FILE owner for files-only work without promoting plugin configuration", async () => {
    const request = {
      content: {
        text: "Create /tmp/index.html with the supplied HTML, then read the file back.",
      },
    } as Memory;
    const incidental: Action[] = ["PLUGIN_LIST", "PLUGIN_READ_CONFIG"].map(
      (name) => ({
        name,
        description: "Read plugin configuration files",
        contexts: ["files", "settings"],
      }),
    );
    const actions = [...incidental, fileAction];
    expect(
      actionGateRejection(fileAction, {
        message: request,
        userRoles: ["OWNER"],
        activeContexts: ["files"],
      }),
    ).toBeUndefined();
    expect(
      actionGateRejection(fileAction, {
        message: request,
        userRoles: ["USER"],
        activeContexts: ["files"],
      }),
    ).toBeDefined();
    expect(
      retrieveContextualPlannerActions({
        actions,
        query: request.content.text as string,
        contexts: ["files"],
        intents: ["Create the HTML file", "Read saved file back"],
      }).actions,
    ).toEqual([fileAction]);
    let loaded: Action[] = [];
    const discovery = createPlannerToolDiscoveryAction(
      actions,
      (selected) => {
        loaded = selected;
      },
      async () => actions,
      { taskIntents: ["Create HTML file", "Read saved file back"] },
    );
    const result = await discovery.handler?.(runtime, request, undefined, {
      parameters: { contexts: ["files"] },
    });
    expect(result?.data?.loadedTools).toEqual(["FILE"]);
    expect(loaded).toEqual([fileAction]);
    expect(loaded[0]?.parameters).toEqual(fileAction.parameters);
    expect(
      retrieveContextualPlannerActions({
        actions,
        query: request.content.text as string,
        intents: ["Read the file"],
        contexts: ["files"],
        selectedActions: [incidental[1]],
      }).actions,
    ).toEqual([incidental[1], fileAction]);
  });

  it.each([{}, { names: [] }, { mode: "load", names: [] }])(
    "searches current work for empty selectors %j without dumping unrelated catalog bodies",
    async (parameters) => {
      const original = "Complete unrelated action documentation Ω\n".repeat(
        200,
      );
      const actions: Action[] = [
        {
          name: "NOTES_LIST",
          description: "Search notes",
          contexts: ["notes"],
        },
        { name: "UNRELATED", description: original, contexts: ["other"] },
        {
          name: "REVOKED",
          description: "Private revoked action",
          contexts: ["notes"],
        },
      ];
      let loaded: Action[] = [];
      const fresh = actions.slice(0, 2);
      const discovery = createPlannerToolDiscoveryAction(
        actions,
        (selected) => {
          loaded = selected;
        },
        async () => fresh,
        { taskIntents: ["search notes"] },
      );
      const request = {
        content: { text: "Search notes for groceries" },
      } as Memory;
      const result = await discovery.handler?.(runtime, request, undefined, {
        parameters,
      });
      expect(result?.success).toBe(true);
      expect(loaded).toEqual([actions[0]]);
      expect(result?.data?.catalog).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(original);
      expect(JSON.stringify(result)).not.toContain("REVOKED");
      const full = await discovery.handler?.(runtime, request, undefined, {
        parameters: { mode: "describe", names: [] },
      });
      expect(full?.data?.catalog).toHaveLength(2);
      expect(JSON.stringify(full)).toContain(
        JSON.stringify(original).slice(1, -1),
      );
      expect(JSON.stringify(full)).not.toContain("REVOKED");
      expect(loaded).toEqual([actions[0]]);
    },
  );

  it("ranks context-only loads by the current task while keeping explicit queries and catalog reads intact", async () => {
    const unrelated: Action[] = Array.from({ length: 12 }, (_, index) => ({
      name: `NOTES_DELETE_${index}`,
      description: "Delete a saved note",
      contexts: ["notes"],
    }));
    const list: Action = {
      name: "NOTES_LIST",
      description: "Search saved notes",
      contexts: ["notes"],
      parameters: [
        { name: "query", schema: { type: "string" }, required: true },
      ],
    };
    const create: Action = {
      name: "NOTES_CREATE",
      description: "Create a saved note",
      contexts: ["notes"],
    };
    const actions = [...unrelated, list, create];
    let loaded: Action[] = [];
    const discovery = createPlannerToolDiscoveryAction(
      actions,
      (selected) => {
        loaded = selected;
      },
      async () => actions,
      { taskIntents: ["search notes"] },
    );
    const request = {
      content: { text: "Find my saved grocery note." },
    } as Memory;
    const found = await discovery.handler?.(runtime, request, undefined, {
      parameters: { contexts: ["notes"] },
    });
    expect(found?.success).toBe(true);
    expect(loaded).toEqual([list]);
    expect(loaded[0]?.parameters).toEqual(list.parameters);
    await discovery.handler?.(runtime, request, undefined, {
      parameters: { contexts: ["notes"], query: "create a note" },
    });
    expect(loaded).toEqual([create]);
    const described = await discovery.handler?.(runtime, request, undefined, {
      parameters: { contexts: ["notes"], mode: "describe" },
    });
    expect(described?.data).toMatchObject({
      matchCount: 14,
      selectedCount: 10,
      deferredCount: 4,
    });
    expect(loaded).toEqual([create]);
    const full = await discovery.handler?.(runtime, request, undefined, {
      parameters: { names: [], mode: "describe" },
    });
    expect(full?.data?.catalog).toHaveLength(14);
    await discovery.handler?.(runtime, request, undefined, {
      parameters: { names: [unrelated[11].name] },
    });
    expect(loaded).toEqual([unrelated[11]]);
  });
  it("bounds broad query loads while keeping deferred operations exactly discoverable", async () => {
    const actions: Action[] = Array.from({ length: 24 }, (_, index) => ({
      name: `RECORDS_READ_${index}`,
      description: "Read saved records",
      contexts: ["records"],
      tags: ["domain:records"],
      parameters: [{ name: "id", required: true, schema: { type: "string" } }],
    }));
    let loaded: Action[] = [];
    const discovery = createPlannerToolDiscoveryAction(
      actions,
      (selected) => {
        loaded = selected;
      },
      async () => actions,
    );
    const result = await discovery.handler?.(runtime, message, undefined, {
      parameters: { query: "read records" },
    });
    expect(loaded).toHaveLength(10);
    expect(result?.data).toMatchObject({
      matchCount: 24,
      selectedCount: 10,
      deferredCount: 14,
      completeMatches: false,
    });
    expect(JSON.stringify(result)).not.toContain('"parameters"');
    const omitted = actions.find((action) => !loaded.includes(action));
    if (!omitted) throw new Error("Missing deferred operation");
    expect(
      (
        await discovery.handler?.(runtime, message, undefined, {
          parameters: { names: [omitted.name] },
        })
      )?.success,
    ).toBe(true);
    expect(loaded).toEqual([omitted]);
    const catalog = await discovery.handler?.(runtime, message, undefined, {
      parameters: { names: [], mode: "describe" },
    });
    expect(catalog?.data?.catalog).toHaveLength(24);
  });
  it("bounds context-only descriptions without loading tools and refreshes denied matches", async () => {
    const actions: Action[] = Array.from({ length: 25 }, (_, index) => ({
      name: `RECORDS_READ_${index}`,
      description: "Read records",
      contexts: ["records"],
    }));
    let admitted = actions.slice(1);
    let loads = 0;
    const discovery = createPlannerToolDiscoveryAction(
      actions,
      () => {
        loads++;
      },
      async () => admitted,
    );
    const description = await discovery.handler?.(runtime, message, undefined, {
      parameters: { contexts: ["records"], mode: "describe" },
    });
    expect(description?.data).toMatchObject({
      matchCount: 24,
      selectedCount: 10,
      deferredCount: 14,
      completeMatches: false,
    });
    expect(description?.data?.catalog).toHaveLength(10);
    expect(JSON.stringify(description)).not.toContain('"RECORDS_READ_0"');
    expect(loads).toBe(0);
    admitted = [];
    const revoked = await discovery.handler?.(runtime, message, undefined, {
      parameters: { query: "read records" },
    });
    expect(revoked?.data).toMatchObject({
      matchCount: 0,
      selectedCount: 0,
      deferredCount: 0,
      completeMatches: true,
    });
    expect(loads).toBe(0);
  });
  it("keeps incidental-context members and parents discoverable in bounded context-only enumeration", async () => {
    const owner: Action = {
      name: "CALENDAR",
      description: "Calendar",
      tags: ["domain:calendar"],
      contexts: ["calendar"],
      subActions: ["CALENDAR_READ"],
    };
    const read: Action = {
      name: "CALENDAR_READ",
      description: "Read calendar",
      tags: ["domain:calendar"],
      contexts: ["calendar"],
    };
    const related: Action[] = Array.from({ length: 14 }, (_, index) => ({
      name: `HOUSEHOLD_READ_${index}`,
      description: "Read household proposal",
      tags: ["domain:household"],
      contexts: ["household", "calendar"],
    }));
    const actions = [owner, read, ...related];
    let loaded: Action[] = [];
    const discovery = createPlannerToolDiscoveryAction(
      actions,
      (selected) => {
        loaded = selected;
      },
      async () => actions,
    );
    const result = await discovery.handler?.(runtime, message, undefined, {
      parameters: { contexts: ["calendar"] },
    });
    expect(result?.data).toMatchObject({
      matchCount: 16,
      selectedCount: 10,
      deferredCount: 6,
      completeMatches: false,
    });
    expect(loaded).toHaveLength(10);
    const deferred = related.find((action) => !loaded.includes(action));
    if (!deferred) throw new Error("Missing deferred scoped operation");
    await discovery.handler?.(runtime, message, undefined, {
      parameters: { names: [deferred.name] },
    });
    expect(loaded).toEqual([deferred]);
  });
  it.each([{ contexts: ["notes", "calendar"] }, { contexts: ["general"] }])(
    "preserves mixed-domain coverage inside the initial ten-operation budget for $contexts",
    ({ contexts }) => {
      const notes: Action[] = Array.from({ length: 24 }, (_, index) => ({
        name: `NOTES_READ_${index}`,
        description: "Read notes",
        contexts: ["notes"],
      }));
      const calendar: Action = {
        name: "CALENDAR_READ",
        description: "Read calendar",
        contexts: ["calendar"],
      };
      const selection = retrieveContextualPlannerActions({
        actions: [...notes, calendar],
        query: "read notes and calendar",
        intents: ["Read notes", "Read calendar"],
        contexts,
      });
      expect(selection.actions).toHaveLength(10);
      expect(selection.actions).toContain(calendar);
      expect(selection.actions.some((action) => notes.includes(action))).toBe(
        true,
      );
      expect(selection).toMatchObject({
        matchCount: 25,
        selectedCount: 10,
        deferredCount: 15,
      });
    },
  );
  it("keeps every exact hint even when required operations exceed the automatic budget", () => {
    const required: Action[] = Array.from({ length: 12 }, (_, index) => ({
      name: `REQUIRED_${index}`,
      description: "Exact requested operation",
      contexts: ["required"],
    }));
    const reads: Action[] = Array.from({ length: 15 }, (_, index) => ({
      name: `NOTES_READ_${index}`,
      description: "Read notes",
      contexts: ["notes"],
    }));
    const selection = retrieveContextualPlannerActions({
      actions: [...required, ...reads],
      query: "read notes",
      contexts: ["notes"],
      selectedActions: required,
    });
    expect(selection.actions).toEqual(required);
    expect(selection).toMatchObject({
      matchCount: 27,
      selectedCount: 12,
      deferredCount: 15,
    });
  });
  it.each([
    { contexts: ["general", "notes", "calendar"] },
    { contexts: ["general"] },
  ])(
    "completes hinted navigation with read operations for $contexts",
    async ({ contexts }) => {
      const views: Action = {
        name: "VIEWS_SHOW",
        description: "Open a view",
        contexts: ["general", "notes", "calendar"],
      };
      const calendarRead: Action = {
        name: "CALENDAR_NEXT_EVENT",
        description: "Read the next saved calendar event",
        contexts: ["calendar"],
        tags: ["domain:calendar", "capability:read"],
      };
      const calendarWrite: Action = {
        name: "CALENDAR_DELETE_EVENT",
        description: "Delete a calendar event",
        contexts: ["calendar"],
        tags: ["domain:calendar", "capability:delete"],
      };
      const found = retrieveContextualPlannerActions({
        actions: [
          views,
          ...(notesPlugin.actions ?? []),
          calendarRead,
          calendarWrite,
          ...sharedCalendarActions,
        ],
        query:
          "Open Notes and read my latest existing note and my next saved Calendar event. Do not create, edit, or delete anything.",
        intents: [
          "Open Notes view",
          "Read latest existing note",
          "Read next saved calendar event",
        ],
        contexts,
        contextAliases: (context) => (context === "notes" ? ["note"] : []),
        selectedActions: [views],
      }).actions;
      expect(found.map((action) => action.name).sort()).toEqual([
        "CALENDAR_NEXT_EVENT",
        "NOTES_GET",
        "NOTES_LIST",
        "VIEWS_SHOW",
      ]);
      const sequence: string[] = [];
      let planners = 0;
      const evaluations: string[] = [];
      const result = await runPlannerLoop({
        context: { id: "compound-read", events: [] },
        tools: buildPlannerToolsFromActions(found),
        runtime: {
          useModel: async () => {
            planners++;
            if (planners > 1)
              throw new Error("Unexpected schema-discovery replan");
            return {
              text: "",
              toolCalls: [
                {
                  id: "navigation",
                  name: "VIEWS_SHOW",
                  arguments: {
                    view: "notes",
                    eliza_turn_scope: "final",
                  },
                },
                {
                  id: "notes",
                  name: "NOTES_LIST",
                  arguments: { eliza_turn_scope: "final" },
                },
                {
                  id: "calendar",
                  name: "CALENDAR_NEXT_EVENT",
                  arguments: { eliza_turn_scope: "final" },
                },
              ],
            };
          },
        },
        executeToolCall: async (call) => {
          sequence.push(call.name);
          if (call.name === "VIEWS_SHOW")
            return {
              success: true,
              transcriptVisibility: "internal",
              modelReplyRequired: true,
              data: {
                navigation: {
                  effect: "view_navigation",
                  status: "delivered",
                  viewId: "notes",
                  label: "Notes",
                  path: "/notes",
                  handoffId: "offline",
                  stepId: call.params?.navigationStepId,
                },
              },
            };
          return {
            success: true,
            text: `${call.name} read complete.`,
            transcriptVisibility: "internal",
            modelReplyRequired: true,
            data: { readOnlyOperation: true },
          };
        },
        evaluate: async () => {
          evaluations.push(sequence.at(-1) ?? "");
          return sequence.at(-1) === "NOTES_LIST"
            ? {
                success: true,
                decision: "NEXT_RECOMMENDED",
                thought: "Calendar read is still queued.",
                recommendedToolCallId: "calendar",
                raw: {},
              }
            : {
                success: true,
                decision: "FINISH",
                thought: "Both records were read.",
                messageToUser:
                  "Notes is open. The saved note and next calendar event were read.",
                raw: {},
              };
        },
      });
      expect(result.status).toBe("finished");
      expect(sequence).toEqual([
        "VIEWS_SHOW",
        "NOTES_LIST",
        "CALENDAR_NEXT_EVENT",
      ]);
      expect(planners).toBe(1);
      expect(evaluations).toEqual(["NOTES_LIST", "CALENDAR_NEXT_EVENT"]);
    },
  );
  it("retains exact domain hints and does not fill their unselected sibling operations", () => {
    const actions = notesPlugin.actions ?? [];
    const exact = actions.find((action) => action.name === "NOTES_GET");
    if (!exact) throw new Error("Missing Notes fixture operation");
    expect(
      retrieveContextualPlannerActions({
        actions,
        query: "read notes",
        intents: ["Read the selected note"],
        contexts: ["notes"],
        selectedActions: [exact],
      }).actions,
    ).toEqual([exact]);
  });
  it("preserves explicit cross-domain hints without treating their incidental Calendar domain as covered", () => {
    const capacity = sharedCalendarActions.find(
      (action) => action.name === "HOUSEHOLD_RESOURCE_CAPACITY_READ_PROPOSAL",
    );
    if (!capacity) throw new Error("Missing capacity fixture");
    const calendar: Action = {
      name: "CALENDAR_NEXT_EVENT",
      description: "Read next calendar event",
      contexts: ["calendar"],
      tags: ["domain:calendar"],
    };
    const selected = retrieveContextualPlannerActions({
      actions: [...sharedCalendarActions, calendar],
      query: "Read the next calendar event and the household resource proposal",
      intents: ["Read next calendar event", "Read household resource proposal"],
      contexts: ["calendar"],
      selectedActions: [capacity],
    }).actions;
    expect(selected).toEqual([capacity, calendar]);
    expect(
      sharedCalendarActions.some(
        (action) => action.name === "SCHEDULED_TASKS_LIST",
      ),
    ).toBe(true);
  });
  it.each(["VIEWS", "VIEWS_SHOW"])(
    "does not load record operations for navigation-only %s",
    (name) => {
      const view: Action = {
        name,
        description: "Open a view",
        contexts: ["general", "notes", "calendar"],
      };
      expect(
        retrieveContextualPlannerActions({
          actions: [view, ...(notesPlugin.actions ?? [])],
          query: "Open Notes view",
          intents: ["Open Notes view"],
          contexts: ["general", "notes"],
          selectedActions: [view],
        }).actions,
      ).toEqual([view]);
    },
  );
  it("keeps the Notes read owner when selected navigation accompanies a read intent", () => {
    const view: Action = {
      name: "VIEWS_SHOW",
      description: "Open a view",
      contexts: ["general", "notes", "calendar"],
    };
    const selected = retrieveContextualPlannerActions({
      actions: [view, ...(notesPlugin.actions ?? [])],
      query: "Open Notes and read my grocery note",
      intents: ["Open Notes view", "Read grocery note"],
      contexts: ["general", "notes"],
      selectedActions: [view],
    }).actions;
    expect(selected[0]).toBe(view);
    expect(selected.map((action) => action.name)).toContain("NOTES_LIST");
  });

  it.each([
    ["Navigate to Notes", []],
    ["Open Notes", []],
    ["Do not read calendar", []],
    ["Don't read calendar", []],
    ["Don’t read calendar", []],
    ["Don't read a note titled 'Calendar rules'", []],
    ["Read a note titled 'not Calendar'", ["NOTES_GET", "NOTES_LIST"]],
    ['Read a note titled "don\'t read Calendar"', ["NOTES_GET", "NOTES_LIST"]],
    ["Read a note titled 'Calendar rules'", ["NOTES_GET", "NOTES_LIST"]],
    ['Read a note titled "Calendar rules"', ["NOTES_GET", "NOTES_LIST"]],
    ["Read unknown-domain records", []],
    ["Say hello", []],
  ])(
    "keeps bootstrap domain inference conservative for %s",
    (intent, expected) => {
      const view: Action = {
        name: "VIEWS_SHOW",
        contexts: ["general"],
        description: "Open a view",
      };
      const actions: Action[] = [
        view,
        ...(notesPlugin.actions ?? []),
        {
          name: "CALENDAR_NEXT_EVENT",
          contexts: ["calendar"],
          description: "Read next calendar event",
        },
      ];
      const found = retrieveContextualPlannerActions({
        actions,
        query: String(intent),
        intents: [String(intent)],
        contexts: ["general"],
        selectedActions: [view],
        contextAliases: (context) => (context === "notes" ? ["note"] : []),
      });
      expect(found.actions.map((action) => action.name).sort()).toEqual(
        ["VIEWS_SHOW", ...expected].sort(),
      );
    },
  );

  it("does not load a domain family from an incidental domain word in a clause claimed by a selected action (#31017)", () => {
    const echo: Action = {
      name: "ECHO_TEST",
      contexts: ["general"],
      description: "Echo the user's message back",
    };
    const worldOperations: Action[] = [
      {
        name: "MESSAGE_LIST_WORLDS",
        contexts: ["messaging", "world"],
        description: "List shared worlds",
      },
      {
        name: "MESSAGE_EDIT",
        contexts: ["messaging", "world"],
        description: "Edit a sent message",
      },
    ];
    const retrieve = (intent: string) =>
      retrieveContextualPlannerActions({
        actions: [echo, ...worldOperations],
        query: intent,
        intents: [intent],
        contexts: ["general"],
        selectedActions: [echo],
      }).actions.map((action) => action.name);
    // ECHO_TEST claims the clause; "world" names a registered domain, but
    // nothing asks for one of its operations, so the family stays behind
    // DISCOVER_ACTIONS.
    expect(
      retrieve("please echo this message back to me: hello world"),
    ).toEqual(["ECHO_TEST"]);
    // An unclaimed clause naming the domain still loads its matching
    // operation without its siblings.
    expect(retrieve("list the world rooms")).toEqual([
      "ECHO_TEST",
      "MESSAGE_LIST_WORLDS",
    ]);
  });

  it("does not use negated operations to widen a positive read intent", () => {
    const view: Action = {
      name: "VIEWS_SHOW",
      contexts: ["general"],
      description: "Open a view",
    };
    const found = retrieveContextualPlannerActions({
      actions: [view, ...(notesPlugin.actions ?? [])],
      query: "Read notes; do not delete notes",
      intents: ["Read notes", "Do not delete notes"],
      contexts: ["general"],
      selectedActions: [view],
    });
    expect(found.actions.map((action) => action.name).sort()).toEqual([
      "NOTES_GET",
      "NOTES_LIST",
      "VIEWS_SHOW",
    ]);
  });

  it("preserves retrieval for an explicitly selected domain with a constrained read intent", () => {
    const result = retrieveContextualPlannerActions({
      actions: notesPlugin.actions ?? [],
      query: "Read notes without changing anything",
      intents: ["Read notes without changing anything"],
      contexts: ["notes"],
    });
    expect(result.actions.map((action) => action.name)).toContain("NOTES_LIST");
    expect(result.actions.map((action) => action.name)).toContain("NOTES_GET");
  });

  it("uses discovery admission for pending domains without weakening role, private, context or availability gates", async () => {
    const currentRuntime = new AgentRuntime({
      character: { name: "Bootstrap gates", bio: "Test" },
      logLevel: "fatal",
    });
    const actions: Action[] = [
      {
        name: "ALLOWED_READ",
        description: "Read calendar",
        contexts: ["calendar"],
      },
      {
        name: "RESTRICTED_READ",
        description: "Read calendar",
        contexts: ["calendar"],
        roleGate: { minRole: "OWNER" },
      },
      {
        name: "HIDDEN_READ",
        description: "Read calendar",
        contexts: ["calendar"],
        private: true,
      },
      {
        name: "UNAVAILABLE_READ",
        description: "Read calendar",
        contexts: ["calendar"],
        validate: async () => false,
      },
      {
        name: "FORBIDDEN_READ",
        description: "Read calendar",
        contextGate: { anyOf: ["calendar"], noneOf: ["blocked"] },
      },
      {
        name: "UNDISCLOSED_READ",
        description: "Read calendar",
        contexts: ["calendar"],
        disclosureGate: { require: "owner_exclusive" },
      },
      {
        name: "NO_ACCOUNT_READ",
        description: "Read calendar",
        contexts: ["calendar"],
        connectorAccountPolicy: {
          provider: "bootstrap-fixture",
          required: true,
        },
      },
    ];
    currentRuntime.actions.push(...actions);
    const currentMessage: Memory = {
      entityId: "00000000-0000-0000-0000-000000000001",
      content: { text: "Read calendar", channelType: "DM" },
    };
    const args = {
      runtime: currentRuntime,
      message: currentMessage,
      state: { text: "", values: {}, data: {} },
      selectedContexts: ["general", "blocked"],
      userRoles: ["USER" as const],
    };
    const before = await collectV5PlannerCandidateActions(args);
    expect(before).toEqual([]);
    const after = await collectV5PlannerCandidateActions({
      ...args,
      intents: ["Read calendar"],
    });
    expect(after.map((action) => action.name)).toEqual(["ALLOWED_READ"]);
  });

  it("bounds new supplemental admission checks before action validation", async () => {
    const currentRuntime = new AgentRuntime({
      character: { name: "Bounded admission", bio: "Test" },
      logLevel: "fatal",
    });
    let validations = 0;
    currentRuntime.actions.push(
      ...Array.from(
        { length: 25 },
        (_, index): Action => ({
          name: `RECORDS_READ_${index}`,
          description: "Read records",
          contexts: ["records"],
          validate: async () => {
            validations++;
            return true;
          },
        }),
      ),
    );
    const admitted = await collectV5PlannerCandidateActions({
      runtime: currentRuntime,
      message: {
        entityId: currentRuntime.agentId,
        content: { text: "Read records", channelType: "DM" },
      },
      state: { text: "", values: {}, data: {} },
      selectedContexts: ["general"],
      intents: ["Read records"],
      userRoles: ["USER"],
    });
    expect(admitted).toHaveLength(10);
    expect(validations).toBe(10);
  });
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
      }).actions;
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
      }).actions;
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
      }).actions;
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
    }).actions;
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
    }).actions;
    expect(result.map((action) => action.name)).toEqual(["NOTES"]);
    for (const name of [
      "NOTES_LIST",
      "NOTES_GET",
      "NOTES_CREATE",
      "NOTES_UPDATE",
      "NOTES_DELETE",
      "NOTES_PATCH",
    ]) {
      const discovered = retrieveContextualPlannerActions({
        actions,
        query: name,
        contexts: ["notes"],
      }).actions;
      expect(discovered.map((action) => action.name)).toContain(name);
    }
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

  it("uses plugin-declared domain aliases without guessing English word forms", async () => {
    const contexts = new ContextRegistry();
    const currentRuntime = { ...runtime, contexts } as IAgentRuntime;
    await notesPlugin.init?.({}, currentRuntime);
    const browser: Action = {
      name: "BROWSER_GET",
      contexts: ["browser"],
      description: "Read page body content",
    };
    const news: Action = {
      name: "NEWS_GET",
      contexts: ["news"],
      description: "Read new news body content",
    };
    const actions = [...(notesPlugin.actions ?? []), browser, news];
    const discovery = createPlannerToolDiscoveryAction(
      actions,
      () => {},
      async () => actions,
    );
    const read = await discovery.handler?.(currentRuntime, message, undefined, {
      parameters: { query: "read note body content" },
    });
    expect(read?.data?.inferredContexts).toEqual(["notes"]);
    expect([...((read?.data?.loadedTools ?? []) as string[])].sort()).toEqual([
      "NOTES_GET",
      "NOTES_LIST",
    ]);
    const unknown = await discovery.handler?.(
      currentRuntime,
      message,
      undefined,
      { parameters: { query: "read new body" } },
    );
    expect(unknown?.data?.inferredContexts).toBeUndefined();
    expect(unknown?.data?.loadedTools).toContain("BROWSER_GET");
    const revoked = createPlannerToolDiscoveryAction(
      actions,
      () => {},
      async () => [browser],
    );
    const fresh = await revoked.handler?.(currentRuntime, message, undefined, {
      parameters: { query: "read note body content" },
    });
    expect(fresh?.data?.inferredContexts).toBeUndefined();
    expect(fresh?.data?.loadedTools).toEqual(["BROWSER_GET"]);
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
      retrieveContextualPlannerActions({ actions, query: "read" }).actions.map(
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

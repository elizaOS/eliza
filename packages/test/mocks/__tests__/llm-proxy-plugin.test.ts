import { ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createDeterministicLlmProxyPlugin } from "../helpers/llm-proxy-plugin.ts";

const runtime = {} as never;

function actualDiagnosticsFrom(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  expect(message).toContain(
    "Expected: the E2E prompt must clearly match exactly one provided action/tool.",
  );
  const actualLine = message
    .split("\n")
    .find((line) => line.startsWith("Actual: "));
  expect(actualLine).toBeDefined();
  return JSON.parse(actualLine?.slice("Actual: ".length) ?? "{}");
}

function actualFixtureDiagnosticsFrom(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  const actualLine = message
    .split("\n")
    .find((line) => line.startsWith("Actual: "));
  expect(actualLine).toBeDefined();
  return JSON.parse(actualLine?.slice("Actual: ".length) ?? "{}");
}

describe("deterministic LLM proxy plugin", () => {
  it("registers high-priority deterministic text and embedding handlers", async () => {
    const plugin = createDeterministicLlmProxyPlugin({
      embeddingDimensions: 4,
    });

    expect(plugin.name).toBe("deterministic-llm-proxy");
    expect(plugin.priority).toBe(1_000);

    const embedding = await plugin.models?.[ModelType.TEXT_EMBEDDING]?.(
      runtime,
      "hello",
    );
    expect(embedding).toEqual([0, 0, 0, 0]);
    expect(plugin.models?.[ModelType.RESPONSE_HANDLER]).toBeTypeOf("function");
    expect(plugin.models?.[ModelType.ACTION_PLANNER]).toBeTypeOf("function");
    expect(plugin.models?.[ModelType.TEXT_SMALL]).toBeTypeOf("function");
    expect(plugin.models?.[ModelType.TEXT_LARGE]).toBeTypeOf("function");
  });

  it("returns a deterministic HANDLE_RESPONSE payload for Stage 1", async () => {
    const plugin = createDeterministicLlmProxyPlugin();
    const raw = await plugin.models?.[ModelType.RESPONSE_HANDLER]?.(runtime, {
      messages: [{ role: "user", content: "Open the view manager" }],
      tools: [{ name: "HANDLE_RESPONSE" }],
    });

    const result = JSON.parse(String(raw));
    const args = result.toolCalls[0].arguments;
    expect(result.toolCalls[0].name).toBe("HANDLE_RESPONSE");
    expect(args.shouldRespond).toBe("RESPOND");
    expect(args.contexts).toEqual(["simple"]);
    expect(args.replyText).toBe(
      "Deterministic test reply for: Open the view manager",
    );
  });

  it("extracts exact user_message text from direct-reply prompts", async () => {
    const plugin = createDeterministicLlmProxyPlugin();
    const raw = await plugin.models?.[ModelType.TEXT_SMALL]?.(runtime, {
      prompt: [
        "task: Write one direct reply to the user.",
        "rules:",
        "- answer directly",
        "user_message: hello deterministic proxy",
        "routing_thought: Direct private chat fast path.",
      ].join("\n"),
    });

    expect(raw).toBe("deterministic-test-response: hello deterministic proxy");
  });

  it("selects an action planner tool from the actual tool list", async () => {
    const plugin = createDeterministicLlmProxyPlugin();
    const raw = await plugin.models?.[ModelType.ACTION_PLANNER]?.(runtime, {
      messages: [{ role: "user", content: "Please create view" }],
      tools: [
        {
          name: "CREATE_VIEW",
          parameters: {
            type: "object",
            properties: {
              title: { type: "string" },
              pinned: { type: "boolean" },
            },
          },
        },
      ],
    });

    const result = JSON.parse(String(raw));
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        name: "CREATE_VIEW",
        arguments: { title: "View Manager", pinned: false },
      }),
    ]);
  });

  it("selects view/window actions from user intent instead of first-tool order", async () => {
    const plugin = createDeterministicLlmProxyPlugin();
    const raw = await plugin.models?.[ModelType.ACTION_PLANNER]?.(runtime, {
      messages: [
        {
          role: "user",
          content: "Create a new remote ledger view and pin it as a tab",
        },
      ],
      tools: [
        {
          name: "DYNAMIC_VIEW_UNREGISTER",
          description: "Delete or remove an existing dynamic view",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "DYNAMIC_VIEW_REGISTER",
          description:
            "Create or update a local or remote plugin view from a bundle",
          parameters: {
            type: "object",
            properties: {
              source: { const: "remote-plugin" },
              placement: { default: "desktop-tab" },
            },
          },
        },
        {
          name: "DESKTOP_OPEN_APP_WINDOW",
          description: "Open or switch to an app window",
          parameters: { type: "object", properties: {} },
        },
      ],
    });

    const result = JSON.parse(String(raw));
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        name: "DYNAMIC_VIEW_REGISTER",
        arguments: {
          source: "remote-plugin",
          placement: "desktop-tab",
        },
      }),
    ]);
  });

  it("fails closed with actual-vs-expected diagnostics when no planner tool matches", async () => {
    const plugin = createDeterministicLlmProxyPlugin();

    let thrown: unknown;
    try {
      await plugin.models?.[ModelType.ACTION_PLANNER]?.(runtime, {
        messages: [
          {
            role: "user",
            content: "Create a new remote ledger view",
          },
        ],
        tools: [
          {
            name: "SEND_EMAIL",
            description: "Send an email message",
            parameters: { type: "object", properties: {} },
          },
        ],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(
      "deterministic LLM proxy could not select an ACTION_PLANNER tool: no matching tool",
    );
    const actual = actualDiagnosticsFrom(thrown);
    expect(actual.latestUserText).toBe("Create a new remote ledger view");
    expect(actual.toolNames).toEqual(["SEND_EMAIL"]);
    expect(actual.scores).toEqual([
      {
        name: "SEND_EMAIL",
        score: 0,
        description: "Send an email message",
      },
    ]);
  });

  it("fails closed with actual-vs-expected diagnostics when planner tools tie", async () => {
    const plugin = createDeterministicLlmProxyPlugin();

    let thrown: unknown;
    try {
      await plugin.models?.[ModelType.ACTION_PLANNER]?.(runtime, {
        messages: [
          {
            role: "user",
            content: "Open the remote ledger view",
          },
        ],
        tools: [
          {
            name: "REMOTE_LEDGER_PRIMARY",
            description: "Open the remote ledger view",
            parameters: { type: "object", properties: {} },
          },
          {
            name: "REMOTE_LEDGER_SECONDARY",
            description: "Open the remote ledger view",
            parameters: { type: "object", properties: {} },
          },
        ],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(
      "deterministic LLM proxy could not select an ACTION_PLANNER tool: ambiguous matching tools",
    );
    const actual = actualDiagnosticsFrom(thrown);
    expect(actual.latestUserText).toBe("Open the remote ledger view");
    expect(actual.toolNames).toEqual([
      "REMOTE_LEDGER_PRIMARY",
      "REMOTE_LEDGER_SECONDARY",
    ]);
    expect(actual.scores).toEqual([
      {
        name: "REMOTE_LEDGER_PRIMARY",
        score: expect.any(Number),
        description: "Open the remote ledger view",
      },
      {
        name: "REMOTE_LEDGER_SECONDARY",
        score: expect.any(Number),
        description: "Open the remote ledger view",
      },
    ]);
  });

  it("can opt into legacy first-tool fallback for compatibility-only smoke tests", async () => {
    const plugin = createDeterministicLlmProxyPlugin({
      failOnUnhandledAction: false,
    });
    const raw = await plugin.models?.[ModelType.ACTION_PLANNER]?.(runtime, {
      messages: [
        {
          role: "user",
          content: "Create a new remote ledger view",
        },
      ],
      tools: [
        {
          name: "SEND_EMAIL",
          description: "Send an email message",
          parameters: { type: "object", properties: {} },
        },
      ],
    });

    const result = JSON.parse(String(raw));
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        name: "SEND_EMAIL",
      }),
    ]);
  });

  it("generates exact deterministic view registration arguments from schema field names", async () => {
    const plugin = createDeterministicLlmProxyPlugin();
    const raw = await plugin.models?.[ModelType.ACTION_PLANNER]?.(runtime, {
      messages: [
        {
          role: "user",
          content: "Create a new remote ledger view and pin it as a tab",
        },
      ],
      tools: [
        {
          name: "DYNAMIC_VIEW_REGISTER",
          description: "Create or update a dynamic view",
          parameters: {
            type: "object",
            properties: {
              manifest: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  title: { type: "string" },
                  source: { type: "string" },
                  entrypoint: { type: "string" },
                  placement: { type: "string" },
                  metadata: { type: "object" },
                },
              },
              update: { type: "boolean" },
            },
          },
        },
      ],
    });

    const result = JSON.parse(String(raw));
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        name: "DYNAMIC_VIEW_REGISTER",
        arguments: {
          manifest: {
            id: "remote-ledger",
            title: "Remote Ledger",
            source: "remote-plugin",
            entrypoint: "/api/views/remote-ledger/bundle.js",
            placement: "desktop-tab",
            metadata: {
              deterministic: true,
              viewId: "remote-ledger",
            },
          },
          update: false,
        },
      }),
    ]);
  });

  it("generates local dynamic view registration arguments without a remote bundle", async () => {
    const plugin = createDeterministicLlmProxyPlugin();
    const raw = await plugin.models?.[ModelType.ACTION_PLANNER]?.(runtime, {
      messages: [
        {
          role: "user",
          content: "Create a new local agent run trace view",
        },
      ],
      tools: [
        {
          name: "DYNAMIC_VIEW_REGISTER",
          description: "Create or update a dynamic local or remote view",
          parameters: {
            type: "object",
            properties: {
              manifest: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  title: { type: "string" },
                  source: { type: "string" },
                  entrypoint: { type: "string" },
                  placement: { type: "string" },
                  metadata: { type: "object" },
                },
              },
              update: { type: "boolean" },
            },
          },
        },
      ],
    });

    const result = JSON.parse(String(raw));
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        name: "DYNAMIC_VIEW_REGISTER",
        arguments: {
          manifest: {
            id: "agent-run-trace",
            title: "Agent Run Trace",
            source: "local",
            entrypoint: "agent-run-trace.html",
            placement: "floating",
            metadata: {
              deterministic: true,
              viewId: "agent-run-trace",
            },
          },
          update: false,
        },
      }),
    ]);
  });

  it("generates exact deterministic app-window arguments for switch/open tests", async () => {
    const plugin = createDeterministicLlmProxyPlugin();
    const raw = await plugin.models?.[ModelType.ACTION_PLANNER]?.(runtime, {
      messages: [
        {
          role: "user",
          content:
            "Switch to the remote ledger app window and keep it always on top",
        },
      ],
      tools: [
        {
          name: "DESKTOP_OPEN_APP_WINDOW",
          description: "Open or switch to an app window",
          parameters: {
            type: "object",
            properties: {
              slug: { type: "string" },
              title: { type: "string" },
              path: { type: "string" },
              alwaysOnTop: { type: "boolean" },
            },
          },
        },
      ],
    });

    const result = JSON.parse(String(raw));
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        name: "DESKTOP_OPEN_APP_WINDOW",
        arguments: {
          slug: "remote-ledger",
          title: "Remote Ledger",
          path: "/apps/remote-ledger",
          alwaysOnTop: true,
        },
      }),
    ]);
  });

  it("keeps the view id stable while generating edited title arguments", async () => {
    const plugin = createDeterministicLlmProxyPlugin();
    const raw = await plugin.models?.[ModelType.ACTION_PLANNER]?.(runtime, {
      messages: [
        {
          role: "user",
          content:
            "Edit the remote ledger view title to Remote Ledger Updated and pin it as a tab",
        },
      ],
      tools: [
        {
          name: "DYNAMIC_VIEW_REGISTER",
          description: "Create, update, or edit a dynamic view",
          parameters: {
            type: "object",
            properties: {
              manifest: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  title: { type: "string" },
                  entrypoint: { type: "string" },
                  placement: { type: "string" },
                },
              },
              update: { type: "boolean" },
            },
          },
        },
      ],
    });

    const result = JSON.parse(String(raw));
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        name: "DYNAMIC_VIEW_REGISTER",
        arguments: {
          manifest: {
            id: "remote-ledger",
            title: "Remote Ledger Updated",
            entrypoint: "/api/views/remote-ledger/bundle.js",
            placement: "desktop-tab",
          },
          update: true,
        },
      }),
    ]);
  });

  it("generates exact deterministic dynamic view delete arguments", async () => {
    const plugin = createDeterministicLlmProxyPlugin();
    const raw = await plugin.models?.[ModelType.ACTION_PLANNER]?.(runtime, {
      messages: [
        {
          role: "user",
          content: "Delete the stale remote ledger dynamic view",
        },
      ],
      tools: [
        {
          name: "DYNAMIC_VIEW_REGISTER",
          description: "Create or update a dynamic view",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "DYNAMIC_VIEW_UNREGISTER",
          description: "Delete or remove a dynamic view",
          parameters: {
            type: "object",
            properties: {
              viewId: { type: "string" },
            },
          },
        },
      ],
    });

    const result = JSON.parse(String(raw));
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        name: "DYNAMIC_VIEW_UNREGISTER",
        arguments: {
          viewId: "remote-ledger",
        },
      }),
    ]);
  });

  it("generates exact deterministic view-interaction arguments for real DOM input and button tests", async () => {
    const plugin = createDeterministicLlmProxyPlugin();
    const raw = await plugin.models?.[ModelType.ACTION_PLANNER]?.(runtime, {
      messages: [
        {
          role: "user",
          content:
            "Fill the remote ledger view title input with Remote Ledger Updated and then press save",
        },
      ],
      tools: [
        {
          name: "INTERACT_WITH_VIEW",
          description:
            "Interact with a loaded view using standard DOM capabilities",
          parameters: {
            type: "object",
            properties: {
              viewId: { type: "string" },
              capability: { type: "string" },
              params: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  value: { type: "string" },
                },
              },
            },
          },
        },
      ],
    });

    const result = JSON.parse(String(raw));
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        name: "INTERACT_WITH_VIEW",
        arguments: {
          viewId: "remote-ledger",
          capability: "fill-input",
          params: {
            name: "view-title",
            value: "Remote Ledger Updated",
          },
        },
      }),
    ]);
  });

  it("generates exact deterministic view-interaction click arguments", async () => {
    const plugin = createDeterministicLlmProxyPlugin();
    const raw = await plugin.models?.[ModelType.ACTION_PLANNER]?.(runtime, {
      messages: [
        {
          role: "user",
          content: "Click the save button in the remote ledger view",
        },
      ],
      tools: [
        {
          name: "INTERACT_WITH_VIEW",
          description:
            "Click, fill, focus, or read from a loaded view using standard capabilities",
          parameters: {
            type: "object",
            properties: {
              viewId: { type: "string" },
              capability: { type: "string" },
              params: { type: "object" },
            },
          },
        },
      ],
    });

    const result = JSON.parse(String(raw));
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        name: "INTERACT_WITH_VIEW",
        arguments: {
          viewId: "remote-ledger",
          capability: "click-element",
          params: {
            selector: ".submit-view",
          },
        },
      }),
    ]);
  });

  it.each([
    {
      text: "Open the view manager",
      action: "manager",
      view: "view-manager",
    },
    {
      text: "Pin the remote ledger view as a desktop tab",
      action: "pin",
      view: "remote-ledger",
    },
    {
      text: "Open the remote ledger view in a separate window and keep it always on top",
      action: "window",
      view: "remote-ledger",
      alwaysOnTop: true,
    },
    {
      text: "Fill the remote ledger view title input with Remote Ledger Updated",
      action: "interact",
      view: "remote-ledger",
      capability: "fill-input",
      params: { name: "view-title", value: "Remote Ledger Updated" },
    },
    {
      text: "Create a new remote ledger view",
      action: "create",
      view: "remote-ledger",
    },
    {
      text: "Edit the remote ledger view title",
      action: "edit",
      view: "remote-ledger",
    },
    {
      text: "Delete the stale remote ledger view",
      action: "delete",
      view: "remote-ledger",
    },
  ])("generates semantic arguments for unified VIEWS action: $action", async ({
    action,
    alwaysOnTop,
    capability,
    params,
    text,
    view,
  }) => {
    const plugin = createDeterministicLlmProxyPlugin();
    const raw = await plugin.models?.[ModelType.ACTION_PLANNER]?.(runtime, {
      messages: [
        {
          role: "user",
          content: text,
        },
      ],
      tools: [
        {
          name: "VIEWS",
          description:
            "Manage views: list, show, manager, interact, pin, window, create, edit, delete",
          parameters: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: [
                  "list",
                  "current",
                  "show",
                  "manager",
                  "interact",
                  "pin",
                  "window",
                  "create",
                  "edit",
                  "delete",
                ],
              },
              view: { type: "string" },
              capability: { type: "string" },
              alwaysOnTop: { type: "boolean" },
              params: { type: "object" },
              viewType: { type: "string", enum: ["gui", "tui"] },
            },
          },
        },
      ],
    });

    const result = JSON.parse(String(raw));
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        name: "VIEWS",
        arguments: {
          action,
          alwaysOnTop: alwaysOnTop ?? false,
          capability: capability ?? "get-text",
          params: params ?? {},
          view,
          viewType: "gui",
        },
      }),
    ]);
  });

  it.each([
    { text: "can you show me the settings?", view: "settings" },
    { text: "show me my character profile", view: "character" },
    { text: "take me to the chat", view: "chat" },
    { text: "open the automations view", view: "automations" },
    { text: "open the trajectories view", view: "trajectories" },
    { text: "open the database view", view: "database" },
    { text: "show me the logs", view: "logs" },
    { text: "open the memories view", view: "memories" },
    { text: "open the plugins page", view: "plugins-page" },
    { text: "open my wallet", view: "wallet" },
    { text: "show my skills", view: "skills" },
    { text: "go to training", view: "training" },
    { text: "show me the apps", view: "apps" },
    { text: "take me home", view: "home" },
  ])("navigates to built-in view $view with exact show action and params", async ({
    text,
    view,
  }) => {
    const plugin = createDeterministicLlmProxyPlugin();
    const raw = await plugin.models?.[ModelType.ACTION_PLANNER]?.(runtime, {
      messages: [{ role: "user", content: text }],
      tools: [
        {
          name: "VIEWS",
          description:
            "Manage and navigate UI views: list, show, open, search, manager, broadcast, interact, pin, window, create, edit, delete",
          parameters: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: [
                  "list",
                  "current",
                  "show",
                  "open",
                  "search",
                  "manager",
                  "broadcast",
                  "interact",
                  "pin",
                  "window",
                  "create",
                  "edit",
                  "delete",
                ],
              },
              view: { type: "string" },
            },
          },
        },
      ],
    });

    const result = JSON.parse(String(raw));
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        name: "VIEWS",
        arguments: { action: "show", view },
      }),
    ]);
  });

  it("feeds Stage 1 candidateActionNames from the intent-ranked action tool", async () => {
    const plugin = createDeterministicLlmProxyPlugin();
    const raw = await plugin.models?.[ModelType.RESPONSE_HANDLER]?.(runtime, {
      messages: [{ role: "user", content: "Delete the stale dynamic view" }],
      tools: [
        { name: "HANDLE_RESPONSE" },
        {
          name: "DYNAMIC_VIEW_REGISTER",
          description: "Create or update a dynamic view",
        },
        {
          name: "DYNAMIC_VIEW_UNREGISTER",
          description: "Delete or remove a dynamic view",
        },
      ],
    });

    const result = JSON.parse(String(raw));
    const args = result.toolCalls[0].arguments;
    expect(args.contexts).toEqual(["actions"]);
    expect(args.replyText).toBe("On it.");
    expect(args.candidateActionNames).toEqual(["DYNAMIC_VIEW_UNREGISTER"]);
  });

  it("fails Stage 1 with actual-vs-expected diagnostics when no candidate action matches", async () => {
    const plugin = createDeterministicLlmProxyPlugin();

    let thrown: unknown;
    try {
      await plugin.models?.[ModelType.RESPONSE_HANDLER]?.(runtime, {
        messages: [
          {
            role: "user",
            content: "Create a new remote ledger view",
          },
        ],
        tools: [
          { name: "HANDLE_RESPONSE" },
          {
            name: "SEND_EMAIL",
            description: "Send an email message",
            parameters: { type: "object", properties: {} },
          },
        ],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(
      "deterministic LLM proxy could not select an ACTION_PLANNER tool: no matching tool",
    );
    const actual = actualDiagnosticsFrom(thrown);
    expect(actual.modelType).toBe(ModelType.RESPONSE_HANDLER);
    expect(actual.latestUserText).toBe("Create a new remote ledger view");
    expect(actual.toolNames).toEqual(["HANDLE_RESPONSE", "SEND_EMAIL"]);
    expect(actual.scores).toEqual([
      {
        name: "SEND_EMAIL",
        score: 0,
        description: "Send an email message",
      },
    ]);
  });

  it("fails Stage 1 with actual-vs-expected diagnostics when candidate actions tie", async () => {
    const plugin = createDeterministicLlmProxyPlugin();

    let thrown: unknown;
    try {
      await plugin.models?.[ModelType.RESPONSE_HANDLER]?.(runtime, {
        messages: [
          {
            role: "user",
            content: "Open the remote ledger view",
          },
        ],
        tools: [
          { name: "HANDLE_RESPONSE" },
          {
            name: "REMOTE_LEDGER_PRIMARY",
            description: "Open the remote ledger view",
            parameters: { type: "object", properties: {} },
          },
          {
            name: "REMOTE_LEDGER_SECONDARY",
            description: "Open the remote ledger view",
            parameters: { type: "object", properties: {} },
          },
        ],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(
      "deterministic LLM proxy could not select an ACTION_PLANNER tool: ambiguous matching tools",
    );
    const actual = actualDiagnosticsFrom(thrown);
    expect(actual.modelType).toBe(ModelType.RESPONSE_HANDLER);
    expect(actual.latestUserText).toBe("Open the remote ledger view");
    expect(actual.toolNames).toEqual([
      "HANDLE_RESPONSE",
      "REMOTE_LEDGER_PRIMARY",
      "REMOTE_LEDGER_SECONDARY",
    ]);
    expect(actual.scores).toEqual([
      {
        name: "REMOTE_LEDGER_PRIMARY",
        score: expect.any(Number),
        description: "Open the remote ledger view",
      },
      {
        name: "REMOTE_LEDGER_SECONDARY",
        score: expect.any(Number),
        description: "Open the remote ledger view",
      },
    ]);
  });

  it("matches strict named fixtures by model, input, and schema with exact JSON output", async () => {
    const responseSchema = {
      type: "object",
      required: ["answer", "count"],
      additionalProperties: false,
      properties: {
        answer: { const: "fixture-exact" },
        count: { type: "integer" },
      },
    };
    const exact = { answer: "fixture-exact", count: 2 };
    const plugin = createDeterministicLlmProxyPlugin({
      strict: true,
      fixtures: [
        {
          name: "exact-json-response",
          match: {
            modelType: ModelType.TEXT_SMALL,
            input: "run the strict fixture",
            responseSchema,
          },
          response: exact,
          times: 1,
        },
      ],
    });

    const raw = await plugin.models?.[ModelType.TEXT_SMALL]?.(runtime, {
      messages: [{ role: "user", content: "run the strict fixture" }],
      responseSchema,
    });

    expect(raw).toBe(JSON.stringify(exact));
    plugin.assertFixturesConsumed();
    expect(plugin.getFixtureDiagnostics().fixtures).toEqual([
      expect.objectContaining({
        name: "exact-json-response",
        consumed: 1,
      }),
    ]);
  });

  it("returns exact strict ACTION_PLANNER tool-call JSON and validates tool arguments", async () => {
    const exact = {
      text: "",
      finishReason: "tool-calls",
      toolCalls: [
        {
          id: "call-create-ledger",
          name: "CREATE_LEDGER_VIEW",
          type: "function",
          arguments: {
            viewId: "remote-ledger",
            pinned: true,
          },
        },
      ],
    };
    const plugin = createDeterministicLlmProxyPlugin({
      strict: true,
      fixtures: [
        {
          name: "planner-create-ledger",
          match: {
            modelType: ModelType.ACTION_PLANNER,
            input: /create the ledger view/i,
            toolName: "CREATE_LEDGER_VIEW",
          },
          response: exact,
          times: 1,
        },
      ],
    });

    const raw = await plugin.models?.[ModelType.ACTION_PLANNER]?.(runtime, {
      messages: [{ role: "user", content: "Create the ledger view" }],
      tools: [
        {
          name: "CREATE_LEDGER_VIEW",
          description: "Create a deterministic ledger view",
          parameters: {
            type: "object",
            required: ["viewId", "pinned"],
            additionalProperties: false,
            properties: {
              viewId: { type: "string" },
              pinned: { type: "boolean" },
            },
          },
        },
      ],
    });

    expect(raw).toBe(JSON.stringify(exact));
    plugin.assertFixturesConsumed();
  });

  it("lets tests register strict named resolver fixtures after plugin creation", async () => {
    const plugin = createDeterministicLlmProxyPlugin({ strict: true });
    plugin.llmFixtures.register({
      name: "late-registered-resolver",
      match: {
        modelType: ModelType.TEXT_SMALL,
        input: /registered resolver/i,
      },
      resolve(call) {
        return {
          ok: true,
          input: call.latestUserText,
          tool: call.toolNames[0] ?? "none",
        };
      },
      times: 1,
    });

    const raw = await plugin.models?.[ModelType.TEXT_SMALL]?.(runtime, {
      messages: [{ role: "user", content: "Use registered resolver" }],
      tools: [{ name: "ASSERT_RESOLVER_USED" }],
    });

    expect(JSON.parse(String(raw))).toEqual({
      ok: true,
      input: "Use registered resolver",
      tool: "ASSERT_RESOLVER_USED",
    });
    plugin.assertFixturesConsumed();
  });

  it("fails strict fixture mode on unhandled calls with call diagnostics", async () => {
    const plugin = createDeterministicLlmProxyPlugin({
      strict: true,
      fixtures: [
        {
          name: "different-input",
          match: {
            modelType: ModelType.TEXT_SMALL,
            input: "handled input",
          },
          response: { ok: true },
        },
      ],
    });

    let thrown: unknown;
    try {
      await plugin.models?.[ModelType.TEXT_SMALL]?.(runtime, {
        messages: [{ role: "user", content: "unhandled input" }],
        tools: [{ name: "ASSERT_EXACT_FIXTURE" }],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(
      "deterministic LLM proxy fixture registry has no fixture for this call",
    );
    const actual = actualFixtureDiagnosticsFrom(thrown);
    expect(actual.call).toEqual(
      expect.objectContaining({
        modelType: ModelType.TEXT_SMALL,
        latestUserText: "unhandled input",
        toolNames: ["ASSERT_EXACT_FIXTURE"],
      }),
    );
    expect(plugin.getFixtureDiagnostics().unexpectedCalls).toHaveLength(1);
  });

  it("fails strict fixture mode when more than one fixture matches", async () => {
    const plugin = createDeterministicLlmProxyPlugin({
      strict: true,
      fixtures: [
        {
          name: "ambiguous-one",
          match: {
            modelType: ModelType.TEXT_SMALL,
            input: "same input",
          },
          response: { one: true },
        },
        {
          name: "ambiguous-two",
          match: {
            modelType: ModelType.TEXT_SMALL,
            input: "same input",
          },
          response: { two: true },
        },
      ],
    });

    let thrown: unknown;
    try {
      await plugin.models?.[ModelType.TEXT_SMALL]?.(runtime, {
        messages: [{ role: "user", content: "same input" }],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(
      "deterministic LLM proxy fixture registry matched multiple fixtures",
    );
    const actual = actualFixtureDiagnosticsFrom(thrown);
    expect(actual.matchingFixtures).toEqual(["ambiguous-one", "ambiguous-two"]);
  });

  it("fails fixture consumption assertions when an expected fixture is unused", () => {
    const plugin = createDeterministicLlmProxyPlugin({
      strict: true,
      fixtures: [
        {
          name: "must-be-used",
          match: {
            modelType: ModelType.TEXT_SMALL,
            input: "consume me",
          },
          response: { ok: true },
        },
      ],
    });

    let thrown: unknown;
    try {
      plugin.assertFixturesConsumed();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(
      "deterministic LLM proxy fixture registry has unused fixtures",
    );
    const actual = actualFixtureDiagnosticsFrom(thrown);
    expect(actual.unused).toEqual([
      expect.objectContaining({
        name: "must-be-used",
        consumed: 0,
      }),
    ]);
  });

  it("lets tests override responses dynamically from model type and action", async () => {
    const plugin = createDeterministicLlmProxyPlugin({
      resolve(call) {
        if (call.modelType !== ModelType.TEXT_SMALL) return null;
        return { ok: true, action: call.toolNames[0] ?? "none" };
      },
    });

    const raw = await plugin.models?.[ModelType.TEXT_SMALL]?.(runtime, {
      messages: [{ role: "user", content: "anything" }],
      tools: [{ name: "VALIDATE_WINDOW_MANAGER" }],
    });

    expect(JSON.parse(String(raw))).toEqual({
      ok: true,
      action: "VALIDATE_WINDOW_MANAGER",
    });
  });
});

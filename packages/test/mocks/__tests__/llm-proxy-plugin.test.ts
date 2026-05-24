import { ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createDeterministicLlmProxyPlugin } from "../helpers/llm-proxy-plugin.ts";

const runtime = {} as never;

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
      text: "Open the remote ledger view in a separate window",
      action: "window",
      view: "remote-ledger",
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
          capability: capability ?? "get-text",
          params: params ?? {},
          view,
          viewType: "gui",
        },
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

/** Mounted Todos dispatch and PA owner-task receipts; deterministic model, real PGlite. */

import { mkdir, writeFile } from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { ChannelType, type Memory, type UUID } from "@elizaos/core";
import { act, cleanup, render } from "@testing-library/react";
import { JSDOM } from "jsdom";
import { expect, it, vi } from "vitest";
import { executePlannedToolCall } from "../../../packages/core/src/runtime/execute-planned-tool-call.ts";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";
import { strictTerminalReplyFixture } from "../../../packages/testing/src/deterministic-action-fixtures.ts";
import { createDeterministicModelPlugin } from "../../../packages/testing/src/deterministic-model-plugin.ts";
import {
  handleLifeOpsRoutes,
  type LifeOpsRouteContext,
} from "../src/routes/lifeops-routes.ts";

vi.mock(
  "@elizaos/ui/api",
  async () => import("../../../packages/ui/src/api/client.ts"),
);

import { client } from "../../../packages/ui/src/api/client.ts";
import { TodosView } from "../../plugin-todos/src/components/todos/TodosView.tsx";
import { todosPlugin } from "../../plugin-todos/src/plugin.ts";
import { ownerTodosAction } from "../src/actions/owner-surfaces.ts";
import { LifeOpsService } from "../src/lifeops/service.ts";
import { createLifeOpsTestRuntime } from "./helpers/runtime.ts";

it("separates mounted Add dispatch from owner task creation and Retry readback", async () => {
  const ask = "Add a todo for me.";
  const clarification = "What task would you like to add?";
  const unmatched: unknown[] = [];
  const model = createDeterministicModelPlugin({
    resolve(call) {
      unmatched.push({
        modelType: call.modelType,
        latestUserText: call.latestUserText,
      });
      return null;
    },
    fixtures: [
      {
        ...strictTerminalReplyFixture({
          input: ask,
          text: clarification,
          contextIds: ["tasks"],
        }),
        // Missing task details require a clarification, not a task mutation.
        response: {
          contexts: ["tasks"],
          intents: [],
          replyText: clarification,
          replyEffectStatus: "non_applied",
          threadOps: [],
          candidateActionNames: [],
        },
      },
    ],
  });
  const host = await createLifeOpsTestRuntime({ plugins: [model] });
  const runtime = host.runtime;
  const messageService = runtime.messageService;
  if (!messageService) throw new Error("Real message service missing");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
  });
  for (const key of [
    "window",
    "document",
    "HTMLElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLSelectElement",
    "HTMLButtonElement",
    "Element",
    "Node",
    "MutationObserver",
    "Event",
    "CustomEvent",
    "MouseEvent",
  ] as const)
    vi.stubGlobal(key, dom.window[key]);
  vi.stubGlobal(
    "getComputedStyle",
    dom.window.getComputedStyle.bind(dom.window),
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { DynamicViewLoader, __resetDynamicViewLoaderCacheForTests } =
    await import(
      "../../../packages/ui/src/components/views/DynamicViewLoader.tsx"
    );
  const { invokeViewInteract } = await import(
    "../../../packages/ui/src/components/views/view-interact-registry.ts"
  );
  Object.defineProperty(window, "CSS", {
    configurable: true,
    value: { escape: (value: string) => value.replaceAll('"', '\\"') },
  });
  vi.stubGlobal("CSS", window.CSS);
  const owner = crypto.randomUUID() as UUID;
  const worldId = crypto.randomUUID() as UUID;
  const message: Memory = {
    id: crypto.randomUUID() as UUID,
    agentId: runtime.agentId,
    entityId: owner,
    roomId: crypto.randomUUID() as UUID,
    worldId,
    content: { text: ask, source: "client_chat", channelType: ChannelType.DM },
  };
  const service = new LifeOpsService(runtime, { ownerEntityId: owner });
  const requests: string[] = [];
  let delivered!: Promise<unknown>;
  let reply = "";
  const transport = vi
    .spyOn(client, "sendChatRest")
    .mockImplementation(async (text) => {
      requests.push(text);
      // Replace only the host transport: the actual message service and strict
      // model fixture produce the clarification. No successful task is fabricated.
      delivered = messageService.handleMessage(
        runtime,
        { ...message, content: { ...message.content, text } },
        async (content) => {
          reply += content.text ?? "";
          return [];
        },
      );
      await delivered;
      return { text: reply } as Awaited<ReturnType<typeof client.sendChatRest>>;
    });
  try {
    runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", owner);
    await runtime.ensureConnection({
      entityId: owner,
      roomId: message.roomId,
      worldId,
      worldName: "Todos operation proof",
      userName: "owner",
      name: "Owner",
      source: "client_chat",
      type: ChannelType.DM,
      channelId: message.roomId,
    });
    const before = await service.repository.listDefinitions(runtime.agentId, {
      domain: "user_lifeops",
      subjectType: "owner",
      subjectId: owner,
    });
    let failRead = false;
    const fetchTodos = async () => {
      if (failRead) throw new Error("Owner task query unavailable");
      const socket = new Socket();
      Object.defineProperty(socket, "remoteAddress", { value: "127.0.0.1" });
      const req = new IncomingMessage(socket);
      req.method = "GET";
      const res = new ServerResponse(req);
      let body = "";
      res.end = function (chunk?: unknown) {
        body = String(chunk ?? "");
        return this;
      };
      const ctx: LifeOpsRouteContext = {
        req,
        res,
        method: "GET",
        pathname: "/api/lifeops/todos",
        url: new URL("http://localhost/api/lifeops/todos"),
        state: { runtime, adminEntityId: owner },
        json(r, data, status = 200) {
          r.statusCode = status;
          r.end(JSON.stringify(data));
        },
        error(r, text, status = 400) {
          r.statusCode = status;
          r.end(JSON.stringify({ error: text }));
        },
        async readJsonBody() {
          return null;
        },
        decodePathComponent: decodeURIComponent,
      };
      await handleLifeOpsRoutes(ctx);
      if (res.statusCode !== 200) throw new Error(body);
      return JSON.parse(body) as {
        todos: {
          id: string;
          title: string;
          status: string;
          dueDate: string | null;
        }[];
      };
    };
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = async () => ({
      default: () => <TodosView fetchers={{ fetchTodos }} />,
    });
    const mount = () =>
      render(
        <DynamicViewLoader
          installationId="todos-operation-proof"
          bundleUrl="http://localhost/assets/todos-operation-proof.js"
          viewId="todos"
          viewType="gui"
          reserveChatClearance={false}
          surface={{ capabilities: ["agent-surface"] }}
        />,
      );
    let mounted = mount();
    await mounted.findByText("No active todos", {}, { timeout: 30_000 });
    const declarations = todosPlugin.views?.[0].scopedActions;
    if (!declarations?.length)
      throw new Error("Todo operation declarations missing");
    const receipts: { operationId: string; result: unknown }[] = [];
    const dispatch = async (name: string) => {
      if (receipts.some((row) => row.operationId === name))
        throw new Error("Duplicate operation evidence");
      const matches = declarations.filter((row) => row.name === name);
      if (matches.length !== 1)
        throw new Error("Unknown or ambiguous operation");
      for (const step of matches[0].steps) {
        const result = await invokeViewInteract("todos", "gui", step.kind, {
          id: step.target,
        });
        expect(result).toMatchObject({ ok: true });
        receipts.push({ operationId: name, result });
      }
    };
    await act(async () => {
      await dispatch("VIEW_TODOS_ADD");
      await delivered;
    });
    const diagnosticOutput = testOutputPath("todos-mounted-operations");
    await mkdir(diagnosticOutput, { recursive: true });
    await writeFile(
      `${diagnosticOutput}/unmatched-model-calls.json`,
      JSON.stringify(unmatched, null, 2),
    );
    expect(requests).toEqual([ask]);
    expect(
      reply,
      JSON.stringify(model.getFixtureDiagnostics(), null, 2),
    ).toContain(clarification);
    expect(
      await service.repository.listDefinitions(runtime.agentId, {
        domain: "user_lifeops",
        subjectType: "owner",
        subjectId: owner,
      }),
    ).toEqual(before);
    model.assertFixturesConsumed();
    const title = "Read the complete draft";
    const created = await executePlannedToolCall(
      runtime,
      {
        message: {
          ...message,
          id: crypto.randomUUID() as UUID,
          content: {
            source: "client_chat",
            text: `Add a todo named ${title} without a deadline.`,
          },
        },
        activeContexts: ["tasks"],
      },
      {
        name: "OWNER_TODOS",
        params: {
          action: "create",
          title,
          intent: `Create ${title} without any deadline.`,
          idempotencyKey: "mounted-todos-proof",
          details: {
            kind: "task",
            cadence: { kind: "unscheduled" },
            timeZone: "UTC",
          },
        },
      },
      { actions: [ownerTodosAction] },
    );
    expect(created.success).toBe(true);
    const id = created.effectReceipts?.[0].resource.id;
    expect(id).toBeTruthy();
    expect(
      await service.repository.listDefinitions(runtime.agentId, {
        domain: "user_lifeops",
        subjectType: "owner",
        subjectId: owner,
      }),
    ).toEqual([expect.objectContaining({ id, title })]);
    cleanup();
    failRead = true;
    mounted = mount();
    await mounted.findByText(
      "Owner task query unavailable",
      {},
      { timeout: 30_000 },
    );
    failRead = false;
    await act(async () => {
      await dispatch("VIEW_TODOS_RETRY");
    });
    await mounted.findByText(title, {}, { timeout: 30_000 });
    expect(receipts.map((row) => row.operationId).sort()).toEqual(
      declarations.map((row) => row.name).sort(),
    );
    const output = testOutputPath("todos-mounted-operations");
    await mkdir(output, { recursive: true });
    await writeFile(
      `${output}/evidence.json`,
      JSON.stringify(
        {
          qualification: "mounted-dispatch-and-owner-task-receipts",
          declarations,
          requests,
          clarification: reply,
          dispatchReceipts: receipts,
          effectResult: created,
          readback: await fetchTodos(),
          modelDiagnostics: model.getFixtureDiagnostics(),
          limitations: [
            "DOM mounted in jsdom, not desktop/mobile visual certification",
            "Add transport is an in-process adapter into the real message service",
            "Authored follow-up uses canonical OWNER_TODOS dispatch, not model intent quality",
          ],
        },
        null,
        2,
      ),
    );
    expect(
      await service.repository.listDefinitions(runtime.agentId, {
        domain: "user_lifeops",
        subjectType: "owner",
        subjectId: owner,
      }),
    ).toEqual([expect.objectContaining({ id, title })]);
  } finally {
    try {
      await act(async () => {
        cleanup();
        await new Promise<void>((resolve) => setImmediate(resolve));
      });
      transport.mockRestore();
      delete window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__;
      __resetDynamicViewLoaderCacheForTests();
    } finally {
      try {
        await host.cleanup();
        await new Promise<void>((resolve) => setImmediate(resolve));
      } finally {
        vi.unstubAllGlobals();
        dom.window.close();
      }
    }
  }
}, 120_000);

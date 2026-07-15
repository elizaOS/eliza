/**
 * Real Node HTTP coverage for the registered widget routes over a PGlite-backed
 * AgentRuntime. It creates durable tasks through the production service, then
 * verifies both JSON and SSE bytes through the plugin route adapter.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import { codingAgentRoutePlugin } from "../setup-routes.js";
import { createRealTestRuntime } from "./real-runtime.js";

describe("orchestrator widget registered HTTP surface", () => {
  let server: Server | undefined;
  let baseUrl: string;
  let service: OrchestratorTaskService;
  let runtime: AgentRuntime;
  let cleanupRuntime: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ runtime, cleanup: cleanupRuntime } = await createRealTestRuntime({
      characterName: "OrchestratorWidgetRouteTest",
      plugins: [
        {
          name: "orchestrator-widget-route-test",
          description: "Registers the production orchestrator task service",
          services: [OrchestratorTaskService],
        },
      ],
    }));
    const loadedService = await runtime.getServiceLoadPromise(
      OrchestratorTaskService.serviceType,
    );
    if (!(loadedService instanceof OrchestratorTaskService)) {
      throw new Error("Production orchestrator task service did not start");
    }
    service = loadedService;

    const parent = await service.createTask({
      title: "Render live orchestration",
      goal: "Show production task state in the chat rail",
      acceptanceCriteria: ["The task is visible through the widget route"],
    });
    await service.createTask({
      title: "Stream child progress",
      goal: "Emit a child task over SSE",
      parentTaskId: parent.id,
      acceptanceCriteria: ["The child is linked to its parent"],
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    await service.updateTask(parent.id, {
      summary: "Production service state reached the app consumer",
    });

    const widgetRoute = codingAgentRoutePlugin.routes?.find(
      (route) => route.path === "/api/orchestrator/widgets",
    );
    const streamRoute = codingAgentRoutePlugin.routes?.find(
      (route) => route.path === "/api/orchestrator/widgets/stream",
    );
    if (!widgetRoute?.handler || !streamRoute?.handler) {
      throw new Error("Registered orchestrator widget routes are missing");
    }

    server = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      const route = pathname.endsWith("/stream") ? streamRoute : widgetRoute;
      void route.handler(request as never, response as never, runtime);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await cleanupRuntime?.();
  });

  it("returns bounded tasks with complete lineage from the durable store", async () => {
    const response = await fetch(`${baseUrl}/api/orchestrator/widgets?limit=1`);
    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as {
      totalTaskCount: number;
      tasks: Array<{
        label: string;
        progressSummary: string;
        childTaskIds: string[];
      }>;
    };

    expect(snapshot.totalTaskCount).toBe(2);
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({
      label: "Render live orchestration",
      progressSummary: "Production service state reached the app consumer",
    });
    expect(snapshot.tasks[0]?.childTaskIds).toHaveLength(1);
  });

  it("streams the production snapshot as named SSE bytes", async () => {
    const controller = new AbortController();
    const response = await fetch(
      `${baseUrl}/api/orchestrator/widgets/stream?limit=1`,
      { signal: controller.signal },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body?.getReader();
    if (!reader) throw new Error("SSE response body is unavailable");
    const frame = await reader.read();
    const text = new TextDecoder().decode(frame.value);
    expect(text).toContain("event: snapshot");
    expect(text).toContain("Render live orchestration");
    expect(text).toContain("Production service state reached the app consumer");
    controller.abort();
  });
});

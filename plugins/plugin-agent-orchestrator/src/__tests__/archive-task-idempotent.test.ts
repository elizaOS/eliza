/**
 * Archiving a task that is already archived, over the registered archive route
 * and a PGlite-backed AgentRuntime. A retried POST or a second click must
 * return the archived task, not a 500 from the transition table.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRuntime, ServiceClass } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import {
  nextTaskStatus,
  type OrchestratorTaskStatus,
  TASK_STATUS_TRANSITIONS,
} from "../services/orchestrator-task-types.js";
import { codingAgentRoutePlugin } from "../setup-routes.js";
import { createRealTestRuntime } from "./real-runtime.js";

describe("archiving an archived task", () => {
  let server: Server | undefined;
  let baseUrl: string;
  let service: OrchestratorTaskService;
  let runtime: AgentRuntime;
  let cleanupRuntime: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ runtime, cleanup: cleanupRuntime } = await createRealTestRuntime({
      characterName: "OrchestratorArchiveTest",
      plugins: [
        {
          name: "orchestrator-archive-test",
          description: "Registers the production orchestrator task service",
          services: [OrchestratorTaskService as unknown as ServiceClass],
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

    const archiveHandler = codingAgentRoutePlugin.routes?.find(
      (route) => route.path === "/api/orchestrator/tasks/:taskId/archive",
    )?.handler;
    if (!archiveHandler) {
      throw new Error("Registered orchestrator archive route is missing");
    }
    const httpServer = createServer((request, response) => {
      void archiveHandler(request as never, response as never, runtime);
    });
    server = httpServer;
    await new Promise<void>((resolve) =>
      httpServer.listen(0, "127.0.0.1", resolve),
    );
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await cleanupRuntime?.();
  });

  it("resolves the archived trigger from every status", () => {
    for (const from of Object.keys(
      TASK_STATUS_TRANSITIONS,
    ) as OrchestratorTaskStatus[]) {
      expect(nextTaskStatus(from, "archived"), from).toBe("archived");
    }
  });

  it("returns the archived task when the archive request is repeated", async () => {
    const task = await service.createTask({
      title: "Shelve the parser rewrite",
      goal: "Archive this task twice",
      acceptanceCriteria: [],
    });
    const archive = () =>
      fetch(`${baseUrl}/api/orchestrator/tasks/${task.id}/archive`, {
        method: "POST",
      });

    const first = await archive();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: "archived" });

    const second = await archive();
    const body = (await second.json()) as { status?: string; error?: string };
    expect(body.error).toBeUndefined();
    expect(second.status).toBe(200);
    expect(body.status).toBe("archived");
    expect((await service.getTask(task.id))?.status).toBe("archived");
  });
});

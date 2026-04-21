import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompatRuntimeState } from "../../src/api/compat-route-shared";

const {
  toWorkbenchTaskMock,
  listTriggerTasksMock,
  taskToTriggerSummaryMock,
  handleN8nRoutesMock,
  getGoogleConnectorStatusMock,
  getTelegramConnectorStatusMock,
  getSignalConnectorStatusMock,
  getDiscordConnectorStatusMock,
} = vi.hoisted(() => ({
  toWorkbenchTaskMock: vi.fn(),
  listTriggerTasksMock: vi.fn(),
  taskToTriggerSummaryMock: vi.fn(),
  handleN8nRoutesMock: vi.fn(),
  getGoogleConnectorStatusMock: vi.fn(),
  getTelegramConnectorStatusMock: vi.fn(),
  getSignalConnectorStatusMock: vi.fn(),
  getDiscordConnectorStatusMock: vi.fn(),
}));

vi.mock("@elizaos/agent/config/config", () => ({
  loadElizaConfig: () => ({
    ui: { assistant: { name: "Milady" } },
    agents: { defaults: { adminEntityId: "admin-entity-id" } },
  }),
}));

vi.mock("@elizaos/agent/api/workbench-helpers", () => ({
  toWorkbenchTask: (...args: unknown[]) => toWorkbenchTaskMock(...args),
}));

vi.mock("@elizaos/agent/triggers/runtime", () => ({
  listTriggerTasks: (...args: unknown[]) => listTriggerTasksMock(...args),
  taskToTriggerSummary: (...args: unknown[]) =>
    taskToTriggerSummaryMock(...args),
}));

vi.mock("@elizaos/app-lifeops/lifeops/service", () => ({
  LifeOpsService: class {
    getGoogleConnectorStatus(
      ...args: Parameters<typeof getGoogleConnectorStatusMock>
    ) {
      return getGoogleConnectorStatusMock(...args);
    }

    getTelegramConnectorStatus(
      ...args: Parameters<typeof getTelegramConnectorStatusMock>
    ) {
      return getTelegramConnectorStatusMock(...args);
    }

    getSignalConnectorStatus(
      ...args: Parameters<typeof getSignalConnectorStatusMock>
    ) {
      return getSignalConnectorStatusMock(...args);
    }

    getDiscordConnectorStatus(
      ...args: Parameters<typeof getDiscordConnectorStatusMock>
    ) {
      return getDiscordConnectorStatusMock(...args);
    }
  },
}));

vi.mock("../../src/api/n8n-routes", () => ({
  handleN8nRoutes: (...args: unknown[]) => handleN8nRoutesMock(...args),
}));

import { handleAutomationsCompatRoutes } from "../../src/api/automations-compat-routes";

interface Harness {
  baseUrl: string;
  dispose: () => Promise<void>;
}

async function startApiHarness(state: CompatRuntimeState): Promise<Harness> {
  const server = http.createServer(async (req, res) => {
    try {
      const handled = await handleAutomationsCompatRoutes(req, res, state);
      if (!handled && !res.headersSent) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "not-found" }));
      }
    } catch (error) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(String(error));
      }
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    dispose: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function buildRuntimeStub() {
  return {
    character: { name: "Milady" },
    actions: [
      { name: "CODE_TASK", description: "Run a coding agent task." },
      { name: "SEND_MESSAGE", description: "Send a message." },
    ],
    providers: [
      {
        name: "recent-conversations",
        description: "Browse recent conversation context.",
      },
    ],
    getSetting: vi.fn((key: string) =>
      key === "GITHUB_TOKEN" ? "ghp_test_token" : undefined,
    ),
    getTasks: vi.fn(async () => [
      {
        id: "task-1",
        name: "Inbox triage",
        description: "Clear my inbox and create follow-ups.",
        tags: [],
        isCompleted: false,
        updatedAt: Date.parse("2026-04-17T10:00:00Z"),
      },
    ]),
    getRooms: vi.fn(async () => [
      {
        id: "room-task-1",
        name: "Inbox triage",
        updatedAt: "2026-04-17T12:00:00Z",
        metadata: {
          webConversation: {
            conversationId: "conv-task-1",
            scope: "automation-coordinator",
            automationType: "coordinator_text",
            taskId: "task-1",
            terminalBridgeConversationId: "terminal-1",
          },
        },
      },
      {
        id: "room-trigger-1",
        name: "Morning summary",
        updatedAt: "2026-04-17T13:00:00Z",
        metadata: {
          webConversation: {
            conversationId: "conv-trigger-1",
            scope: "automation-coordinator",
            automationType: "coordinator_text",
            triggerId: "trigger-1",
            terminalBridgeConversationId: "terminal-1",
          },
        },
      },
      {
        id: "room-draft-1",
        name: "Draft workflow",
        updatedAt: "2026-04-17T14:00:00Z",
        metadata: {
          webConversation: {
            conversationId: "conv-draft-1",
            scope: "automation-workflow-draft",
            automationType: "n8n_workflow",
            draftId: "draft-1",
            terminalBridgeConversationId: "terminal-1",
          },
        },
      },
      {
        id: "room-wf-1",
        name: "Daily report workflow",
        updatedAt: "2026-04-17T15:00:00Z",
        metadata: {
          webConversation: {
            conversationId: "conv-wf-1",
            scope: "automation-workflow",
            automationType: "n8n_workflow",
            workflowId: "wf-1",
            workflowName: "Daily report workflow",
            terminalBridgeConversationId: "terminal-1",
          },
        },
      },
    ]),
  };
}

function buildRuntimeWithDuplicateSystemTasks() {
  return {
    ...buildRuntimeStub(),
    getTasks: vi.fn(async () => [
      {
        id: "task-user-1",
        name: "Inbox triage",
        description: "Clear my inbox and create follow-ups.",
        tags: [],
        isCompleted: false,
        updatedAt: Date.parse("2026-04-17T10:00:00Z"),
      },
      {
        id: "task-system-1",
        name: "EMBEDDING_DRAIN",
        description: "",
        tags: ["queue", "repeat"],
        isCompleted: false,
        updatedAt: Date.parse("2026-04-17T08:00:00Z"),
      },
      {
        id: "task-system-2",
        name: "EMBEDDING_DRAIN",
        description: "Embedding generation drain",
        tags: ["queue", "repeat"],
        isCompleted: false,
        updatedAt: Date.parse("2026-04-17T09:00:00Z"),
      },
    ]),
  };
}

describe("automations compat routes", () => {
  let harness: Harness;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ELIZA_API_TOKEN;

    toWorkbenchTaskMock.mockImplementation((task) => task);
    listTriggerTasksMock.mockResolvedValue([
      {
        id: "trigger-1",
        taskId: "task-trigger-1",
        displayName: "Morning summary",
        instructions: "Summarize the morning queue.",
        triggerType: "interval",
        intervalMs: 3_600_000,
        wakeMode: "inject_now",
        enabled: true,
        createdBy: "user",
        runCount: 0,
        kind: "text",
        updatedAt: Date.parse("2026-04-17T11:00:00Z"),
      },
      {
        id: "trigger-workflow-1",
        taskId: "task-trigger-workflow-1",
        displayName: "Daily workflow run",
        instructions: "Run workflow wf-1",
        triggerType: "cron",
        cronExpression: "0 9 * * *",
        wakeMode: "inject_now",
        enabled: true,
        createdBy: "user",
        runCount: 0,
        kind: "workflow",
        workflowId: "wf-1",
        workflowName: "Daily report workflow",
        updatedAt: Date.parse("2026-04-17T09:00:00Z"),
      },
    ]);
    taskToTriggerSummaryMock.mockImplementation((task) => task);

    handleN8nRoutesMock.mockImplementation(
      async ({
        pathname,
        json,
        res,
      }: {
        pathname: string;
        json: (
          res: http.ServerResponse,
          body: unknown,
          status?: number,
        ) => void;
        res: http.ServerResponse;
      }) => {
        if (pathname === "/api/n8n/status") {
          json(
            res,
            {
              mode: "local",
              host: "http://127.0.0.1:5678",
              status: "ready",
              cloudConnected: false,
              localEnabled: true,
              platform: "desktop",
              cloudHealth: "unknown",
            },
            200,
          );
          return true;
        }

        if (pathname === "/api/n8n/workflows") {
          json(
            res,
            {
              workflows: [
                {
                  id: "wf-1",
                  name: "Daily report workflow",
                  active: true,
                  description: "Posts a daily report.",
                  nodeCount: 2,
                  nodes: [
                    { id: "node-1", name: "Code task", type: "agent.codeTask" },
                    { id: "node-2", name: "Gmail", type: "lifeops.gmail" },
                  ],
                },
              ],
            },
            200,
          );
          return true;
        }

        return false;
      },
    );

    getGoogleConnectorStatusMock.mockResolvedValue({
      connected: true,
      grantedCapabilities: ["gmail.read", "calendar.events"],
    });
    getTelegramConnectorStatusMock.mockResolvedValue({ connected: false });
    getSignalConnectorStatusMock.mockResolvedValue({ connected: true });
    getDiscordConnectorStatusMock.mockResolvedValue({
      connected: false,
      available: false,
    });
  });

  afterEach(async () => {
    await harness?.dispose?.();
  });

  it("GET /api/automations returns canonical coordinator and workflow items", async () => {
    harness = await startApiHarness({
      current: buildRuntimeStub() as never,
      pendingAgentName: null,
      pendingRestartReasons: [],
    });

    const response = await fetch(`${harness.baseUrl}/api/automations`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      automations: Array<{
        id: string;
        room?: { conversationId: string | null };
        schedules: unknown[];
        isDraft: boolean;
        workflowId?: string;
        source: string;
      }>;
      summary: {
        total: number;
        coordinatorCount: number;
        workflowCount: number;
        scheduledCount: number;
        draftCount: number;
      };
      n8nStatus: { mode: string; status: string };
      workflowFetchError: string | null;
    };

    expect(body.summary).toEqual({
      total: 4,
      coordinatorCount: 2,
      workflowCount: 2,
      scheduledCount: 2,
      draftCount: 1,
    });
    expect(body.n8nStatus).toMatchObject({ mode: "local", status: "ready" });
    expect(body.workflowFetchError).toBeNull();

    const taskItem = body.automations.find((item) => item.id === "task:task-1");
    const triggerItem = body.automations.find(
      (item) => item.id === "trigger:trigger-1",
    );
    const draftItem = body.automations.find(
      (item) => item.id === "workflow-draft:draft-1",
    );
    const workflowItem = body.automations.find(
      (item) => item.id === "workflow:wf-1",
    );

    expect(taskItem?.room?.conversationId).toBe("conv-task-1");
    expect(triggerItem?.room?.conversationId).toBe("conv-trigger-1");
    expect(draftItem?.isDraft).toBe(true);
    expect(workflowItem).toMatchObject({
      workflowId: "wf-1",
      source: "n8n_workflow",
      room: { conversationId: "conv-wf-1" },
    });
    expect(workflowItem?.schedules).toHaveLength(1);
  });

  it("deduplicates repeated system tasks so the sidebar is not flooded", async () => {
    harness = await startApiHarness({
      current: buildRuntimeWithDuplicateSystemTasks() as never,
      pendingAgentName: null,
      pendingRestartReasons: [],
    });

    const response = await fetch(`${harness.baseUrl}/api/automations`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      automations: Array<{ id: string; title: string; system: boolean }>;
      summary: { total: number; coordinatorCount: number };
    };

    const embeddingDrainItems = body.automations.filter(
      (item) => item.title === "EMBEDDING_DRAIN" && item.system,
    );

    expect(embeddingDrainItems).toHaveLength(1);
    expect(body.summary.total).toBe(5);
    expect(body.summary.coordinatorCount).toBe(3);
  });

  it("does not surface trigger-backed runtime tasks as separate coordinator items", async () => {
    harness = await startApiHarness({
      current: buildRuntimeStub() as never,
      pendingAgentName: null,
      pendingRestartReasons: [],
    });

    const response = await fetch(`${harness.baseUrl}/api/automations`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      automations: Array<{ id: string; taskId?: string }>;
    };

    expect(body.automations).not.toContainEqual(
      expect.objectContaining({
        id: "task:task-trigger-1",
      }),
    );
    expect(body.automations).not.toContainEqual(
      expect.objectContaining({
        id: "task:task-trigger-workflow-1",
      }),
    );
  });

  it("GET /api/automations/nodes returns enabled and disabled runtime and LifeOps nodes", async () => {
    harness = await startApiHarness({
      current: buildRuntimeStub() as never,
      pendingAgentName: null,
      pendingRestartReasons: [],
    });

    const response = await fetch(`${harness.baseUrl}/api/automations/nodes`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      nodes: Array<{
        id: string;
        class: string;
        source: string;
        availability: string;
        ownerScoped: boolean;
        disabledReason?: string;
      }>;
      summary: {
        total: number;
        enabled: number;
        disabled: number;
      };
    };

    expect(body.summary.total).toBe(body.nodes.length);
    expect(body.summary.enabled).toBeGreaterThan(0);
    expect(body.summary.disabled).toBeGreaterThan(0);

    expect(body.nodes).toContainEqual(
      expect.objectContaining({
        id: "action:CODE_TASK",
        class: "agent",
        source: "runtime_action",
        availability: "enabled",
      }),
    );
    expect(body.nodes).not.toContainEqual(
      expect.objectContaining({
        id: "provider:recent-conversations",
      }),
    );
    expect(body.nodes).not.toContainEqual(
      expect.objectContaining({
        id: "provider:relevant-conversations",
      }),
    );
    expect(body.nodes).toContainEqual(
      expect.objectContaining({
        id: "lifeops:gmail",
        class: "integration",
        source: "lifeops",
        ownerScoped: true,
        availability: "enabled",
      }),
    );
    expect(body.nodes).toContainEqual(
      expect.objectContaining({
        id: "lifeops:telegram",
        class: "integration",
        source: "lifeops",
        ownerScoped: true,
        availability: "disabled",
        disabledReason: "Connect the owner Telegram account.",
      }),
    );
  });
});

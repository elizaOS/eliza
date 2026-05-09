import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompatRuntimeState } from "../../src/api/compat-route-shared";

type AutomationsCompatRoutesModule =
  typeof import("../../src/api/automations-compat-routes");

const toWorkbenchTaskMock = vi.fn();
const listTriggerTasksMock = vi.fn();
const taskToTriggerSummaryMock = vi.fn();
const handleWorkflowRoutesMock = vi.fn();
const ensureRouteAuthorizedMock = vi.fn();

vi.doMock("@elizaos/agent/config/config", () => ({
  loadElizaConfig: () => ({
    ui: { assistant: { name: "Eliza" } },
    agents: { defaults: { adminEntityId: "admin-entity-id" } },
  }),
}));

vi.doMock("@elizaos/agent/api/workbench-helpers", () => ({
  WORKBENCH_TASK_TAG: "workbench-task",
  WORKBENCH_TODO_TAG: "workbench-todo",
  toWorkbenchTask: (...args: unknown[]) => toWorkbenchTaskMock(...args),
}));

vi.doMock("@elizaos/agent/triggers/runtime", () => ({
  listTriggerTasks: (...args: unknown[]) => listTriggerTasksMock(...args),
  taskToTriggerSummary: (...args: unknown[]) =>
    taskToTriggerSummaryMock(...args),
}));

vi.doMock("@elizaos/plugin-workflow/routes/n8n-routes", () => ({
  handleWorkflowRoutes: (...args: unknown[]) => handleWorkflowRoutesMock(...args),
}));

vi.doMock("../../src/api/auth", () => ({
  ensureRouteAuthorized: (...args: unknown[]) =>
    ensureRouteAuthorizedMock(...args),
}));

import {
  clearAutomationNodeContributorsForTests,
  registerAutomationNodeContributor,
} from "../../src/api/automation-node-contributors";

interface Harness {
  baseUrl: string;
  dispose: () => Promise<void>;
}

let automationsCompatRoutesImport:
  | Promise<AutomationsCompatRoutesModule>
  | undefined;

function importAutomationsCompatRoutes(): Promise<AutomationsCompatRoutesModule> {
  automationsCompatRoutesImport ??= import(
    "../../src/api/automations-compat-routes"
  );
  return automationsCompatRoutesImport;
}

async function startApiHarness(state: CompatRuntimeState): Promise<Harness> {
  const { handleAutomationsCompatRoutes } =
    await importAutomationsCompatRoutes();
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
        res.end("internal-error");
      }
      void error;
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
    character: { name: "Eliza" },
    actions: [
      { name: "CODE_TASK", description: "Run a coding agent task." },
      { name: "MESSAGE", description: "Send, read, search, or manage messages." },
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

function buildRuntimeWithCryptoAutomationCapabilities() {
  const runtime = buildRuntimeStub();
  return {
    ...runtime,
    actions: [
      ...runtime.actions,
      {
        name: "HYPERLIQUID_ACTION",
        description: "Manage Hyperliquid automation intents.",
      },
    ],
    plugins: [{ name: "evm" }, { name: "chain_solana" }],
  };
}

describe("automations compat routes", () => {
  let harness: Harness;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ELIZA_API_TOKEN;
    delete process.env.EVM_PRIVATE_KEY;
    delete process.env.SOLANA_PRIVATE_KEY;
    delete process.env.POLYMARKET_PRIVATE_KEY;

    toWorkbenchTaskMock.mockImplementation((task) => task);
    ensureRouteAuthorizedMock.mockResolvedValue(true);
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

    handleWorkflowRoutesMock.mockImplementation(
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
        if (pathname === "/api/workflow/status") {
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

        if (pathname === "/api/workflow/workflows") {
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

    registerAutomationNodeContributor("test-lifeops", () => [
      {
        id: "lifeops:gmail",
        label: "Gmail",
        description:
          "Owner-scoped Gmail triage, drafting, and send operations.",
        class: "integration",
        source: "lifeops",
        backingCapability: "lifeops:gmail",
        ownerScoped: true,
        requiresSetup: true,
        availability: "enabled",
      },
      {
        id: "lifeops:telegram",
        label: "Telegram",
        description: "Owner-scoped Telegram account messaging.",
        class: "integration",
        source: "lifeops",
        backingCapability: "lifeops:telegram",
        ownerScoped: true,
        requiresSetup: true,
        availability: "disabled",
        disabledReason: "Connect the owner Telegram account.",
      },
    ]);
  });

  afterEach(async () => {
    delete process.env.EVM_PRIVATE_KEY;
    delete process.env.SOLANA_PRIVATE_KEY;
    delete process.env.POLYMARKET_PRIVATE_KEY;
    clearAutomationNodeContributorsForTests();
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
    expect(body.nodes).toContainEqual(
      expect.objectContaining({
        id: "crypto:evm.swap",
        class: "action",
        source: "static_catalog",
        ownerScoped: true,
        availability: "disabled",
        disabledReason: "Load the EVM plugin with swap support.",
      }),
    );
    expect(body.nodes).toContainEqual(
      expect.objectContaining({
        id: "crypto:evm.bridge",
        class: "action",
        source: "static_catalog",
        ownerScoped: true,
        availability: "disabled",
        disabledReason: "Load the EVM plugin with bridge support.",
      }),
    );
    expect(body.nodes).toContainEqual(
      expect.objectContaining({
        id: "crypto:solana.swap",
        class: "action",
        source: "static_catalog",
        ownerScoped: true,
        availability: "disabled",
        disabledReason: "Load the Solana plugin with swap support.",
      }),
    );
    expect(body.nodes).toContainEqual(
      expect.objectContaining({
        id: "crypto:hyperliquid.action",
        class: "action",
        source: "static_catalog",
        ownerScoped: true,
        availability: "disabled",
        disabledReason: "Load the Hyperliquid runtime plugin.",
      }),
    );
    expect(body.nodes).toContainEqual(
      expect.objectContaining({
        id: "trigger:order.schedule",
        class: "trigger",
        source: "static_catalog",
        ownerScoped: false,
        availability: "enabled",
      }),
    );
    expect(body.nodes).toContainEqual(
      expect.objectContaining({
        id: "trigger:order.event",
        class: "trigger",
        source: "static_catalog",
        ownerScoped: false,
        availability: "disabled",
        disabledReason: "Load an order-event-capable runtime plugin.",
      }),
    );
  });

  it("enables crypto automation descriptors only when matching capabilities are loaded", async () => {
    harness = await startApiHarness({
      current: buildRuntimeWithCryptoAutomationCapabilities() as never,
      pendingAgentName: null,
      pendingRestartReasons: [],
    });

    const response = await fetch(`${harness.baseUrl}/api/automations/nodes`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      nodes: Array<{ id: string; availability: string }>;
    };

    for (const id of [
      "crypto:evm.swap",
      "crypto:evm.bridge",
      "crypto:solana.swap",
      "crypto:hyperliquid.action",
      "trigger:order.event",
    ]) {
      expect(body.nodes).toContainEqual(
        expect.objectContaining({ id, availability: "enabled" }),
      );
    }
  });

  it("does not leak crypto secrets in the automation node catalog", async () => {
    process.env.EVM_PRIVATE_KEY = `0x${"11".repeat(32)}`;
    process.env.SOLANA_PRIVATE_KEY = "solana-secret-test-key";
    process.env.POLYMARKET_PRIVATE_KEY = "polymarket-secret-test-key";

    harness = await startApiHarness({
      current: buildRuntimeStub() as never,
      pendingAgentName: null,
      pendingRestartReasons: [],
    });

    const response = await fetch(`${harness.baseUrl}/api/automations/nodes`);
    expect(response.status).toBe(200);
    const payload = await response.text();

    expect(payload).not.toContain(process.env.EVM_PRIVATE_KEY);
    expect(payload).not.toContain(process.env.SOLANA_PRIVATE_KEY);
    expect(payload).not.toContain(process.env.POLYMARKET_PRIVATE_KEY);
    expect(payload).not.toContain("ghp_test_token");
  });
});

// @eliza-live-audit allow-route-fixtures
import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

type TriggerSummary = {
  id: string;
  taskId: string;
  displayName: string;
  instructions: string;
  triggerType: "interval" | "once" | "cron" | "event";
  enabled: boolean;
  wakeMode: "inject_now" | "next_autonomy_cycle";
  createdBy: string;
  eventKind?: string;
  intervalMs?: number;
  runCount: number;
  nextRunAtMs?: number;
  updatedAt?: number;
  kind?: "text" | "workflow";
  workflowId?: string;
  workflowName?: string;
};

type WorkflowNode = {
  id: string;
  name: string;
  type: string;
  typeVersion?: number;
  position?: [number, number];
  parameters?: Record<string, unknown>;
  notes?: string;
  notesInFlow?: boolean;
};

type Workflow = {
  id: string;
  name: string;
  active: boolean;
  nodeCount?: number;
  nodes?: WorkflowNode[];
  connections?: Record<
    string,
    { main?: Array<Array<{ node: string; type: "main"; index: number }>> }
  >;
};

type AutomationItem = {
  id: string;
  type: "coordinator_text" | "n8n_workflow" | "automation_draft";
  source: "trigger" | "workflow" | "workflow_shadow";
  title: string;
  description: string;
  status: "active" | "paused" | "draft";
  enabled: boolean;
  system: boolean;
  isDraft: boolean;
  hasBackingWorkflow: boolean;
  updatedAt: string | null;
  triggerId?: string;
  workflowId?: string;
  draftId?: string;
  trigger?: TriggerSummary;
  workflow?: Workflow;
  schedules: TriggerSummary[];
  room?: {
    conversationId: string | null;
    roomId: string;
    scope: string;
    sourceConversationId?: string;
    terminalBridgeConversationId?: string;
  };
};

type Conversation = {
  id: string;
  title: string;
  roomId: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type AutomationsMockApi = {
  getCreatedTrigger: () => Record<string, unknown> | null;
  getCreatedWorkflow: () => Record<string, unknown> | null;
  getGeneratedWorkflow: () => Record<string, unknown> | null;
  getDeletedConversationIds: () => string[];
};

const NOW_ISO = "2026-04-23T20:00:00.000Z";
const HOUR_MS = 60 * 60 * 1000;

function workflowFixture(id: string, name: string, active = true): Workflow {
  return {
    id,
    name,
    active,
    nodeCount: 3,
    nodes: [
      {
        id: `${id}-trigger`,
        name: "Message event",
        type: "n8n-nodes-base.webhook",
        typeVersion: 1,
        position: [0, 0],
        parameters: { path: "message.received" },
        notes: "Receives a normalized message event.",
        notesInFlow: true,
      },
      {
        id: `${id}-summarize`,
        name: "Summarize",
        type: "@elizaos/n8n-nodes-agent.agent",
        typeVersion: 1,
        position: [320, 0],
        parameters: { prompt: "Summarize the message." },
        notes: "Turns the event payload into a short summary.",
        notesInFlow: true,
      },
      {
        id: `${id}-send`,
        name: "Send digest",
        type: "n8n-nodes-base.discord",
        typeVersion: 1,
        position: [640, 0],
        parameters: { channel: "inbox" },
        notes: "Posts the summary to the destination channel.",
        notesInFlow: true,
      },
    ],
    connections: {
      "Message event": {
        main: [[{ node: "Summarize", type: "main", index: 0 }]],
      },
      Summarize: {
        main: [[{ node: "Send digest", type: "main", index: 0 }]],
      },
    },
  };
}

function eventTaskItem(): AutomationItem {
  const trigger: TriggerSummary = {
    id: "trigger-event-message",
    taskId: "task-event-message",
    displayName: "Message triage",
    instructions: "Summarize each inbound message.",
    triggerType: "event",
    eventKind: "message.received",
    enabled: true,
    wakeMode: "inject_now",
    createdBy: "playwright",
    runCount: 0,
    updatedAt: Date.parse(NOW_ISO),
    kind: "text",
  };
  return {
    id: "trigger:trigger-event-message",
    type: "coordinator_text",
    source: "trigger",
    title: "Message triage",
    description: "Summarize each inbound message.",
    status: "active",
    enabled: true,
    system: false,
    isDraft: false,
    hasBackingWorkflow: false,
    updatedAt: NOW_ISO,
    triggerId: trigger.id,
    trigger,
    schedules: [trigger],
  };
}

function workflowItem(workflow: Workflow): AutomationItem {
  const schedule: TriggerSummary = {
    id: `trigger-${workflow.id}`,
    taskId: `task-${workflow.id}`,
    displayName: `Run ${workflow.name}`,
    instructions: `Run workflow ${workflow.name}`,
    triggerType: "interval",
    intervalMs: HOUR_MS,
    enabled: true,
    wakeMode: "inject_now",
    createdBy: "playwright",
    runCount: 1,
    nextRunAtMs: Date.parse(NOW_ISO) + HOUR_MS,
    updatedAt: Date.parse(NOW_ISO),
    kind: "workflow",
    workflowId: workflow.id,
    workflowName: workflow.name,
  };
  return {
    id: `workflow:${workflow.id}`,
    type: "n8n_workflow",
    source: "workflow",
    title: workflow.name,
    description: "",
    status: workflow.active ? "active" : "paused",
    enabled: workflow.active,
    system: false,
    isDraft: false,
    hasBackingWorkflow: true,
    updatedAt: NOW_ISO,
    workflowId: workflow.id,
    workflow,
    schedules: [schedule],
    room: {
      conversationId: `conversation-${workflow.id}`,
      roomId: `room-${workflow.id}`,
      scope: "automation-workflow",
    },
  };
}

function draftWorkflowItem(
  draftId = "draft-existing",
  conversationId = "conversation-draft-existing",
): AutomationItem {
  return {
    id: `workflow-draft:${draftId}`,
    type: "n8n_workflow",
    source: "workflow_shadow",
    title: "Draft",
    description: "",
    status: "draft",
    enabled: false,
    system: false,
    isDraft: true,
    hasBackingWorkflow: false,
    updatedAt: NOW_ISO,
    workflowId: draftId,
    draftId,
    schedules: [],
    room: {
      conversationId,
      roomId: `room-${draftId}`,
      scope: "automation-workflow-draft",
    },
  };
}

function automationSummary(automations: AutomationItem[]) {
  return {
    total: automations.length,
    coordinatorCount: automations.filter((item) => item.type !== "n8n_workflow")
      .length,
    workflowCount: automations.filter((item) => item.type === "n8n_workflow")
      .length,
    scheduledCount: automations.reduce(
      (count, item) => count + item.schedules.length,
      0,
    ),
    draftCount: automations.filter((item) => item.isDraft).length,
  };
}

async function installAutomationsApi(
  page: Page,
  initialAutomations: AutomationItem[],
): Promise<AutomationsMockApi> {
  let automations = [...initialAutomations];
  const workflows = new Map<string, Workflow>();
  const conversations = new Map<string, Conversation>();
  let createdTrigger: Record<string, unknown> | null = null;
  let createdWorkflow: Record<string, unknown> | null = null;
  let generatedWorkflow: Record<string, unknown> | null = null;
  const deletedConversationIds: string[] = [];

  for (const item of automations) {
    if (item.workflowId && item.workflow) {
      workflows.set(item.workflowId, item.workflow);
    }
    if (item.room?.conversationId) {
      conversations.set(item.room.conversationId, {
        id: item.room.conversationId,
        title: item.title,
        roomId: item.room.roomId,
        metadata: {
          scope: item.room.scope,
          workflowId: item.hasBackingWorkflow ? item.workflowId : undefined,
          draftId: item.draftId,
        },
        createdAt: item.updatedAt ?? NOW_ISO,
        updatedAt: item.updatedAt ?? NOW_ISO,
      });
    }
  }

  const fulfillJson = async (
    route: Parameters<Page["route"]>[1] extends (route: infer R) => unknown
      ? R
      : never,
    body: unknown,
    status = 200,
  ) => {
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  };

  await page.route("**/api/automations", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, {
      automations,
      summary: automationSummary(automations),
      n8nStatus: {
        mode: "local",
        host: "http://127.0.0.1:5678",
        status: "ready",
        cloudConnected: false,
        localEnabled: true,
        platform: "desktop",
        cloudHealth: "unknown",
      },
      workflowFetchError: null,
    });
  });

  await page.route("**/api/automations/nodes", async (route) => {
    await fulfillJson(route, {
      nodes: [
        {
          id: "lifeops:message",
          label: "Message Event",
          description: "Normalized message input",
          class: "trigger",
          source: "lifeops_event",
          backingCapability: "message.received",
          ownerScoped: true,
          requiresSetup: false,
          availability: "enabled",
        },
      ],
      summary: { total: 1, enabled: 1, disabled: 0 },
    });
  });

  await page.route("**/api/triggers**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/triggers") {
      await fulfillJson(route, {
        triggers: automations
          .map((item) => item.trigger ?? item.schedules[0])
          .filter(Boolean),
      });
      return;
    }
    if (request.method() === "GET" && url.pathname.endsWith("/runs")) {
      await fulfillJson(route, { runs: [] });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/api/triggers/health") {
      await fulfillJson(route, {
        triggersEnabled: true,
        activeTriggers: 0,
        disabledTriggers: 0,
        totalExecutions: 0,
        totalFailures: 0,
        totalSkipped: 0,
      });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/triggers") {
      createdTrigger = request.postDataJSON() as Record<string, unknown>;
      const trigger: TriggerSummary = {
        id: "trigger-created-event",
        taskId: "task-created-event",
        displayName: String(createdTrigger.displayName ?? "Created task"),
        instructions: String(createdTrigger.instructions ?? ""),
        triggerType:
          createdTrigger.triggerType as TriggerSummary["triggerType"],
        eventKind:
          typeof createdTrigger.eventKind === "string"
            ? createdTrigger.eventKind
            : undefined,
        enabled: true,
        wakeMode: "inject_now",
        createdBy: "playwright",
        runCount: 0,
        updatedAt: Date.parse(NOW_ISO),
        kind: "text",
      };
      automations = [
        ...automations,
        {
          id: `trigger:${trigger.id}`,
          type: "coordinator_text",
          source: "trigger",
          title: trigger.displayName,
          description: trigger.instructions,
          status: "active",
          enabled: true,
          system: false,
          isDraft: false,
          hasBackingWorkflow: false,
          updatedAt: NOW_ISO,
          triggerId: trigger.id,
          trigger,
          schedules: [trigger],
        },
      ];
      await fulfillJson(route, trigger);
      return;
    }
    await fulfillJson(route, { ok: true });
  });

  await page.route("**/api/workflow/workflows**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (request.method() === "GET" && path === "/api/workflow/workflows") {
      await fulfillJson(route, {
        workflows: [...workflows.values()],
      });
      return;
    }

    if (request.method() === "POST" && path === "/api/workflow/workflows") {
      createdWorkflow = request.postDataJSON() as Record<string, unknown>;
      const copy = workflowFixture(
        "workflow-copy",
        String(createdWorkflow.name ?? "Workflow Copy"),
      );
      workflows.set(copy.id, copy);
      automations = [...automations, workflowItem(copy)];
      await fulfillJson(route, copy);
      return;
    }

    if (request.method() === "POST" && path === "/api/workflow/workflows/generate") {
      generatedWorkflow = request.postDataJSON() as Record<string, unknown>;
      const workflow = workflowFixture(
        "workflow-generated",
        "Generated workflow",
      );
      workflows.set(workflow.id, workflow);
      automations = [
        ...automations.filter((item) => !item.isDraft),
        workflowItem(workflow),
      ];
      await fulfillJson(route, workflow);
      return;
    }

    const workflowId = decodeURIComponent(path.split("/").pop() ?? "");
    const workflow = workflows.get(workflowId);
    if (!workflow) {
      await fulfillJson(route, { error: "not found" }, 404);
      return;
    }
    await fulfillJson(route, workflow);
  });

  await page.route("**/api/conversations**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (request.method() === "GET" && path === "/api/conversations") {
      await fulfillJson(route, { conversations: [...conversations.values()] });
      return;
    }

    if (request.method() === "POST" && path === "/api/conversations") {
      const body = request.postDataJSON() as {
        title?: string;
        metadata?: Record<string, unknown>;
      };
      const conversation: Conversation = {
        id: `conversation-${conversations.size + 1}`,
        title: body.title ?? "Automation",
        roomId: `room-${conversations.size + 1}`,
        metadata: body.metadata,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      };
      conversations.set(conversation.id, conversation);
      const draftId =
        typeof body.metadata?.draftId === "string"
          ? body.metadata.draftId
          : `draft-${conversations.size}`;
      automations = [
        ...automations,
        draftWorkflowItem(draftId, conversation.id),
      ];
      await fulfillJson(route, { conversation });
      return;
    }

    const conversationId = decodeURIComponent(path.split("/").pop() ?? "");
    if (request.method() === "PATCH") {
      const existing = conversations.get(conversationId);
      const body = request.postDataJSON() as Partial<Conversation>;
      const conversation: Conversation = {
        ...(existing ?? {
          id: conversationId,
          roomId: `room-${conversationId}`,
          createdAt: NOW_ISO,
        }),
        title: body.title ?? existing?.title ?? "Automation",
        metadata: body.metadata ?? existing?.metadata,
        updatedAt: NOW_ISO,
      };
      conversations.set(conversation.id, conversation);
      await fulfillJson(route, { conversation });
      return;
    }

    if (request.method() === "DELETE") {
      deletedConversationIds.push(conversationId);
      conversations.delete(conversationId);
      automations = automations.filter(
        (item) => item.room?.conversationId !== conversationId,
      );
      await fulfillJson(route, { ok: true });
      return;
    }

    await fulfillJson(route, { error: "not found" }, 404);
  });

  return {
    getCreatedTrigger: () => createdTrigger,
    getCreatedWorkflow: () => createdWorkflow,
    getGeneratedWorkflow: () => generatedWorkflow,
    getDeletedConversationIds: () => [...deletedConversationIds],
  };
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

test("automations overview empty state encourages creating tasks and workflows", async ({
  page,
}) => {
  await installAutomationsApi(page, []);

  await openAppPath(page, "/automations");

  await expect(page.getByTestId("automations-shell")).toBeVisible();
  await expect(
    page.getByPlaceholder("Describe a task or workflow…"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Daily inbox digest" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "GitHub issue triage" }),
  ).toBeVisible();
  await expect(page.getByLabel("Create task")).toBeVisible();
  await expect(page.getByLabel("Create workflow")).toBeVisible();
  await expect(page.getByTestId("automations-sidebar")).toContainText(
    "No tasks",
  );
  await expect(page.getByTestId("automations-sidebar")).toContainText(
    "No workflows",
  );
  await expect(page.getByText("Drafts in progress")).toHaveCount(0);
});

test("automations can create event tasks and inspect workflow data flow", async ({
  page,
}) => {
  const workflow = workflowFixture(
    "workflow-message-pipeline",
    "Message pipeline",
  );
  const api = await installAutomationsApi(page, [
    eventTaskItem(),
    draftWorkflowItem(),
    workflowItem(workflow),
  ]);

  await openAppPath(page, "/automations");

  const sidebar = page.getByTestId("automations-sidebar");
  await expect(sidebar.getByText("Tasks")).toBeVisible();
  await expect(sidebar.getByText("Workflows")).toBeVisible();
  await expect(
    sidebar.getByRole("button", { name: "Message triage" }),
  ).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "Draft" })).toBeVisible();
  await expect(
    sidebar.getByRole("button", { name: "Message pipeline" }),
  ).toBeVisible();
  await expect(page.getByText("Drafts in progress")).toBeVisible();

  await page.getByRole("button", { name: "Message pipeline" }).first().click();
  await expect(page.getByText("Workflow graph")).toBeVisible();
  await expect(page.getByText("Data flow")).toBeVisible();
  await expect(page.getByText("Input")).toBeVisible();
  await expect(page.getByText("Message event").first()).toBeVisible();
  await expect(page.getByText("Summarize").first()).toBeVisible();
  await expect(page.getByText("Send digest").first()).toBeVisible();
  await expect(page.getByText("Output")).toBeVisible();

  await page.getByLabel("Duplicate workflow").click();
  await expect
    .poll(() => api.getCreatedWorkflow())
    .toMatchObject({
      name: "Message pipeline Copy",
    });
  await expect(
    page.getByRole("heading", { name: "Message pipeline Copy" }),
  ).toBeVisible();

  await page.getByLabel("Create task").click();
  const editor = page.getByTestId("heartbeats-editor-panel");
  await editor.locator("input").first().fill("Escalate inbound messages");
  await editor
    .locator("textarea")
    .fill(
      "When a normalized message arrives, summarize it and flag urgent ones.",
    );
  await editor.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "Event" }).click();
  await expect(editor.getByText("Waiting for Message Received.")).toBeVisible();
  await page
    .locator("main")
    .getByRole("button", { name: "Create task" })
    .click();
  await expect
    .poll(() => api.getCreatedTrigger())
    .toMatchObject({
      displayName: "Escalate inbound messages",
      triggerType: "event",
      eventKind: "message.received",
      kind: "text",
    });
});

test("workflow drafts generate from a prompt and drafts can be deleted", async ({
  page,
}) => {
  const api = await installAutomationsApi(page, [draftWorkflowItem()]);
  page.on("dialog", (dialog) => void dialog.accept());

  await openAppPath(page, "/automations");

  await page.getByRole("button", { name: "Draft" }).first().click();
  await expect(page.getByText("Create workflow")).toBeVisible();
  await page.getByLabel("Delete draft").click();
  await expect
    .poll(() => api.getDeletedConversationIds())
    .toContain("conversation-draft-existing");

  await page.getByLabel("Create workflow").click();
  const workflowPrompt = page.locator("[data-workflow-prompt-input='true']");
  await expect(workflowPrompt).toBeVisible();
  await workflowPrompt.fill(
    "When a generic message event arrives, summarize it and send a digest.",
  );
  await page.getByRole("button", { name: "Generate" }).click();

  await expect
    .poll(() => api.getGeneratedWorkflow())
    .toMatchObject({
      prompt:
        "When a generic message event arrives, summarize it and send a digest.",
    });
  await expect(
    page.getByRole("heading", { name: "Generated workflow" }),
  ).toBeVisible();
  await expect(page.getByText("Data flow")).toBeVisible();
});

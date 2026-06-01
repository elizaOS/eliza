import { expect, type Page, type Route, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const NOW = "2026-01-01T00:00:00.000Z";

type JsonRecord = Record<string, unknown>;

function usage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    state: "unavailable",
    usageState: "unavailable",
    byProvider: [],
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function taskSummary(overrides: JsonRecord = {}) {
  return {
    id: "smoke-task-1",
    title: "Audit orchestrator surface",
    kind: "coding",
    status: "open",
    priority: "high",
    paused: false,
    originalRequest: "Audit orchestrator surface",
    summary: "Created by ui-smoke",
    sessionCount: 0,
    activeSessionCount: 0,
    latestSessionId: null,
    latestSessionLabel: null,
    latestWorkdir: null,
    latestRepo: null,
    latestActivityAt: null,
    decisionCount: 0,
    usage: usage(),
    createdAt: NOW,
    updatedAt: NOW,
    closedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

function taskDetail(overrides: JsonRecord = {}) {
  return {
    ...taskSummary(overrides),
    goal: "Verify controls, routing, and message flow",
    roomId: null,
    taskRoomId: null,
    worldId: null,
    ownerUserId: null,
    parentTaskId: null,
    acceptanceCriteria: ["Task appears in rail", "Message posts"],
    currentPlan: null,
    providerPolicy: null,
    lastUserTurnAt: null,
    lastCoordinatorTurnAt: null,
    metadata: {},
    sessions: [],
    decisions: [],
    events: [],
    artifacts: [],
    messages: [],
    transcripts: [],
  };
}

function statusFor(hasTask: boolean) {
  return {
    taskCount: hasTask ? 1 : 0,
    activeTaskCount: 0,
    pausedTaskCount: 0,
    blockedTaskCount: 0,
    validatingTaskCount: 0,
    sessionCount: 0,
    activeSessionCount: 0,
    usage: usage(),
    byStatus: {
      open: hasTask ? 1 : 0,
      active: 0,
      waiting_on_user: 0,
      blocked: 0,
      validating: 0,
      done: 0,
      failed: 0,
      archived: 0,
      interrupted: 0,
    },
  };
}

async function fulfillJson(
  route: Route,
  body: unknown,
  status = 200,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installOrchestratorWorkbenchRoutes(page: Page): Promise<{
  createBodies: JsonRecord[];
  messageBodies: JsonRecord[];
}> {
  let detail: JsonRecord | null = null;
  const messages: JsonRecord[] = [];
  const createBodies: JsonRecord[] = [];
  const messageBodies: JsonRecord[] = [];

  await page.route("**/api/orchestrator/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const pathname = url.pathname;

    if (method === "GET" && pathname === "/api/orchestrator/status") {
      await fulfillJson(route, statusFor(Boolean(detail)));
      return;
    }

    if (method === "GET" && pathname === "/api/orchestrator/tasks") {
      await fulfillJson(route, { tasks: detail ? [taskSummary(detail)] : [] });
      return;
    }

    if (method === "POST" && pathname === "/api/orchestrator/tasks") {
      const body = JSON.parse(request.postData() ?? "{}") as JsonRecord;
      createBodies.push(body);
      detail = taskDetail({
        title: body.title,
        goal: body.goal,
        priority: body.priority,
        acceptanceCriteria: body.acceptanceCriteria,
      });
      await fulfillJson(route, detail);
      return;
    }

    if (pathname === "/api/orchestrator/tasks/smoke-task-1") {
      await fulfillJson(route, detail ?? taskDetail());
      return;
    }

    if (
      method === "GET" &&
      pathname === "/api/orchestrator/tasks/smoke-task-1/messages"
    ) {
      await fulfillJson(route, { items: messages, nextCursor: null });
      return;
    }

    if (
      method === "POST" &&
      pathname === "/api/orchestrator/tasks/smoke-task-1/messages"
    ) {
      const body = JSON.parse(request.postData() ?? "{}") as JsonRecord;
      messageBodies.push(body);
      messages.push({
        id: "smoke-message-1",
        threadId: "smoke-task-1",
        sessionId: null,
        senderKind: "user",
        direction: "stdin",
        content: body.content,
        timestamp: Date.parse(NOW),
        metadata: {},
        createdAt: NOW,
      });
      await fulfillJson(route, { recorded: true, forwardedTo: [] });
      return;
    }

    if (
      method === "GET" &&
      pathname === "/api/orchestrator/tasks/smoke-task-1/events"
    ) {
      await fulfillJson(route, { items: [], nextCursor: null });
      return;
    }

    await fulfillJson(route, { error: `Unhandled ${method} ${pathname}` }, 404);
  });

  return { createBodies, messageBodies };
}

test.describe("orchestrator GUI workbench", () => {
  test("creates a task and sends a message through the visible controls", async ({
    page,
  }) => {
    await seedAppStorage(page);
    await installDefaultAppRoutes(page);
    const requests = await installOrchestratorWorkbenchRoutes(page);

    await openAppPath(page, "/orchestrator");

    await expect(page.getByTestId("orchestrator-workbench")).toBeVisible();
    await expect(page.getByTestId("orchestrator-pause-all")).toBeDisabled();
    await expect(page.getByTestId("orchestrator-resume-all")).toBeDisabled();
    await expect
      .poll(async () =>
        JSON.parse(
          (await page
            .locator("[data-view-state]")
            .first()
            .getAttribute("data-view-state")) ?? "{}",
        ),
      )
      .toMatchObject({ taskCount: 0, selectedId: null });

    await page.getByTestId("orchestrator-new-task").click();
    await expect(page.getByTestId("orchestrator-create-dialog")).toBeVisible();
    await expect(page.getByTestId("orchestrator-create-submit")).toBeDisabled();

    await page
      .getByTestId("orchestrator-create-title")
      .fill("Audit orchestrator surface");
    await page
      .getByTestId("orchestrator-create-goal")
      .fill("Verify controls, routing, and message flow");
    await page.getByTestId("orchestrator-create-priority").selectOption("high");
    await page
      .getByTestId("orchestrator-create-acceptance")
      .fill("Task appears in rail\nMessage posts");
    await expect(page.getByTestId("orchestrator-create-submit")).toBeEnabled();
    await page.getByTestId("orchestrator-create-submit").click();

    await expect
      .poll(() => requests.createBodies)
      .toEqual([
        {
          title: "Audit orchestrator surface",
          goal: "Verify controls, routing, and message flow",
          priority: "high",
          acceptanceCriteria: ["Task appears in rail", "Message posts"],
        },
      ]);
    await expect(page.getByTestId("orchestrator-task-item")).toContainText(
      "Audit orchestrator surface",
    );
    await expect(page.getByTestId("orchestrator-message-list")).toBeVisible();
    await expect(page.getByTestId("orchestrator-composer")).toBeVisible();

    await page
      .getByTestId("orchestrator-composer")
      .fill("Please verify the smoke task.");
    await expect(page.getByTestId("orchestrator-send")).toBeEnabled();
    await page.getByTestId("orchestrator-send").click();

    await expect
      .poll(() => requests.messageBodies)
      .toEqual([{ content: "Please verify the smoke task." }]);
    await expect(page.getByTestId("orchestrator-message-list")).toContainText(
      "Please verify the smoke task.",
    );
  });
});

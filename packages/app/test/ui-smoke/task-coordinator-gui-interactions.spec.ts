/**
 * Playwright UI-smoke spec for the Task Coordinator Gui Interactions app flow
 * using the real renderer fixture.
 */
import { expect, type Page, type Route, test } from "@playwright/test";
import {
  expectNoPageDiagnostics,
  installDefaultAppRoutes,
  installPageDiagnosticsGuard,
  openAppPath,
  seedAppStorage,
} from "./helpers";

type JsonRecord = Record<string, unknown>;

const NOW = "2026-05-31T10:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function taskThread(overrides: Partial<JsonRecord> = {}): JsonRecord {
  return {
    id: "task-smoke-1",
    title: "Audit task coordinator GUI",
    kind: "coding",
    status: "active",
    priority: "high",
    paused: false,
    originalRequest: "Review every control in the task coordinator view",
    summary: "Coordinator is reviewing the GUI interaction contract.",
    sessionCount: 1,
    activeSessionCount: 1,
    latestSessionId: "session-smoke-1",
    latestSessionLabel: "Gauss",
    latestWorkdir: "/home/example/eliza",
    latestRepo: "example/eliza",
    latestActivityAt: NOW_MS,
    decisionCount: 2,
    usage: {
      inputTokens: 120,
      outputTokens: 80,
      reasoningTokens: 20,
      totalTokens: 220,
      cacheTokens: 0,
      costUsd: 0.01,
      state: "measured",
    },
    createdAt: NOW,
    updatedAt: NOW,
    closedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

function taskDetail(overrides: Partial<JsonRecord> = {}): JsonRecord {
  return {
    ...taskThread(),
    goal: "Prove the task coordinator GUI is interactive and readable.",
    roomId: "room-smoke",
    taskRoomId: "task-room-smoke",
    worldId: "world-smoke",
    ownerUserId: "user-smoke",
    parentTaskId: null,
    acceptanceCriteria: [
      "Search filters task threads",
      "Thread detail exposes sessions and artifacts",
      "Archive action refreshes the list",
    ],
    currentPlan: null,
    providerPolicy: null,
    lastUserTurnAt: NOW,
    lastCoordinatorTurnAt: NOW,
    metadata: {},
    sessions: [
      {
        id: "record-smoke-1",
        threadId: "task-smoke-1",
        sessionId: "session-smoke-1",
        framework: "codex",
        providerSource: "local",
        model: "gpt-5.3-codex",
        label: "Gauss",
        originalTask: "Inspect task coordinator UI",
        workdir: "/home/example/eliza",
        repo: "example/eliza",
        status: "active",
        activeTool: null,
        decisionCount: 2,
        autoResolvedCount: 1,
        registeredAt: NOW_MS,
        lastActivityAt: NOW_MS,
        idleCheckCount: 0,
        taskDelivered: false,
        completionSummary: null,
        lastSeenDecisionIndex: 2,
        lastInputSentAt: null,
        stoppedAt: null,
        inputTokens: 120,
        outputTokens: 80,
        reasoningTokens: 20,
        totalTokens: 220,
        cacheTokens: 0,
        costUsd: 0.01,
        usageState: "measured",
        metadata: {
          workspaceChanges: {
            changedFiles: ["packages/app/test/ui-smoke/task.spec.ts"],
            totalChangedFiles: 1,
          },
        },
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    decisions: [
      {
        id: "decision-smoke-1",
        threadId: "task-smoke-1",
        sessionId: "session-smoke-1",
        event: "review",
        promptText: "Proceed with focused browser coverage?",
        decision: "continue",
        response: null,
        reasoning: "The GUI debt is explicit and bounded.",
        timestamp: NOW_MS,
        createdAt: NOW,
      },
    ],
    events: [
      {
        id: "event-smoke-1",
        threadId: "task-smoke-1",
        sessionId: "session-smoke-1",
        eventType: "tool_result",
        timestamp: NOW_MS,
        summary: "Loaded task coordinator fixtures",
        data: {},
        createdAt: NOW,
      },
    ],
    artifacts: [
      {
        id: "artifact-smoke-1",
        threadId: "task-smoke-1",
        sessionId: "session-smoke-1",
        artifactType: "patch",
        title: "Task coordinator coverage patch",
        path: "packages/app/test/ui-smoke/task-coordinator-gui-interactions.spec.ts",
        uri: null,
        mimeType: "text/x-diff",
        verificationStatus: "pending",
        metadata: {},
        createdAt: NOW,
      },
    ],
    messages: [],
    transcripts: [
      {
        id: "transcript-smoke-1",
        threadId: "task-smoke-1",
        sessionId: "session-smoke-1",
        timestamp: NOW_MS,
        direction: "stdin",
        content: "Summarize the task coordinator interaction risks.",
        metadata: {},
        createdAt: NOW,
      },
      {
        id: "transcript-smoke-2",
        threadId: "task-smoke-1",
        sessionId: "session-smoke-1",
        timestamp: NOW_MS,
        direction: "system",
        content: "Search and archive controls are ready for browser coverage.",
        metadata: {},
        createdAt: NOW,
      },
    ],
    pendingDecisions: [
      {
        sessionId: "session-smoke-1",
        threadId: "task-smoke-1",
        promptText: "Choose the next GUI debt to pay down",
        recentOutput: "Task coordinator is the best next target.",
        llmDecision: { reasoning: "It has thread controls and session state." },
        taskContext: {},
        createdAt: NOW_MS,
        updatedAt: NOW,
      },
    ],
    ...overrides,
  };
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installTaskCoordinatorRoutes(page: Page) {
  const listRequests: Array<{ search: string | null; limit: string | null }> =
    [];
  const detailRequests: string[] = [];
  const archiveRequests: string[] = [];
  const reopenRequests: string[] = [];

  const activeThread = taskThread();
  const otherThread = taskThread({
    id: "task-smoke-2",
    title: "Refactor sidebar density",
    status: "open",
    originalRequest: "Tune spacing in a separate task",
    summary: "Waiting for assignment.",
    sessionCount: 0,
    activeSessionCount: 0,
    latestSessionId: null,
    latestSessionLabel: null,
    decisionCount: 0,
  });
  let archived = false;

  await page.route("**/api/coding-agents", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, []);
  });

  await page.route("**/api/orchestrator/status", async (route) => {
    await fulfillJson(route, {
      taskCount: archived ? 1 : 2,
      activeTaskCount: archived ? 0 : 1,
      pausedTaskCount: 0,
      agentCount: archived ? 0 : 1,
      runningAgentCount: archived ? 0 : 1,
      pendingMessageCount: 0,
      tokenUsage: {
        inputTokens: 120,
        outputTokens: 80,
        reasoningTokens: 20,
        totalTokens: 220,
      },
      costUsd: 0.01,
    });
  });

  await page.route("**/api/orchestrator/tasks**", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const method = route.request().method();

    if (method === "GET" && pathname === "/api/orchestrator/tasks") {
      const search = url.searchParams.get("search");
      listRequests.push({
        search,
        limit: url.searchParams.get("limit"),
      });
      const baseTasks = archived
        ? [
            taskThread({
              status: "archived",
              archivedAt: NOW,
              activeSessionCount: 0,
            }),
          ]
        : [activeThread, otherThread];
      const tasks = search
        ? baseTasks.filter((task) =>
            String(task.title).toLowerCase().includes(search.toLowerCase()),
          )
        : baseTasks;
      await fulfillJson(route, { tasks });
      return;
    }

    if (
      method === "GET" &&
      pathname === "/api/orchestrator/tasks/task-smoke-1"
    ) {
      detailRequests.push("task-smoke-1");
      await fulfillJson(
        route,
        archived
          ? taskDetail({
              status: "archived",
              archivedAt: NOW,
              activeSessionCount: 0,
            })
          : taskDetail(),
      );
      return;
    }

    if (
      method === "POST" &&
      pathname === "/api/orchestrator/tasks/task-smoke-1/archive"
    ) {
      archiveRequests.push("task-smoke-1");
      archived = true;
      await fulfillJson(
        route,
        taskDetail({ status: "archived", archivedAt: NOW }),
      );
      return;
    }

    if (
      method === "POST" &&
      pathname === "/api/orchestrator/tasks/task-smoke-1/reopen"
    ) {
      reopenRequests.push("task-smoke-1");
      archived = false;
      await fulfillJson(route, taskDetail());
      return;
    }

    await route.fallback();
  });

  return {
    listRequests: () => listRequests.slice(),
    detailRequests: () => detailRequests.slice(),
    archiveRequests: () => archiveRequests.slice(),
    reopenRequests: () => reopenRequests.slice(),
  };
}

test.beforeEach(async ({ page }) => {
  installPageDiagnosticsGuard(page);
  await seedAppStorage(page, {
    "eliza:ui-theme": "dark",
    "elizaos:ui-theme": "dark",
  });
  await installDefaultAppRoutes(page);
});

test.afterEach(async ({ page }, testInfo) => {
  await expectNoPageDiagnostics(page, testInfo.title);
});

test("task coordinator GUI searches, opens detail, shows operational state, and archives a thread", async ({
  page,
}) => {
  const recorder = await installTaskCoordinatorRoutes(page);

  await openAppPath(page, "/task-coordinator");

  await expect(page.getByTestId("task-coordinator-panel")).toBeVisible();
  await expect(page.getByText("Audit task coordinator GUI")).toBeVisible();
  await expect(page.getByText("Refactor sidebar density")).toBeVisible();

  await page.getByPlaceholder("Search tasks").fill("Audit");
  await expect
    .poll(() =>
      recorder.listRequests().some((request) => request.search === "Audit"),
    )
    .toBe(true);
  await expect(page.getByText("Audit task coordinator GUI")).toBeVisible();
  await expect(page.getByText("Refactor sidebar density")).toHaveCount(0);

  // Rows are spatial primitives: the thread title is a label, not a button.
  // Opening the detail goes through the row's "Open" affordance, addressed by
  // its stable spatial agent id.
  await page.locator('[data-agent-id="open-task-smoke-1"]').click();
  await expect.poll(() => recorder.detailRequests()).toContain("task-smoke-1");
  await expect(page.getByText("Search filters task threads")).toBeVisible();
  await expect(page.getByText("Gauss")).toBeVisible();
  // The spatial detail renders the session framework + workspace, not the
  // legacy rich panel's combined "framework (provider)" string.
  await expect(page.getByText("codex", { exact: true })).toBeVisible();
  await expect(page.getByText("Task coordinator coverage patch")).toBeVisible();
  // The spatial detail surfaces resolved decisions (decision + reasoning); the
  // pending-decision queue the legacy panel showed is not part of this surface.
  await expect(
    page.getByText("The GUI debt is explicit and bounded."),
  ).toBeVisible();
  await expect(page.getByText("continue", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Loaded task coordinator fixtures"),
  ).toBeVisible();

  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect.poll(() => recorder.archiveRequests()).toEqual(["task-smoke-1"]);

  await openAppPath(page, "/task-coordinator");
  await expect(page.getByText("Audit task coordinator GUI")).toBeVisible();
  await page.locator('[data-agent-id="open-task-smoke-1"]').click();
  await expect(page.getByRole("button", { name: "Reopen" })).toBeVisible();

  await page.getByRole("button", { name: "Reopen", exact: true }).click();
  await expect.poll(() => recorder.reopenRequests()).toEqual(["task-smoke-1"]);

  await openAppPath(page, "/task-coordinator");
  await expect(page.getByText("Audit task coordinator GUI")).toBeVisible();
  await page.locator('[data-agent-id="open-task-smoke-1"]').click();
  await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();
});

// End-to-end Playwright spec for the chat task widget contract:
//   1. Boot the app's real continuous-chat surface with a mocked backend.
//   2. Send a user request through the composer and stream an assistant reply
//      containing `[TASK:<uuid>]<title>[/TASK]`.
//   3. `MessageContent` resolves the block to a TaskWidget that polls
//      `client.getCodingAgentTaskThread` (mocked at `/api/coding-agents/...`).
//   4. Clicking the widget dispatches `eliza:navigate:view` →
//      `/orchestrator?taskId=<id>`, which the shell catches and routes into the
//      orchestrator workbench. The workbench is itself mocked through the same
//      `installOrchestratorWorkbenchRoutes`-style fixture so it can render the
//      selected task without 500-ing.
//
// Companion to the component-level tests in `packages/ui/src/components/chat/`
// (`message-task-parser`, `widgets/task-widget`, and
// `MessageContent.task-widget`) — this file is the only one that exercises the
// full chat → widget → orchestrator hop end-to-end.

import { writeFile } from "node:fs/promises";
import { expect, type Page, type Route, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const NOW = "2026-01-01T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const CONVERSATION_ID = "task-widget-conversation";
const ROOM_ID = "task-widget-room";
const TASK_ID = "0123abcd-1234-5678-9abc-deadbeefcafe";
const TASK_TITLE = "Build planner app";
const FETCHED_TASK_TITLE = "Build planner app — hydrated";

type JsonRecord = Record<string, unknown>;

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function usage(overrides: JsonRecord = {}) {
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
    ...overrides,
  };
}

function taskDetail(overrides: JsonRecord = {}) {
  return {
    id: TASK_ID,
    title: FETCHED_TASK_TITLE,
    kind: "coding",
    status: "active",
    priority: "high",
    paused: false,
    originalRequest: TASK_TITLE,
    summary: null,
    goal: "Generate the planner shell and wire persistence.",
    roomId: null,
    taskRoomId: null,
    worldId: null,
    ownerUserId: null,
    parentTaskId: null,
    sessionCount: 2,
    activeSessionCount: 2,
    latestSessionId: "session-builder",
    latestSessionLabel: "Builder",
    latestWorkdir: null,
    latestRepo: null,
    latestActivityAt: NOW_MS - 30_000,
    decisionCount: 0,
    acceptanceCriteria: [],
    currentPlan: null,
    providerPolicy: null,
    lastUserTurnAt: null,
    lastCoordinatorTurnAt: null,
    metadata: {},
    usage: usage({ totalTokens: 1234, state: "estimated" }),
    sessions: [],
    decisions: [],
    events: [],
    artifacts: [],
    messages: [],
    transcripts: [],
    planRevisions: [],
    createdAt: NOW,
    updatedAt: NOW,
    closedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

function taskSummary(overrides: JsonRecord = {}) {
  return {
    id: TASK_ID,
    title: TASK_TITLE,
    kind: "coding",
    status: "active",
    priority: "high",
    paused: false,
    originalRequest: TASK_TITLE,
    summary: null,
    sessionCount: 2,
    activeSessionCount: 2,
    latestSessionId: "session-builder",
    latestSessionLabel: "Builder",
    latestWorkdir: null,
    latestRepo: null,
    latestActivityAt: NOW_MS - 30_000,
    decisionCount: 0,
    usage: usage({ totalTokens: 1234, state: "estimated" }),
    createdAt: NOW,
    updatedAt: NOW,
    closedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

function statusFor(detail: JsonRecord) {
  return {
    taskCount: 1,
    activeTaskCount: detail.status === "active" ? 1 : 0,
    pausedTaskCount: detail.paused === true ? 1 : 0,
    blockedTaskCount: 0,
    validatingTaskCount: 0,
    sessionCount: Number(detail.sessionCount ?? 0),
    activeSessionCount: Number(detail.activeSessionCount ?? 0),
    usage: detail.usage ?? usage(),
    byStatus: {
      open: 0,
      active: detail.status === "active" ? 1 : 0,
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

/**
 * Installs the minimal chat-backend mock for this spec. The default
 * `installDefaultAppRoutes` covers all the orthogonal startup routes; this
 * helper only adds the chat-conversation surface and task detail endpoints.
 */
async function installTaskChatRoutes(
  page: Page,
  assistantText: string,
): Promise<{
  taskFetches: number;
  streamRequests: string[];
  completeTask: () => void;
}> {
  let detail = taskDetail();
  let taskFetches = 0;
  let sequence = 0;
  const streamRequests: string[] = [];
  const conversation = {
    id: CONVERSATION_ID,
    roomId: ROOM_ID,
    title: "Task widget chat",
    updatedAt: NOW,
    createdAt: NOW,
  };
  const messages: Array<{
    id: string;
    role: "assistant" | "user";
    text: string;
    source: string;
    roomId: string;
    timestamp: number;
  }> = [];

  await page.route("**/api/conversations**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/conversations") {
      await route.fallback();
      return;
    }
    if (route.request().method() === "GET") {
      await fulfillJson(route, { conversations: [conversation] });
      return;
    }
    if (route.request().method() === "POST") {
      await fulfillJson(route, { conversation });
      return;
    }
    await route.fallback();
  });

  await page.route(`**/api/conversations/${CONVERSATION_ID}`, async (route) => {
    if (route.request().method() === "PATCH") {
      await fulfillJson(route, { conversation });
      return;
    }
    if (route.request().method() === "GET") {
      await fulfillJson(route, { conversation });
      return;
    }
    await route.fallback();
  });

  await page.route(
    `**/api/conversations/${CONVERSATION_ID}/messages**`,
    async (route) => {
      if (route.request().method() === "GET") {
        await fulfillJson(route, { messages });
        return;
      }
      await route.fallback();
    },
  );

  await page.route(
    `**/api/conversations/${CONVERSATION_ID}/messages/stream`,
    async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}") as {
        text?: string;
      };
      const userText = (body.text ?? "").trim();
      streamRequests.push(userText);
      sequence += 1;
      messages.push(
        {
          id: `task-user-${sequence}`,
          role: "user",
          text: userText,
          source: "eliza",
          roomId: ROOM_ID,
          timestamp: Date.now(),
        },
        {
          id: `task-assistant-${sequence}`,
          role: "assistant",
          text: assistantText,
          source: "eliza",
          roomId: ROOM_ID,
          timestamp: Date.now() + 1,
        },
      );
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          `data: ${JSON.stringify({
            type: "token",
            text: assistantText,
            fullText: assistantText,
          })}\n\n` +
          `data: ${JSON.stringify({
            type: "done",
            fullText: assistantText,
            agentName: "Eliza",
          })}\n\n`,
      });
    },
  );

  await page.route(
    `**/api/conversations/${CONVERSATION_ID}/greeting**`,
    async (route) => {
      await fulfillJson(route, { text: "Ready.", localInference: null });
    },
  );

  // TaskWidget polls `client.getCodingAgentTaskThread` which hits
  // `/api/coding-agents/tasks/<id>` and/or `/api/orchestrator/tasks/<id>`.
  // We answer both shapes so the widget binds to the live detail regardless
  // of which path the runtime client picks.
  const handleTaskDetail = async (route: Route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    taskFetches += 1;
    await fulfillJson(route, detail);
  };
  await page.route(`**/api/coding-agents/tasks/${TASK_ID}`, handleTaskDetail);
  await page.route(`**/api/orchestrator/tasks/${TASK_ID}`, handleTaskDetail);

  // The orchestrator workbench, opened by the widget's navigate dispatch,
  // expects the status + tasks list endpoints to return the same task.
  await page.unroute("**/api/orchestrator/status").catch(() => undefined);
  await page.route("**/api/orchestrator/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, statusFor(detail));
  });

  await page.unroute("**/api/orchestrator/tasks**").catch(() => undefined);
  await page.route("**/api/orchestrator/tasks**", async (route) => {
    const url = new URL(route.request().url());
    if (
      route.request().method() === "GET" &&
      url.pathname === "/api/orchestrator/tasks"
    ) {
      await fulfillJson(route, { tasks: [taskSummary(detail)] });
      return;
    }
    if (
      route.request().method() === "GET" &&
      url.pathname === `/api/orchestrator/tasks/${TASK_ID}`
    ) {
      taskFetches += 1;
      await fulfillJson(route, detail);
      return;
    }
    if (
      route.request().method() === "GET" &&
      (url.pathname.endsWith("/messages") ||
        url.pathname.endsWith("/events") ||
        url.pathname.endsWith("/timeline"))
    ) {
      await fulfillJson(route, { items: [], nextCursor: null });
      return;
    }
    await route.fallback();
  });

  return {
    get taskFetches() {
      return taskFetches;
    },
    streamRequests,
    completeTask() {
      detail = taskDetail({
        status: "validating",
        activeSessionCount: 0,
        metadata: {
          prUrl: "https://github.com/elizaOS/eliza/pull/16090",
          prNumber: 16090,
          prRepo: "elizaOS/eliza",
        },
      });
    },
  } as {
    taskFetches: number;
    streamRequests: string[];
    completeTask: () => void;
  };
}

test.use({ video: "on" });

test.describe("chat task widget", () => {
  test("renders an inline TaskWidget with its durable PR and opens the orchestrator workbench", async ({
    page,
  }, testInfo) => {
    const consoleEntries: string[] = [];
    const networkEntries: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (message) =>
      consoleEntries.push(`[${message.type()}] ${message.text()}`),
    );
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    page.on("request", (request) =>
      networkEntries.push(`${request.method()} ${request.url()}`),
    );
    await seedAppStorage(page);
    await installDefaultAppRoutes(page);
    const assistantText = `Created the task you asked for.\n\n[TASK:${TASK_ID}]${TASK_TITLE}[/TASK]\n\nThe builders are running.`;
    const handles = await installTaskChatRoutes(page, assistantText);

    await openAppPath(page, "/chat");

    const userPrompt = "Spin up the planner task.";
    await page.getByTestId("chat-composer-textarea").fill(userPrompt);
    await page.getByTestId("chat-composer-action").click();

    await expect.poll(() => handles.streamRequests).toContain(userPrompt);

    // The streamed assistant turn renders. Surrounding prose is preserved.
    await expect(
      page
        .getByTestId("thread-line")
        .filter({ hasText: "Created the task you asked for." })
        .first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page
        .getByTestId("thread-line")
        .filter({ hasText: "The builders are running." })
        .first(),
    ).toBeVisible({ timeout: 30_000 });

    // The TASK block resolves into a TaskWidget. Title is the fetched title
    // (taskDetail() returns the same title as the fallback here), and the
    // status attribute reflects the live detail (status="active").
    const widget = page.getByTestId("task-widget").first();
    await expect(widget).toBeVisible({ timeout: 15_000 });
    await expect(widget).toContainText(FETCHED_TASK_TITLE);
    await expect(widget).toHaveAttribute("data-task-id", TASK_ID);
    await expect(widget).toHaveAttribute("data-task-status", "active");
    await expect(widget.getByTestId("task-widget-pr-chip")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("task-widget-pr-before.jpg"),
      fullPage: true,
      type: "jpeg",
      quality: 88,
    });

    handles.completeTask();
    const completionPrompt = "Show the completed task.";
    await page.getByTestId("chat-composer-textarea").fill(completionPrompt);
    await page.getByTestId("chat-composer-action").click();
    await expect.poll(() => handles.streamRequests).toContain(completionPrompt);
    const completedWidget = page.getByTestId("task-widget").last();
    await expect(completedWidget).toHaveAttribute(
      "data-task-status",
      "validating",
    );
    const prChip = completedWidget.getByTestId("task-widget-pr-chip");
    await expect(prChip).toBeVisible();
    await expect(prChip).toHaveAttribute(
      "href",
      "https://github.com/elizaOS/eliza/pull/16090",
    );
    await expect(prChip).toHaveAttribute("title", "elizaOS/eliza #16090");
    await page.screenshot({
      path: testInfo.outputPath("task-widget-pr-desktop.jpg"),
      fullPage: true,
      type: "jpeg",
      quality: 88,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(prChip).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("task-widget-pr-mobile.jpg"),
      fullPage: true,
      type: "jpeg",
      quality: 88,
    });
    await page.setViewportSize({ width: 1280, height: 720 });

    // The widget calls into the runtime client at least once; we assert that
    // happened by checking the mocked detail endpoint fired.
    await expect.poll(() => handles.taskFetches).toBeGreaterThan(0);

    // The raw `[TASK:…]` literal must never bleed into the rendered chat DOM.
    const chatBody = await page.locator("body").textContent();
    expect(chatBody?.includes(`[TASK:${TASK_ID}]`)).toBe(false);
    expect(chatBody?.includes("[/TASK]")).toBe(false);

    // Clicking the widget dispatches `eliza:navigate:view` →
    // `/orchestrator?taskId=…`. We assert directly on the event AND on the
    // shell behavior (navigation + workbench render). The event listener is
    // installed before the click so a sync dispatch is observable.
    await page.evaluate(() => {
      (
        window as unknown as { __taskWidgetNavigations: string[] }
      ).__taskWidgetNavigations = [];
      window.addEventListener("eliza:navigate:view", (event) => {
        const detail = (event as CustomEvent<{ viewPath?: string }>).detail;
        const win = window as unknown as { __taskWidgetNavigations: string[] };
        if (typeof detail?.viewPath === "string") {
          win.__taskWidgetNavigations.push(detail.viewPath);
        }
      });
    });

    // Open the chat sheet before interacting: the slim peek can't fit a full
    // task card, so the realistic flow is to open the history sheet (which
    // applies the composer clearance) and then tap the widget. Without this the
    // last message can sit under the bottom composer's button row.
    const grabber = page.getByTestId("chat-sheet-grabber");
    if ((await grabber.count()) > 0) {
      await grabber.focus();
      await page.keyboard.press("ArrowUp");
      await page.waitForTimeout(400);
    }

    // Expansion and workbench navigation remain separate from the adjacent PR
    // anchor so every control is independently keyboard- and pointer-accessible.
    await completedWidget.getByRole("button").click();
    await completedWidget
      .getByRole("button", { name: "Open in workbench →" })
      .click();

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __taskWidgetNavigations?: string[] })
              .__taskWidgetNavigations ?? [],
        ),
      )
      .toContain(`/orchestrator?taskId=${TASK_ID}`);

    // The shell follows the dispatch by navigating to the orchestrator route
    // and rendering the workbench with the selected task.
    await expect
      .poll(() => page.url(), { timeout: 15_000 })
      .toContain(`taskId=${TASK_ID}`);
    await expect(page.getByTestId("orchestrator-workbench")).toBeVisible({
      timeout: 30_000,
    });
    expect(pageErrors).toEqual([]);
    await writeFile(
      testInfo.outputPath("frontend-console.log"),
      consoleEntries.join("\n"),
    );
    await writeFile(
      testInfo.outputPath("frontend-network.log"),
      networkEntries.join("\n"),
    );
    await testInfo.attach("frontend-console", {
      body: Buffer.from(consoleEntries.join("\n")),
      contentType: "text/plain",
    });
    await testInfo.attach("frontend-network", {
      body: Buffer.from(networkEntries.join("\n")),
      contentType: "text/plain",
    });
  });
});

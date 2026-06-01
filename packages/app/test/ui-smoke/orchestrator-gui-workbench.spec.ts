import { expect, type Page, type Route, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const NOW = "2026-01-01T00:00:00.000Z";

type JsonRecord = Record<string, unknown>;

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

function statusFor(detail: JsonRecord | null) {
  const hasTask = Boolean(detail);
  const status = typeof detail?.status === "string" ? detail.status : "open";
  const activeSessionCount =
    typeof detail?.activeSessionCount === "number"
      ? detail.activeSessionCount
      : 0;
  const sessionCount =
    typeof detail?.sessionCount === "number" ? detail.sessionCount : 0;
  return {
    taskCount: hasTask ? 1 : 0,
    activeTaskCount: hasTask && status === "active" ? 1 : 0,
    pausedTaskCount: hasTask && detail?.paused === true ? 1 : 0,
    blockedTaskCount:
      hasTask && (status === "blocked" || status === "waiting_on_user") ? 1 : 0,
    validatingTaskCount: hasTask && status === "validating" ? 1 : 0,
    sessionCount,
    activeSessionCount,
    usage: (detail?.usage as JsonRecord | undefined) ?? usage(),
    byStatus: {
      open: hasTask && status === "open" ? 1 : 0,
      active: hasTask && status === "active" ? 1 : 0,
      waiting_on_user: 0,
      blocked: hasTask && status === "blocked" ? 1 : 0,
      validating: hasTask && status === "validating" ? 1 : 0,
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

async function installOrchestratorWorkbenchRoutes(
  page: Page,
  initial: {
    detail?: JsonRecord;
    messages?: JsonRecord[];
    events?: JsonRecord[];
  } = {},
): Promise<{
  createBodies: JsonRecord[];
  messageBodies: JsonRecord[];
  addAgentBodies: JsonRecord[];
  patchBodies: JsonRecord[];
  actionLog: string[];
}> {
  let detail: JsonRecord | null = initial.detail ?? null;
  const messages: JsonRecord[] = [...(initial.messages ?? [])];
  const events: JsonRecord[] = [...(initial.events ?? [])];
  const createBodies: JsonRecord[] = [];
  const messageBodies: JsonRecord[] = [];
  const addAgentBodies: JsonRecord[] = [];
  const patchBodies: JsonRecord[] = [];
  const actionLog: string[] = [];

  await page.route("**/api/orchestrator/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const pathname = url.pathname;

    if (method === "GET" && pathname === "/api/orchestrator/status") {
      await fulfillJson(route, statusFor(detail));
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
      if (method === "PATCH") {
        const body = JSON.parse(request.postData() ?? "{}") as JsonRecord;
        patchBodies.push(body);
        detail = { ...(detail ?? taskDetail()), ...body };
        await fulfillJson(route, detail);
        return;
      }
      if (method === "DELETE") {
        actionLog.push("delete");
        detail = null;
        await fulfillJson(route, { deleted: true });
        return;
      }
      await fulfillJson(route, detail ?? taskDetail());
      return;
    }

    if (
      method === "POST" &&
      pathname === "/api/orchestrator/tasks/smoke-task-1/pause"
    ) {
      actionLog.push("pause");
      detail = { ...(detail ?? taskDetail()), paused: true };
      await fulfillJson(route, detail);
      return;
    }

    if (
      method === "POST" &&
      pathname === "/api/orchestrator/tasks/smoke-task-1/resume"
    ) {
      actionLog.push("resume");
      detail = { ...(detail ?? taskDetail()), paused: false };
      await fulfillJson(route, detail);
      return;
    }

    if (
      method === "POST" &&
      pathname === "/api/orchestrator/tasks/smoke-task-1/archive"
    ) {
      actionLog.push("archive");
      detail = { ...(detail ?? taskDetail()), status: "archived" };
      await fulfillJson(route, { archived: true });
      return;
    }

    if (
      method === "POST" &&
      pathname === "/api/orchestrator/tasks/smoke-task-1/reopen"
    ) {
      actionLog.push("reopen");
      detail = { ...(detail ?? taskDetail()), status: "open" };
      await fulfillJson(route, detail);
      return;
    }

    if (
      method === "POST" &&
      pathname === "/api/orchestrator/tasks/smoke-task-1/fork"
    ) {
      actionLog.push("fork");
      const forked = taskDetail({
        ...(detail ?? {}),
        id: "smoke-task-2",
        title: "Forked orchestrator task",
        parentTaskId: "smoke-task-1",
      });
      await fulfillJson(route, forked);
      return;
    }

    if (
      method === "POST" &&
      pathname === "/api/orchestrator/tasks/smoke-task-1/validate"
    ) {
      const body = JSON.parse(request.postData() ?? "{}") as JsonRecord;
      actionLog.push(`validate:${String(body.passed)}`);
      detail = {
        ...(detail ?? taskDetail()),
        status: body.passed === true ? "done" : "blocked",
      };
      await fulfillJson(route, detail);
      return;
    }

    if (
      method === "POST" &&
      pathname === "/api/orchestrator/tasks/smoke-task-1/agents"
    ) {
      const body = JSON.parse(request.postData() ?? "{}") as JsonRecord;
      addAgentBodies.push(body);
      const sessions = [
        ...(((detail?.sessions as JsonRecord[] | undefined) ??
          []) as JsonRecord[]),
        {
          id: "session-new",
          sessionId: "session-new",
          label: body.label || "New agent",
          status: "running",
          framework: body.framework,
          providerSource: body.providerSource,
          model: body.model,
          workdir: body.workdir,
          repo: body.repo,
          activeTool: null,
          usageState: "estimated",
          totalTokens: 0,
          stoppedAt: null,
          lastActivityAt: Date.parse(NOW),
        },
      ];
      detail = {
        ...(detail ?? taskDetail()),
        sessions,
        sessionCount: sessions.length,
        activeSessionCount: sessions.filter(
          (session) => session.status === "running",
        ).length,
      };
      await fulfillJson(route, detail);
      return;
    }

    if (
      method === "POST" &&
      pathname ===
        "/api/orchestrator/tasks/smoke-task-1/agents/session-codex/stop"
    ) {
      actionLog.push("stop:session-codex");
      const sessions = (
        ((detail?.sessions as JsonRecord[] | undefined) ?? []) as JsonRecord[]
      ).map((session) =>
        session.sessionId === "session-codex"
          ? { ...session, status: "stopped", stoppedAt: NOW, activeTool: null }
          : session,
      );
      detail = {
        ...(detail ?? taskDetail()),
        sessions,
        activeSessionCount: sessions.filter(
          (session) => session.status === "running",
        ).length,
      };
      await fulfillJson(route, { stopped: true });
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
      await fulfillJson(route, { items: events, nextCursor: null });
      return;
    }

    await fulfillJson(route, { error: `Unhandled ${method} ${pathname}` }, 404);
  });

  return {
    createBodies,
    messageBodies,
    addAgentBodies,
    patchBodies,
    actionLog,
  };
}

function richOrchestratorFixture() {
  const richUsage = usage({
    inputTokens: 8400,
    outputTokens: 2600,
    reasoningTokens: 1345,
    totalTokens: 12_345,
    costUsd: 0.42,
    state: "measured",
    usageState: "measured",
    byProvider: [
      {
        provider: "cerebras",
        model: "gpt-oss-120b",
        inputTokens: 8400,
        outputTokens: 2600,
        reasoningTokens: 1345,
        cacheTokens: 0,
        totalTokens: 12_345,
        costUsd: 0.42,
        state: "measured",
      },
      {
        provider: "codex",
        model: "gpt-5.4",
        inputTokens: 1200,
        outputTokens: 900,
        reasoningTokens: 0,
        cacheTokens: 0,
        totalTokens: 2100,
        costUsd: 0,
        state: "estimated",
      },
    ],
  });
  const detail = taskDetail({
    id: "smoke-task-1",
    title: "Build Kanban planner app",
    status: "active",
    priority: "urgent",
    paused: false,
    goal: "Build and verify a tiny Kanban planner app with accessible columns, cards, and persistence.",
    originalRequest:
      "Use Codex plus Cerebras gpt-oss-120b to build a planner app.",
    summary: "Codex has generated files; Cerebras is reviewing UX.",
    sessionCount: 2,
    activeSessionCount: 2,
    latestSessionId: "session-codex",
    latestSessionLabel: "Codex Builder",
    latestWorkdir: "/tmp/orchestrator-kanban",
    latestRepo: "/home/shaw/milady/eliza",
    latestActivityAt: Date.parse(NOW),
    acceptanceCriteria: [
      "Planner renders three workflow columns",
      "Cards can be created and moved",
      "Generated files pass syntax checks",
    ],
    currentPlan: {
      summary: "Build, review, and verify the Kanban planner.",
      steps: [
        { title: "Generate app shell", status: "completed" },
        { title: "Review visual affordances", status: "in_progress" },
        { title: "Run browser smoke checks", status: "pending" },
      ],
    },
    providerPolicy: {
      preferredFramework: "codex",
      providerSource: "cerebras",
      model: "gpt-oss-120b",
    },
    sessions: [
      {
        id: "session-codex-record",
        sessionId: "session-codex",
        label: "Codex Builder",
        status: "running",
        framework: "codex",
        providerSource: "local-auth",
        model: "gpt-5.4",
        workdir: "/tmp/orchestrator-kanban",
        repo: "/home/shaw/milady/eliza",
        activeTool: "write",
        usageState: "estimated",
        totalTokens: 2100,
        stoppedAt: null,
        lastActivityAt: Date.parse(NOW),
      },
      {
        id: "session-cerebras-record",
        sessionId: "session-cerebras",
        label: "Cerebras Reviewer",
        status: "running",
        framework: "eliza",
        providerSource: "cerebras",
        model: "gpt-oss-120b",
        workdir: "/tmp/orchestrator-kanban",
        repo: "/home/shaw/milady/eliza",
        activeTool: "review",
        usageState: "measured",
        totalTokens: 12_345,
        stoppedAt: null,
        lastActivityAt: Date.parse(NOW),
      },
    ],
    artifacts: [
      {
        id: "artifact-index",
        title: "Kanban planner HTML",
        artifactType: "file",
        path: "planner/index.html",
        uri: null,
        verificationStatus: "passed",
        metadata: {},
        createdAt: NOW,
      },
      {
        id: "artifact-test",
        title: "Browser smoke report",
        artifactType: "verification",
        path: "reports/kanban-smoke.md",
        uri: null,
        verificationStatus: "pending",
        metadata: {},
        createdAt: NOW,
      },
    ],
    usage: richUsage,
  });
  return {
    detail,
    messages: [
      {
        id: "message-user-1",
        threadId: "smoke-task-1",
        sessionId: null,
        senderKind: "user",
        direction: "stdout",
        content: "Create a compact Kanban planner app.",
        timestamp: Date.parse(NOW) - 4000,
        metadata: {},
        createdAt: NOW,
      },
      {
        id: "message-agent-1",
        threadId: "smoke-task-1",
        sessionId: "session-codex",
        senderKind: "sub_agent",
        direction: "stdout",
        content: "Generated the planner shell and wired card movement.",
        timestamp: Date.parse(NOW) - 2000,
        metadata: {},
        createdAt: NOW,
      },
    ],
    events: [
      {
        id: "event-tool-write",
        threadId: "smoke-task-1",
        sessionId: "session-codex",
        eventType: "tool_running",
        summary: "write planner files",
        timestamp: Date.parse(NOW) - 1000,
        data: {
          toolCall: {
            id: "tool-write-index",
            title: "write",
            kind: "edit",
            status: "completed",
            rawInput: {
              path: "planner/index.html",
              content: '<main id="board"></main>',
            },
            output: "Wrote planner/index.html",
          },
        },
        createdAt: NOW,
      },
      {
        id: "event-validation",
        threadId: "smoke-task-1",
        sessionId: "session-cerebras",
        eventType: "task_registered",
        summary: "Cerebras reviewer joined for UX validation",
        timestamp: Date.parse(NOW) - 500,
        data: {},
        createdAt: NOW,
      },
    ],
  };
}

test.describe("orchestrator GUI workbench", () => {
  test("renders the expected rich build-room data and drives inspector controls", async ({
    page,
  }) => {
    await seedAppStorage(page);
    await installDefaultAppRoutes(page);
    const fixture = richOrchestratorFixture();
    const requests = await installOrchestratorWorkbenchRoutes(page, fixture);

    await openAppPath(page, "/orchestrator?task=smoke-task-1");

    await expect(page.getByTestId("orchestrator-workbench")).toBeVisible();
    await expect(page.getByText("Orchestrator")).toBeVisible();
    await expect(page.getByTestId("orchestrator-task-item")).toContainText(
      "Build Kanban planner app",
    );
    await expect(page.getByTestId("orchestrator-task-item")).toContainText(
      "2/2",
    );
    await expect(page.getByTestId("orchestrator-filter")).toContainText(
      "Active (1)",
    );
    await expect(page.getByText("12.3K")).toBeVisible();
    await expect(page.getByText("$0.42")).toBeVisible();

    await expect(page.getByTestId("orchestrator-timeline")).toContainText(
      "Build Kanban planner app",
    );
    await expect(page.getByTestId("orchestrator-message-list")).toContainText(
      "Create a compact Kanban planner app.",
    );
    await expect(page.getByTestId("orchestrator-message-list")).toContainText(
      "Generated the planner shell",
    );
    await expect(page.getByTestId("orchestrator-message-list")).toContainText(
      "planner/index.html",
    );
    await expect(page.getByTestId("orchestrator-running-bar")).toBeVisible();

    const inspector = page.getByTestId("orchestrator-inspector");
    await expect(inspector).toContainText(
      "Build and verify a tiny Kanban planner app",
    );
    await expect(inspector).toContainText("Codex Builder");
    await expect(inspector).toContainText("Cerebras Reviewer");
    await expect(inspector).toContainText("codex · gpt-5.4");
    await expect(inspector).toContainText("eliza · gpt-oss-120b");
    await expect(inspector).toContainText(
      "Build, review, and verify the Kanban planner.",
    );
    await expect(inspector).toContainText("Generate app shell");
    await expect(inspector).toContainText("Review visual affordances");
    await expect(inspector).toContainText(
      "Planner renders three workflow columns",
    );
    await expect(inspector).toContainText("Kanban planner HTML");
    await expect(inspector).toContainText("planner/index.html");
    await expect(inspector).toContainText("Browser smoke report");
    await expect(inspector).toContainText("cerebras · gpt-oss-120b");
    await expect(inspector).toContainText("codex · gpt-5.4");

    await page.getByTestId("orchestrator-priority-select").selectOption("high");
    await expect
      .poll(() => requests.patchBodies)
      .toContainEqual({
        priority: "high",
      });

    await page.getByTestId("orchestrator-add-agent").click();
    await page
      .getByTestId("orchestrator-add-agent-label")
      .fill("Cerebras Builder");
    await page.getByPlaceholder("Framework").fill("eliza");
    await page.getByPlaceholder("Model").fill("gpt-oss-120b");
    await page.getByPlaceholder("Workdir (optional)").fill("/tmp/build-app");
    await page
      .getByPlaceholder("Sub-task for this agent (optional)")
      .fill("Build a small notes app and report generated files.");
    await page.getByTestId("orchestrator-add-agent-submit").click();
    await expect
      .poll(() => requests.addAgentBodies)
      .toContainEqual({
        label: "Cerebras Builder",
        framework: "eliza",
        model: "gpt-oss-120b",
        workdir: "/tmp/build-app",
        task: "Build a small notes app and report generated files.",
      });

    await page.getByTestId("orchestrator-stop-agent").first().click();
    await expect.poll(() => requests.actionLog).toContain("stop:session-codex");

    await page.getByTestId("orchestrator-inspector-pause").click();
    await expect.poll(() => requests.actionLog).toContain("pause");
    await expect(
      page.getByTestId("orchestrator-inspector-resume"),
    ).toBeVisible();
    await page.getByTestId("orchestrator-inspector-resume").click();
    await expect.poll(() => requests.actionLog).toContain("resume");

    await expect
      .poll(async () =>
        JSON.parse(
          (await page
            .locator("[data-view-state]")
            .first()
            .getAttribute("data-view-state")) ?? "{}",
        ),
      )
      .toMatchObject({
        selectedId: "smoke-task-1",
        taskCount: 1,
        activeTaskCount: 1,
      });
  });

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

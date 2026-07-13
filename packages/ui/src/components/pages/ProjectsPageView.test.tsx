// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CodingAgentCreateTaskInput,
  CodingAgentTaskThread,
} from "../../api/client-types-cloud";
import { __setAppValueForTests } from "../../state/app-store";

const clientMock = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listCodingAgentTaskThreads: vi.fn(),
  activateProject: vi.fn(),
  createProject: vi.fn(),
  createOrchestratorTask: vi.fn(),
}));

vi.mock("../../api/client", () => ({ client: clientMock }));

vi.mock("../views/ShellViewAgentSurface", () => ({
  ShellViewAgentSurface: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("../../slots/task-coordinator-slots", () => ({
  CodingAgentTasksPanel: ({
    fullPage,
    projectId,
  }: {
    fullPage?: boolean;
    projectId?: string | null;
  }) => (
    <div
      data-testid="project-task-panel"
      data-full-page={fullPage ? "true" : "false"}
      data-project-id={projectId ?? "unassigned"}
    >
      {projectId ? `Tasks for project ${projectId}` : "Unassigned tasks"}
    </div>
  ),
}));

import { ProjectsPageView } from "./ProjectsPageView";

function task(
  id: string,
  projectId: string | null,
  title = "Build feature",
): CodingAgentTaskThread {
  return {
    id,
    projectId,
    title,
    originalRequest: title,
    kind: "coding",
    status: "active",
    priority: "normal",
    paused: false,
    sessionCount: 0,
    activeSessionCount: 0,
    latestSessionId: null,
    latestSessionLabel: null,
    latestWorkdir: null,
    latestRepo: null,
    latestActivityAt: null,
    decisionCount: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      state: "unavailable",
      byProvider: [],
    },
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    closedAt: null,
    archivedAt: null,
  };
}

afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
  vi.clearAllMocks();
});

describe("ProjectsPageView", () => {
  function arrange() {
    __setAppValueForTests({ setActionNotice: vi.fn() } as never);
    clientMock.listProjects.mockResolvedValue({
      activeProjectId: "project-a",
      projects: [
        {
          id: "project-a",
          name: "Alpha",
          localPath: "/work/alpha",
          cloudAppId: "app-alpha",
          lastOpenedAt: "2026-07-12T00:00:00.000Z",
        },
      ],
    });
    clientMock.listCodingAgentTaskThreads.mockResolvedValue([
      task("task-a", "project-a"),
      task("task-unassigned", null),
    ]);
    clientMock.activateProject.mockResolvedValue({});
    clientMock.createOrchestratorTask.mockResolvedValue({});
  }

  it("shows project-bound task counts, cloud state, and unassigned work", async () => {
    arrange();
    render(<ProjectsPageView />);

    expect(await screen.findByText("Alpha")).toBeTruthy();
    expect(screen.getByText("Cloud")).toBeTruthy();
    expect(screen.getByTestId("project-card-unassigned").textContent).toContain(
      "1",
    );
  });

  it("opens a project with a controlled project task scope", async () => {
    arrange();
    render(<ProjectsPageView />);

    fireEvent.click(await screen.findByTestId("project-card-project-a"));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Alpha" }),
    ).toBeTruthy();
    const taskPanel = screen.getByTestId("project-task-panel");
    expect(taskPanel.getAttribute("data-full-page")).toBe("true");
    expect(taskPanel.getAttribute("data-project-id")).toBe("project-a");
    expect(taskPanel.textContent).toBe("Tasks for project project-a");
    expect(screen.queryByTestId("project-card-project-a")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Back to Projects" }),
    ).toBeTruthy();
  });

  it("starts publishing as a tracked, project-bound task", async () => {
    arrange();
    const persistedTasks = [
      task("task-a", "project-a"),
      task("task-unassigned", null),
    ];
    clientMock.listCodingAgentTaskThreads.mockImplementation(async () => [
      ...persistedTasks,
    ]);
    clientMock.createOrchestratorTask.mockImplementation(
      async (input: CodingAgentCreateTaskInput) => {
        const isValidProjectPublish =
          input.projectId === "project-a" &&
          input.workdir === "/work/alpha" &&
          input.title === "Publish Alpha" &&
          input.metadata?.publishProject === true;
        if (isValidProjectPublish) {
          persistedTasks.push(
            task("task-publish-alpha", "project-a", input.title),
          );
        }
        return {};
      },
    );
    render(<ProjectsPageView />);
    fireEvent.click(await screen.findByTestId("project-card-project-a"));
    const publishButton = screen.getByRole("button", {
      name: "Publish Alpha",
    });
    fireEvent.click(publishButton);

    expect(publishButton.hasAttribute("disabled")).toBe(true);
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Publish Alpha" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to Projects" }));

    const projectCard = await screen.findByTestId("project-card-project-a");
    expect(projectCard.textContent).toContain("2");
    expect(projectCard.textContent).toContain("Publishing");
  });
});

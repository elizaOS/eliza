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
import type { CodingAgentTaskThread } from "../../api/client-types-cloud";
import { __setAppValueForTests } from "../../state/app-store";

const panelProps = vi.hoisted(() => ({
  value: null as Record<string, unknown> | null,
}));

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
  CodingAgentTasksPanel: (props: Record<string, unknown>) => {
    panelProps.value = props;
    return <div data-testid="project-task-panel" />;
  },
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
  panelProps.value = null;
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

    await waitFor(() =>
      expect(panelProps.value).toMatchObject({
        fullPage: true,
        projectId: "project-a",
      }),
    );
    expect(clientMock.activateProject).toHaveBeenCalledWith("project-a");
  });

  it("starts publishing as a tracked, project-bound task", async () => {
    arrange();
    render(<ProjectsPageView />);
    fireEvent.click(await screen.findByTestId("project-card-project-a"));
    fireEvent.click(screen.getByRole("button", { name: "Publish Alpha" }));

    await waitFor(() =>
      expect(clientMock.createOrchestratorTask).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "project-a",
          workdir: "/work/alpha",
          title: "Publish Alpha",
          metadata: expect.objectContaining({ publishProject: true }),
        }),
      ),
    );
  });
});

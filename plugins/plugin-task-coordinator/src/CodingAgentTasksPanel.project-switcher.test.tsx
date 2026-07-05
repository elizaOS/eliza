// @vitest-environment jsdom
//
// Project-switcher integration coverage for the legacy Tasks-page slot panel.
// The parent must wait for the switcher to load the active project before its
// first task-thread query, otherwise the header can show one project while the
// list briefly contains every project's tasks.

import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listCodingAgentTaskThreads: vi.fn(),
}));

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: () => {}, agentProps: {} }),
}));

vi.mock("@elizaos/ui/components", () => ({
  ViewBackButton: () => <button type="button">Back</button>,
}));

vi.mock("@elizaos/ui/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuContent: ({
    children,
    align: _align,
    ...rest
  }: { children: ReactNode; align?: string } & Record<string, unknown>) => (
    <div {...rest}>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    ...rest
  }: {
    children: ReactNode;
    onSelect?: () => void;
  } & Record<string, unknown>) => (
    <button type="button" onClick={() => onSelect?.()} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock("@elizaos/ui", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  Button: ({
    children,
    ...rest
  }: { children: ReactNode } & Record<string, unknown>) => (
    <button type="button" {...rest}>
      {children}
    </button>
  ),
  ChatEmptyStateWithRecommendations: ({
    title,
    testId,
  }: {
    title: ReactNode;
    testId?: string;
  }) => <div data-testid={testId}>{title}</div>,
  client: {
    listProjects: () => calls.listProjects(),
    listCodingAgentTaskThreads: (options: unknown) =>
      calls.listCodingAgentTaskThreads(options),
  },
  useAppSelectorShallow: () => ({ t: undefined, uiLanguage: "en" }),
}));

import { CodingAgentTasksPanel } from "./CodingAgentTasksPanel";

const PROJECT_A = {
  id: "proj-a",
  name: "Alpha",
  localPath: "/home/dev/alpha",
  lastOpenedAt: "2026-07-05T00:00:00.000Z",
};
const PROJECT_B = {
  id: "proj-b",
  name: "Beta",
  localPath: "/home/dev/beta",
  lastOpenedAt: "2026-07-04T00:00:00.000Z",
};

describe("CodingAgentTasksPanel project switcher integration", () => {
  beforeEach(() => {
    calls.listProjects.mockReset();
    calls.listCodingAgentTaskThreads.mockReset();
    calls.listCodingAgentTaskThreads.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  it("filters the first task-thread fetch by the active project when ≥2 projects exist", async () => {
    calls.listProjects.mockResolvedValue({
      projects: [PROJECT_A, PROJECT_B],
      activeProjectId: "proj-a",
    });
    render(<CodingAgentTasksPanel />);

    await waitFor(() =>
      expect(calls.listCodingAgentTaskThreads).toHaveBeenCalledTimes(1),
    );
    expect(calls.listCodingAgentTaskThreads).toHaveBeenCalledWith({
      includeArchived: false,
      search: undefined,
      projectId: "proj-a",
      limit: 30,
    });
  });

  it("does NOT filter with a single project — the list stays unfiltered like today (#14112)", async () => {
    calls.listProjects.mockResolvedValue({
      projects: [PROJECT_A],
      activeProjectId: "proj-a",
    });
    render(<CodingAgentTasksPanel />);

    await waitFor(() =>
      expect(calls.listCodingAgentTaskThreads).toHaveBeenCalledTimes(1),
    );
    // projectId omitted (undefined) → server returns all threads, including
    // project-unbound ones, identical to the pre-switcher single-project view.
    expect(calls.listCodingAgentTaskThreads).toHaveBeenCalledWith({
      includeArchived: false,
      search: undefined,
      projectId: undefined,
      limit: 30,
    });
  });
});

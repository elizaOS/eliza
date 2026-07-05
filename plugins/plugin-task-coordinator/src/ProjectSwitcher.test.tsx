// @vitest-environment jsdom
//
// ProjectSwitcher (#13776 item 5) — drives the switcher through the REAL
// client boundary (mocked) and the dropdown primitives (rendered inline so
// items are always in the DOM for assertions). Proves: it renders one row per
// registered project with the active one marked, selecting a row calls
// client.activateProject and fires onActiveProjectChange with the new id, and
// an empty registry self-hides (renders nothing).

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Local mirror of the client `ProjectSummary` shape — the module is fully
 *  mocked below (no real @elizaos/ui import) so we don't drag core into the
 *  browser test graph. */
interface ProjectSummary {
  id: string;
  name: string;
  localPath: string;
  repoUrl?: string;
  defaultBranch?: string;
  lastOpenedAt: string;
}

const calls = vi.hoisted(() => ({
  listProjects: vi.fn(),
  activateProject: vi.fn(),
}));

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: () => {}, agentProps: {} }),
}));

// Render the dropdown inline: trigger + content are always mounted so items are
// queryable without simulating the Radix portal open sequence.
vi.mock("@elizaos/ui/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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

// Full mock (no importOriginal): the switcher only touches `client`,
// `useAppSelectorShallow`, and `Button`, so stub them and keep @elizaos/core
// out of the browser test graph (mirrors use-orchestrator-data.test.ts).
vi.mock("@elizaos/ui", () => ({
  client: {
    listProjects: () => calls.listProjects(),
    activateProject: (id: string) => calls.activateProject(id),
  },
  // Selector returns a stable no-i18n object so the fallback translate runs.
  useAppSelectorShallow: () => ({ t: undefined }),
  Button: ({
    children,
    ...rest
  }: { children: ReactNode } & Record<string, unknown>) => (
    <button type="button" {...rest}>
      {children}
    </button>
  ),
}));

import { ProjectSwitcher } from "./ProjectSwitcher";

const PROJECT_A: ProjectSummary = {
  id: "proj-a",
  name: "Alpha",
  localPath: "/home/dev/alpha",
  lastOpenedAt: "2026-07-05T00:00:00.000Z",
};
const PROJECT_B: ProjectSummary = {
  id: "proj-b",
  name: "Beta",
  localPath: "/home/dev/beta",
  lastOpenedAt: "2026-07-04T00:00:00.000Z",
};

describe("ProjectSwitcher", () => {
  beforeEach(() => {
    calls.listProjects.mockReset();
    calls.activateProject.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders a row per project with the active one marked", async () => {
    calls.listProjects.mockResolvedValue({
      projects: [PROJECT_A, PROJECT_B],
      activeProjectId: "proj-a",
    });
    render(<ProjectSwitcher />);
    await waitFor(() =>
      expect(screen.getByTestId("project-switcher-menu")).toBeTruthy(),
    );
    expect(screen.getByTestId("project-switcher-item-proj-a")).toBeTruthy();
    expect(screen.getByTestId("project-switcher-item-proj-b")).toBeTruthy();
    // Active row carries the data-active marker; inactive does not.
    expect(
      screen
        .getByTestId("project-switcher-item-proj-a")
        .getAttribute("data-active"),
    ).toBe("true");
    expect(
      screen
        .getByTestId("project-switcher-item-proj-b")
        .getAttribute("data-active"),
    ).toBeNull();
  });

  it("switching a project calls activateProject + fires the change callback", async () => {
    calls.listProjects.mockResolvedValue({
      projects: [PROJECT_A, PROJECT_B],
      activeProjectId: "proj-a",
    });
    calls.activateProject.mockResolvedValue({
      ...PROJECT_B,
      lastOpenedAt: "2026-07-05T12:00:00.000Z",
    });
    const onChange = vi.fn();
    render(<ProjectSwitcher onActiveProjectChange={onChange} />);
    await waitFor(() =>
      expect(screen.getByTestId("project-switcher-item-proj-b")).toBeTruthy(),
    );

    fireEvent.click(screen.getByTestId("project-switcher-item-proj-b"));

    await waitFor(() =>
      expect(calls.activateProject).toHaveBeenCalledWith("proj-b"),
    );
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("proj-b"));
  });

  it("self-hides when the registry has no projects", async () => {
    calls.listProjects.mockResolvedValue({
      projects: [],
      activeProjectId: null,
    });
    const { container } = render(<ProjectSwitcher />);
    // Give the async load a tick to settle, then assert nothing rendered.
    await waitFor(() => expect(calls.listProjects).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByTestId("project-switcher-menu")).toBeNull();
    expect(screen.queryByTestId("project-switcher-trigger")).toBeNull();
    expect(container.textContent).toBe("");
  });
});

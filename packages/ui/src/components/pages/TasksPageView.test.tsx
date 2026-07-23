/**
 * Project-surface composition tests use the real route/query behavior while
 * stubbing the lifecycle inventory and task slot at their package boundaries.
 */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientMock = vi.hoisted(() => ({
  listProjects: vi.fn(),
  activateProject: vi.fn(),
  listInstalledApps: vi.fn(),
  listAppRuns: vi.fn(),
  launchApp: vi.fn(),
  stopApp: vi.fn(),
}));

const panelProps = vi.hoisted(() => ({
  value: null as Record<string, unknown> | null,
}));

const managementProps = vi.hoisted(() => ({
  values: [] as Record<string, unknown>[],
}));

const publicationProps = vi.hoisted(() => ({
  badges: [] as Record<string, unknown>[],
  panel: null as Record<string, unknown> | null,
}));

const INVENTORY = {
  installed: [
    {
      name: "@elizaos/plugin-alpha",
      displayName: "Alpha",
      pluginName: "@elizaos/plugin-alpha",
      version: "1.0.0",
      installedAt: "2026-07-20T00:00:00.000Z",
    },
    {
      name: "weather-tools",
      displayName: "Weather tools",
      pluginName: "weather-tools",
      version: "2.0.0",
      installedAt: "2026-07-20T00:00:00.000Z",
    },
  ],
  runs: [
    {
      runId: "run-alpha",
      appName: "@elizaos/plugin-alpha",
      status: "running",
    },
  ],
};

vi.mock("../../api/client", () => ({ client: clientMock }));

vi.mock("../views/ShellViewAgentSurface", () => ({
  ShellViewAgentSurface: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("../../slots/task-coordinator-slots.js", () => ({
  CodingAgentTasksPanel: (props: Record<string, unknown>) => {
    panelProps.value = props;
    return <div data-testid="coding-agent-tasks-panel-stub" />;
  },
}));

vi.mock(
  "../../cloud/applications/components/project-publication-badge",
  () => ({
    ProjectPublicationBadge: (props: Record<string, unknown>) => {
      publicationProps.badges.push(props);
      return (
        <span data-testid="project-publication-badge-stub">Published</span>
      );
    },
  }),
);

vi.mock("../../cloud/applications/components/project-publish-panel", () => ({
  ProjectPublishPanel: (props: Record<string, unknown>) => {
    publicationProps.panel = props;
    return <div data-testid="project-publish-panel-stub">Publish panel</div>;
  },
}));

vi.mock("../settings/AppsManagementSection", () => ({
  AppsManagementSection: (
    props: Record<string, unknown> & {
      children?: React.ReactNode;
      onInventoryChange?: (snapshot: typeof INVENTORY) => void;
    },
  ) => {
    managementProps.values.push(props);
    React.useEffect(() => {
      props.onInventoryChange?.(INVENTORY);
    }, [props.onInventoryChange]);
    return (
      <div data-testid="apps-management-stub">
        {props.children}
        {props.inventoryOnly ? <span>Run inventory</span> : null}
      </div>
    );
  },
}));

import { findProjectPackage, TasksPageView } from "./TasksPageView";

const PROJECT = {
  id: "project-alpha",
  name: "Alpha",
  localPath: "/workspace/alpha",
  repoUrl: "https://github.com/example/alpha",
  packageName: "@elizaos/plugin-alpha",
  cloudAppId: "cloud-app-alpha",
  lastOpenedAt: "2026-07-22T12:00:00.000Z",
};

beforeEach(() => {
  window.history.replaceState(null, "", "/apps/tasks");
  clientMock.listProjects.mockResolvedValue({
    projects: [PROJECT],
    activeProjectId: PROJECT.id,
  });
  clientMock.activateProject.mockResolvedValue(PROJECT);
  clientMock.listInstalledApps.mockResolvedValue(INVENTORY.installed);
  clientMock.listAppRuns.mockResolvedValue(INVENTORY.runs);
  clientMock.launchApp.mockResolvedValue({ success: true });
  clientMock.stopApp.mockResolvedValue({ success: true });
  managementProps.values = [];
  panelProps.value = null;
  publicationProps.badges = [];
  publicationProps.panel = null;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TasksPageView", () => {
  it("joins package identifiers without treating a display-name collision as ownership", () => {
    const collision = {
      ...INVENTORY.installed[1],
      displayName: "Alpha",
    };

    expect(findProjectPackage(PROJECT, [collision])).toBeNull();
    expect(findProjectPackage(PROJECT, INVENTORY.installed)).toMatchObject({
      name: "@elizaos/plugin-alpha",
    });
    const authoritativeMismatch = {
      ...PROJECT,
      packageName: "@elizaos/plugin-not-alpha",
    };
    expect(
      findProjectPackage(authoritativeMismatch, INVENTORY.installed),
    ).toBeNull();
  });

  it("joins project rows to live runs and excludes project-owned packages from Installed", async () => {
    render(<TasksPageView />);

    expect(
      await screen.findByRole("button", { name: "Open Alpha" }),
    ).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();

    await waitFor(() => {
      const listingProps = managementProps.values.find(
        (props) =>
          props.inventoryOnly !== true &&
          props.excludedAppNames instanceof Set &&
          props.excludedAppNames.has("@elizaos/plugin-alpha"),
      );
      expect(
        (listingProps?.excludedAppNames as Set<string> | undefined)?.has(
          "@elizaos/plugin-alpha",
        ),
      ).toBe(true);
      expect(listingProps?.inventoryVariant).toBe("compact");
      expect(listingProps?.inventoryTitle).toBe("Installed");
    });
  });

  it("opens an in-surface project detail and pins Activity to its project id", async () => {
    render(<TasksPageView />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Alpha" }));

    await waitFor(() => {
      expect(clientMock.activateProject).toHaveBeenCalledWith(PROJECT.id);
      expect(window.location.pathname).toBe("/apps/tasks");
      expect(new URLSearchParams(window.location.search).get("projectId")).toBe(
        PROJECT.id,
      );
    });
    expect(await screen.findByRole("heading", { name: "Alpha" })).toBeTruthy();
    expect(screen.getByTestId("project-overview")).toBeTruthy();
    expect(panelProps.value).toMatchObject({
      projectId: PROJECT.id,
      limit: 4,
    });

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Activity" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(
      await screen.findByTestId("coding-agent-tasks-panel-stub"),
    ).toBeTruthy();
    expect(panelProps.value).toMatchObject({
      fullPage: true,
      projectId: PROJECT.id,
    });
  });

  it("activates a project opened directly by its canonical detail URL", async () => {
    window.history.replaceState(
      null,
      "",
      `/apps/tasks?projectId=${PROJECT.id}`,
    );

    render(<TasksPageView />);

    expect(await screen.findByRole("heading", { name: "Alpha" })).toBeTruthy();
    await waitFor(() => {
      expect(clientMock.activateProject).toHaveBeenCalledTimes(1);
      expect(clientMock.activateProject).toHaveBeenCalledWith(PROJECT.id);
    });
  });

  it("stops a running project from its project row without opening detail", async () => {
    render(<TasksPageView />);

    fireEvent.click(await screen.findByRole("button", { name: "Stop Alpha" }));

    await waitFor(() => {
      expect(clientMock.stopApp).toHaveBeenCalledWith("@elizaos/plugin-alpha");
      expect(clientMock.listInstalledApps).toHaveBeenCalled();
      expect(clientMock.listAppRuns).toHaveBeenCalled();
    });
    expect(new URLSearchParams(window.location.search).has("projectId")).toBe(
      false,
    );
  });

  it("shows only the matched launchable package in Run detail", async () => {
    render(<TasksPageView />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Alpha" }));
    fireEvent.mouseDown(await screen.findByRole("tab", { name: "Run" }), {
      button: 0,
      ctrlKey: false,
    });

    expect(await screen.findByText("Run inventory")).toBeTruthy();
    await waitFor(() => {
      const runProps = managementProps.values.find(
        (props) => props.inventoryOnly === true,
      );
      expect(
        (runProps?.includedAppNames as Set<string> | undefined)?.has(
          "@elizaos/plugin-alpha",
        ),
      ).toBe(true);
      expect(runProps?.inventoryEmptyMessage).toContain(
        "No launchable package",
      );
    });
  });

  it("renders live publication status and mounts Publish for the selected project", async () => {
    render(<TasksPageView />);

    expect(
      await screen.findByTestId("project-publication-badge-stub"),
    ).toBeTruthy();
    expect(publicationProps.badges.at(-1)).toMatchObject({
      project: expect.objectContaining({
        id: PROJECT.id,
        cloudAppId: PROJECT.cloudAppId,
      }),
    });

    fireEvent.click(screen.getByRole("button", { name: "Open Alpha" }));
    fireEvent.mouseDown(await screen.findByRole("tab", { name: "Publish" }), {
      button: 0,
      ctrlKey: false,
    });

    expect(
      await screen.findByTestId("project-publish-panel-stub"),
    ).toBeTruthy();
    expect(publicationProps.panel).toMatchObject({
      project: expect.objectContaining({ id: PROJECT.id }),
      onProjectChanged: expect.any(Function),
    });
  });

  it("renders the designed empty state when no projects are registered", async () => {
    clientMock.listProjects.mockResolvedValue({
      projects: [],
      activeProjectId: null,
    });
    render(<TasksPageView />);

    expect(await screen.findByText("Start your first project")).toBeTruthy();
    expect(
      screen.getByText(
        "Describe what you want to build, or add a workspace you already have.",
      ),
    ).toBeTruthy();
  });

  it.each(["/apps/my-apps", "/cloud-apps"])(
    "replaces the %s alias with the canonical Projects route",
    async (alias) => {
      window.history.replaceState(null, "", alias);
      render(<TasksPageView />);

      await waitFor(() => expect(window.location.pathname).toBe("/apps/tasks"));
    },
  );
});

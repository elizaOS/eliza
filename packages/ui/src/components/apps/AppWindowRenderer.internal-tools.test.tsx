// @vitest-environment jsdom
import "./AppWindowRenderer.routes";

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAppShellPage } from "../../app-shell-registry";
import { AppWindowRenderer } from "./AppWindowRenderer";
import { getInternalToolAppDescriptors } from "./internal-tool-apps";

vi.mock("../pages/SkillsView", () => ({
  SkillsView: () => <div>Internal skills window</div>,
}));
vi.mock("../pages/LogsView", () => ({
  LogsView: () => <div>Internal logs window</div>,
}));

vi.mock("../pages/PluginsPageView", () => ({
  PluginsPageView: () => <div>Internal plugins window</div>,
}));

vi.mock("../pages/TrajectoriesView", () => ({
  TrajectoriesView: () => <div>Internal trajectories window</div>,
}));

vi.mock("../pages/MemoryViewerView", () => ({
  MemoryViewerView: () => <div>Internal memories window</div>,
}));

vi.mock("../pages/RuntimeView", () => ({
  RuntimeView: () => <div>Internal runtime window</div>,
}));

vi.mock("../pages/DatabasePageView", () => ({
  DatabasePageView: () => <div>Internal database window</div>,
}));

vi.mock("../pages/FilesView", () => ({
  FilesView: () => <div>Internal files window</div>,
}));

vi.mock("../pages/TasksPageView", () => ({
  TasksPageView: () => <div>Internal tasks window</div>,
}));

// Load the real lazy chunk during module setup rather than a timed DOM wait.
afterEach(cleanup);

describe("desktop internal tool window routes", () => {
  it.each([
    ["@elizaos/app-skills-viewer", "Internal skills window"],
    ["@elizaos/app-log-viewer", "Internal logs window"],
    ["@elizaos/app-plugin-viewer", "Internal plugins window"],
    ["@elizaos/app-trajectory-viewer", "Internal trajectories window"],
    ["@elizaos/app-memory-viewer", "Internal memories window"],
    ["@elizaos/app-runtime-debugger", "Internal runtime window"],
    ["@elizaos/app-database-viewer", "Internal database window"],
    ["@elizaos/app-files-viewer", "Internal files window"],
    ["@elizaos/plugin-agent-orchestrator", "Internal tasks window"],
  ])("renders the declared desktop window for %s", async (name, label) => {
    const declaration = getInternalToolAppDescriptors().find(
      (entry) => entry.name === name,
    );
    expect(declaration?.windowPath).toMatch(/^\/apps\//);
    if (!declaration?.windowPath)
      throw new Error("Missing declared desktop window");
    const slug = declaration.windowPath.slice("/apps/".length);
    render(<AppWindowRenderer slug={slug} />);
    expect(await screen.findByText(label)).toBeTruthy();
    expect(screen.queryByText(`App not found: ${slug}`)).toBeNull();
  });

  it("renders the declared relationship viewer through its registered page", async () => {
    registerAppShellPage({
      id: "relationships",
      pluginId: "relationships-fixture",
      label: "Relationships",
      path: "/relationships",
      Component: () => <div>Internal relationships window</div>,
    });
    render(<AppWindowRenderer slug="relationships" />);
    expect(
      await screen.findByText("Internal relationships window"),
    ).toBeTruthy();
  });

  it("renders a registered page through its generated agent surface", async () => {
    registerAppShellPage({
      id: "window-route-fixture",
      pluginId: "window-route-fixture-plugin",
      label: "Registered window",
      path: "/apps/registered-window",
      loader: async () => ({
        default: () => <div>Registered window content</div>,
      }),
    });
    const { container } = render(
      <AppWindowRenderer slug="registered-window" />,
    );
    expect(await screen.findByText("Registered window content")).toBeTruthy();
    expect(
      container
        .querySelector('[data-agent-surface-view-id="window-route-fixture"]')
        ?.getAttribute("data-agent-surface-kind"),
    ).toBe("app-shell");
    act(() =>
      registerAppShellPage({
        id: "window-route-fixture",
        pluginId: "window-route-fixture-plugin",
        label: "Registered window",
        path: "/apps/registered-window",
        Component: () => <div>Updated registered window content</div>,
      }),
    );
    expect(
      await screen.findByText("Updated registered window content"),
    ).toBeTruthy();
  });
});

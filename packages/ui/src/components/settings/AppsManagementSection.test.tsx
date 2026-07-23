// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({
  setActionNotice: vi.fn(),
  t: (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

const clientMock = vi.hoisted(() => ({
  listInstalledApps: vi.fn(),
  listAppRuns: vi.fn(),
  fetch: vi.fn(),
  launchApp: vi.fn(),
  stopApp: vi.fn(),
}));

vi.mock("../../state", () => ({
  useAppSelector: (selector: (state: typeof appMock) => unknown) =>
    selector(appMock),
}));
vi.mock("../../api/client", () => ({ client: clientMock }));
vi.mock("./AdvancedToggle.hooks", () => ({
  useAdvancedSettingsEnabled: () => false,
}));
vi.mock("./AdvancedToggle", () => ({ AdvancedToggle: () => null }));

import { AppsManagementSection } from "./AppsManagementSection";

describe("AppsManagementSection failure states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientMock.listInstalledApps.mockResolvedValue([]);
    clientMock.listAppRuns.mockResolvedValue([]);
  });

  afterEach(cleanup);

  it("keeps a rejected create request open and announces the server error", async () => {
    clientMock.fetch.mockResolvedValue({
      ok: false,
      message: "App template could not be created.",
    });
    render(<AppsManagementSection />);

    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Summarize project updates" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    const createError = await screen.findByText(
      "App template could not be created.",
    );
    expect(createError.getAttribute("role")).toBe("alert");
    expect(
      (
        screen.getByLabelText(
          "What do you want to build?",
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("Summarize project updates");
    expect(appMock.setActionNotice).not.toHaveBeenCalled();
  });

  it("keeps a rejected directory load open and announces the server error", async () => {
    clientMock.fetch.mockResolvedValue({
      ok: false,
      message: "That directory is not readable.",
    });
    render(<AppsManagementSection />);

    fireEvent.click(screen.getByRole("button", { name: "Add from folder" }));
    fireEvent.change(screen.getByLabelText("Directory path"), {
      target: { value: "/workspace/my-app" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load" }));

    const loadError = await screen.findByText(
      "That directory is not readable.",
    );
    expect(loadError.getAttribute("role")).toBe("alert");
    expect(
      (screen.getByLabelText("Directory path") as HTMLInputElement).value,
    ).toBe("/workspace/my-app");
    expect(appMock.setActionNotice).not.toHaveBeenCalled();
  });

  it("reports the created project id so Projects can activate and open it", async () => {
    const onProjectsChanged = vi.fn();
    clientMock.fetch.mockResolvedValue({
      success: true,
      text: "Project creation started.",
      data: { projectId: "project-created" },
    });
    render(<AppsManagementSection onProjectsChanged={onProjectsChanged} />);

    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    fireEvent.change(screen.getByLabelText("What do you want to build?"), {
      target: { value: "Build a status page" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(onProjectsChanged).toHaveBeenCalledWith("project-created");
    });
  });

  it("reports the directly loaded project id so Projects can activate and open it", async () => {
    const onProjectsChanged = vi.fn();
    clientMock.fetch.mockResolvedValue({
      ok: true,
      registered: 1,
      projects: [{ id: "project-loaded" }],
    });
    render(<AppsManagementSection onProjectsChanged={onProjectsChanged} />);

    fireEvent.click(screen.getByRole("button", { name: "Add from folder" }));
    fireEvent.change(screen.getByLabelText("Directory path"), {
      target: { value: "/workspace/status-page" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load" }));

    await waitFor(() => {
      expect(onProjectsChanged).toHaveBeenCalledWith("project-loaded");
    });
  });

  it("offers a retry after the installed-app inventory fails", async () => {
    clientMock.listInstalledApps
      .mockRejectedValueOnce(new Error("App service unavailable"))
      .mockResolvedValueOnce([]);
    render(<AppsManagementSection />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "App service unavailable",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(clientMock.listInstalledApps).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText("No installed packages yet.")).toBeTruthy();
  });

  it("renders a compact Installed list without project-owned packages", async () => {
    clientMock.listInstalledApps.mockResolvedValue([
      {
        name: "plugin-owned",
        displayName: "Owned",
        pluginName: "plugin-owned",
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
    ]);
    render(
      <AppsManagementSection
        inventoryOnly
        inventoryVariant="compact"
        excludedAppNames={new Set(["plugin-owned"])}
      />,
    );

    expect(await screen.findByTestId("apps-mgmt-compact-list")).toBeTruthy();
    expect(screen.queryByText("Owned")).toBeNull();
    expect(screen.getByText("Weather tools")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Launch Weather tools" }),
    ).toBeTruthy();
  });
});

/** Verifies AppsManagementSection failure states through the package's configured test harness. */
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

    fireEvent.click(screen.getByRole("button", { name: "Create new app" }));
    fireEvent.change(screen.getByLabelText("What should the app do?"), {
      target: { value: "Summarize project updates" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    const createError = await screen.findByText(
      "App template could not be created.",
    );
    expect(createError.getAttribute("role")).toBe("alert");
    expect(
      (screen.getByLabelText("What should the app do?") as HTMLTextAreaElement)
        .value,
    ).toBe("Summarize project updates");
    expect(appMock.setActionNotice).not.toHaveBeenCalled();
  });

  it("keeps a rejected directory load open and announces the server error", async () => {
    clientMock.fetch.mockResolvedValue({
      ok: false,
      message: "That directory is not readable.",
    });
    render(<AppsManagementSection />);

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "More app actions" }),
      { button: 0, pointerId: 1 },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Import from directory" }),
    );
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
    expect(await screen.findByRole("status")).toBeTruthy();
  });
});

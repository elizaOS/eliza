/** Exercises App Permissions loading, failure recovery, empty, and populated states against the API client boundary. */
// @vitest-environment jsdom

import type { AppPermissionsView } from "@elizaos/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appState = vi.hoisted(() => ({
  setActionNotice: vi.fn(),
}));

const clientMock = vi.hoisted(() => ({
  listAppPermissions: vi.fn(),
  setAppPermissions: vi.fn(),
}));

vi.mock("../../state", () => ({
  useAppSelector: (selector: (state: typeof appState) => unknown) =>
    selector(appState),
}));

vi.mock("../../api/client", () => ({ client: clientMock }));

import { AppPermissionsSection } from "./AppPermissionsSection";

const grantableApp: AppPermissionsView = {
  slug: "example-app",
  trust: "external",
  isolation: "worker",
  requestedPermissions: { fs: { read: ["documents/**"] } },
  recognisedNamespaces: ["fs"],
  grantedNamespaces: [],
  grantedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("AppPermissionsSection terminal states", () => {
  it("renders only loading while the inventory request is unresolved", () => {
    clientMock.listAppPermissions.mockReturnValue(new Promise(() => undefined));

    render(<AppPermissionsSection />);

    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Loading app permissions");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText("No apps declare permissions yet.")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders only the error state and recovers through its retry action", async () => {
    clientMock.listAppPermissions
      .mockRejectedValueOnce(new Error("permission service unavailable"))
      .mockResolvedValueOnce([]);

    render(<AppPermissionsSection />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Unable to load app permissions");
    expect(alert.textContent).toContain("permission service unavailable");
    expect(screen.queryByText("No apps declare permissions yet.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(
      await screen.findByText("No apps declare permissions yet."),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(clientMock.listAppPermissions).toHaveBeenCalledTimes(2);
  });

  it("renders only the designed empty state for an empty inventory", async () => {
    clientMock.listAppPermissions.mockResolvedValue([]);

    render(<AppPermissionsSection />);

    expect(
      await screen.findByText("No apps declare permissions yet."),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Loading app permissions")).toBeNull();
  });

  it("renders permission controls without an empty or error state", async () => {
    clientMock.listAppPermissions.mockResolvedValue([grantableApp]);

    render(<AppPermissionsSection />);

    expect(await screen.findByText("example-app")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Filesystem" })).toBeTruthy();
    expect(screen.queryByText("No apps declare permissions yet.")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps manifest-less apps discoverable inside the designed empty state", async () => {
    clientMock.listAppPermissions.mockResolvedValue([
      {
        ...grantableApp,
        slug: "legacy-app",
        requestedPermissions: null,
        recognisedNamespaces: [],
      },
    ]);

    render(<AppPermissionsSection />);

    expect(
      await screen.findByText("No apps declare permissions yet."),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByText("1 registered app without a permissions manifest"),
    );
    await waitFor(() => expect(screen.getByText("legacy-app")).toBeTruthy());
  });
});

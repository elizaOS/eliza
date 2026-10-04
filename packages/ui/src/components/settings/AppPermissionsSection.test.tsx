/** Exercises App Permissions loading, failure recovery, empty, and populated states against the API client boundary. */
// @vitest-environment jsdom

import type { AppPermissionsView } from "@elizaos/core/contracts/app-permissions";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client-types-core";
import { AppPermissionsSection } from "./AppPermissionsSection";
import { PermissionsCombinedSection } from "./PermissionsCombinedSection";

const appState = vi.hoisted(() => ({
  setActionNotice: vi.fn(),
}));
const clientMock = vi.hoisted(() => ({
  listAppPermissions: vi.fn(),
  setAppPermissions: vi.fn(),
  onBaseUrlChange: vi.fn(),
  unsubscribeBase: vi.fn(),
}));
const baseListeners = vi.hoisted(() => new Set<(baseUrl: string) => void>());
vi.mock("../../state/app-store", () => ({
  useAppSelector: (selector: (state: typeof appState) => unknown) =>
    selector(appState),
}));
vi.mock("../../api/client", () => ({ client: clientMock }));
vi.mock("./PermissionsSection", () => ({
  PermissionsSection: () => <div>Native permissions</div>,
}));
vi.mock("./WebPushSettingsSection", () => ({
  WebPushSettingsSection: () => <div>Web push settings</div>,
}));
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
  vi.resetAllMocks();
  baseListeners.clear();
  clientMock.onBaseUrlChange.mockImplementation((listener) => {
    baseListeners.add(listener);
    return () => {
      baseListeners.delete(listener);
      clientMock.unsubscribeBase();
    };
  });
});
afterEach(cleanup);
describe("AppPermissionsSection terminal states", () => {
  it("removes the optional combined section while preserving the native and web push panels", async () => {
    clientMock.listAppPermissions.mockRejectedValue(
      new ApiError({
        kind: "http",
        status: 404,
        path: "/api/apps/permissions",
        message: "Not found",
      }),
    );
    render(<PermissionsCombinedSection />);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(
      screen.queryByRole("heading", { name: "App permissions" }),
    ).toBeNull();
    expect(
      screen.queryByRole("region", { name: "App permissions" }),
    ).toBeNull();
    expect(screen.getByText("Native permissions")).toBeTruthy();
    expect(screen.getByText("Web push settings")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("No apps declare permissions yet.")).toBeNull();
  });
  it("hides an unsupported inventory without claiming empty or denied grants", async () => {
    clientMock.listAppPermissions.mockRejectedValue(
      new ApiError({
        kind: "http",
        status: 404,
        path: "/api/apps/permissions",
        message: "Not found",
      }),
    );
    const { container } = render(<AppPermissionsSection />);
    await waitFor(() => expect(container.childElementCount).toBe(0));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    expect(screen.queryByText("No apps declare permissions yet.")).toBeNull();
  });
  it.each([
    new ApiError({
      kind: "http",
      status: 401,
      path: "/api/apps/permissions",
      message: "Unauthorized",
    }),
    new ApiError({
      kind: "http",
      status: 403,
      path: "/api/apps/permissions",
      message: "Forbidden",
    }),
    new ApiError({
      kind: "http",
      status: 500,
      path: "/api/apps/permissions",
      message: "Service failed",
    }),
    new ApiError({
      kind: "http",
      status: 404,
      path: "/api/apps/permissions/example-app",
      message: "App missing",
    }),
    new ApiError({
      kind: "network",
      status: 404,
      path: "/api/apps/permissions",
      message: "Network failed",
    }),
    Object.assign(new Error("Untyped missing response"), {
      status: 404,
      path: "/api/apps/permissions",
    }),
  ])("keeps genuine $message errors visible and retryable", async (error) => {
    clientMock.listAppPermissions
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce([grantableApp]);
    render(<AppPermissionsSection />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      error.message,
    );
    expect(
      screen.queryByText("App permissions aren't available on this runtime."),
    ).toBeNull();
    expect(screen.queryByText("No apps declare permissions yet.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(
      await screen.findByRole("switch", { name: "Filesystem" }),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("refetches after a runtime switch and preserves supported grant controls", async () => {
    clientMock.listAppPermissions
      .mockRejectedValueOnce(
        new ApiError({
          kind: "http",
          status: 404,
          path: "/api/apps/permissions",
          message: "Not found",
        }),
      )
      .mockResolvedValueOnce([grantableApp]);
    clientMock.setAppPermissions.mockResolvedValue({
      ...grantableApp,
      grantedNamespaces: ["fs"],
    });
    const { container, unmount } = render(<AppPermissionsSection />);
    await waitFor(() => expect(container.childElementCount).toBe(0));
    act(() => {
      for (const listener of baseListeners)
        listener("https://supported.example");
    });
    const control = await screen.findByRole("switch", { name: "Filesystem" });
    fireEvent.click(control);
    await waitFor(() =>
      expect(clientMock.setAppPermissions).toHaveBeenCalledWith("example-app", [
        "fs",
      ]),
    );
    await waitFor(() =>
      expect(control.getAttribute("aria-checked")).toBe("true"),
    );
    expect(clientMock.listAppPermissions).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByText("App permissions aren't available on this runtime."),
    ).toBeNull();
    unmount();
    expect(clientMock.unsubscribeBase).toHaveBeenCalledOnce();
    expect(baseListeners.size).toBe(0);
  });
  it("ignores an old runtime inventory response after switching to unsupported", async () => {
    let resolveInventory!: (views: AppPermissionsView[]) => void;
    clientMock.listAppPermissions
      .mockReturnValueOnce(
        new Promise<AppPermissionsView[]>((resolve) => {
          resolveInventory = resolve;
        }),
      )
      .mockRejectedValueOnce(
        new ApiError({
          kind: "http",
          status: 404,
          path: "/api/apps/permissions",
          message: "Not found",
        }),
      );
    const { container } = render(<AppPermissionsSection />);
    act(() => {
      for (const listener of baseListeners)
        listener("https://unsupported.example");
    });
    await waitFor(() => expect(container.childElementCount).toBe(0));
    await act(async () => resolveInventory([grantableApp]));
    expect(screen.queryByRole("switch")).toBeNull();
    expect(container.childElementCount).toBe(0);
    expect(screen.queryByText("No apps declare permissions yet.")).toBeNull();
  });
  it("does not apply an old runtime grant completion to the new runtime", async () => {
    let resolveUpdate!: (view: AppPermissionsView) => void;
    clientMock.listAppPermissions.mockResolvedValue([grantableApp]);
    clientMock.setAppPermissions.mockReturnValue(
      new Promise<AppPermissionsView>((resolve) => {
        resolveUpdate = resolve;
      }),
    );
    render(<AppPermissionsSection />);
    fireEvent.click(await screen.findByRole("switch", { name: "Filesystem" }));
    act(() => {
      for (const listener of baseListeners) listener("https://new.example");
    });
    const newControl = await screen.findByRole("switch", {
      name: "Filesystem",
    });
    await act(async () =>
      resolveUpdate({ ...grantableApp, grantedNamespaces: ["fs"] }),
    );
    expect(newControl.getAttribute("aria-checked")).toBe("false");
    expect(appState.setActionNotice).not.toHaveBeenCalled();
  });
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

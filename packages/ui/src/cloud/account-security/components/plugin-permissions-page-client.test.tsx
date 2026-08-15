/**
 * Drives PluginPermissionsPageClient: loading, missing, empty, error, ready,
 * and revoke. jsdom; API client is mocked.
 */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, apiFetchMock, emitAuditEvent, FakeApiError } = vi.hoisted(
  () => {
    class FakeApiError extends Error {
      status: number;
      constructor(status: number, message: string) {
        super(message);
        this.status = status;
        this.name = "ApiError";
      }
    }
    return {
      apiMock: vi.fn(),
      apiFetchMock: vi.fn(),
      emitAuditEvent: vi.fn(),
      FakeApiError,
    };
  },
);

vi.mock("../../lib/api-client", () => ({
  api: apiMock,
  apiFetch: apiFetchMock,
  ApiError: FakeApiError,
}));

vi.mock("../../../cloud-ui", () => ({
  DashboardPageContainer: ({ children }: PropsWithChildren) => (
    <div>{children}</div>
  ),
  useSetPageHeader: () => undefined,
}));

vi.mock("../data/audit-client", () => ({
  emitAuditEvent,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { PluginPermissionsPageClient } from "./plugin-permissions-page-client";

afterEach(cleanup);

describe("PluginPermissionsPageClient", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiFetchMock.mockReset();
    emitAuditEvent.mockReset();
  });

  it("keeps missing, empty, and error states distinct", async () => {
    apiMock.mockRejectedValueOnce(new FakeApiError(404, "not found"));
    const missing = render(<PluginPermissionsPageClient />);
    expect(
      await screen.findByText(/Plugin grant tracking isn't exposed/i),
    ).toBeTruthy();
    expect(
      screen.queryByText(/No plugin has any permission granted/i),
    ).toBeNull();
    missing.unmount();

    apiMock.mockResolvedValueOnce({ grants: [] });
    const empty = render(<PluginPermissionsPageClient />);
    expect(
      await screen.findByText(/No plugin has any permission granted/i),
    ).toBeTruthy();
    expect(
      screen.queryByText(/Plugin grant tracking isn't exposed/i),
    ).toBeNull();
    empty.unmount();

    apiMock.mockRejectedValueOnce(new Error("grants route failed"));
    render(<PluginPermissionsPageClient />);
    expect(await screen.findByText("grants route failed")).toBeTruthy();
    expect(
      screen.queryByText(/No plugin has any permission granted/i),
    ).toBeNull();
  });

  it("revokes a ready grant through the shipped DELETE path", async () => {
    const user = userEvent.setup();
    apiMock
      .mockResolvedValueOnce({
        grants: [
          {
            grant_id: "g-1",
            plugin_id: "plugin-browser",
            plugin_name: "Browser",
            permission: "screen",
            granted_at: "2026-08-01T00:00:00.000Z",
          },
        ],
      })
      .mockResolvedValueOnce({ grants: [] });
    apiFetchMock.mockResolvedValueOnce({});

    render(<PluginPermissionsPageClient />);
    expect(await screen.findByText("Browser")).toBeTruthy();
    await user.click(screen.getByTestId("revoke-g-1"));
    expect(apiFetchMock).toHaveBeenCalledWith("/api/v1/me/plugin-grants/g-1", {
      method: "DELETE",
    });
    expect(
      await screen.findByText(/No plugin has any permission granted/i),
    ).toBeTruthy();
  });
});

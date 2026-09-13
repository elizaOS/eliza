/**
 * Launch-quality Security IA: working controls stay live; unavailable
 * Sessions/MFA/audit/export capabilities must not appear as four peer-level
 * operational rows. jsdom only — no live account mutation.
 */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());
const apiFetchMock = vi.hoisted(() => vi.fn());

vi.mock("../../cloud-ui", () => ({
  DashboardPageContainer: ({ children }: PropsWithChildren) => (
    <div>{children}</div>
  ),
  useSetPageHeader: () => undefined,
}));

vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

vi.mock("../lib/api-client", () => ({
  api: apiMock,
  apiFetch: apiFetchMock,
}));

vi.mock("./data/audit-client", () => ({
  emitAuditEvent: vi.fn(),
}));

vi.mock("./data/consent-store", () => ({
  getTrajectoryLoggingEnabled: vi.fn(() => false),
  getVisionEnabled: vi.fn(() => false),
  setTrajectoryLoggingEnabled: vi.fn(),
  setVisionEnabled: vi.fn(),
}));

vi.mock("./data/account-deletion-client", () => ({
  submitAccountDeletion: vi.fn(),
  endLocalSessionAfterDeletion: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { SecuritySurface } from "./SecuritySurface";

const ALL_AVAILABLE = {
  sessions: true,
  mfa: true,
  auditLog: true,
  dataExport: true,
} as const;

describe("SecuritySurface launch IA", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiFetchMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("hides four peer-level unavailable rows behind one non-interactive notice", () => {
    render(<SecuritySurface />);

    const notice = screen.getByTestId("cloud-unavailable-account-security");
    expect(notice).toBeTruthy();
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.querySelector("button")).toBeNull();
    expect(notice.querySelector("a")).toBeNull();
    expect(notice.querySelector('[role="switch"]')).toBeNull();
    expect(notice.textContent).toMatch(/session inventory/i);
    expect(notice.textContent).toMatch(/two-factor authentication/i);
    expect(notice.textContent).toMatch(/audit-log reading/i);
    expect(notice.textContent).toMatch(/data export/i);

    expect(screen.queryByTestId("cloud-active-sessions")).toBeNull();
    expect(screen.queryByTestId("cloud-mfa-panel")).toBeNull();
    expect(screen.queryByTestId("cloud-recent-audit-events")).toBeNull();
    expect(screen.queryByText("Export unavailable")).toBeNull();
    expect(screen.queryByText("Download my data")).toBeNull();
    expect(screen.queryByText("Active sessions")).toBeNull();
    expect(screen.queryByText("Two-factor authentication")).toBeNull();
    expect(screen.queryByText("Recent security events")).toBeNull();

    expect(screen.getByTestId("cloud-privacy-panel")).toBeTruthy();
    expect(screen.getByTestId("vision-toggle")).toBeTruthy();
    expect(screen.getByTestId("trajectory-toggle")).toBeTruthy();
    expect(screen.getByTestId("delete-account-trigger")).toBeTruthy();
    expect(screen.getByTestId("cloud-plugin-permissions-link")).toBeTruthy();
    expect(screen.getByTestId("cloud-api-keys-link")).toBeTruthy();
    expect(screen.getByTestId("cloud-incident-report")).toBeTruthy();

    expect(apiMock).not.toHaveBeenCalled();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("mounts functional sessions, MFA, and audit panels when those capabilities are available", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path === "/api/v1/sessions") {
        return Promise.resolve({ sessions: [] });
      }
      if (path === "/api/v1/me/mfa") {
        return Promise.resolve({ enrolled: false, method: null });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    render(<SecuritySurface capabilities={ALL_AVAILABLE} />);

    expect(await screen.findByTestId("cloud-active-sessions")).toBeTruthy();
    expect(screen.getByTestId("cloud-mfa-panel")).toBeTruthy();
    expect(screen.getByTestId("cloud-recent-audit-events")).toBeTruthy();
    expect(
      screen.queryByTestId("cloud-unavailable-account-security"),
    ).toBeNull();
    expect(screen.getByTestId("vision-toggle")).toBeTruthy();
    expect(screen.getByTestId("delete-account-trigger")).toBeTruthy();
    expect(screen.queryByText("Export unavailable")).toBeNull();
  });
});

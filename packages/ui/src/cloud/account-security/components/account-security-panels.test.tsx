/**
 * Account-security panel tests for the pinned-unavailable design (#13666).
 *
 * The Worker does not currently expose MFA status or session enumeration, so
 * both panels hold the explicit designed-unavailable state and must not fire
 * dead requests on Security page load. These tests pin that contract: the
 * unavailable copy renders, it never reads as a healthy success state, and no
 * account-security API call leaves either panel. If the backend ships real
 * /api/v1/me/mfa or /api/v1/sessions data flows, rewire the panels first and
 * replace these pins with DTO-driven tests.
 */

// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import type { ButtonHTMLAttributes, PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());
const apiFetchMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/api-client", () => ({
  api: apiMock,
  apiFetch: apiFetchMock,
}));

vi.mock("../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

vi.mock("../../../cloud-ui", () => ({
  BrandButton: ({
    children,
    ...props
  }: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  BrandCard: ({ children }: PropsWithChildren) => <section>{children}</section>,
  CornerBrackets: () => null,
}));

vi.mock("../data/audit-client", () => ({
  emitAuditEvent: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { ActiveSessionsPanel } from "./active-sessions-panel";
import { MfaPanel } from "./mfa-panel";

describe("account-security panels", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiFetchMock.mockReset();
  });

  it("renders the designed MFA-unavailable state without firing a dead request", async () => {
    render(<MfaPanel />);

    expect(
      await screen.findByText(/MFA enrollment is not yet available/i),
    ).toBeTruthy();
    // Unavailable must never read as MFA-disabled success.
    expect(screen.queryByText(/MFA is not enabled/i)).toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("renders the designed sessions-unavailable state without firing a dead request", async () => {
    render(<ActiveSessionsPanel />);

    expect(
      await screen.findByText(/Session listing isn't available yet/i),
    ).toBeTruthy();
    // Unavailable must never read as a healthy empty session list.
    expect(screen.queryByText(/No other active sessions found/i)).toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

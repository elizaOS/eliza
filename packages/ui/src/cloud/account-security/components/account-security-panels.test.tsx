/**
 * Account-security panel tests for explicit backend-unavailable DTOs.
 *
 * The Security page used to infer "not available" from route 404s. These tests
 * pin the cleaner contract: the backend responds, and the panels render the
 * designed unavailable copy without turning malformed DTOs into empty success.
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

  it("renders MFA unavailable from the explicit DTO", async () => {
    apiMock.mockResolvedValue({
      available: false,
      reason: "mfa_enrollment_unavailable",
      enrolled: false,
      method: null,
    });

    render(<MfaPanel />);

    expect(
      await screen.findByText(/MFA enrollment is not yet available/i),
    ).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith("/api/v1/me/mfa");
  });

  it("renders sessions unavailable from the explicit DTO", async () => {
    apiMock.mockResolvedValue({
      available: false,
      reason: "session_inventory_unavailable",
      sessions: [],
    });

    render(<ActiveSessionsPanel />);

    expect(
      await screen.findByText(/Session listing isn't available yet/i),
    ).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith("/api/v1/sessions");
  });

  it("does not turn a malformed sessions DTO into a healthy empty state", async () => {
    apiMock.mockResolvedValue({});

    render(<ActiveSessionsPanel />);

    expect(await screen.findByText("Malformed sessions response")).toBeTruthy();
    expect(screen.queryByText(/No other active sessions found/i)).toBeNull();
  });

  it("does not turn a malformed MFA DTO into disabled-MFA success", async () => {
    apiMock.mockResolvedValue({});

    render(<MfaPanel />);

    expect(
      await screen.findByText("Malformed MFA status response"),
    ).toBeTruthy();
    expect(screen.queryByText(/MFA is not enabled/i)).toBeNull();
  });
});

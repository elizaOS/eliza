/**
 * Account-security panel tests for explicit unavailable DTOs.
 *
 * The cloud Worker exposes read contracts for MFA and session inventory even
 * while those features are unavailable. These tests pin the three-state UI:
 * loading, designed-unavailable, healthy empty, and transport error must remain
 * distinguishable.
 */

// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen } from "@testing-library/react";
import type { ButtonHTMLAttributes, PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  Switch: ({
    checked,
    onCheckedChange: _onCheckedChange,
    ...props
  }: PropsWithChildren<{
    checked?: boolean;
    onCheckedChange?: unknown;
    "data-testid"?: string;
  }>) => <input type="checkbox" checked={checked} readOnly {...props} />,
}));

vi.mock("lucide-react", () => ({
  Camera: () => <span data-testid="icon-camera" />,
  Download: () => <span data-testid="icon-download" />,
  Lock: () => <span data-testid="icon-lock" />,
  ScrollText: () => <span data-testid="icon-scroll-text" />,
  Trash2: () => <span data-testid="icon-trash" />,
}));

vi.mock("../data/audit-client", () => ({
  emitAuditEvent: vi.fn(),
}));

vi.mock("../data/consent-store", () => ({
  getTrajectoryLoggingEnabled: vi.fn(() => false),
  getVisionEnabled: vi.fn(() => false),
  setTrajectoryLoggingEnabled: vi.fn(),
  setVisionEnabled: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { ActiveSessionsPanel } from "./active-sessions-panel";
import { MfaPanel } from "./mfa-panel";
import { RecentAuditEvents } from "./recent-audit-events";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRIVACY_PANEL_SOURCE = path.join(HERE, "privacy-panel.tsx");

describe("account-security panels", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiFetchMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders MFA unavailable from the backend DTO", async () => {
    apiMock.mockResolvedValueOnce({
      available: false,
      reason: "mfa_enrollment_unavailable",
      enrolled: false,
      method: null,
    });

    render(<MfaPanel />);

    expect(screen.getByText(/Loading MFA status/i)).toBeTruthy();
    expect(
      await screen.findByText(/MFA enrollment is unavailable/i),
    ).toBeTruthy();
    expect(screen.queryByText(/MFA is not enabled/i)).toBeNull();
    expect(apiMock).toHaveBeenCalledWith("/api/v1/me/mfa");
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("renders sessions unavailable from the backend DTO", async () => {
    apiMock.mockResolvedValueOnce({
      available: false,
      reason: "session_inventory_unavailable",
      sessions: [],
    });

    render(<ActiveSessionsPanel />);

    expect(screen.getByText(/Loading sessions/i)).toBeTruthy();
    expect(
      await screen.findByText(/Session listing is unavailable/i),
    ).toBeTruthy();
    expect(screen.queryByText(/No other active sessions found/i)).toBeNull();
    expect(apiMock).toHaveBeenCalledWith("/api/v1/sessions");
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("renders healthy empty sessions only when the DTO is available", async () => {
    apiMock.mockResolvedValueOnce({ sessions: [] });

    render(<ActiveSessionsPanel />);

    expect(
      await screen.findByText(/No other active sessions found/i),
    ).toBeTruthy();
    expect(screen.queryByText(/Session listing is unavailable/i)).toBeNull();
    expect(apiMock).toHaveBeenCalledWith("/api/v1/sessions");
  });

  it("renders malformed session DTOs as errors, not healthy empty state", async () => {
    apiMock.mockResolvedValueOnce({});

    render(<ActiveSessionsPanel />);

    expect(
      await screen.findByText(/Session inventory response was malformed/i),
    ).toBeTruthy();
    expect(screen.queryByText(/No other active sessions found/i)).toBeNull();
    expect(screen.queryByText(/Session listing is unavailable/i)).toBeNull();
  });

  it("renders MFA errors separately from unavailable and disabled", async () => {
    apiMock.mockRejectedValueOnce(new Error("mfa route failed"));

    render(<MfaPanel />);

    expect(await screen.findByText("mfa route failed")).toBeTruthy();
    expect(screen.queryByText(/MFA enrollment is unavailable/i)).toBeNull();
    expect(screen.queryByText(/MFA is not enabled/i)).toBeNull();
  });

  it("renders malformed MFA DTOs as errors, not disabled state", async () => {
    apiMock.mockResolvedValueOnce({});

    render(<MfaPanel />);

    expect(
      await screen.findByText(/MFA status response was malformed/i),
    ).toBeTruthy();
    expect(screen.queryByText(/MFA enrollment is unavailable/i)).toBeNull();
    expect(screen.queryByText(/MFA is not enabled/i)).toBeNull();
  });

  it("renders audit events unavailable without calling the missing read route", () => {
    render(<RecentAuditEvents />);

    expect(screen.getByText(/Audit log reading is unavailable/i)).toBeTruthy();
    expect(apiMock).not.toHaveBeenCalled();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("keeps DSR controls disabled without wiring missing export/delete endpoints", () => {
    const source = readFileSync(PRIVACY_PANEL_SOURCE, "utf8");

    expect(source).toContain("Export unavailable");
    expect(source).toContain("Deletion unavailable");
    expect(source).toContain('data-testid="delete-account-trigger"');
    expect(source).not.toContain("/api/v1/me/export");
    expect(source).not.toContain("/api/v1/me/delete-request");
  });
});

/**
 * Account-security panel tests for unavailable launch surfaces.
 *
 * The cloud Worker does not expose account-security read/write routes for these
 * panels yet, so the UI must render explicit unavailable states without firing
 * dead account calls, fabricating successful requests, or reading unavailable
 * data as a healthy empty state.
 */

// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

  it("renders MFA unavailable without calling the missing status endpoint", () => {
    render(<MfaPanel />);

    expect(screen.getByText(/MFA enrollment is unavailable/i)).toBeTruthy();
    expect(screen.queryByText(/MFA is not enabled/i)).toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("renders sessions unavailable without calling session inventory", () => {
    render(<ActiveSessionsPanel />);

    expect(screen.getByText(/Session listing is unavailable/i)).toBeTruthy();
    expect(screen.queryByText(/No other active sessions found/i)).toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
    expect(apiFetchMock).not.toHaveBeenCalled();
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

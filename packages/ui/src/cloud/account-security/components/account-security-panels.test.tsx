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
import type { PropsWithChildren } from "react";
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
  ChevronRight: () => <span data-testid="icon-chevron" />,
  Download: () => <span data-testid="icon-download" />,
  KeyRound: () => <span data-testid="icon-key" />,
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
import { ApiKeysLink } from "./api-keys-link";
import { MfaPanel } from "./mfa-panel";
import { PluginPermissionsLink } from "./plugin-permissions-link";
import { RecentAuditEvents } from "./recent-audit-events";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRIVACY_PANEL_SOURCE = path.join(HERE, "privacy-panel.tsx");
const ACCOUNT_DELETION_DIALOG_SOURCE = path.join(
  HERE,
  "account-deletion-dialog.tsx",
);
const ACCOUNT_DELETION_PAGE_SOURCE = path.join(
  HERE,
  "../../public-pages/pages/legal/account-deletion-page.tsx",
);

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

  it("renders a ready session inventory as settings rows", async () => {
    apiMock.mockResolvedValueOnce({
      sessions: [
        {
          id: "sess-1",
          device: "MacBook Pro",
          ip: "100.64.1.9",
          last_seen: "2026-08-14T12:00:00.000Z",
          current: true,
        },
      ],
    });

    render(<ActiveSessionsPanel />);

    expect(await screen.findByText("MacBook Pro")).toBeTruthy();
    expect(screen.getByText("current")).toBeTruthy();
    expect(screen.queryByText(/No other active sessions found/i)).toBeNull();
    expect(screen.queryByText(/Session listing is unavailable/i)).toBeNull();
  });

  it("routes the API keys nav row to the cloud-api-keys hash", () => {
    render(<ApiKeysLink />);
    const link = screen.getByRole("link", { name: "Manage keys" });
    expect(link.getAttribute("href")).toBe("#cloud-api-keys");
  });

  it("routes the plugin permissions nav row to the cloud-plugin-grants hash", () => {
    render(<PluginPermissionsLink />);
    const link = screen.getByRole("link", { name: "Manage permissions" });
    expect(link.getAttribute("href")).toBe("#cloud-plugin-grants");
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

  it("keeps export unavailable while wiring the real account-deletion endpoint", () => {
    const source = readFileSync(PRIVACY_PANEL_SOURCE, "utf8");
    const deletionDialog = readFileSync(ACCOUNT_DELETION_DIALOG_SOURCE, "utf8");
    const deletionPage = readFileSync(ACCOUNT_DELETION_PAGE_SOURCE, "utf8");

    expect(source).toContain("Export unavailable");
    expect(source).toContain("<AccountDeletionDialog />");
    expect(source).not.toContain("Deletion unavailable");
    expect(deletionDialog).toContain('data-testid="delete-account-trigger"');
    expect(deletionDialog).toContain("submitAccountDeletion");
    expect(deletionDialog).not.toContain("?requested=");
    expect(deletionPage).toContain("readAccountDeletionStatus");
    expect(deletionPage).toContain("cancelAccountDeletion");
    expect(deletionPage).not.toContain("useSearchParams");
    expect(deletionPage).not.toContain('params.get("requested")');
    expect(source).not.toContain("/api/v1/me/export");
    expect(deletionDialog).not.toContain("/api/v1/me/delete-request");
  });
});

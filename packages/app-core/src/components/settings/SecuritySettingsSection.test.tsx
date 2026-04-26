// @vitest-environment jsdom
/**
 * Unit tests for SecuritySettingsSection — sessions list and revoke.
 *
 * Network calls are mocked via vi.mock so no backend is needed.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock auth-client at the module level.
vi.mock("../../api/auth-client", () => ({
  authChangePassword: vi.fn(),
  authListSessions: vi.fn(),
  authMe: vi.fn(),
  authRevokeSession: vi.fn(),
  authSetup: vi.fn(),
}));

import {
  authChangePassword,
  authListSessions,
  authMe,
  authRevokeSession,
  authSetup,
} from "../../api/auth-client";
import { SecuritySettingsSection } from "./SecuritySettingsSection";

const mockAuthMe = authMe as ReturnType<typeof vi.fn>;
const mockAuthSetup = authSetup as ReturnType<typeof vi.fn>;
const mockAuthChangePassword = authChangePassword as ReturnType<typeof vi.fn>;
const mockListSessions = authListSessions as ReturnType<typeof vi.fn>;
const mockRevoke = authRevokeSession as ReturnType<typeof vi.fn>;

afterEach(cleanup);
afterEach(() => vi.clearAllMocks());

beforeEach(() => {
  mockAuthMe.mockResolvedValue({
    ok: true,
    identity: { id: "owner-1", displayName: "Owner", kind: "owner" },
    session: { id: "local-loopback", kind: "local", expiresAt: null },
    access: {
      mode: "local",
      passwordConfigured: false,
      ownerConfigured: false,
    },
  });
  mockAuthSetup.mockResolvedValue({
    ok: true,
    identity: { id: "owner-1", displayName: "Owner", kind: "owner" },
    session: { id: "sess-1", kind: "browser", expiresAt: Date.now() + 60_000 },
    csrfToken: "csrf",
  });
  mockAuthChangePassword.mockResolvedValue({ ok: true });
});

const MOCK_SESSION_A = {
  id: "sess-A",
  kind: "browser" as const,
  ip: "127.0.0.1",
  userAgent: "Mozilla/5.0 (Macintosh)",
  lastSeenAt: Date.now() - 60_000,
  expiresAt: Date.now() + 3_600_000,
  current: true,
};

const MOCK_SESSION_B = {
  id: "sess-B",
  kind: "browser" as const,
  ip: "10.0.0.1",
  userAgent: "Mozilla/5.0 (Linux)",
  lastSeenAt: Date.now() - 120_000,
  expiresAt: Date.now() + 7_200_000,
  current: false,
};

describe("SecuritySettingsSection — sessions list", () => {
  it("shows loading state initially", () => {
    mockListSessions.mockReturnValue(new Promise(() => {})); // never resolves
    render(<SecuritySettingsSection />);
    expect(screen.getByText(/loading sessions/i)).toBeDefined();
  });

  it("renders sessions after load", async () => {
    mockListSessions.mockResolvedValue({
      ok: true,
      sessions: [MOCK_SESSION_A, MOCK_SESSION_B],
    });
    render(<SecuritySettingsSection />);
    await waitFor(() =>
      expect(screen.queryByText(/loading sessions/i)).toBeNull(),
    );
    // Current session should not have a revoke button.
    expect(screen.queryAllByRole("button", { name: /revoke/i })).toHaveLength(
      1,
    );
    // Both sessions should be visible.
    expect(screen.getByText(/127.0.0.1/)).toBeDefined();
    expect(screen.getByText(/10.0.0.1/)).toBeDefined();
  });

  it("marks the current session with a badge", async () => {
    mockListSessions.mockResolvedValue({
      ok: true,
      sessions: [MOCK_SESSION_A],
    });
    render(<SecuritySettingsSection />);
    await waitFor(() =>
      expect(screen.queryByText(/loading sessions/i)).toBeNull(),
    );
    expect(screen.getByText(/this session/i)).toBeDefined();
  });

  it("shows error message when list fails", async () => {
    mockListSessions.mockResolvedValue({ ok: false, status: 401 });
    render(<SecuritySettingsSection />);
    await waitFor(() =>
      expect(screen.getByText(/you must be signed in/i)).toBeDefined(),
    );
  });

  it("revoke button calls authRevokeSession and reloads", async () => {
    mockListSessions
      .mockResolvedValueOnce({
        ok: true,
        sessions: [MOCK_SESSION_A, MOCK_SESSION_B],
      })
      .mockResolvedValueOnce({ ok: true, sessions: [MOCK_SESSION_A] });
    mockRevoke.mockResolvedValue({ ok: true });

    const user = userEvent.setup();
    render(<SecuritySettingsSection />);

    await waitFor(() =>
      expect(screen.queryByText(/loading sessions/i)).toBeNull(),
    );
    const revokeBtn = screen.getByRole("button", { name: /revoke/i });
    await user.click(revokeBtn);

    await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith("sess-B"));
    // List should reload after revoke.
    expect(mockListSessions).toHaveBeenCalledTimes(2);
  });

  it("shows no sessions message when list is empty", async () => {
    mockListSessions.mockResolvedValue({ ok: true, sessions: [] });
    render(<SecuritySettingsSection />);
    await waitFor(() =>
      expect(screen.getByText(/no active sessions/i)).toBeDefined(),
    );
  });
});

describe("SecuritySettingsSection — password change section", () => {
  beforeEach(() => {
    mockListSessions.mockResolvedValue({ ok: true, sessions: [] });
  });

  it("renders local remote-password setup without current password", async () => {
    render(<SecuritySettingsSection />);
    await waitFor(() =>
      expect(screen.queryByText(/loading sessions/i)).toBeNull(),
    );
    expect(screen.getByText(/local access/i)).toBeDefined();
    expect(screen.queryByLabelText(/current password/i)).toBeNull();
    expect(screen.getByLabelText(/display name/i)).toBeDefined();
    expect(screen.getByLabelText(/^new password$/i)).toBeDefined();
    expect(screen.getByLabelText(/^confirm new password$/i)).toBeDefined();
  });

  it("set button is disabled when fields are empty", async () => {
    render(<SecuritySettingsSection />);
    await waitFor(() =>
      expect(screen.queryByText(/loading sessions/i)).toBeNull(),
    );
    expect(
      (
        screen.getByRole("button", {
          name: /set remote password/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("calls setup when no owner exists on local access", async () => {
    const user = userEvent.setup();
    render(<SecuritySettingsSection />);
    await waitFor(() =>
      expect(screen.queryByText(/loading password settings/i)).toBeNull(),
    );

    await user.clear(screen.getByLabelText(/display name/i));
    await user.type(screen.getByLabelText(/display name/i), "Admin");
    await user.type(
      screen.getByLabelText(/^new password$/i),
      "new secure password 1!",
    );
    await user.type(
      screen.getByLabelText(/^confirm new password$/i),
      "new secure password 1!",
    );
    await user.click(
      screen.getByRole("button", { name: /set remote password/i }),
    );

    await waitFor(() =>
      expect(mockAuthSetup).toHaveBeenCalledWith({
        displayName: "Admin",
        password: "new secure password 1!",
      }),
    );
  });

  it("requires current password for remote sessions", async () => {
    mockAuthMe.mockResolvedValue({
      ok: true,
      identity: { id: "owner-1", displayName: "Owner", kind: "owner" },
      session: {
        id: "sess-1",
        kind: "browser",
        expiresAt: Date.now() + 60_000,
      },
      access: {
        mode: "session",
        passwordConfigured: true,
        ownerConfigured: true,
      },
    });

    render(<SecuritySettingsSection />);
    await waitFor(() =>
      expect(screen.queryByText(/loading password settings/i)).toBeNull(),
    );
    expect(screen.getByLabelText(/current password/i)).toBeDefined();
  });
});

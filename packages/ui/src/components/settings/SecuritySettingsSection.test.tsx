// @vitest-environment jsdom
//
// Behavioral coverage for the AUTH-CRITICAL security settings surface:
//  - remote-password SETUP (local host, owner not yet configured) → authSetup
//  - remote-password CHANGE (remote/session) → authChangePassword w/ current pw
//  - validation gates: min length (>=12), confirm mismatch, empty, current pw
//  - a FAILED auth call surfaces an error and does NOT flip to a success state
//  - session revocation fires the exact revoke call + reloads only on success
//
// The auth API boundary (../../api/auth-client) is the only collaborator we
// mock — everything under test (RemotePasswordSection / SessionsSection state
// machines, canSubmit gating, error/success rendering) runs for real.

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AuthAccessInfo,
  AuthSessionListEntry,
} from "../../api/auth-client";

const auth = vi.hoisted(() => ({
  authMe: vi.fn(),
  authListSessions: vi.fn(),
  authRevokeSession: vi.fn(),
  authChangePassword: vi.fn(),
  authSetup: vi.fn(),
}));

vi.mock("../../api/auth-client", () => auth);

vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

vi.mock("../../config/boot-config-react.hooks", () => ({
  useBootConfig: () => ({}),
}));

// STABLE translation object. Returning a fresh `{ t }` per render made `t`
// change every render, so the component's `load = useCallback(..., [t])` and its
// `useEffect(..., [load])` re-ran on every render — setState → re-render →
// new t → infinite loop (the whole file hung). The real useTranslation returns
// a stable t; mirror that with a hoisted singleton.
const i18nMock = vi.hoisted(() => {
  const t = (key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? key;
  return { t, uiLanguage: "en", setUiLanguage: () => {} };
});
vi.mock("../../state/TranslationContext.hooks", () => ({
  useTranslation: () => i18nMock,
}));

vi.mock("./AdvancedToggle", () => ({ AdvancedToggle: () => <div /> }));
vi.mock("./AdvancedToggle.hooks", () => ({
  useAdvancedSettingsEnabled: () => false,
}));

import { SecuritySettingsSection } from "./SecuritySettingsSection";

const VALID_PW = "correcthorse12"; // 14 chars, >= 12 minimum
const SHORT_PW = "shortpw12"; // 9 chars, < 12

function loadedAccess(access: AuthAccessInfo) {
  auth.authMe.mockResolvedValue({
    ok: true,
    identity: { id: "u1", displayName: "Owner", kind: "owner" },
    session: { id: "s1", kind: "local", expiresAt: null },
    access,
  });
}

function session(
  over: Partial<AuthSessionListEntry> & { id: string },
): AuthSessionListEntry {
  return {
    kind: "browser",
    ip: "10.0.0.5",
    userAgent: "Mozilla/5.0",
    lastSeenAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
    current: false,
    ...over,
  };
}

beforeEach(() => {
  for (const fn of Object.values(auth)) fn.mockReset();
  // Default: no sessions so SessionsSection settles without noise.
  auth.authListSessions.mockResolvedValue({ ok: true, sessions: [] });
});

afterEach(() => cleanup());

describe("RemotePasswordSection — setup mode (local host, owner not configured)", () => {
  const SETUP_ACCESS: AuthAccessInfo = {
    mode: "local",
    passwordConfigured: false,
    ownerConfigured: false,
  };

  it("submits authSetup with the exact display name + password on a valid form", async () => {
    const user = userEvent.setup();
    loadedAccess(SETUP_ACCESS);
    auth.authSetup.mockResolvedValue({
      ok: true,
      identity: { id: "u1", displayName: "Owner", kind: "owner" },
      session: { id: "s1", kind: "local", expiresAt: null },
      csrfToken: "tok",
    });

    render(<SecuritySettingsSection />);

    // Setup mode shows a display-name field and the "Set remote password" CTA.
    const newPw = await screen.findByLabelText("New password");
    const confirmPw = screen.getByLabelText("Confirm new password");
    const submit = screen.getByRole("button", { name: "Set remote password" });

    // Empty form → gated.
    expect(submit.hasAttribute("disabled")).toBe(true);

    await user.type(newPw, VALID_PW);
    await user.type(confirmPw, VALID_PW);

    await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
    await user.click(submit);

    await waitFor(() => expect(auth.authSetup).toHaveBeenCalledTimes(1));
    expect(auth.authSetup).toHaveBeenCalledWith({
      displayName: "Owner",
      password: VALID_PW,
    });
    // Setup, not change: the change endpoint must never be hit here.
    expect(auth.authChangePassword).not.toHaveBeenCalled();

    // Success surfaces + fields are cleared + access is re-fetched.
    await screen.findByText(
      "Remote access enabled. Remote browsers can sign in with this password.",
    );
    expect((newPw as HTMLInputElement).value).toBe("");
    expect(auth.authMe.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps submit gated when the new password is under 12 chars", async () => {
    const user = userEvent.setup();
    loadedAccess(SETUP_ACCESS);
    render(<SecuritySettingsSection />);

    const newPw = await screen.findByLabelText("New password");
    const confirmPw = screen.getByLabelText("Confirm new password");
    const submit = screen.getByRole("button", { name: "Set remote password" });

    await user.type(newPw, SHORT_PW);
    await user.type(confirmPw, SHORT_PW);

    // Matching but too short → still gated; no call escapes.
    expect(submit.hasAttribute("disabled")).toBe(true);
    await user.click(submit);
    expect(auth.authSetup).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only display name (adversarial)", async () => {
    const user = userEvent.setup();
    loadedAccess(SETUP_ACCESS);
    render(<SecuritySettingsSection />);

    const displayName = await screen.findByLabelText("Display name");
    const newPw = screen.getByLabelText("New password");
    const confirmPw = screen.getByLabelText("Confirm new password");
    const submit = screen.getByRole("button", { name: "Set remote password" });

    await user.clear(displayName);
    await user.type(displayName, "   ");
    await user.type(newPw, VALID_PW);
    await user.type(confirmPw, VALID_PW);

    expect(submit.hasAttribute("disabled")).toBe(true);
    await user.click(submit);
    expect(auth.authSetup).not.toHaveBeenCalled();
  });

  it("shows a mismatch error + marks the confirm field invalid + gates submit", async () => {
    const user = userEvent.setup();
    loadedAccess(SETUP_ACCESS);
    render(<SecuritySettingsSection />);

    const newPw = await screen.findByLabelText("New password");
    const confirmPw = screen.getByLabelText("Confirm new password");
    const submit = screen.getByRole("button", { name: "Set remote password" });

    await user.type(newPw, VALID_PW);
    await user.type(confirmPw, "totallydifferent99");

    await screen.findByText("Passwords do not match.");
    expect(confirmPw.getAttribute("aria-invalid")).toBe("true");
    expect(submit.hasAttribute("disabled")).toBe(true);
    expect(auth.authSetup).not.toHaveBeenCalled();
  });
});

describe("RemotePasswordSection — change mode (remote session)", () => {
  const REMOTE_ACCESS: AuthAccessInfo = {
    mode: "session",
    passwordConfigured: true,
    ownerConfigured: true,
  };

  it("requires the current password and sends the exact change payload", async () => {
    const user = userEvent.setup();
    loadedAccess(REMOTE_ACCESS);
    auth.authChangePassword.mockResolvedValue({ ok: true });

    render(<SecuritySettingsSection />);

    const current = await screen.findByLabelText("Current password");
    const newPw = screen.getByLabelText("New password");
    const confirmPw = screen.getByLabelText("Confirm new password");
    const submit = screen.getByRole("button", {
      name: "Change remote password",
    });

    // Missing current password → gated even with a valid new password.
    await user.type(newPw, VALID_PW);
    await user.type(confirmPw, VALID_PW);
    expect(submit.hasAttribute("disabled")).toBe(true);

    await user.type(current, "oldpassword123");
    await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
    await user.click(submit);

    await waitFor(() => expect(auth.authChangePassword).toHaveBeenCalledTimes(1));
    expect(auth.authChangePassword).toHaveBeenCalledWith({
      currentPassword: "oldpassword123",
      newPassword: VALID_PW,
    });
    expect(auth.authSetup).not.toHaveBeenCalled();
  });

  it("surfaces a failed change as an error and does NOT show a success state", async () => {
    const user = userEvent.setup();
    loadedAccess(REMOTE_ACCESS);
    auth.authChangePassword.mockResolvedValue({
      ok: false,
      status: 401,
      reason: "invalid_credentials",
      message: "Current password is incorrect.",
    });

    render(<SecuritySettingsSection />);

    const current = await screen.findByLabelText("Current password");
    const newPw = screen.getByLabelText("New password");
    const confirmPw = screen.getByLabelText("Confirm new password");
    const submit = screen.getByRole("button", {
      name: "Change remote password",
    });

    await user.type(current, "wrongpassword1");
    await user.type(newPw, VALID_PW);
    await user.type(confirmPw, VALID_PW);
    await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
    await user.click(submit);

    // The server message renders in the alert region...
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Current password is incorrect.");
    // ...and the success confirmation must be absent.
    expect(
      screen.queryByText(
        "Remote access enabled. Remote browsers can sign in with this password.",
      ),
    ).toBeNull();
  });
});

describe("SessionsSection — revocation", () => {
  const REMOTE_ACCESS: AuthAccessInfo = {
    mode: "session",
    passwordConfigured: true,
    ownerConfigured: true,
  };

  it("revokes the exact session id and reloads the list on success", async () => {
    const user = userEvent.setup();
    loadedAccess(REMOTE_ACCESS);
    auth.authListSessions.mockResolvedValue({
      ok: true,
      sessions: [
        session({ id: "sess-current", current: true }),
        session({ id: "sess-other", current: false }),
      ],
    });
    auth.authRevokeSession.mockResolvedValue({ ok: true });

    render(<SecuritySettingsSection />);

    const revoke = await screen.findByRole("button", {
      name: "Revoke this session",
    });
    // One list load happened on mount.
    expect(auth.authListSessions).toHaveBeenCalledTimes(1);

    await user.click(revoke);

    await waitFor(() =>
      expect(auth.authRevokeSession).toHaveBeenCalledWith("sess-other"),
    );
    // ok:true → the section reloads sessions (second list call).
    await waitFor(() =>
      expect(auth.authListSessions).toHaveBeenCalledTimes(2),
    );
  });

  it("does NOT reload the list when the revoke call fails", async () => {
    const user = userEvent.setup();
    loadedAccess(REMOTE_ACCESS);
    auth.authListSessions.mockResolvedValue({
      ok: true,
      sessions: [
        session({ id: "sess-current", current: true }),
        session({ id: "sess-other", current: false }),
      ],
    });
    auth.authRevokeSession.mockResolvedValue({ ok: false, status: 401 });

    render(<SecuritySettingsSection />);

    const revoke = await screen.findByRole("button", {
      name: "Revoke this session",
    });
    await user.click(revoke);

    await waitFor(() =>
      expect(auth.authRevokeSession).toHaveBeenCalledTimes(1),
    );
    // Failure must not trigger a reload — still exactly the mount load.
    expect(auth.authListSessions).toHaveBeenCalledTimes(1);
  });
});

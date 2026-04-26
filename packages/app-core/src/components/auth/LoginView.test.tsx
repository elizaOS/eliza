// @vitest-environment jsdom
/**
 * Unit tests for LoginView.
 *
 * Tests each tab independently. All network calls are replaced with
 * injected mock functions.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthLoginResult } from "../../api/auth-client";
import { LoginView } from "./LoginView";

afterEach(cleanup);

const SUCCESS_RESULT: AuthLoginResult = {
  ok: true,
  identity: { id: "id-1", displayName: "Admin", kind: "owner" },
  session: { id: "sess-1", kind: "browser", expiresAt: Date.now() + 3_600_000 },
  csrfToken: "csrf-abc",
};

// ── Password tab ──────────────────────────────────────────────────────────────

describe("LoginView — Password tab", () => {
  it("renders the password tab by default", () => {
    render(<LoginView onLoginSuccess={vi.fn()} loginFn={vi.fn()} />);
    expect(screen.getByLabelText(/display name/i)).toBeDefined();
    expect(
      screen.getByLabelText(/^password$/i, { selector: "input" }),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeDefined();
  });

  it("submit is disabled when fields are empty", () => {
    render(<LoginView onLoginSuccess={vi.fn()} loginFn={vi.fn()} />);
    expect(
      (screen.getByRole("button", { name: /sign in/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("calls loginFn and onLoginSuccess on success", async () => {
    const user = userEvent.setup();
    const loginFn = vi.fn().mockResolvedValue(SUCCESS_RESULT);
    const onLoginSuccess = vi.fn();

    render(<LoginView onLoginSuccess={onLoginSuccess} loginFn={loginFn} />);

    await user.type(screen.getByLabelText(/display name/i), "Admin");
    await user.type(
      screen.getByLabelText(/^password$/i, { selector: "input" }),
      "correctpassword",
    );
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(onLoginSuccess).toHaveBeenCalledOnce());
    expect(loginFn).toHaveBeenCalledWith({
      displayName: "Admin",
      password: "correctpassword",
      rememberDevice: false,
    });
  });

  it("passes rememberDevice=true when checkbox is checked", async () => {
    const user = userEvent.setup();
    const loginFn = vi.fn().mockResolvedValue(SUCCESS_RESULT);

    render(<LoginView onLoginSuccess={vi.fn()} loginFn={loginFn} />);

    await user.type(screen.getByLabelText(/display name/i), "Admin");
    await user.type(
      screen.getByLabelText(/^password$/i, { selector: "input" }),
      "correctpassword",
    );
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() =>
      expect(loginFn).toHaveBeenCalledWith(
        expect.objectContaining({ rememberDevice: true }),
      ),
    );
  });

  it("shows error banner on failed login", async () => {
    const user = userEvent.setup();
    const loginFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      reason: "invalid_credentials",
      message: "Invalid display name or password.",
    } satisfies AuthLoginResult);

    render(<LoginView onLoginSuccess={vi.fn()} loginFn={loginFn} />);

    await user.type(screen.getByLabelText(/display name/i), "Admin");
    await user.type(
      screen.getByLabelText(/^password$/i, { selector: "input" }),
      "wrongpassword",
    );
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() =>
      expect(
        screen.getByText(/invalid display name or password/i),
      ).toBeDefined(),
    );
  });

  it("does not render password fields before remote password is configured", () => {
    render(
      <LoginView
        onLoginSuccess={vi.fn()}
        loginFn={vi.fn()}
        reason="remote_password_not_configured"
      />,
    );
    expect(screen.getByText(/remote access is not enabled yet/i)).toBeDefined();
    expect(
      screen.getByText(/remote password login has not been configured/i),
    ).toBeDefined();
    expect(screen.queryByLabelText(/display name/i)).toBeNull();
  });
});

// ── Cloud SSO tab ─────────────────────────────────────────────────────────────

describe("LoginView — Cloud SSO tab", () => {
  it("button is disabled when cloudEnabled=false", async () => {
    const user = userEvent.setup();
    render(<LoginView onLoginSuccess={vi.fn()} cloudEnabled={false} />);
    await user.click(screen.getByRole("tab", { name: /cloud/i }));
    const btn = screen.getByRole("button", {
      name: /sign in with eliza cloud/i,
    });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("button is enabled when cloudEnabled=true", async () => {
    const user = userEvent.setup();
    render(<LoginView onLoginSuccess={vi.fn()} cloudEnabled={true} />);
    await user.click(screen.getByRole("tab", { name: /cloud/i }));
    // When enabled, the button is an anchor inside a Button — not disabled.
    const link = screen.getByRole("link", {
      name: /sign in with eliza cloud/i,
    });
    expect(link).toBeDefined();
    expect((link as HTMLAnchorElement).href).toContain(
      "/api/auth/login/sso/start",
    );
  });
});

// ── Connector tab ─────────────────────────────────────────────────────────────

describe("LoginView — Connector tab", () => {
  it("shows placeholder when no bindings configured", async () => {
    const user = userEvent.setup();
    render(<LoginView onLoginSuccess={vi.fn()} connectorBindings={[]} />);
    await user.click(screen.getByRole("tab", { name: /connector/i }));
    expect(
      (
        screen.getByRole("button", {
          name: /send login link/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("renders a button per binding", async () => {
    const user = userEvent.setup();
    render(
      <LoginView
        onLoginSuccess={vi.fn()}
        connectorBindings={[
          { connector: "discord", displayHandle: "user#1234" },
          { connector: "telegram", displayHandle: "@user" },
        ]}
      />,
    );
    await user.click(screen.getByRole("tab", { name: /connector/i }));
    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(2);
  });
});

// ── Pairing tab ───────────────────────────────────────────────────────────────

describe("LoginView — Pairing tab", () => {
  it("renders pairing form when pairing prop provided", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <LoginView
        onLoginSuccess={vi.fn()}
        pairing={{
          pairingEnabled: true,
          pairingCodeInput: "",
          pairingBusy: false,
          pairingError: null,
          onCodeChange: vi.fn(),
          onSubmit,
        }}
      />,
    );
    await user.click(screen.getByRole("tab", { name: /pairing/i }));
    expect(
      screen.getByLabelText(/pairing code/i, { selector: "input" }),
    ).toBeDefined();
  });

  it("calls onSubmit with the entered code", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    // We need a stateful wrapper to test the controlled input.
    let code = "";
    const onCodeChangeImpl = vi.fn((val: string) => {
      code = val;
    });

    const { rerender } = render(
      <LoginView
        onLoginSuccess={vi.fn()}
        pairing={{
          pairingEnabled: true,
          pairingCodeInput: code,
          pairingBusy: false,
          pairingError: null,
          onCodeChange: onCodeChangeImpl,
          onSubmit,
        }}
      />,
    );

    await user.click(screen.getByRole("tab", { name: /pairing/i }));
    const input = screen.getByPlaceholderText(/xxxx/i);
    await user.type(input, "1234-5678-9012");

    // Re-render with updated code value
    rerender(
      <LoginView
        onLoginSuccess={vi.fn()}
        pairing={{
          pairingEnabled: true,
          pairingCodeInput: "1234-5678-9012",
          pairingBusy: false,
          pairingError: null,
          onCodeChange: onCodeChangeImpl,
          onSubmit,
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: /submit code/i }));
    expect(onSubmit).toHaveBeenCalledWith("1234-5678-9012");
  });
});

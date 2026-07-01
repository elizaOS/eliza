// @vitest-environment jsdom
//
// Behavioral test for the PasswordTab sign-in path in LoginView.
//
// The unit under test is LoginView's password form. The only collaborator we
// mock is the login API — injected via the component's own `loginFn` seam
// (LoginView falls back to `authLoginPassword` when it is absent), so the real
// submit/validation/error/navigation logic runs unmodified. `useTranslation`
// resolves to the built-in test context under NODE_ENV=test, so `t(key, {
// defaultValue })` yields the default strings we assert against.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthLoginResult } from "../../api/auth-client";
import { LoginView } from "./LoginView";

afterEach(() => {
  cleanup();
});

const OK_RESULT: AuthLoginResult = {
  ok: true,
  identity: { id: "u_1", displayName: "alice", kind: "owner" },
  session: { id: "s_1", kind: "browser", expiresAt: null },
  csrfToken: "csrf_1",
};

const BAD_CREDS: AuthLoginResult = {
  ok: false,
  status: 401,
  reason: "invalid_credentials",
  message: "Incorrect display name or password.",
};

function fillCredentials(displayName: string, password: string) {
  const nameInput = screen.getByPlaceholderText(
    "Your display name",
  ) as HTMLInputElement;
  const passwordInput = screen.getByPlaceholderText(
    "Your password",
  ) as HTMLInputElement;
  fireEvent.change(nameInput, { target: { value: displayName } });
  fireEvent.change(passwordInput, { target: { value: password } });
  return { nameInput, passwordInput };
}

function submitButton() {
  return screen.getByRole("button", { name: /sign in/i }) as HTMLButtonElement;
}

/** A promise we can resolve on demand, to hold the form in the submitting state. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("LoginView password sign-in", () => {
  it("fires the sign-in call with the exact (trimmed) credentials and navigates on success", async () => {
    const loginFn = vi.fn().mockResolvedValue(OK_RESULT);
    const onLoginSuccess = vi.fn();
    render(<LoginView onLoginSuccess={onLoginSuccess} loginFn={loginFn} />);

    // Whitespace around the display name must be trimmed in the payload; the
    // password is sent verbatim.
    fillCredentials("  alice  ", "hunter2 ");
    fireEvent.click(submitButton());

    // Let the awaited loginFn promise + success state settle.
    await vi.waitFor(() => expect(onLoginSuccess).toHaveBeenCalledTimes(1));

    expect(loginFn).toHaveBeenCalledTimes(1);
    expect(loginFn).toHaveBeenCalledWith({
      displayName: "alice",
      password: "hunter2 ",
      rememberDevice: false,
    });
    // No error alert on the happy path.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("includes rememberDevice=true in the payload when the checkbox is checked", async () => {
    const loginFn = vi.fn().mockResolvedValue(OK_RESULT);
    const onLoginSuccess = vi.fn();
    render(<LoginView onLoginSuccess={onLoginSuccess} loginFn={loginFn} />);

    fillCredentials("alice", "hunter2");
    const remember = screen.getByRole("checkbox") as HTMLInputElement;
    expect(remember.checked).toBe(false);
    fireEvent.click(remember);
    expect(remember.checked).toBe(true);

    fireEvent.click(submitButton());

    await vi.waitFor(() => expect(loginFn).toHaveBeenCalledTimes(1));
    expect(loginFn).toHaveBeenCalledWith({
      displayName: "alice",
      password: "hunter2",
      rememberDevice: true,
    });
  });

  it("gates submission when required fields are empty (disabled + no call)", () => {
    const loginFn = vi.fn().mockResolvedValue(OK_RESULT);
    const onLoginSuccess = vi.fn();
    const { container } = render(
      <LoginView onLoginSuccess={onLoginSuccess} loginFn={loginFn} />,
    );

    // Nothing entered → submit disabled.
    expect(submitButton().disabled).toBe(true);

    // Only display name entered → still disabled.
    const nameInput = screen.getByPlaceholderText(
      "Your display name",
    ) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "alice" } });
    expect(submitButton().disabled).toBe(true);

    // A whitespace-only display name with a password must not be accepted:
    // force a raw form submit (bypassing the disabled button) and confirm the
    // handler's presence guard rejects it.
    fireEvent.change(nameInput, { target: { value: "   " } });
    const passwordInput = screen.getByPlaceholderText(
      "Your password",
    ) as HTMLInputElement;
    fireEvent.change(passwordInput, { target: { value: "hunter2" } });
    const form = container.querySelector("form") as HTMLFormElement;
    fireEvent.submit(form);

    expect(loginFn).not.toHaveBeenCalled();
    expect(onLoginSuccess).not.toHaveBeenCalled();
  });

  it("surfaces an invalid-credentials error and does NOT navigate", async () => {
    const loginFn = vi.fn().mockResolvedValue(BAD_CREDS);
    const onLoginSuccess = vi.fn();
    render(<LoginView onLoginSuccess={onLoginSuccess} loginFn={loginFn} />);

    fillCredentials("alice", "wrong-password");
    fireEvent.click(submitButton());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Incorrect display name or password.");
    expect(loginFn).toHaveBeenCalledTimes(1);
    expect(onLoginSuccess).not.toHaveBeenCalled();

    // The button is re-enabled after the failed attempt so the user can retry.
    expect(submitButton().disabled).toBe(false);
  });

  it("surfaces a thrown transport error message and does NOT navigate", async () => {
    const loginFn = vi.fn().mockRejectedValue(new Error("Network down"));
    const onLoginSuccess = vi.fn();
    render(<LoginView onLoginSuccess={onLoginSuccess} loginFn={loginFn} />);

    fillCredentials("alice", "hunter2");
    fireEvent.click(submitButton());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Network down");
    expect(onLoginSuccess).not.toHaveBeenCalled();
  });

  it("clears a prior error once the user edits a field again", async () => {
    const loginFn = vi.fn().mockResolvedValue(BAD_CREDS);
    const onLoginSuccess = vi.fn();
    render(<LoginView onLoginSuccess={onLoginSuccess} loginFn={loginFn} />);

    const { passwordInput } = fillCredentials("alice", "wrong");
    fireEvent.click(submitButton());
    await screen.findByRole("alert");

    // Editing the password should reset the error banner to idle.
    fireEvent.change(passwordInput, { target: { value: "wrong2" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("fires exactly one sign-in call on a rapid double submit", async () => {
    const gate = deferred<AuthLoginResult>();
    const loginFn = vi.fn().mockReturnValue(gate.promise);
    const onLoginSuccess = vi.fn();
    render(<LoginView onLoginSuccess={onLoginSuccess} loginFn={loginFn} />);

    fillCredentials("alice", "hunter2");
    const btn = submitButton();
    // Two rapid clicks: the first flips the form into the submitting state and
    // disables the button, so the second must be a no-op.
    fireEvent.click(btn);
    fireEvent.click(btn);

    expect(loginFn).toHaveBeenCalledTimes(1);
    // While submitting, the sole button relabels to "Signing in…" and is
    // disabled — query by role only, since the accessible name changed.
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(
      true,
    );

    // Resolve so no unhandled promise dangles.
    gate.resolve(OK_RESULT);
    await vi.waitFor(() => expect(onLoginSuccess).toHaveBeenCalledTimes(1));
    expect(loginFn).toHaveBeenCalledTimes(1);
  });
});

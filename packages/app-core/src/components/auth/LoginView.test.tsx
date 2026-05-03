// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthLoginResult } from "../../api/auth-client";

type ButtonProps = ComponentPropsWithoutRef<"button"> & {
  asChild?: boolean;
  variant?: string;
  children?: ReactNode;
};

vi.mock("@elizaos/ui", async () => {
  const React = await import("react");
  const cn = (...classes: Array<string | false | null | undefined>) =>
    classes.filter(Boolean).join(" ");
  const Div = ({ children, ...props }: ComponentPropsWithoutRef<"div">) =>
    React.createElement("div", props, children);

  return {
    Button: ({
      asChild,
      children,
      variant: _variant,
      ...props
    }: ButtonProps) =>
      asChild
        ? React.createElement(React.Fragment, null, children)
        : React.createElement("button", props, children),
    Card: Div,
    CardContent: Div,
    CardHeader: Div,
    CardTitle: ({ children, ...props }: ComponentPropsWithoutRef<"h2">) =>
      React.createElement("h2", props, children),
    cn,
    Input: (props: ComponentPropsWithoutRef<"input">) =>
      React.createElement("input", props),
    Label: ({ children, ...props }: ComponentPropsWithoutRef<"label">) =>
      React.createElement("label", props, children),
  };
});

vi.mock("../../api/auth-client", () => ({
  authLoginPassword: vi.fn(),
}));

import { LoginView } from "./LoginView";

afterEach(() => {
  cleanup();
});

const SUCCESS_RESULT: AuthLoginResult = {
  ok: true,
  identity: { id: "id-1", displayName: "Admin", kind: "owner" },
  session: { id: "sess-1", kind: "browser", expiresAt: Date.now() + 3_600_000 },
  csrfToken: "csrf-abc",
};

describe("LoginView password login", () => {
  it("renders only the real password login path", () => {
    render(<LoginView onLoginSuccess={vi.fn()} loginFn={vi.fn()} />);

    expect(screen.getByLabelText(/display name/i)).toBeDefined();
    expect(
      screen.getByLabelText(/^password$/i, { selector: "input" }),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeDefined();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByText(/^cloud$/i)).toBeNull();
    expect(screen.queryByText(/^connector$/i)).toBeNull();
    expect(screen.queryByText(/^pairing$/i)).toBeNull();
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

  it("renders a blocked screen before remote password is configured", () => {
    render(
      <LoginView
        onLoginSuccess={vi.fn()}
        loginFn={vi.fn()}
        reason="remote_password_not_configured"
      />,
    );

    expect(screen.getByText(/remote access blocked/i)).toBeDefined();
    expect(screen.getByRole("alert").textContent).toContain(
      "set a remote password in Settings",
    );
    expect(screen.queryByLabelText(/display name/i)).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});

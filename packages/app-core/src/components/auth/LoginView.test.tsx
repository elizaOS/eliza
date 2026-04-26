// @vitest-environment jsdom
/**
 * Unit tests for LoginView.
 *
 * Network calls are replaced with injected mock functions or global fetch
 * stubs.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentPropsWithoutRef, MouseEvent, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthLoginResult } from "../../api/auth-client";

type ButtonProps = ComponentPropsWithoutRef<"button"> & {
  asChild?: boolean;
  variant?: string;
  children?: ReactNode;
};
type TabsProps = { defaultValue: string; children?: ReactNode };
type TabsTriggerProps = ComponentPropsWithoutRef<"button"> & {
  value: string;
  children?: ReactNode;
};
type TabsContentProps = ComponentPropsWithoutRef<"div"> & {
  value: string;
  children?: ReactNode;
};

vi.mock("@elizaos/ui", async () => {
  const React = await import("react");
  const TabsContext = React.createContext<{
    value: string;
    setValue: (value: string) => void;
  } | null>(null);

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
    Tabs: ({ defaultValue, children }: TabsProps) => {
      const [value, setValue] = React.useState(defaultValue);
      return React.createElement(
        TabsContext.Provider,
        { value: { value, setValue } },
        children,
      );
    },
    TabsContent: ({ value, children, ...props }: TabsContentProps) => {
      const tabs = React.useContext(TabsContext);
      if (tabs?.value !== value) return null;
      return React.createElement(
        "div",
        { role: "tabpanel", ...props },
        children,
      );
    },
    TabsList: ({ children, ...props }: ComponentPropsWithoutRef<"div">) =>
      React.createElement("div", { role: "tablist", ...props }, children),
    TabsTrigger: ({ value, children, onClick, ...props }: TabsTriggerProps) => {
      const tabs = React.useContext(TabsContext);
      const selected = tabs?.value === value;
      return React.createElement(
        "button",
        {
          role: "tab",
          type: "button",
          "aria-selected": selected,
          onClick: (event: MouseEvent<HTMLButtonElement>) => {
            tabs?.setValue(value);
            onClick?.(event);
          },
          ...props,
        },
        children,
      );
    },
  };
});

vi.mock("../../api/auth-client", () => ({
  authLoginPassword: vi.fn(),
}));

import { LoginView } from "./LoginView";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

  it("renders password as the default method when all methods are available", () => {
    render(
      <LoginView
        onLoginSuccess={vi.fn()}
        loginFn={vi.fn()}
        cloudEnabled={true}
        connectorBindings={[{ connector: "discord", displayHandle: "user#1" }]}
        pairing={{
          pairingEnabled: true,
          pairingCodeInput: "",
          pairingBusy: false,
          pairingError: null,
          onCodeChange: vi.fn(),
          onSubmit: vi.fn(),
        }}
      />,
    );

    expect(screen.getByLabelText(/display name/i)).toBeDefined();
    const tablistStyle =
      screen.getByRole("tablist").getAttribute("style") ?? "";
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Password",
      "Cloud",
      "Connector",
      "Pairing",
    ]);
    expect(tablistStyle).toContain("repeat(4");
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

// ── Cloud SSO tab ─────────────────────────────────────────────────────────────

describe("LoginView — Cloud SSO tab", () => {
  it("is hidden when cloudEnabled=false", () => {
    render(<LoginView onLoginSuccess={vi.fn()} cloudEnabled={false} />);
    expect(screen.queryByRole("tab", { name: /cloud/i })).toBeNull();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    const tablistStyle =
      screen.getByRole("tablist").getAttribute("style") ?? "";
    expect(tablistStyle).toContain("repeat(1");
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
  it("is hidden when no bindings are configured", () => {
    render(<LoginView onLoginSuccess={vi.fn()} connectorBindings={[]} />);
    expect(screen.queryByRole("tab", { name: /connector/i })).toBeNull();
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

  it("shows a durable error when the DM-link endpoint is unavailable", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404 }),
    );

    render(
      <LoginView
        onLoginSuccess={vi.fn()}
        connectorBindings={[{ connector: "discord", displayHandle: "user#1" }]}
      />,
    );

    await user.click(screen.getByRole("tab", { name: /connector/i }));
    await user.click(
      screen.getByRole("button", { name: /send link via discord/i }),
    );

    await waitFor(() =>
      expect(
        screen.getByText(/login links are unavailable on this server/i),
      ).toBeDefined(),
    );
  });
});

// ── Pairing tab ───────────────────────────────────────────────────────────────

describe("LoginView — Pairing tab", () => {
  it("is hidden when pairing is unavailable", () => {
    render(<LoginView onLoginSuccess={vi.fn()} />);
    expect(screen.queryByRole("tab", { name: /pairing/i })).toBeNull();
  });

  it("is hidden when pairing is disabled", () => {
    render(
      <LoginView
        onLoginSuccess={vi.fn()}
        pairing={{
          pairingEnabled: false,
          pairingCodeInput: "",
          pairingBusy: false,
          pairingError: null,
          onCodeChange: vi.fn(),
          onSubmit: vi.fn(),
        }}
      />,
    );
    expect(screen.queryByRole("tab", { name: /pairing/i })).toBeNull();
  });

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

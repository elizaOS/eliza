// @vitest-environment jsdom
/**
 * Unit tests for PasswordSetupStep.
 *
 * Uses @testing-library/react. Mocks the setupFn prop so no network calls
 * are made — the API client is tested separately.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthSetupResult } from "../../api/auth-client";
import { PasswordSetupStep } from "./PasswordSetupStep";

afterEach(cleanup);

const SUCCESS_RESULT: AuthSetupResult = {
  ok: true,
  identity: { id: "id-1", displayName: "Admin", kind: "owner" },
  session: { id: "sess-1", kind: "browser", expiresAt: Date.now() + 3_600_000 },
  csrfToken: "csrf-abc",
};

describe("PasswordSetupStep — required mode", () => {
  it("renders the form without a skip button", () => {
    render(
      <PasswordSetupStep
        optional={false}
        onAdvance={vi.fn()}
        setupFn={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /skip/i })).toBeNull();
    expect(screen.getByRole("button", { name: /set password/i })).toBeDefined();
  });

  it("submit button is disabled until form is complete and passwords match", async () => {
    const user = userEvent.setup();
    render(
      <PasswordSetupStep
        optional={false}
        onAdvance={vi.fn()}
        setupFn={vi.fn()}
      />,
    );
    const submit = screen.getByRole("button", { name: /set password/i });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByLabelText(/display name/i), "Admin");
    await user.type(
      screen.getByLabelText(/^password$/i, { selector: "input" }),
      "password123abc",
    );
    expect((submit as HTMLButtonElement).disabled).toBe(true); // confirm still empty

    await user.type(screen.getByLabelText(/confirm password/i), "different");
    expect((submit as HTMLButtonElement).disabled).toBe(true); // mismatch
  });

  it("submit button enables when form is valid", async () => {
    const user = userEvent.setup();
    render(
      <PasswordSetupStep
        optional={false}
        onAdvance={vi.fn()}
        setupFn={vi.fn()}
      />,
    );
    await user.type(screen.getByLabelText(/display name/i), "Admin");
    await user.type(
      screen.getByLabelText(/^password$/i, { selector: "input" }),
      "strongpassword99!",
    );
    await user.type(
      screen.getByLabelText(/confirm password/i),
      "strongpassword99!",
    );
    const submit = screen.getByRole("button", { name: /set password/i });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  it("calls setupFn and onAdvance on success", async () => {
    const user = userEvent.setup();
    const setupFn = vi.fn().mockResolvedValue(SUCCESS_RESULT);
    const onAdvance = vi.fn();

    render(
      <PasswordSetupStep
        optional={false}
        onAdvance={onAdvance}
        setupFn={setupFn}
      />,
    );

    await user.type(screen.getByLabelText(/display name/i), "Admin");
    await user.type(
      screen.getByLabelText(/^password$/i, { selector: "input" }),
      "strongpassword99!",
    );
    await user.type(
      screen.getByLabelText(/confirm password/i),
      "strongpassword99!",
    );
    await user.click(screen.getByRole("button", { name: /set password/i }));

    await waitFor(() => expect(onAdvance).toHaveBeenCalledOnce());
    expect(setupFn).toHaveBeenCalledWith({
      displayName: "Admin",
      password: "strongpassword99!",
    });
  });

  it("shows error message on failure", async () => {
    const user = userEvent.setup();
    const setupFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      reason: "weak_password",
      message: "Password too weak.",
    } satisfies AuthSetupResult);
    const onAdvance = vi.fn();

    render(
      <PasswordSetupStep
        optional={false}
        onAdvance={onAdvance}
        setupFn={setupFn}
      />,
    );

    await user.type(screen.getByLabelText(/display name/i), "Admin");
    await user.type(
      screen.getByLabelText(/^password$/i, { selector: "input" }),
      "weakpassword999!!",
    );
    await user.type(
      screen.getByLabelText(/confirm password/i),
      "weakpassword999!!",
    );
    await user.click(screen.getByRole("button", { name: /set password/i }));

    await waitFor(() =>
      expect(screen.getByText("Password too weak.")).toBeDefined(),
    );
    expect(onAdvance).not.toHaveBeenCalled();
  });

  it("shows mismatch error inline on confirm field", async () => {
    const user = userEvent.setup();
    render(
      <PasswordSetupStep
        optional={false}
        onAdvance={vi.fn()}
        setupFn={vi.fn()}
      />,
    );

    await user.type(
      screen.getByLabelText(/^password$/i, { selector: "input" }),
      "strongpassword99!",
    );
    await user.type(screen.getByLabelText(/confirm password/i), "different");

    expect(screen.getByText(/passwords do not match/i)).toBeDefined();
  });
});

describe("PasswordSetupStep — optional mode", () => {
  it("renders a skip button", () => {
    render(
      <PasswordSetupStep
        optional
        onAdvance={vi.fn()}
        onSkip={vi.fn()}
        setupFn={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /skip/i })).toBeDefined();
  });

  it("calls onSkip when skip button is clicked", async () => {
    const user = userEvent.setup();
    const onSkip = vi.fn();
    render(
      <PasswordSetupStep
        optional
        onAdvance={vi.fn()}
        onSkip={onSkip}
        setupFn={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /skip/i }));
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it("renders the cloud-fallback warning text", () => {
    render(
      <PasswordSetupStep
        optional
        onAdvance={vi.fn()}
        onSkip={vi.fn()}
        setupFn={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/eliza cloud sso is your primary login method/i),
    ).toBeDefined();
  });
});

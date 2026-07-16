/**
 * Exercises the account dialog's provider-specific user paths with deterministic
 * transport boundaries while retaining the real form and state transitions.
 */

// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddAccountDialog } from "./AddAccountDialog";

const api = vi.hoisted(() => ({
  cancelAccountOAuth: vi.fn(),
  createApiKeyAccount: vi.fn(),
  startAccountOAuth: vi.fn(),
  submitAccountOAuthCode: vi.fn(),
}));

const eventSource = vi.hoisted(() => ({
  close: vi.fn(),
  onerror: null as (() => void) | null,
  onmessage: null as ((event: MessageEvent<string>) => void) | null,
  onopen: null as (() => void) | null,
  readyState: 1,
}));

const oauthState = vi.hoisted(() => ({
  clearSubscriptionOAuth: vi.fn(),
  readSubscriptionOAuth: vi.fn(
    () =>
      null as null | {
        providerId: "anthropic-subscription";
        sessionId: string;
        mode: "device";
        phase: "need-code";
        oauthUrl?: string;
        startedAt: number;
      },
  ),
  writeSubscriptionOAuth: vi.fn(),
}));

vi.mock("../../api", () => ({ client: api }));
vi.mock("../../state", () => ({
  useAppSelector: (
    selector: (state: {
      t: (key: string, vars?: Record<string, unknown>) => string;
    }) => unknown,
  ) => selector({ t: (_key, vars) => String(vars?.defaultValue ?? _key) }),
}));
vi.mock("../../utils", () => ({
  navigatePreOpenedWindow: vi.fn(),
  preOpenWindow: vi.fn(() => ({ close: vi.fn() })),
}));
vi.mock("../../utils/clipboard", () => ({ copyTextToClipboard: vi.fn() }));
vi.mock("../../utils/event-source", () => ({
  openEventSource: vi.fn(() => eventSource),
}));
vi.mock("./subscription-oauth-state", () => oauthState);

describe("AddAccountDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.cancelAccountOAuth.mockResolvedValue(undefined);
    api.createApiKeyAccount.mockResolvedValue({
      id: "account-1",
      label: "Work",
    });
    eventSource.readyState = 1;
    eventSource.onmessage = null;
    oauthState.readSubscriptionOAuth.mockReturnValue(null);
  });
  afterEach(cleanup);

  it("selects a chat provider and creates a trimmed API-key account", async () => {
    const onClose = vi.fn();
    const onCreated = vi.fn();
    render(<AddAccountDialog open onClose={onClose} onCreated={onCreated} />);

    // Provider selection is now a searchable command-palette list; the row is
    // exposed as a listbox option. Narrow via search, then pick the option.
    fireEvent.change(screen.getByPlaceholderText("Search providers"), {
      target: { value: "OpenAI API" },
    });
    fireEvent.click(screen.getByRole("option", { name: /OpenAI API/ }));
    expect(
      (screen.getByLabelText("Account name") as HTMLInputElement).value,
    ).toBe("API account");
    fireEvent.change(screen.getByLabelText("Account name"), {
      target: { value: " Work " },
    });
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: " secret " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));

    await waitFor(() =>
      expect(api.createApiKeyAccount).toHaveBeenCalledWith("openai-api", {
        label: "Work",
        apiKey: "secret",
      }),
    );
    expect(onCreated).toHaveBeenCalledWith({ id: "account-1", label: "Work" });
    expect(onClose).toHaveBeenCalled();
  });

  it("surfaces an API failure and supports retry", async () => {
    api.createApiKeyAccount.mockRejectedValueOnce(
      new Error("credential rejected"),
    );
    render(
      <AddAccountDialog
        open
        providerId="zai-coding"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    expect(
      (screen.getByLabelText("Account name") as HTMLInputElement).value,
    ).toBe("Coding plan account");
    fireEvent.change(screen.getByLabelText("Account name"), {
      target: { value: "Plan" },
    });
    fireEvent.change(screen.getByLabelText("Coding-plan key"), {
      target: { value: "bad" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "credential rejected",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByLabelText("Coding-plan key")).toBeTruthy();
  });

  it("renders explicit external-CLI and unavailable states", () => {
    const { rerender } = render(
      <AddAccountDialog
        open
        providerId="gemini-cli"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    expect(screen.getByText(/Run gemini auth login/)).toBeTruthy();
    rerender(
      <AddAccountDialog
        open
        providerId="deepseek-coding"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/no first-party coding subscription endpoint/),
    ).toBeTruthy();
  });

  it("starts OAuth and completes from the status stream", async () => {
    const onClose = vi.fn();
    const onCreated = vi.fn();
    api.startAccountOAuth.mockResolvedValue({
      sessionId: "session-123",
      authUrl: "https://login.test",
      needsCodeSubmission: false,
    });
    render(
      <AddAccountDialog
        open
        providerId="openai-codex"
        onClose={onClose}
        onCreated={onCreated}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Log in/ }));
    await waitFor(() => expect(api.startAccountOAuth).toHaveBeenCalled());
    expect(screen.getByText(/Waiting for browser/)).toBeTruthy();
    await act(async () =>
      eventSource.onmessage?.({
        data: JSON.stringify({
          status: "success",
          account: { id: "oauth-1", label: "Codex" },
        }),
      } as MessageEvent<string>),
    );
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith({ id: "oauth-1", label: "Codex" }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("restores a persisted paste-code flow without resetting its step", async () => {
    oauthState.readSubscriptionOAuth.mockReturnValue({
      providerId: "anthropic-subscription",
      sessionId: "restored-session",
      mode: "device",
      phase: "need-code",
      oauthUrl: "https://login.test/restored",
      startedAt: Date.now(),
    });

    render(
      <AddAccountDialog
        open
        providerId="anthropic-subscription"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );

    expect(
      await screen.findByPlaceholderText("Paste the code or redirect URL"),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "https://login.test/restored" })
        .getAttribute("href"),
    ).toBe("https://login.test/restored");
    expect(screen.queryByRole("button", { name: /Log in/ })).toBeNull();
  });

  it("starts an explicit in-place OAuth replacement without an editable duplicate label", async () => {
    api.startAccountOAuth.mockResolvedValue({
      sessionId: "repair-session",
      authUrl: "https://login.test",
      needsCodeSubmission: true,
    });
    render(
      <AddAccountDialog
        open
        providerId="anthropic-subscription"
        credentialRepairAccount={{
          id: "expired-account",
          label: "Work Claude",
          source: "oauth",
          health: "needs-reauth",
        }}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );

    expect(screen.getByText("Reauthenticate Work Claude")).toBeTruthy();
    expect(screen.getByText(/updated in place/)).toBeTruthy();
    expect(screen.queryByLabelText("Account name")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Log in and paste a code" }),
    );
    await waitFor(() =>
      expect(api.startAccountOAuth).toHaveBeenCalledWith(
        "anthropic-subscription",
        expect.objectContaining({
          label: "Work Claude",
          replaceAccountId: "expired-account",
        }),
      ),
    );
  });

  it("submits an API-key repair as an in-place replacement", async () => {
    render(
      <AddAccountDialog
        open
        providerId="zai-coding"
        credentialRepairAccount={{
          id: "invalid-plan",
          label: "Work plan",
          source: "api-key",
          health: "invalid",
        }}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("Account name")).toBeNull();
    fireEvent.change(screen.getByLabelText("Coding-plan key"), {
      target: { value: "replacement-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save replacement" }));
    await waitFor(() =>
      expect(api.createApiKeyAccount).toHaveBeenCalledWith("zai-coding", {
        label: "Work plan",
        apiKey: "replacement-secret",
        replaceAccountId: "invalid-plan",
      }),
    );
  });

  it("resets repair form state when the account id changes despite the same label", () => {
    const props = {
      open: true,
      providerId: "zai-coding" as const,
      onClose: vi.fn(),
      onCreated: vi.fn(),
    };
    const { rerender } = render(
      <AddAccountDialog
        {...props}
        credentialRepairAccount={{
          id: "first-invalid",
          label: "Shared label",
          source: "api-key",
          health: "invalid",
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText("Coding-plan key"), {
      target: { value: "first-secret-value" },
    });
    rerender(
      <AddAccountDialog
        {...props}
        credentialRepairAccount={{
          id: "second-invalid",
          label: "Shared label",
          source: "api-key",
          health: "invalid",
        }}
      />,
    );
    expect(
      (screen.getByLabelText("Coding-plan key") as HTMLInputElement).value,
    ).toBe("");
  });

  it("submits an OAuth callback code and reports terminal stream errors", async () => {
    api.startAccountOAuth.mockResolvedValue({
      sessionId: "session-code",
      authUrl: "https://login.test",
      needsCodeSubmission: true,
    });
    api.submitAccountOAuthCode.mockResolvedValue(undefined);
    render(
      <AddAccountDialog
        open
        providerId="anthropic-subscription"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Log in and paste a code" }),
    );
    const code = await screen.findByPlaceholderText(
      "Paste the code or redirect URL",
    );
    oauthState.readSubscriptionOAuth.mockReturnValue({
      providerId: "anthropic-subscription",
      sessionId: "session-code",
      mode: "device",
      phase: "need-code",
      oauthUrl: "https://login.test",
      startedAt: Date.now(),
    });
    fireEvent.change(code, { target: { value: " callback-code " } });
    fireEvent.click(screen.getByRole("button", { name: "Submit code" }));
    await waitFor(() =>
      expect(api.submitAccountOAuthCode).toHaveBeenCalledWith(
        "anthropic-subscription",
        { sessionId: "session-code", code: "callback-code" },
      ),
    );
    expect(oauthState.writeSubscriptionOAuth).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: "session-code",
        phase: "waiting",
        oauthUrl: "https://login.test",
      }),
    );
    await act(async () =>
      eventSource.onmessage?.({
        data: JSON.stringify({ status: "error", error: "login denied" }),
      } as MessageEvent<string>),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "login denied",
    );
  });
});

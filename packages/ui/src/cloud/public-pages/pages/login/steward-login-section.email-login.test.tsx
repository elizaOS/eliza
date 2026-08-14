/** Verifies StewardLoginSection email magic-link companion code through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Email magic-link companion-code login coverage. The Steward HTTP adapter is
 * doubled so these tests can assert the login state machine: code redemption
 * establishes the session, while remote link approval polling only updates UI.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const emailLoginSpies = vi.hoisted(() => ({
  start: vi.fn(),
  verify: vi.fn(),
  poll: vi.fn(),
}));

const sessionSpies = vi.hoisted(() => ({
  sync: vi.fn(),
}));

vi.mock("./passkey-capability", () => ({
  resolveWebPasskeyCapability: () =>
    Promise.resolve({ usable: false, reason: "native-without-bridge" }),
}));

vi.mock("@stwd/sdk", () => ({
  StewardAuth: class {
    getProviders() {
      return Promise.resolve({
        passkey: false,
        email: true,
        siwe: false,
        siws: false,
        google: false,
        discord: false,
        github: false,
        twitter: false,
        oauth: [],
      });
    }
    getSession() {
      return null;
    }
    refreshSession() {
      return Promise.resolve(null);
    }
  },
}));

vi.mock("../../../shell/steward-url", () => ({
  resolveBrowserStewardApiUrl: () => "https://api.example.test/steward",
}));

vi.mock("../../../shell/steward-config", () => ({
  configuredStewardTenantId: () => "elizacloud",
  DEFAULT_STEWARD_TENANT_ID: "elizacloud",
}));

vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? _key,
}));

vi.mock("../../lib/steward-email-login", () => ({
  StewardEmailLoginError: class StewardEmailLoginError extends Error {
    status: number;
    code: string | null;
    constructor(message: string, status: number, code: string | null) {
      super(message);
      this.name = "StewardEmailLoginError";
      this.status = status;
      this.code = code;
    }
  },
  startStewardEmailLogin: emailLoginSpies.start,
  verifyStewardEmailSignInCode: emailLoginSpies.verify,
  pollStewardEmailSignInStatus: emailLoginSpies.poll,
}));

vi.mock("../../lib/steward-session", () => ({
  hasStewardOAuthCallbackInUrl: () => false,
  consumeStewardCodeFromQuery: () => null,
  consumeStewardTokensFromHash: () => null,
  exchangeStewardCodeViaApi: vi.fn(),
  recoverStewardSessionViaCookie: vi.fn(),
  refreshStewardSessionViaCookie: vi.fn(),
  syncStewardSessionCookie: sessionSpies.sync,
}));

vi.mock("../../lib/login-return-to", () => ({
  resolveLoginReturnTo: () => "/cloud",
  consumePendingOAuthReturnTo: () => null,
  storePendingOAuthReturnTo: () => undefined,
}));

import StewardLoginSection from "./steward-login-section";

function renderSection(initialEntry = "/login") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <StewardLoginSection />
    </MemoryRouter>,
  );
}

async function startEmailLogin() {
  const input = await screen.findByPlaceholderText("you@example.com");
  fireEvent.change(input, { target: { value: "person@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: /Magic Link/i }));
  await screen.findByLabelText("Six-digit code");
}

describe("StewardLoginSection email magic-link companion code", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.localStorage.clear();
    emailLoginSpies.start.mockResolvedValue({
      expiresAt: Date.now() + 600_000,
      challengeId: "challenge-1",
      pollSecret: "poll-secret",
    });
    emailLoginSpies.verify.mockResolvedValue({
      token: "session-token",
      refreshToken: "refresh-token",
    });
    emailLoginSpies.poll.mockResolvedValue("pending");
    sessionSpies.sync.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("redeems only six digits and establishes the session from the verify response", async () => {
    renderSection();
    await startEmailLogin();

    const codeInput = screen.getByLabelText("Six-digit code");
    fireEvent.change(codeInput, { target: { value: "12a345678" } });
    expect((codeInput as HTMLInputElement).value).toBe("123456");
    fireEvent.click(screen.getByRole("button", { name: /Verify code/i }));

    await waitFor(() =>
      expect(emailLoginSpies.verify).toHaveBeenCalledWith(
        {
          baseUrl: "https://api.example.test/steward",
          tenantId: "elizacloud",
        },
        "person@example.com",
        "123456",
      ),
    );
    await waitFor(() =>
      expect(sessionSpies.sync).toHaveBeenCalledWith(
        "session-token",
        "refresh-token",
      ),
    );
  });

  it("remote consumed status shows approval guidance without syncing a session", async () => {
    emailLoginSpies.poll.mockResolvedValue("consumed");
    renderSection();
    await startEmailLogin();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(await screen.findByText("Link approved")).toBeTruthy();
    expect(
      screen.getByText(
        "The link was approved elsewhere. This device was not signed in.",
      ),
    ).toBeTruthy();
    expect(sessionSpies.sync).not.toHaveBeenCalled();
  });

  it("shows expired and replay guidance for a rejected code", async () => {
    const { StewardEmailLoginError } = await import(
      "../../lib/steward-email-login"
    );
    emailLoginSpies.verify.mockRejectedValue(
      new StewardEmailLoginError("already used", 410, "challenge_consumed"),
    );
    renderSection();
    await startEmailLogin();

    fireEvent.change(screen.getByLabelText("Six-digit code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Verify code/i }));

    expect(
      await screen.findByText(
        "That sign-in email expired or was already used. Request a new email.",
      ),
    ).toBeTruthy();
    expect(sessionSpies.sync).not.toHaveBeenCalled();
  });

  it("renders locked and expired polling states", async () => {
    emailLoginSpies.poll.mockResolvedValueOnce("locked");
    renderSection();
    await startEmailLogin();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(await screen.findByText("Too many attempts")).toBeTruthy();
    expect(sessionSpies.sync).not.toHaveBeenCalled();

    cleanup();
    vi.clearAllMocks();
    emailLoginSpies.start.mockResolvedValue({
      expiresAt: Date.now() + 600_000,
      challengeId: "challenge-2",
      pollSecret: "poll-secret-2",
    });
    emailLoginSpies.poll.mockResolvedValueOnce("expired");
    sessionSpies.sync.mockResolvedValue(undefined);

    renderSection();
    await startEmailLogin();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(await screen.findByText("Email expired")).toBeTruthy();
    expect(sessionSpies.sync).not.toHaveBeenCalled();
  });

  it("shows link-only UI when codeAvailable is explicitly false despite polling credentials", async () => {
    emailLoginSpies.start.mockResolvedValue({
      expiresAt: Date.now() + 600_000,
      challengeId: "challenge-1",
      pollSecret: "poll-secret",
      codeAvailable: false,
    });
    renderSection();
    const emailInput = await screen.findByPlaceholderText("you@example.com");
    fireEvent.change(emailInput, { target: { value: "person@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Magic Link/i }));

    // Wait for the email-sent step to render
    await screen.findByText("Check your email");

    // Verify that the code input is NOT shown (link-only case)
    expect(screen.queryByLabelText("Six-digit code")).toBeNull();

    // Verify that the magic-link-only message is shown
    expect(
      screen.getByText(
        "Check your inbox and open the magic link to sign in.",
      ),
    ).toBeTruthy();

    // Verify that the verify code button is NOT shown
    expect(screen.queryByRole("button", { name: /Verify code/i })).toBeNull();

    // Verify that the code hint is NOT shown
    expect(
      screen.queryByText(
        "Use only the current email. A new email replaces the old code.",
      ),
    ).toBeNull();
  });

  it("shows code UI when codeAvailable is explicitly true", async () => {
    emailLoginSpies.start.mockResolvedValue({
      expiresAt: Date.now() + 600_000,
      challengeId: "challenge-1",
      pollSecret: "poll-secret",
      codeAvailable: true,
    });
    renderSection();
    const emailInput = await screen.findByPlaceholderText("you@example.com");
    fireEvent.change(emailInput, { target: { value: "person@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Magic Link/i }));

    // Verify that the code input IS shown
    expect(await screen.findByLabelText("Six-digit code")).toBeTruthy();

    // Verify that the code verification button IS shown
    expect(
      screen.getByRole("button", { name: /Verify code/i }),
    ).toBeTruthy();

    // Verify that the code hint IS shown
    expect(
      screen.getByText(
        "Use only the current email. A new email replaces the old code.",
      ),
    ).toBeTruthy();

    // Verify the correct message is shown
    expect(
      screen.getByText(
        "Open the link on this device or enter the six-digit code we sent.",
      ),
    ).toBeTruthy();
  });
});

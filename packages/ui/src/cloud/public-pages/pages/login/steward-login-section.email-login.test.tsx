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
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const emailLoginSpies = vi.hoisted(() => ({
  start: vi.fn(),
  verify: vi.fn(),
  poll: vi.fn(),
}));

const sessionSpies = vi.hoisted(() => ({
  sync: vi.fn(),
  recover: vi.fn(),
  recoverEmail: vi.fn(),
  hasAuthedCookie: vi.fn(),
}));

const emailCompleteSpies = vi.hoisted(() => ({
  listener: null as
    | null
    | ((message: { email: string; destination: string }) => void),
  unsubscribe: vi.fn(),
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

vi.mock("@elizaos/shared/steward-session-client", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@elizaos/shared/steward-session-client")
  >()),
  hasStewardAuthedCookie: sessionSpies.hasAuthedCookie,
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
  stripLegacyTokenHashFromAddressBar: () => false,
  exchangeStewardCodeViaApi: vi.fn(),
  recoverStewardEmailSessionViaCookie: sessionSpies.recoverEmail,
  recoverStewardSessionViaCookie: sessionSpies.recover,
  refreshStewardSessionViaCookie: vi.fn(),
  syncStewardSessionCookie: sessionSpies.sync,
}));

vi.mock("../../lib/steward-email-login-complete", () => ({
  subscribeStewardEmailLoginComplete: vi.fn(
    (
      _email: string,
      listener: (message: { email: string; destination: string }) => void,
    ) => {
      emailCompleteSpies.listener = listener;
      return emailCompleteSpies.unsubscribe;
    },
  ),
}));

import StewardLoginSection from "./steward-login-section";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-path">{location.pathname}</output>;
}

function renderSection(initialEntry = "/login") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <StewardLoginSection />
      <LocationProbe />
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
    sessionSpies.recover.mockResolvedValue({ ok: true });
    sessionSpies.recoverEmail.mockResolvedValue({ ok: true });
    sessionSpies.hasAuthedCookie.mockReturnValue(false);
    emailCompleteSpies.listener = null;
    emailCompleteSpies.unsubscribe.mockReset();
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

  it("binds consumed-link recovery to the challenged email", async () => {
    emailLoginSpies.poll.mockResolvedValue("consumed");
    let finishRecovery: ((value: { ok: true }) => void) | undefined;
    sessionSpies.recoverEmail.mockImplementation(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          finishRecovery = resolve;
        }),
    );
    renderSection();
    await startEmailLogin();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(sessionSpies.recoverEmail).toHaveBeenCalledWith(
      "person@example.com",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByLabelText("Six-digit code")).toBeTruthy();

    await act(async () => {
      finishRecovery?.({ ok: true });
    });

    expect(await screen.findByText("Signed in")).toBeTruthy();
    expect(
      screen.getByText(
        "Sign-in finished in another tab. You can continue here or close this tab.",
      ),
    ).toBeTruthy();
    expect(sessionSpies.recoverEmail).toHaveBeenCalledOnce();
    expect(sessionSpies.sync).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Six-digit code")).toBeNull();
  });

  it("aborts an abandoned challenge's recovery and never hands it to a later email", async () => {
    emailLoginSpies.poll.mockResolvedValue("consumed");
    const pendingRecoveries: Array<(value: { ok: true } | null) => void> = [];
    sessionSpies.recoverEmail.mockImplementation(
      () =>
        new Promise<{ ok: true } | null>((resolve) => {
          pendingRecoveries.push(resolve);
        }),
    );
    renderSection();
    await startEmailLogin();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(sessionSpies.recoverEmail).toHaveBeenCalledWith(
      "person@example.com",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const emailASignal = sessionSpies.recoverEmail.mock.calls[0]?.[1]
      ?.signal as AbortSignal;

    // Abandon the email-A challenge while its recovery is still pending.
    fireEvent.click(screen.getByRole("button", { name: /Back to login/i }));
    expect(emailASignal.aborted).toBe(true);

    // Start a fresh challenge for a different account.
    emailLoginSpies.start.mockResolvedValue({
      expiresAt: Date.now() + 600_000,
      challengeId: "challenge-2",
      pollSecret: "poll-secret-2",
    });
    const input = await screen.findByPlaceholderText("you@example.com");
    fireEvent.change(input, { target: { value: "other@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Magic Link/i }));
    await screen.findByLabelText("Six-digit code");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(sessionSpies.recoverEmail).toHaveBeenCalledTimes(2);
    expect(sessionSpies.recoverEmail).toHaveBeenLastCalledWith(
      "other@example.com",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const emailBSignal = sessionSpies.recoverEmail.mock.calls[1]?.[1]
      ?.signal as AbortSignal;
    expect(emailBSignal.aborted).toBe(false);

    // The abandoned email-A recovery resolving late must not sign email B in.
    await act(async () => {
      pendingRecoveries[0]?.({ ok: true });
    });
    expect(screen.queryByText("Signed in")).toBeNull();
    expect(screen.getByLabelText("Six-digit code")).toBeTruthy();

    // Only email B's own keyed recovery completes the waiting tab.
    await act(async () => {
      pendingRecoveries[1]?.({ ok: true });
    });
    expect(await screen.findByText("Signed in")).toBeTruthy();
  });

  it("bounds consumed-link cookie waiting and keeps resend recovery visible", async () => {
    emailLoginSpies.poll.mockResolvedValue("consumed");
    sessionSpies.recoverEmail.mockResolvedValue(null);
    renderSection();
    await startEmailLogin();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(13_000);
    });

    expect(await screen.findByText("Link approved")).toBeTruthy();
    expect(
      screen.getByText(
        "The link was used, but this tab could not restore the shared session. Continue in the tab that opened the link or request a fresh email.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Resend/i })).toBeTruthy();
    expect(sessionSpies.recoverEmail).toHaveBeenCalledOnce();
  });

  it("falls back to /join for a hostile waiting-tab returnTo", async () => {
    emailLoginSpies.poll.mockResolvedValue("consumed");
    sessionSpies.recoverEmail.mockResolvedValue({ ok: true });
    renderSection("/login?returnTo=%2F%5C%5Cevil.example");
    await startEmailLogin();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));

    expect(screen.getByTestId("location-path").textContent).toBe("/join");
  });

  it("dismisses the live waiting form when the callback succeeds in another tab", async () => {
    renderSection();
    await startEmailLogin();

    await waitFor(() => expect(emailCompleteSpies.listener).not.toBeNull());
    act(() => {
      emailCompleteSpies.listener?.({
        email: "person@example.com",
        destination: "/get-started",
      });
    });

    expect(await screen.findByText("Signed in")).toBeTruthy();
    expect(
      screen.getByText(
        "Sign-in finished in another tab. You can continue here or close this tab.",
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Six-digit code")).toBeNull();
    expect(screen.queryByRole("button", { name: /Resend/i })).toBeNull();
    expect(sessionSpies.recoverEmail).toHaveBeenCalledOnce();
    expect(sessionSpies.sync).not.toHaveBeenCalled();
  });

  it("keeps the waiting form live until advisory recovery is account-bound", async () => {
    let finishRecovery: ((value: { ok: true }) => void) | undefined;
    sessionSpies.recoverEmail.mockImplementation(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          finishRecovery = resolve;
        }),
    );
    renderSection();
    await startEmailLogin();

    await waitFor(() => expect(emailCompleteSpies.listener).not.toBeNull());
    act(() => {
      emailCompleteSpies.listener?.({
        email: "person@example.com",
        destination: "/get-started",
      });
    });
    expect(sessionSpies.recoverEmail).toHaveBeenCalledWith(
      "person@example.com",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByLabelText("Six-digit code")).toBeTruthy();

    await act(async () => {
      finishRecovery?.({ ok: true });
    });

    expect(await screen.findByText("Signed in")).toBeTruthy();
    expect(sessionSpies.recoverEmail).toHaveBeenCalledOnce();
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
});

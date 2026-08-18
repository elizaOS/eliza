/**
 * Verifies the app-hosted Steward SMS login state machine with deterministic
 * SDK and session-boundary doubles; no real text messages or sessions are used.
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
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authSpies = vi.hoisted(() => ({
  storage: null as {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  } | null,
  getProviders: vi.fn(),
  getSession: vi.fn(),
  refreshSession: vi.fn(),
  sendSmsOtp: vi.fn(),
  verifySmsOtp: vi.fn(),
}));

const sessionSpies = vi.hoisted(() => ({
  storedToken: null as string | null,
  write: vi.fn(),
  sync: vi.fn(),
}));

const returnToSpies = vi.hoisted(() => ({
  resolve: vi.fn(),
}));

vi.mock("@elizaos/shared/steward-session-client", () => ({
  hasStewardAuthedCookie: () => false,
  readStoredStewardToken: () => sessionSpies.storedToken,
  writeStoredStewardToken: (token: string) => {
    sessionSpies.storedToken = token;
    sessionSpies.write(token);
  },
  StewardSessionError: class StewardSessionError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock("@stwd/sdk", () => ({
  StewardAuth: class {
    constructor(config: {
      storage: {
        getItem(key: string): string | null;
        setItem(key: string, value: string): void;
        removeItem(key: string): void;
      };
    }) {
      authSpies.storage = config.storage;
    }

    getProviders = authSpies.getProviders;
    getSession = authSpies.getSession;
    refreshSession = authSpies.refreshSession;
    sendSmsOtp = authSpies.sendSmsOtp;

    async verifySmsOtp(phone: string, code: string) {
      const result = await authSpies.verifySmsOtp(phone, code);
      if (result && typeof result === "object" && "token" in result) {
        authSpies.storage?.setItem(
          "steward_session_token",
          String(result.token),
        );
      }
      return result;
    }
  },
}));

vi.mock("./passkey-capability", () => ({
  resolveWebPasskeyCapability: () =>
    Promise.resolve({ usable: false, reason: "native-without-bridge" }),
}));

vi.mock("../../../shell/steward-url", () => ({
  resolveBrowserStewardApiUrl: () => "https://api.example.test/steward",
}));

vi.mock("../../../shell/steward-config", () => ({
  configuredStewardTenantId: () => "elizacloud",
  DEFAULT_STEWARD_TENANT_ID: "elizacloud",
}));

vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

vi.mock("../../lib/steward-email-login", () => ({
  StewardEmailLoginError: class StewardEmailLoginError extends Error {},
  startStewardEmailLogin: vi.fn(),
  verifyStewardEmailSignInCode: vi.fn(),
  pollStewardEmailSignInStatus: vi.fn(),
}));

vi.mock("../../lib/steward-session", () => ({
  hasStewardOAuthCallbackInUrl: () => false,
  consumeStewardCodeFromQuery: () => null,
  stripLegacyTokenHashFromAddressBar: () => false,
  exchangeStewardCodeViaApi: vi.fn(),
  recoverStewardSessionViaCookie: vi.fn(),
  refreshStewardSessionViaCookie: vi.fn(),
  syncStewardSessionCookie: sessionSpies.sync,
}));

vi.mock("../../lib/login-return-to", () => ({
  resolveLoginReturnTo: returnToSpies.resolve,
  consumePendingOAuthReturnTo: () => null,
  storePendingOAuthReturnTo: () => undefined,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn() },
}));

import StewardLoginSection from "./steward-login-section";

function renderSection(initialEntry = "/login") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <StewardLoginSection />
    </MemoryRouter>,
  );
}

async function sendPhoneCode() {
  const phoneInput = await screen.findByLabelText("Phone number");
  fireEvent.change(phoneInput, { target: { value: "+1 (415) 555-2671" } });
  fireEvent.click(screen.getByRole("button", { name: "Text me a code" }));
  await screen.findByText("Enter the text code");
}

describe("StewardLoginSection phone login", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    authSpies.getProviders.mockResolvedValue({
      passkey: false,
      email: true,
      sms: true,
      siwe: false,
      siws: false,
      google: true,
      discord: false,
      github: false,
      twitter: false,
      oauth: ["google"],
    });
    authSpies.getSession.mockReturnValue(null);
    authSpies.refreshSession.mockResolvedValue(null);
    authSpies.sendSmsOtp.mockResolvedValue({
      ok: true,
      expiresAt: "2026-08-12T12:05:00.000Z",
    });
    authSpies.verifySmsOtp.mockResolvedValue({
      token: "sms-session-token",
      refreshToken: "sms-refresh-token",
      expiresIn: 900,
      user: { id: "user-1", email: null },
    });
    window.localStorage.clear();
    sessionSpies.storedToken = null;
    sessionSpies.sync.mockResolvedValue(undefined);
    returnToSpies.resolve.mockReturnValue("/dashboard/agents");
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("restores an existing browser token through the Cloud session boundary", async () => {
    sessionSpies.storedToken = "existing-session-token";

    renderSection();

    await waitFor(() =>
      expect(sessionSpies.sync).toHaveBeenCalledWith(
        "existing-session-token",
        null,
      ),
    );
    expect(authSpies.refreshSession).not.toHaveBeenCalled();
  });

  it("normalizes E.164, sends a code, and exposes the cooldown before resend", async () => {
    renderSection();

    await sendPhoneCode();

    expect(authSpies.sendSmsOtp).toHaveBeenCalledWith("+14155552671");
    expect(screen.getByText("+14155552671")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Resend in 30s",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    fireEvent.click(screen.getByRole("button", { name: "Resend code" }));

    await waitFor(() => expect(authSpies.sendSmsOtp).toHaveBeenCalledTimes(2));
    expect(authSpies.sendSmsOtp).toHaveBeenLastCalledWith("+14155552671");
  });

  it("rejects a phone number without an explicit country code", async () => {
    renderSection();

    const phoneInput = await screen.findByLabelText("Phone number");
    fireEvent.change(phoneInput, { target: { value: "415-555-2671" } });
    fireEvent.click(screen.getByRole("button", { name: "Text me a code" }));

    expect(
      await screen.findByText(
        "Enter a complete phone number with country code, such as +1 415 555 2671.",
      ),
    ).toBeTruthy();
    expect(authSpies.sendSmsOtp).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Magic Link" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Google" })).toBeTruthy();
  });

  it("holds the send state while Steward is pending and surfaces its failure", async () => {
    let rejectSend: (error: Error) => void = () => undefined;
    authSpies.sendSmsOtp.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectSend = reject;
      }),
    );
    renderSection();

    const phoneInput = await screen.findByLabelText("Phone number");
    fireEvent.change(phoneInput, { target: { value: "+14155552671" } });
    fireEvent.click(screen.getByRole("button", { name: "Text me a code" }));

    await waitFor(() =>
      expect((phoneInput as HTMLInputElement).disabled).toBe(true),
    );
    expect(
      (screen.getByRole("button", { name: "Magic Link" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    await act(async () => rejectSend(new Error("SMS temporarily unavailable")));

    expect(await screen.findByText("SMS temporarily unavailable")).toBeTruthy();
    expect((phoneInput as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByText("Enter the text code")).toBeNull();
  });

  it("verifies six digits through the existing session completion authority", async () => {
    renderSection("/login?returnTo=%2Fdashboard%2Fagents");
    await sendPhoneCode();

    const codeInput = screen.getByLabelText("Six-digit code");
    fireEvent.change(codeInput, { target: { value: "12a345678" } });
    expect((codeInput as HTMLInputElement).value).toBe("123456");
    fireEvent.click(screen.getByRole("button", { name: "Verify phone" }));

    await waitFor(() =>
      expect(authSpies.verifySmsOtp).toHaveBeenCalledWith(
        "+14155552671",
        "123456",
      ),
    );
    await waitFor(() =>
      expect(sessionSpies.sync).toHaveBeenCalledWith(
        "sms-session-token",
        "sms-refresh-token",
        { verifiedPhone: "+14155552671" },
      ),
    );
    expect(sessionSpies.write).toHaveBeenCalledWith("sms-session-token");
    expect(returnToSpies.resolve).toHaveBeenCalled();
  });

  it("keeps the SDK token private until phone-account convergence completes", async () => {
    let completeSync: (() => void) | undefined;
    const storageEvent = vi.fn();
    window.addEventListener("storage", storageEvent);
    sessionSpies.sync.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        completeSync = resolve;
      }),
    );
    renderSection();
    await sendPhoneCode();

    fireEvent.change(screen.getByLabelText("Six-digit code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify phone" }));

    await waitFor(() => expect(sessionSpies.sync).toHaveBeenCalledTimes(1));
    expect(authSpies.storage?.getItem("steward_session_token")).toBe(
      "sms-session-token",
    );
    expect(window.localStorage.getItem("steward_session_token")).toBeNull();
    expect(storageEvent).not.toHaveBeenCalled();
    expect(sessionSpies.write).not.toHaveBeenCalled();

    await act(async () => completeSync?.());
    await waitFor(() =>
      expect(sessionSpies.write).toHaveBeenCalledWith("sms-session-token"),
    );
    window.removeEventListener("storage", storageEvent);
  });

  it("keeps a rejected verification recoverable without creating a session", async () => {
    authSpies.verifySmsOtp.mockRejectedValue(new Error("Code expired"));
    renderSection();
    await sendPhoneCode();

    fireEvent.change(screen.getByLabelText("Six-digit code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify phone" }));

    expect(await screen.findByText("Code expired")).toBeTruthy();
    expect(screen.getByLabelText("Six-digit code")).toBeTruthy();
    expect(sessionSpies.sync).not.toHaveBeenCalled();
    expect(sessionSpies.write).not.toHaveBeenCalled();
  });
});

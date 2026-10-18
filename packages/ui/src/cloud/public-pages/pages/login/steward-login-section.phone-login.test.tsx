/**
 * Verifies the app-hosted Steward SMS login state machine with deterministic
 * SDK and session-boundary doubles; no real text messages or sessions are used.
 */
// @vitest-environment jsdom

import { STEWARD_SESSION_CHANGE_EVENT } from "@elizaos/plugin-elizacloud/steward-session-client";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
});

const authSpies = vi.hoisted(() => ({
  configurations: [] as Array<{ baseUrl?: string; tenantId?: string }>,
  smsConfigurations: [] as Array<{ baseUrl?: string; tenantId?: string }>,
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
  hasAuthedCookie: false,
  clear: vi.fn(),
  recover: vi.fn(),
  write: vi.fn(),
  sync: vi.fn(),
}));

const handoffSpies = vi.hoisted(() => ({
  mint: vi.fn(),
  burn: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("../../../app-mode/app-mode", () => ({
  appModeNavigation: { replace: handoffSpies.replace },
}));
vi.mock("../../../sso-bridge/sso-bridge", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../sso-bridge/sso-bridge")>();
  return {
    ...actual,
    mintSsoCode: handoffSpies.mint,
    burnSsoBridgeCode: handoffSpies.burn,
  };
});

const returnToSpies = vi.hoisted(() => ({
  resolve: vi.fn(),
  consume: vi.fn(),
}));

vi.mock(
  "@elizaos/plugin-elizacloud/steward-session-client",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@elizaos/plugin-elizacloud/steward-session-client")
      >();
    return {
      ...actual,
      hasStewardAuthedCookie: () => sessionSpies.hasAuthedCookie,
      readStoredStewardToken: () => sessionSpies.storedToken,
      clearStoredStewardToken: async () => {
        sessionSpies.storedToken = null;
        sessionSpies.clear();
      },
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
    };
  },
);

vi.mock("@elizaos/auth", () => ({
  LoginAuth: class {
    private config: { baseUrl?: string; tenantId?: string };
    constructor(config: {
      baseUrl?: string;
      tenantId?: string;
      storage: {
        getItem(key: string): string | null;
        setItem(key: string, value: string): void;
        removeItem(key: string): void;
      };
    }) {
      this.config = config;
      authSpies.storage = config.storage;
      authSpies.configurations.push({
        baseUrl: config.baseUrl,
        tenantId: config.tenantId,
      });
    }

    getProviders = authSpies.getProviders;
    getSession = authSpies.getSession;
    refreshSession = authSpies.refreshSession;
    async sendSmsOtp(...args: unknown[]) {
      authSpies.smsConfigurations.push(this.config);
      return await authSpies.sendSmsOtp(...args);
    }

    async verifySmsOtp(phone: string, code: string) {
      authSpies.smsConfigurations.push(this.config);
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
  recoverStewardSessionViaCookie: sessionSpies.recover,
  refreshStewardSessionViaCookie: vi.fn(),
  syncStewardSessionCookie: sessionSpies.sync,
  resolveStewardAuthEndpoint: (path: string) =>
    `https://api.example.test${path}`,
}));

vi.mock("../../lib/login-return-to", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/login-return-to")>();
  return {
    ...actual,
    resolveLoginReturnTo: returnToSpies.resolve,
    consumePendingOAuthReturnTo: returnToSpies.consume,
  };
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn() },
}));

import type { StewardLoginMethod } from "./steward-login-methods";
import StewardLoginSection from "./steward-login-section";

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: object) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.sig`;
}

function LoginDestinationProbe() {
  const location = useLocation();
  return (
    <span data-testid="login-destination">
      {location.pathname}
      {location.search}
    </span>
  );
}

function renderSection(
  initialEntry = "/login",
  phoneOnly = false,
  allowedMethods?: readonly StewardLoginMethod[],
) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <StewardLoginSection
        phoneOnly={phoneOnly}
        allowedMethods={allowedMethods}
      />
      <LoginDestinationProbe />
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
  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    authSpies.configurations.length = 0;
    authSpies.smsConfigurations.length = 0;
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
    sessionSpies.hasAuthedCookie = false;
    sessionSpies.recover.mockResolvedValue(null);
    sessionSpies.sync.mockImplementation(
      async (
        token: string,
        _refresh?: string | null,
        options?: { signal?: AbortSignal; expectedToken?: string | null },
      ) => {
        if (!options?.signal) return;
        options.signal.throwIfAborted();
        if (sessionSpies.storedToken !== options.expectedToken)
          throw new DOMException("Session changed", "AbortError");
        sessionSpies.storedToken = token;
        sessionSpies.write(token);
      },
    );
    const returnTo = await vi.importActual<
      typeof import("../../lib/login-return-to")
    >("../../lib/login-return-to");
    returnToSpies.resolve.mockImplementation(returnTo.resolveLoginReturnTo);
    returnToSpies.consume.mockReturnValue(null);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("restricts Alpha presentation to discovered Google, email and phone without changing default capabilities", async () => {
    authSpies.getProviders.mockResolvedValue({
      passkey: true,
      email: true,
      sms: true,
      siwe: true,
      siws: true,
      google: true,
      discord: true,
      github: true,
      twitter: true,
      telegram: true,
      oauth: ["google", "discord", "github", "twitter", "apple"],
    });
    renderSection("/alpha/sign-in", false, ["google", "email", "sms"]);
    await screen.findByRole("button", { name: "Google" });
    const summary = screen.getByText("Phone or email");
    const disclosure = summary.closest("details") as HTMLDetailsElement;
    expect(disclosure.open).toBe(false);
    fireEvent.click(summary);
    expect(disclosure.open).toBe(true);
    await screen.findByRole("button", { name: "Email me a link" });
    expect(screen.getByRole("button", { name: "Google" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Text me a code" })).toBeTruthy();
    for (const name of [
      /passkey/i,
      /magic link/i,
      /discord/i,
      /github/i,
      /twitter/i,
      /apple/i,
      /telegram/i,
      /wallet/i,
    ])
      expect(screen.queryByRole("button", { name })).toBeNull();
    cleanup();
    renderSection();
    await screen.findByRole("button", { name: "Magic Link" });
    expect(screen.getByRole("button", { name: "Discord" })).toBeTruthy();
  });

  it("does not enable a selected method the server disabled", async () => {
    authSpies.getProviders.mockResolvedValue({
      passkey: true,
      email: false,
      sms: false,
      siwe: false,
      siws: false,
      google: true,
      discord: true,
      github: false,
      twitter: false,
      oauth: ["google", "discord"],
    });
    renderSection("/alpha/sign-in", false, ["google", "email", "sms"]);
    await screen.findByRole("button", { name: "Google" });
    expect(
      screen.queryByRole("button", { name: "Email me a link" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Text me a code" })).toBeNull();
    expect(screen.queryByLabelText("Email")).toBeNull();
  });

  it("offers recovery when successful discovery has no allowed Alpha methods", async () => {
    authSpies.getProviders.mockResolvedValue({
      passkey: true,
      email: false,
      sms: false,
      siwe: true,
      siws: true,
      google: false,
      discord: true,
      github: false,
      twitter: false,
      oauth: ["discord"],
    });
    renderSection("/alpha/sign-in", false, ["google", "email", "sms"]);
    await screen.findByText(
      "Sign-in is unavailable right now. Please try again.",
    );
    expect(
      screen.getByRole("button", { name: "Retry sign-in options" }),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.queryByRole("button", { name: /wallet/i })).toBeNull();
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
    fireEvent.click(
      screen.getByRole("button", { name: "Retry sign-in options" }),
    );
    await screen.findByRole("button", { name: "Google" });
    fireEvent.click(screen.getByText("Phone or email"));
    await screen.findByRole("button", { name: "Email me a link" });
    expect(screen.getByRole("button", { name: "Google" })).toBeTruthy();
  });

  it("offers only phone sign-in on the Network entry without restoring another identity", async () => {
    sessionSpies.storedToken = makeJwt({
      userId: "older-user",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    renderSection("/network/sign-in", true);
    expect(await screen.findByLabelText("Phone number")).toBeTruthy();
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.queryByText("or continue with")).toBeNull();
    expect(sessionSpies.sync).not.toHaveBeenCalled();
    expect(sessionSpies.recover).not.toHaveBeenCalled();
  });

  it("completes phone-only verification through the existing verified-phone sync", async () => {
    renderSection("/network/sign-in", true);
    await sendPhoneCode();
    fireEvent.change(screen.getByLabelText("Six-digit code"), {
      target: { value: "123456" },
    });
    expect(
      screen.getByRole("button", { name: "Change phone number" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(sessionSpies.sync).toHaveBeenCalledWith(
        "sms-session-token",
        "sms-refresh-token",
        {
          verifiedPhone: "+14155552671",
          expectedToken: null,
          signal: expect.any(AbortSignal),
        },
      ),
    );
    expect(returnToSpies.resolve).toHaveBeenCalledWith(
      expect.any(URLSearchParams),
    );
    expect(returnToSpies.consume).not.toHaveBeenCalled();
    expect(sessionSpies.write).toHaveBeenCalledWith("sms-session-token");
  });

  it.each([
    [
      "/auth/bridge?state=owned&challenge=owned&returnTo=%2Fjoin",
      "/auth/bridge?state=owned&challenge=owned&returnTo=%2Fjoin",
    ],
    ["https://evil.example/", "/join"],
    ["//evil.example/", "/join"],
  ])(
    "phone-only completion sanitizes its bridge returnTo: %s",
    async (returnTo, destination) => {
      renderSection(
        `/network/sign-in?returnTo=${encodeURIComponent(returnTo)}`,
        true,
      );
      await sendPhoneCode();
      fireEvent.change(screen.getByLabelText("Six-digit code"), {
        target: { value: "123456" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
      await waitFor(() =>
        expect(screen.getByTestId("login-destination").textContent).toBe(
          destination,
        ),
      );
      expect(returnToSpies.consume).not.toHaveBeenCalled();
      expect(handoffSpies.mint).not.toHaveBeenCalled();
    },
  );

  it.each(["cancel", "unmount"])(
    "does not publish a late verification after %s without a handoff tuple",
    async (action) => {
      const existingToken = makeJwt({
        userId: "existing-user",
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      sessionSpies.storedToken = existingToken;
      let finishVerify!: (value: object) => void;
      authSpies.verifySmsOtp.mockReturnValueOnce(
        new Promise((resolve) => {
          finishVerify = resolve;
        }),
      );
      const view = renderSection("/network/sign-in", true);
      await sendPhoneCode();
      fireEvent.change(screen.getByLabelText("Six-digit code"), {
        target: { value: "123456" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
      await waitFor(() =>
        expect(authSpies.verifySmsOtp).toHaveBeenCalledTimes(1),
      );
      if (action === "cancel")
        fireEvent.click(
          screen.getByRole("button", { name: "Change phone number" }),
        );
      else view.unmount();
      if (action === "cancel") {
        authSpies.sendSmsOtp.mockReturnValueOnce(new Promise(() => undefined));
        fireEvent.click(screen.getByRole("button", { name: "Text me a code" }));
      }
      await act(async () => {
        finishVerify({
          token: "late-token",
          refreshToken: "late-refresh",
          expiresIn: 900,
          user: { id: "late-user", email: null },
        });
      });
      expect(sessionSpies.sync).not.toHaveBeenCalled();
      expect(sessionSpies.write).not.toHaveBeenCalled();
      expect(handoffSpies.mint).not.toHaveBeenCalled();
      expect(handoffSpies.replace).not.toHaveBeenCalled();
      expect(sessionSpies.storedToken).toBe(existingToken);
      if (action === "cancel") {
        expect(screen.getByLabelText("Phone number")).toBeTruthy();
        expect(screen.queryByLabelText("Six-digit code")).toBeNull();
        expect(
          screen
            .getByRole("button", { name: "Text me a code" })
            .hasAttribute("disabled"),
        ).toBe(true);
      }
    },
  );

  it("does not overwrite a newer send error with an abandoned verification error", async () => {
    let failVerify!: (reason: Error) => void;
    authSpies.verifySmsOtp.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        failVerify = reject;
      }),
    );
    renderSection("/network/sign-in", true);
    await sendPhoneCode();
    fireEvent.change(screen.getByLabelText("Six-digit code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(authSpies.verifySmsOtp).toHaveBeenCalledTimes(1),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Change phone number" }),
    );
    authSpies.sendSmsOtp.mockRejectedValueOnce(new Error("New send failed"));
    fireEvent.click(screen.getByRole("button", { name: "Text me a code" }));
    await screen.findByText("New send failed");
    await act(async () => {
      failVerify(new Error("Old verification failed"));
    });
    expect(screen.getByText("New send failed")).toBeTruthy();
    expect(screen.queryByText("Old verification failed")).toBeNull();
    expect(sessionSpies.sync).not.toHaveBeenCalled();
    expect(sessionSpies.write).not.toHaveBeenCalled();
  });

  it("does not reopen the code view when a cancelled resend completes", async () => {
    renderSection("/network/sign-in", true);
    await sendPhoneCode();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    let finishSend!: (value: object) => void;
    authSpies.sendSmsOtp.mockReturnValueOnce(
      new Promise((resolve) => {
        finishSend = resolve;
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Resend code" }));
    await waitFor(() => expect(authSpies.sendSmsOtp).toHaveBeenCalledTimes(2));
    fireEvent.click(
      screen.getByRole("button", { name: "Change phone number" }),
    );
    await act(async () => {
      finishSend({ ok: true, expiresAt: "2026-08-12T12:05:00.000Z" });
    });
    expect(screen.getByLabelText("Phone number")).toBeTruthy();
    expect(screen.queryByLabelText("Six-digit code")).toBeNull();
    expect(sessionSpies.sync).not.toHaveBeenCalled();
    expect(sessionSpies.write).not.toHaveBeenCalled();
  });

  it("does not publish a pending phone verification after explicit logout from an empty session", async () => {
    const canonical = await vi.importActual<
      typeof import("@elizaos/plugin-elizacloud/steward-session-client")
    >("@elizaos/plugin-elizacloud/steward-session-client");
    let finishVerify!: (value: object) => void;
    authSpies.verifySmsOtp.mockReturnValueOnce(
      new Promise((resolve) => {
        finishVerify = resolve;
      }),
    );
    renderSection("/network/sign-in", true);
    await sendPhoneCode();
    fireEvent.change(screen.getByLabelText("Six-digit code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(authSpies.verifySmsOtp).toHaveBeenCalledTimes(1),
    );
    expect(sessionSpies.storedToken).toBeNull();
    await act(async () => {
      await canonical.clearStoredStewardToken();
    });
    expect(
      screen.getByRole("button", { name: "Sign in" }).hasAttribute("disabled"),
    ).toBe(false);
    await act(async () => {
      finishVerify({
        token: "late-phone-token",
        refreshToken: "late-refresh",
        expiresIn: 900,
        user: { id: "phone-user", email: null },
      });
    });
    expect(sessionSpies.sync).not.toHaveBeenCalled();
    expect(sessionSpies.write).not.toHaveBeenCalled();
    expect(handoffSpies.mint).not.toHaveBeenCalled();
    expect(handoffSpies.replace).not.toHaveBeenCalled();
    expect(sessionSpies.storedToken).toBeNull();
    expect(canonical.readStoredStewardToken()).toBeNull();
  });

  it("does not replace an external sign-in while phone verification is pending", async () => {
    const initial = makeJwt({
      userId: "initial-user",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const newer = makeJwt({
      userId: "newer-user",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    sessionSpies.storedToken = initial;
    let finishVerify!: (value: object) => void;
    authSpies.verifySmsOtp.mockReturnValueOnce(
      new Promise((resolve) => {
        finishVerify = resolve;
      }),
    );
    renderSection("/network/sign-in", true);
    await sendPhoneCode();
    fireEvent.change(screen.getByLabelText("Six-digit code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(authSpies.verifySmsOtp).toHaveBeenCalledTimes(1),
    );
    sessionSpies.storedToken = newer;
    window.dispatchEvent(
      new CustomEvent(STEWARD_SESSION_CHANGE_EVENT, {
        detail: { state: "present", sessionEpoch: 2 },
      }),
    );
    await act(async () => {
      finishVerify({
        token: "late-phone-token",
        refreshToken: "late-refresh",
        expiresIn: 900,
        user: { id: "phone-user", email: null },
      });
    });
    expect(sessionSpies.sync).not.toHaveBeenCalled();
    expect(sessionSpies.write).not.toHaveBeenCalled();
    expect(handoffSpies.mint).not.toHaveBeenCalled();
    expect(handoffSpies.replace).not.toHaveBeenCalled();
    expect(sessionSpies.storedToken).toBe(newer);
  });

  it("burns a late handoff code after unmount without redirecting", async () => {
    vi.stubGlobal(
      "location",
      new URL("https://cloud-staging.eliza.app/network/sign-in"),
    );
    let finishMint!: (value: { ok: true; code: string }) => void;
    handoffSpies.mint.mockReturnValueOnce(
      new Promise((resolve) => {
        finishMint = resolve;
      }),
    );
    const tuple = new URLSearchParams({
      networkSite: "http://127.0.0.1:5102",
      state: "a".repeat(64),
      challenge: "b".repeat(64),
    });
    const view = renderSection(`/network/sign-in?${tuple}`, true);
    await sendPhoneCode();
    fireEvent.change(screen.getByLabelText("Six-digit code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(handoffSpies.mint).toHaveBeenCalledTimes(1));
    expect(sessionSpies.sync).toHaveBeenCalledWith(
      "sms-session-token",
      "sms-refresh-token",
      {
        verifiedPhone: "+14155552671",
        expectedToken: null,
        signal: expect.any(AbortSignal),
      },
    );
    expect(sessionSpies.write).toHaveBeenCalledWith("sms-session-token");
    view.unmount();
    const code = `enso_${"c".repeat(64)}`;
    await act(async () => {
      finishMint({ ok: true, code });
    });
    expect(handoffSpies.replace).not.toHaveBeenCalled();
    expect(handoffSpies.burn).toHaveBeenCalledTimes(1);
    expect(handoffSpies.burn).toHaveBeenCalledWith(
      code,
      "cloud-staging.eliza.app",
      fetch,
      true,
    );
    expect(sessionSpies.clear).not.toHaveBeenCalled();
  });
});

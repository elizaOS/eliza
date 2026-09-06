/**
 * Verifies the signed-out Steward login form does not render an unowned
 * "Too many requests" alert from background session restoration (#27712).
 * Deterministic SDK and session-boundary doubles; no real sessions.
 */
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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
  getProviders: vi.fn(),
  getSession: vi.fn(),
  refreshSession: vi.fn(),
  sendSmsOtp: vi.fn(),
}));

const sessionSpies = vi.hoisted(() => ({
  storedToken: null as string | null,
  hasAuthedCookie: vi.fn(),
  recover: vi.fn(),
  sync: vi.fn(),
}));

vi.mock("@elizaos/shared/steward-session-client", () => ({
  hasStewardAuthedCookie: sessionSpies.hasAuthedCookie,
  readStoredStewardToken: () => sessionSpies.storedToken,
  writeStoredStewardToken: vi.fn(),
  StewardSessionError: class StewardSessionError extends Error {
    status: number;
    code: string | null;
    constructor(message: string, status: number, code: string | null = null) {
      super(message);
      this.name = "StewardSessionError";
      this.status = status;
      this.code = code;
    }
  },
}));

vi.mock("@stwd/sdk", () => ({
  StewardAuth: class {
    getProviders = authSpies.getProviders;
    getSession = authSpies.getSession;
    refreshSession = authSpies.refreshSession;
    sendSmsOtp = authSpies.sendSmsOtp;
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
  recoverStewardEmailSessionViaCookie: vi.fn(),
  refreshStewardSessionViaCookie: vi.fn(),
  syncStewardSessionCookie: sessionSpies.sync,
}));

vi.mock("../../lib/login-return-to", () => ({
  resolveLoginReturnTo: () => "/chat",
  consumePendingOAuthReturnTo: () => null,
  storePendingOAuthReturnTo: () => undefined,
}));

import { StewardSessionError } from "@elizaos/shared/steward-session-client";
import StewardLoginSection from "./steward-login-section";

function renderSignedOutLogin() {
  return render(
    <MemoryRouter initialEntries={["/login?returnTo=%2Fchat"]}>
      <StewardLoginSection />
    </MemoryRouter>,
  );
}

async function expectWorkingSignedOutForm() {
  expect(await screen.findByLabelText("Phone number")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Google" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Magic Link" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("Too many requests")).toBeNull();
}

describe("StewardLoginSection unowned rate-limit alert (#27712)", () => {
  beforeEach(() => {
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
      expiresAt: "2026-08-27T12:05:00.000Z",
    });
    window.localStorage.clear();
    sessionSpies.storedToken = null;
    sessionSpies.hasAuthedCookie.mockReturnValue(false);
    sessionSpies.recover.mockResolvedValue(null);
    sessionSpies.sync.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("does not alert Too many requests when cookie session restore is rate-limited", async () => {
    sessionSpies.hasAuthedCookie.mockReturnValue(true);
    sessionSpies.recover.mockRejectedValue(
      new StewardSessionError("Too many requests", 429, "rate_limited"),
    );

    renderSignedOutLogin();

    await expectWorkingSignedOutForm();
    expect(sessionSpies.recover).toHaveBeenCalled();
  });

  it("does not alert Too many requests when stored-token cookie sync is rate-limited", async () => {
    sessionSpies.storedToken = "stale-browser-token";
    sessionSpies.hasAuthedCookie.mockReturnValue(false);
    sessionSpies.sync.mockRejectedValue(new Error("Too many requests"));

    renderSignedOutLogin();

    await expectWorkingSignedOutForm();
    expect(sessionSpies.sync).toHaveBeenCalledWith("stale-browser-token", null);
  });

  it("still surfaces an owned Too many requests alert after the user sends an SMS code", async () => {
    authSpies.sendSmsOtp.mockRejectedValue(new Error("Too many requests"));

    renderSignedOutLogin();

    const phoneInput = await screen.findByLabelText("Phone number");
    fireEvent.change(phoneInput, { target: { value: "+14155552671" } });
    fireEvent.click(screen.getByRole("button", { name: "Text me a code" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Too many requests")).toBeTruthy();
    expect(screen.queryByText("Enter the text code")).toBeNull();
  });
});

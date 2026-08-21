/** Verifies StewardLoginSection button label contrast through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Regression coverage for the invisible-label login buttons. The primary CTAs
 * pass `variant="ghost"` plus a `bg-accent` className; the ghost variant's
 * `text-txt-strong` (white on .theme-cloud, where --accent is ALSO white)
 * combined with a blanket `disabled:opacity-50` rendered the labels as a flat
 * washed-out bar — only the loading spinner was legible. These tests pin the
 * merged class list: the accent fill must keep `text-accent-foreground` in
 * idle/hover/disabled (never the ghost variant's `text-txt-strong`, never
 * `disabled:opacity-50`), and the idle button must render its label enabled.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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
        google: true,
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
  subscribeStewardEmailLoginComplete: vi.fn(() => vi.fn()),
}));

import StewardLoginSection from "./steward-login-section";

function renderSection() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <StewardLoginSection />
    </MemoryRouter>,
  );
}

/**
 * Asserts the merged class list keeps the accent CTA's label legible on the
 * accent fill in every state instead of inheriting the ghost variant's
 * neutral text color or a blanket disabled fade.
 */
function expectAccentLabelContrast(button: HTMLElement) {
  const classes = button.className;
  // Idle: label color must be the accent's paired foreground, not the ghost
  // variant's text-txt-strong (which equals the accent fill on .theme-cloud).
  expect(classes).toMatch(/(^| )text-accent-foreground( |$)/);
  expect(classes).not.toMatch(/(^| )text-txt-strong( |$)/);
  // Hover: keep the paired foreground (ghost's hover:text-txt-strong loses).
  expect(classes).toContain("hover:text-accent-foreground");
  // Disabled: dim the FILL, never fade the whole button to a gray bar.
  expect(classes).not.toContain("disabled:opacity-50");
  expect(classes).toContain("disabled:text-accent-foreground");
}

describe("StewardLoginSection button label contrast", () => {
  beforeEach(() => {
    window.localStorage.clear();
    emailLoginSpies.start.mockResolvedValue({
      expiresAt: Date.now() + 600_000,
      challengeId: "challenge-1",
      pollSecret: "poll-secret",
    });
    emailLoginSpies.poll.mockResolvedValue("pending");
    sessionSpies.sync.mockResolvedValue(undefined);
    sessionSpies.recover.mockResolvedValue({ ok: true });
    sessionSpies.recoverEmail.mockResolvedValue({ ok: true });
    sessionSpies.hasAuthedCookie.mockReturnValue(false);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the idle Magic Link button enabled with a visible label", async () => {
    renderSection();
    const magicLink = await screen.findByRole<HTMLButtonElement>("button", {
      name: /Magic Link/i,
    });
    expect(magicLink.disabled).toBe(false);
    expect(magicLink.textContent).toContain("Magic Link");
    // The bordered secondary CTA keeps explicit label color + border in the
    // disabled state instead of a whole-button opacity fade.
    expect(magicLink.className).toMatch(/(^| )text-txt( |$)/);
    expect(magicLink.className).not.toContain("disabled:opacity-50");
  });

  it("keeps OAuth button labels legible without a blanket disabled fade", async () => {
    renderSection();
    const google = await screen.findByRole<HTMLButtonElement>("button", {
      name: /Google/i,
    });
    expect(google.textContent).toContain("Google");
    expect(google.className).toMatch(/(^| )text-txt( |$)/);
    expect(google.className).not.toContain("disabled:opacity-50");
  });

  it("renders the email-sent Verify button with accent-contrast label classes in idle and disabled states", async () => {
    renderSection();
    const input = await screen.findByPlaceholderText("you@example.com");
    fireEvent.change(input, { target: { value: "person@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Magic Link/i }));

    const codeInput = await screen.findByLabelText("Six-digit code");
    const verify = screen.getByRole<HTMLButtonElement>("button", {
      name: /Verify code/i,
    });
    expect(verify.textContent).toContain("Verify code");
    expectAccentLabelContrast(verify);

    // Empty code: the button is disabled but its classes must still pair the
    // accent fill with its foreground (no opacity fade, no gray bar).
    expect(verify.disabled).toBe(true);

    // With a complete code the button enables and keeps the same label color.
    fireEvent.change(codeInput, { target: { value: "123456" } });
    const enabledVerify = screen.getByRole<HTMLButtonElement>("button", {
      name: /Verify code/i,
    });
    expect(enabledVerify.disabled).toBe(false);
    expectAccentLabelContrast(enabledVerify);
  });
});

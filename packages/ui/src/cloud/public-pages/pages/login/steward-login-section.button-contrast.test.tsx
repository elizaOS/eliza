/** Verifies StewardLoginSection button contrast through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Regression coverage for the invisible-label login buttons. Primary CTAs use
 * the canonical default variant, whose accent fill must keep `text-accent-fg`
 * in idle and disabled states. Secondary provider icons use `outlineMuted`,
 * keep their stronger muted label contrast, and never inherit a blanket
 * `disabled:opacity-50`. The idle controls must render their labels enabled.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
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
        siwe: true,
        siws: false,
        google: true,
        discord: true,
        github: true,
        twitter: true,
        telegram: true,
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
 * accent fill in every state through the canonical default variant rather
 * than a caller paint override or blanket disabled fade.
 */
function expectAccentLabelContrast(button: HTMLElement) {
  const classes = button.className;
  // Idle: label color must be the accent's paired foreground.
  expect(classes).toMatch(/(^| )text-accent-fg( |$)/);
  expect(classes).not.toMatch(/(^| )text-txt-strong( |$)/);
  // Disabled: dim the FILL, never fade the whole button to a gray bar.
  expect(classes).not.toContain("disabled:opacity-50");
  expect(classes).toContain("disabled:text-accent-fg");
}

describe("StewardLoginSection button label contrast", () => {
  beforeEach(() => {
    window.localStorage.clear();
    emailLoginSpies.start.mockResolvedValue({
      expiresAt: Date.now() + 600_000,
      challengeId: "challenge-1",
      pollSecret: "poll-secret",
      emailCodeDelivered: true,
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
    expect(magicLink.className).toMatch(/(^| )text-muted-strong( |$)/);
    expect(magicLink.className).not.toContain("disabled:opacity-50");
  });

  it("keeps all six compact provider actions accessible by icon", async () => {
    renderSection();
    const providerGroup = await screen.findByRole("group", {
      name: "or continue with",
    });
    expect(providerGroup.tagName).toBe("FIELDSET");

    const providerButtons = within(providerGroup).getAllByRole("button");
    expect(providerButtons).toHaveLength(6);

    const providerNames = [
      "Google",
      "Discord",
      "GitHub",
      "X",
      "Telegram",
      "Continue with a wallet",
    ];
    for (const accessibleName of providerNames) {
      const button = within(providerGroup).getByRole<HTMLButtonElement>(
        "button",
        { name: accessibleName },
      );
      expect(button.getAttribute("aria-label")).toBe(accessibleName);
      expect(button.getAttribute("title")).toBe(accessibleName);
      expect(button.textContent?.trim()).toBe("");
      expect(button.querySelector("span")).toBeNull();
      expect(button.querySelector("svg")).not.toBeNull();
    }
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

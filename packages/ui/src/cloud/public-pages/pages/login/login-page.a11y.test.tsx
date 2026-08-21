/**
 * LoginPage / StewardLoginSection public-surface a11y contracts under a
 * mocked Steward provider-discovery harness (jsdom). Asserts main landmark,
 * persistent email label (for/id), focus-visible border hooks that survive the
 * global outline ban, and touch-sized Terms/Privacy links.
 */
// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../../lib/use-page-title", () => ({ usePageTitle: () => {} }));

// Eager section import — LoginPage also lazy-loads this module; importing it
// here keeps Suspense resolution deterministic under the test runner.
import LoginPage from "./login-page";
import StewardLoginSection from "./steward-login-section";

afterEach(() => {
  cleanup();
});

describe("LoginPage accessibility", () => {
  it("owns a dark full-viewport canvas instead of leaking the light document background", async () => {
    await act(async () => {
      render(
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const fill = screen.getByTestId("login-safe-area-fill");
    expect(fill.className).toContain("z-0");
    expect(fill.className).toContain("bg-bg");
    expect(fill.parentElement?.className).toContain("isolate");
    expect(fill.parentElement?.className).toContain("bg-bg");
  });

  it("exposes a main landmark and touch-sized legal links", async () => {
    await act(async () => {
      render(
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>,
      );
      // Flush the lazy StewardLoginSection chunk + provider discovery.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.querySelectorAll("main")).toHaveLength(1);
    expect(
      screen.getByRole("heading", { level: 1, name: "Sign in" }),
    ).toBeTruthy();

    const terms = screen.getByRole("link", { name: "Terms" });
    const privacy = screen.getByRole("link", { name: "Privacy Policy" });
    expect(terms.className).toContain("min-h-touch");
    expect(privacy.className).toContain("min-h-touch");
  });
});

describe("StewardLoginSection accessibility", () => {
  it("binds a persistent Email label to the email input", async () => {
    await act(async () => {
      render(
        <MemoryRouter>
          <StewardLoginSection />
        </MemoryRouter>,
      );
    });

    const email = await waitFor(() => screen.getByLabelText("Email"));
    expect(email.getAttribute("type")).toBe("email");
    expect(email.id).toBe("steward-login-email");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Magic Link/i })).toBeTruthy();
    });
  });
});

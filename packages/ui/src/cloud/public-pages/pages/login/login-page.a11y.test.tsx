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
      screen.getByRole("heading", { level: 1, name: "Sign in to Eliza Cloud" }),
    ).toBeTruthy();

    const terms = screen.getByRole("link", { name: "Terms" });
    const privacy = screen.getByRole("link", { name: "Privacy Policy" });
    expect(terms.className).toContain("min-h-touch");
    expect(privacy.className).toContain("min-h-touch");
    expect(terms.className).toContain("focus-visible:bg-bg-hover");
  });
});

describe("StewardLoginSection accessibility", () => {
  it("binds a persistent Email label and focus-visible border classes", async () => {
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
    expect(email.className).toContain("focus-visible:border-accent");

    const magic = await waitFor(() =>
      screen.getByRole("button", { name: /Magic Link/i }),
    );
    expect(magic.className).toContain("focus-visible:border-accent");
  });
});

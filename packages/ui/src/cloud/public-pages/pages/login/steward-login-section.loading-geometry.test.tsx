/**
 * Verifies StewardLoginSection's transient states reserve the final option
 * stack's geometry (#18256) under a mocked Steward harness (jsdom). The
 * provider-discovery state must render the structural skeleton — the same
 * touch-height control set as the fully-enabled form — instead of a short spinner
 * block, and the completing-callback state must carry an invisible sizing
 * ghost of that stack, so neither state resolves with a card-height jump.
 * jsdom cannot measure layout, so the contract is structural: both states
 * expose exactly the skeleton's touch-height controls and no live options.
 */
// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  hasCallback: false,
  code: null as string | null,
  providers: (): Promise<unknown> => new Promise(() => {}),
}));

vi.mock("../../lib/steward-session", () => ({
  hasStewardOAuthCallbackInUrl: () => harness.hasCallback,
  consumeStewardCodeFromQuery: () => harness.code,
  consumeStewardOAuthStateFromCallback: () => "state-1",
  stripLegacyTokenHashFromAddressBar: () => false,
  exchangeStewardCodeViaApi: () => new Promise(() => {}),
  recoverStewardSessionViaCookie: () => Promise.resolve(null),
  refreshStewardSessionViaCookie: () => Promise.resolve({ ok: true as const }),
  syncStewardSessionCookie: () => Promise.resolve(),
}));

vi.mock("@stwd/sdk", () => ({
  StewardAuth: class {
    getSession() {
      return null;
    }
    getProviders() {
      return harness.providers();
    }
    refreshSession() {
      return Promise.resolve(null);
    }
  },
}));

vi.mock("./passkey-capability", () => ({
  resolveWebPasskeyCapability: () =>
    Promise.resolve({ usable: false, reason: "native-without-bridge" }),
}));

vi.mock("../../../shell/steward-url", () => ({
  resolveBrowserStewardApiUrl: () => "https://api.example.test",
}));

vi.mock("../../../shell/steward-config", () => ({
  configuredStewardTenantId: () => "elizacloud",
  DEFAULT_STEWARD_TENANT_ID: "elizacloud",
}));

vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? _key,
}));

vi.mock("@elizaos/shared/steward-session-client", async () => {
  const actual = await vi.importActual<
    typeof import("@elizaos/shared/steward-session-client")
  >("@elizaos/shared/steward-session-client");
  return {
    ...actual,
    peekStewardOAuthState: () => "state-1",
  };
});

vi.mock("../../lib/steward-oauth-url", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/steward-oauth-url")
  >("../../lib/steward-oauth-url");
  return {
    ...actual,
    consumeStewardPkceVerifier: () => "verifier-1",
    buildStewardOAuthRedirectUri: () => "https://app.example.test/login",
  };
});

vi.mock("../../lib/login-return-to", () => ({
  resolveLoginReturnTo: () => "/cloud",
  consumePendingOAuthReturnTo: () => null,
  storePendingOAuthReturnTo: () => undefined,
}));

import StewardLoginSection from "./steward-login-section";

function expectFullyEnabledProviderSkeleton(scope: HTMLElement): void {
  const providerGrid = scope.querySelector<HTMLElement>(
    '[data-testid="login-provider-skeleton-grid"]',
  );
  expect(providerGrid).not.toBeNull();
  // The production profile exposes six compact actions in a 3×2 grid.
  expect(providerGrid?.children).toHaveLength(6);
}

function renderSection(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <StewardLoginSection />
    </MemoryRouter>,
  );
}

describe("StewardLoginSection — reserved loading geometry (#18256)", () => {
  beforeEach(() => {
    harness.hasCallback = false;
    harness.code = null;
    harness.providers = () => new Promise(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the full option-stack skeleton (not a bare spinner) while provider discovery is pending", async () => {
    renderSection("/login");
    await act(async () => undefined);

    const status = screen.getByRole("status", {
      name: "Loading sign-in options",
    });
    expect(status.getAttribute("aria-busy")).toBe("true");
    expectFullyEnabledProviderSkeleton(status);
    // Skeleton only — no live options may exist before discovery resolves.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("reserves the option-stack footprint under the completing-callback state", async () => {
    harness.hasCallback = true;
    harness.code = "callback-code";
    renderSection("/login?code=callback-code&state=state-1");

    await waitFor(() =>
      expect(screen.getByText("Completing sign-in…")).toBeTruthy(),
    );
    const ghost = screen.getByTestId("login-reserved-geometry-ghost");
    expect(ghost.getAttribute("aria-hidden")).toBe("true");
    expectFullyEnabledProviderSkeleton(ghost);
  });
});

/**
 * Render test for the personal Eliza fallback banner (#25146): the real banner,
 * route owner and `/api/v1/eliza/personal` parser under jsdom, with only the
 * API client transport and the platform URL opener mocked. Covers the typed
 * account state (reason, memory, retention deadline), the pay action's link
 * choice, the retryable 503 state and the recovery handback to Dedicated.
 *
 * @vitest-environment jsdom
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../../i18n";

const PERSONAL_ID = "personal:0f8fad5b-d9cb-5fa0-b5a9-8a2b1c3d4e5f";
const CLOUD = "https://api.elizacloud.ai";
const SHARED_BASE = `${CLOUD}/api/v1/eliza/agents/${PERSONAL_ID}`;
const DEDICATED_ID = "11111111-2222-4333-8444-555555555555";
const DEDICATED_BASE = `https://${DEDICATED_ID}.elizacloud.ai`;
const RECOVERY_LINK = `${CLOUD}/api/v1/eliza/personal/recovery/aGVhZGVy.cGF5bG9hZA.c2lnbmF0dXJl`;

const mocks = vi.hoisted(() => {
  let base = "";
  const baseListeners = new Set<(value: string) => void>();
  return {
    baseListeners,
    setBase(value: string) {
      base = value;
    },
    client: {
      getBaseUrl: vi.fn(() => base),
      getRestAuthToken: vi.fn(() => "steward-session"),
      getPersonalSharedEliza: vi.fn(),
      setToken: vi.fn(),
      repointBaseUrl: vi.fn((next: string) => {
        base = next;
        for (const listener of baseListeners) listener(next);
      }),
      onBaseUrlChange: vi.fn((listener: (value: string) => void) => {
        baseListeners.add(listener);
        return () => baseListeners.delete(listener);
      }),
    },
    openExternalUrl: vi.fn(async (_url: string) => true),
  };
});

vi.mock("../../api", () => ({ client: mocks.client }));
vi.mock("../../utils/openExternalUrl", () => ({
  openExternalUrl: mocks.openExternalUrl,
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
    getPlatform: () => "web",
    registerPlugin: () => ({}),
  },
  CapacitorHttp: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
}));

import { parsePersonalFallbackAccountState } from "../../api/personal-fallback";
import { __resetPersonalFallbackRouteForTests } from "../../state/personal-fallback-route";
import { PersonalAccountStateBanner } from "./PersonalAccountStateBanner";

const t = createTranslator("en");

function wireAccountState(overrides: Record<string, unknown> = {}) {
  return {
    access: "shared_fallback",
    state: "shared_active",
    reason: "subscription_payment_failed",
    dedicatedMemory: "unavailable",
    generation: 3,
    dedicatedRetainedUntil: "2026-10-27T00:00:00.000Z",
    recoveryAction: {
      kind: "restore_subscription",
      path: "/cloud/billing",
      link: { url: RECOVERY_LINK, expiresAt: "2099-01-01T00:00:00.000Z" },
    },
    ...overrides,
  };
}

function sharedIdentity(accountState: unknown) {
  const parsed = parsePersonalFallbackAccountState(accountState);
  if (!parsed) throw new Error("fixture account state must parse");
  return {
    personalElizaId: PERSONAL_ID,
    agentId: PERSONAL_ID,
    activeAgentId: PERSONAL_ID,
    agentName: "Eliza",
    apiBase: SHARED_BASE,
    runtime: "shared" as const,
    accountState: parsed,
  };
}

describe("PersonalAccountStateBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetPersonalFallbackRouteForTests();
    mocks.baseListeners.clear();
    window.localStorage.clear();
    mocks.setBase(SHARED_BASE);
  });

  afterEach(() => {
    cleanup();
    __resetPersonalFallbackRouteForTests();
  });

  it("renders the server's account state and opens the signed recovery link", async () => {
    mocks.client.getPersonalSharedEliza.mockResolvedValue(
      sharedIdentity(wireAccountState()),
    );
    render(<PersonalAccountStateBanner t={t} locale="en-US" />);

    const banner = await screen.findByTestId("personal-fallback-banner");
    expect(banner.textContent).toContain(
      "Your Dedicated Eliza is paused because a subscription payment failed.",
    );
    expect(banner.textContent).toContain(
      "Your Dedicated memory is unavailable until billing is restored.",
    );
    expect(banner.textContent).toContain(
      "Your Dedicated Eliza is kept until October 27, 2026.",
    );
    expect(mocks.client.getPersonalSharedEliza).toHaveBeenCalledWith({
      cloudApiBase: CLOUD,
      authToken: "steward-session",
    });

    const pay = screen.getByTestId("personal-fallback-pay");
    expect(pay.textContent).toBe("Restore subscription");
    fireEvent.click(pay);
    expect(mocks.openExternalUrl).toHaveBeenCalledWith(RECOVERY_LINK);
  });

  it("falls back to the billing page when the recovery link has expired", async () => {
    mocks.client.getPersonalSharedEliza.mockResolvedValue(
      sharedIdentity(
        wireAccountState({
          reason: "billing_suspended",
          dedicatedRetainedUntil: null,
          recoveryAction: {
            kind: "add_credits",
            path: "/cloud/billing",
            link: { url: RECOVERY_LINK, expiresAt: "2020-01-01T00:00:00.000Z" },
          },
        }),
      ),
    );
    render(<PersonalAccountStateBanner t={t} />);

    const banner = await screen.findByTestId("personal-fallback-banner");
    expect(banner.textContent).toContain("out of credits");
    expect(banner.textContent).not.toContain("kept until");
    const pay = screen.getByTestId("personal-fallback-pay");
    expect(pay.textContent).toBe("Add credits");
    fireEvent.click(pay);
    const opened = mocks.openExternalUrl.mock.calls[0]?.[0] ?? "";
    expect(opened).not.toBe(RECOVERY_LINK);
    expect(new URL(opened).pathname).toBe("/cloud/billing");
  });

  it("shows nothing for a Shared account the server did not put in fallback", async () => {
    mocks.client.getPersonalSharedEliza.mockResolvedValue({
      ...sharedIdentity(wireAccountState()),
      accountState: undefined,
    });
    const { container } = render(<PersonalAccountStateBanner t={t} />);
    await waitFor(() =>
      expect(mocks.client.getPersonalSharedEliza).toHaveBeenCalled(),
    );
    expect(container.textContent).toBe("");
  });

  it("shows a retryable state on 503 dedicated_reconciling and hands back to Dedicated on retry", async () => {
    mocks.client.getPersonalSharedEliza.mockRejectedValueOnce(
      Object.assign(new Error("HTTP 503"), {
        status: 503,
        data: {
          success: false,
          code: "dedicated_reconciling",
          retryable: true,
        },
      }),
    );
    render(<PersonalAccountStateBanner t={t} />);

    const retrying = await screen.findByTestId("personal-fallback-retrying");
    expect(retrying.textContent).toContain(
      "Your Dedicated Eliza is restoring your recent conversation.",
    );

    mocks.client.getPersonalSharedEliza.mockResolvedValueOnce({
      personalElizaId: PERSONAL_ID,
      agentId: PERSONAL_ID,
      activeAgentId: DEDICATED_ID,
      agentName: "Eliza",
      apiBase: DEDICATED_BASE,
      runtime: "dedicated",
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("personal-fallback-retry"));
    });

    await waitFor(() =>
      expect(mocks.client.repointBaseUrl).toHaveBeenCalledWith(DEDICATED_BASE),
    );
    expect(screen.queryByTestId("personal-fallback-retrying")).toBeNull();
    expect(screen.queryByTestId("personal-fallback-banner")).toBeNull();
  });

  it("rejects a malformed account state instead of rendering it", () => {
    expect(
      parsePersonalFallbackAccountState(
        wireAccountState({ reason: "card_declined_4242" }),
      ),
    ).toBeNull();
    expect(
      parsePersonalFallbackAccountState(
        wireAccountState({
          recoveryAction: {
            kind: "add_credits",
            path: "/cloud/billing",
            link: {
              url: `${RECOVERY_LINK}?card=4242`,
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
          },
        }),
      ),
    ).toBeNull();
  });
});

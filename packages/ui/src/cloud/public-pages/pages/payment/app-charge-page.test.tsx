/**
 * Verifies the public app-charge checkout page guards its top-window
 * navigation: the provider checkout URL is a wire value, so a non-http(s)
 * value must surface the visible error state instead of reaching
 * `location.assign`. The component is real; the API client, router, session
 * auth, and i18n are mocked under jsdom.
 */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const paramsRef = vi.hoisted(() => ({
  current: { appId: "app-test-1", chargeId: "charge-test-1" },
}));
const apiMock = vi.hoisted(() => vi.fn());
// A stable translator: an unstable `t` identity would re-arm the load effect
// every render and consume the checkout mock as a load response.
const tMock = vi.hoisted(
  () =>
    (
      key: string,
      options?: { defaultValue?: string } & Record<string, string | number>,
    ) => {
      let value = options?.defaultValue ?? key;
      for (const [name, replacement] of Object.entries(options ?? {})) {
        if (name !== "defaultValue") {
          value = value.replace(`{{${name}}}`, String(replacement));
        }
      }
      return value;
    },
);

vi.mock("react-router-dom", () => ({
  Link: ({ children, ...props }: { children: ReactNode }) => (
    <a {...props}>{children}</a>
  ),
  useLocation: () => ({
    pathname: "/pay/app-test-1/charge-test-1",
    search: "",
  }),
  useNavigate: () => vi.fn(),
  useParams: () => paramsRef.current,
}));

vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT: () => tMock,
}));

vi.mock("../../../lib/api-client", () => ({
  ApiError: class ApiError extends Error {},
  api: apiMock,
}));

vi.mock("../../../lib/use-session-auth", () => ({
  useSessionAuth: () => ({ ready: true, authenticated: true }),
}));

vi.mock("../../../../components/ui/button", () => ({
  Button: ({ children, ...props }: ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));

import AppChargePaymentPage from "./app-charge-page";

function appChargeDetails() {
  return {
    charge: {
      id: "charge-test-1",
      appId: "app-test-1",
      amountUsd: 25,
      description: "Test charge",
      providers: ["stripe", "oxapay"],
      paymentUrl: "https://eliza.example/pay/app-test-1/charge-test-1",
      status: "requested",
      paidAt: null,
      expiresAt: "2030-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    app: {
      id: "app-test-1",
      name: "Test App",
      description: null,
      logo_url: null,
      website_url: null,
    },
  };
}

describe("AppChargePaymentPage checkout navigation guard", () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("navigates to a provider-supplied https checkout URL", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", {
      assign,
      href: "https://eliza.example/pay",
      origin: "https://eliza.example",
    });

    apiMock.mockResolvedValueOnce(appChargeDetails()).mockResolvedValueOnce({
      checkout: {
        provider: "stripe",
        url: "https://checkout.stripe.com/c/pay_123",
        sessionId: "sess_123",
      },
    });

    render(<AppChargePaymentPage />);

    const button = await screen.findByRole("button", {
      name: /pay with card/i,
    });
    fireEvent.click(button);

    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        "https://checkout.stripe.com/c/pay_123",
      ),
    );
  });

  it("blocks navigation and shows an error when the checkout URL is not http(s)", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", {
      assign,
      href: "https://eliza.example/pay",
      origin: "https://eliza.example",
    });

    apiMock.mockResolvedValueOnce(appChargeDetails()).mockResolvedValueOnce({
      checkout: {
        provider: "stripe",
        url: "javascript:alert(document.cookie)",
        sessionId: "sess_123",
      },
    });

    render(<AppChargePaymentPage />);

    const button = await screen.findByRole("button", {
      name: /pay with card/i,
    });
    fireEvent.click(button);

    expect(
      await screen.findByText(
        "Payment provider returned an invalid checkout link.",
      ),
    ).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });
});

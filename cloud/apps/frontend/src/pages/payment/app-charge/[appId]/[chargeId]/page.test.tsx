import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  useSessionAuth: vi.fn(),
  locationAssign: vi.fn(),
}));

vi.mock("@/lib/hooks/use-session-auth", () => ({
  useSessionAuth: mocks.useSessionAuth,
}));

vi.mock("../../../../../lib/api-client", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
      public readonly body?: unknown,
    ) {
      super(message);
      this.name = "ApiError";
    }
  },
  api: mocks.api,
}));

vi.mock("./payment-navigation", () => ({
  navigateToExternalPayment: mocks.locationAssign,
}));

import AppChargePaymentPage from "./page";

function appChargeDetails(status: "requested" | "confirmed" = "requested") {
  return {
    charge: {
      id: "charge_five",
      appId: "app_five",
      amountUsd: 5,
      description: "Please send me $5",
      providers: ["stripe", "oxapay"],
      paymentUrl: "http://localhost/payment/app-charge/app_five/charge_five",
      status,
      paidAt: status === "confirmed" ? new Date("2026-05-09T23:15:00Z").toISOString() : null,
      paidProvider: status === "confirmed" ? "oxapay" : undefined,
      providerPaymentId: status === "confirmed" ? "oxapay_payment_five" : undefined,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      createdAt: new Date("2026-05-09T23:00:00Z").toISOString(),
    },
    app: {
      id: "app_five",
      name: "Five Dollar Agent",
      description: "Agent payment request",
      logo_url: null,
      website_url: "https://example.com",
    },
  };
}

function renderPaymentPage(initialPath = "/payment/app-charge/app_five/charge_five") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/payment/app-charge/:appId/:chargeId" element={<AppChargePaymentPage />} />
        <Route path="/login" element={<div>login required</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.api.mockReset();
  mocks.useSessionAuth.mockReset();
  mocks.locationAssign.mockReset();
  mocks.useSessionAuth.mockReturnValue({
    ready: true,
    authenticated: true,
    authSource: "steward",
    stewardAuthenticated: true,
    stewardUser: { id: "payer", email: "payer@example.com" },
    user: { id: "payer", email: "payer@example.com" },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AppChargePaymentPage", () => {
  test("renders the dynamic $5 charge and starts OxaPay checkout", async () => {
    mocks.api.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (init?.method === "POST") {
        return {
          checkout: {
            provider: "oxapay",
            paymentId: "oxapay_payment_five",
            trackId: "track_five",
            payLink: "https://pay.oxapay.com/track_five",
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          },
        };
      }
      expect(path).toBe("/api/v1/apps/app_five/charges/charge_five");
      return appChargeDetails();
    });

    renderPaymentPage();

    expect(await screen.findByText("$5.00")).toBeInTheDocument();
    expect(screen.getByText("Five Dollar Agent")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /pay with crypto/i }));

    await waitFor(() => {
      expect(mocks.api).toHaveBeenCalledWith(
        "/api/v1/apps/app_five/charges/charge_five/checkout",
        expect.objectContaining({
          method: "POST",
          json: expect.objectContaining({
            provider: "oxapay",
            return_url: expect.stringMatching(
              /\/payment\/success\?.*charge_request_id=charge_five.*app_id=app_five/,
            ),
          }),
        }),
      );
    });
    expect(mocks.locationAssign).toHaveBeenCalledWith("https://pay.oxapay.com/track_five");
  });

  test("redirects unauthenticated payers to login before checkout", async () => {
    mocks.useSessionAuth.mockReturnValue({
      ready: true,
      authenticated: false,
      authSource: "none",
      stewardAuthenticated: false,
      stewardUser: null,
      user: null,
    });
    mocks.api.mockResolvedValue(appChargeDetails());

    renderPaymentPage();

    expect(await screen.findByText("$5.00")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /pay with card/i }));

    expect(await screen.findByText("login required")).toBeInTheDocument();
    expect(mocks.api).toHaveBeenCalledTimes(1);
  });

  test("polls after provider return until the charge is confirmed", async () => {
    mocks.api
      .mockResolvedValueOnce(appChargeDetails("requested"))
      .mockResolvedValueOnce(appChargeDetails("confirmed"));

    renderPaymentPage("/payment/app-charge/app_five/charge_five?payment=success");

    expect(await screen.findByText("$5.00")).toBeInTheDocument();
    expect(screen.getByText("Waiting for confirmation.")).toBeInTheDocument();

    await waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(2), { timeout: 4_500 });
    expect(await screen.findByText(/paid/i)).toBeInTheDocument();
    expect(screen.queryByText("Waiting for confirmation.")).not.toBeInTheDocument();
  }, 8_000);
});

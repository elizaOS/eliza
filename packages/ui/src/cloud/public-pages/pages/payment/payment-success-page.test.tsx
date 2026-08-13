/**
 * Verifies payment callbacks terminate on canonical Cloud billing routes for
 * signed-in users and preserve that destination through login when signed out.
 */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import PaymentSuccessPage from "./payment-success-page";

const auth = vi.hoisted(() => ({ authenticated: true }));

vi.mock("../../../lib/use-session-auth", () => ({
  useSessionAuth: () => ({ ready: true, authenticated: auth.authenticated }),
}));

vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return (
    <div data-testid="location">{`${location.pathname}${location.search}`}</div>
  );
}

function renderCallback(): void {
  render(
    <MemoryRouter
      initialEntries={["/payment/success?trackId=track-1&status=paid"]}
    >
      <Routes>
        <Route path="/payment/success" element={<PaymentSuccessPage />} />
        <Route path="/cloud/billing" element={<LocationProbe />} />
        <Route path="/login" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  auth.authenticated = true;
});

describe("PaymentSuccessPage", () => {
  it("redirects an authenticated payment to canonical Cloud billing", async () => {
    renderCallback();
    expect((await screen.findByTestId("location")).textContent).toBe(
      "/cloud/billing?payment=success&trackId=track-1&status=paid",
    );
  });

  it("preserves canonical Cloud billing as the signed-out returnTo", async () => {
    auth.authenticated = false;
    renderCallback();
    expect((await screen.findByTestId("location")).textContent).toBe(
      "/login?returnTo=%2Fcloud%2Fbilling%3Fpayment%3Dsuccess%26trackId%3Dtrack-1%26status%3Dpaid",
    );
  });
});

/** Exercises native product loading, denial and purchaser consent with the real billing panel and SDK HTTP fixture. */
// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { billingFixture } from "./billing-fixture";

const boundary = vi.hoisted(() => ({
  product: vi.fn(),
  billing: vi.fn(),
  session: { ready: true, authenticated: true, user: { id: "buyer" } },
}));
vi.mock("../../lib/cloud-sdk", () => ({
  sessionCloudSdk: {
    getApplicationBillingProduct: boundary.product,
    appBilling: boundary.billing,
  },
}));
vi.mock("../../lib/use-session-auth", () => ({
  useSessionAuth: () => boundary.session,
}));

import NativeProductBillingPage from "./NativeProductBillingPage";

beforeEach(() => {
  vi.clearAllMocks();
  boundary.session.authenticated = true;
  boundary.session.ready = true;
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
});
function mount() {
  return render(
    <MemoryRouter initialEntries={["/cloud/billing/products/selected-app"]}>
      <Routes>
        <Route
          path="/cloud/billing/products/:slotKey"
          element={<NativeProductBillingPage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}
it("loads a configured product without purchasing and requires consent before starting its trial", async () => {
  const fixture = billingFixture();
  boundary.product.mockResolvedValue({
    success: true,
    data: {
      slotKey: "selected-app",
      appId: fixture.catalog.appId,
      appName: fixture.catalog.appName,
      productFamilyKey: "workspace",
      environment: "test",
    },
  });
  boundary.billing.mockReturnValue(fixture.client);
  mount();
  const start = await screen.findByRole("button", {
    name: "Start seven-day trial",
  });
  expect(
    fixture.calls.some(
      (call) => call.path.endsWith("/trial") || call.path.endsWith("/checkout"),
    ),
  ).toBe(false);
  expect(boundary.product).toHaveBeenCalledWith("selected-app");
  expect(boundary.billing).toHaveBeenCalledWith(fixture.catalog.appId);
  fireEvent.click(start);
  await waitFor(() =>
    expect(
      fixture.calls.filter((call) => call.path.endsWith("/trial")),
    ).toHaveLength(1),
  );
});
it("unavailable configuration cannot mount billing and can be retried without selecting another product", async () => {
  boundary.product.mockRejectedValue(
    new Error("Configured product is unavailable"),
  );
  mount();
  await screen.findByRole("alert");
  expect(boundary.billing).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "Start seven-day trial" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(boundary.product).toHaveBeenCalledTimes(2));
  expect(
    boundary.product.mock.calls.every(([slot]) => slot === "selected-app"),
  ).toBe(true);
});
it("a signed-out identity cannot resolve or provision product billing", () => {
  boundary.session.authenticated = false;
  mount();
  expect(screen.getByRole("link", { name: "Sign in" })).toBeDefined();
  expect(boundary.product).not.toHaveBeenCalled();
  expect(boundary.billing).not.toHaveBeenCalled();
});

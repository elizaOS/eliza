/** Exercises runtime-selected subscription navigation and explicit unavailable recovery without developer balance authority. */
// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock("../../../api", () => ({
  client: { getCloudStatus: boundary.status },
}));

import { NativeProductBillingEntry } from "./NativeProductBillingEntry";

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);
const mount = () =>
  render(
    <MemoryRouter>
      <NativeProductBillingEntry />
    </MemoryRouter>,
  );
it("uses the runtime slot even without Cloud infrastructure connectivity", async () => {
  boundary.status.mockResolvedValue({
    connected: false,
    applicationBilling: { kind: "configured", slotKey: "selected-product" },
  });
  mount();
  const link = await screen.findByRole("link", {
    name: "Manage app subscription",
  });
  expect(link.getAttribute("href")).toBe(
    "/cloud/billing/products/selected-product",
  );
});
it("a failed read cannot select another billing source and retry resolves current authority", async () => {
  boundary.status
    .mockRejectedValueOnce(new Error("Runtime unavailable"))
    .mockResolvedValueOnce({
      connected: true,
      applicationBilling: { kind: "configured", slotKey: "current-product" },
    });
  mount();
  await screen.findByRole("alert");
  expect(screen.queryByRole("link")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Retry product selection" }),
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole("link", { name: "Manage app subscription" })
        .getAttribute("href"),
    ).toBe("/cloud/billing/products/current-product"),
  );
});
it("an older host's missing field remains unavailable rather than unconfigured", async () => {
  boundary.status.mockResolvedValue({ connected: true });
  mount();
  await screen.findByRole("alert");
  expect(screen.queryByRole("link")).toBeNull();
});

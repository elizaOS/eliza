/** Exercises catalog fetch failure, retry, and stale-price withdrawal through the real React Query consumer with a deterministic HTTP boundary. */
// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SubscriptionPlans } from "./subscription-plans";

const request = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api-client", () => ({
  api: (...args: unknown[]) => request(...args),
}));
const response = {
  success: true,
  data: {
    catalogVersion: "v1",
    plans: [
      {
        key: "plus_monthly",
        name: "Plus",
        amountCents: 3000,
        currency: "usd",
        allowance: { amountUsd: "25.000000" },
      },
    ],
  },
};
function mount(organizationId?: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <SubscriptionPlans organizationId={organizationId} />
    </QueryClientProvider>,
  );
  return client;
}
afterEach(() => {
  cleanup();
  request.mockReset();
  localStorage.clear();
});
test("an unavailable provider is retryable without presenting a successful purchase", async () => {
  request
    .mockRejectedValueOnce(new Error("catalog unavailable"))
    .mockResolvedValueOnce(response);
  mount();
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText("Plus")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Plus")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(request).toHaveBeenCalledTimes(2);
});
test("a failed provider revalidation withdraws cached offers", async () => {
  request
    .mockResolvedValueOnce(response)
    .mockRejectedValue(new Error("price binding changed"));
  const client = mount();
  await screen.findByText("Plus");
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["subscription-plans"] });
  });
  await waitFor(() => expect(screen.queryByText("Plus")).toBeNull());
  expect(screen.getByRole("alert")).toBeTruthy();
});

test("retry keeps the same account-bound purchase intent after an uncertain response", async () => {
  request.mockImplementation((path: string) =>
    path.endsWith("/plans")
      ? Promise.resolve(response)
      : Promise.reject(new Error("Payment service unavailable")),
  );
  mount("org-checkout");
  const button = await screen.findByRole("button", {
    name: "Subscribe to Plus",
  });
  fireEvent.click(button);
  await screen.findByText("Payment service unavailable");
  fireEvent.click(button);
  await waitFor(() =>
    expect(
      request.mock.calls.filter((call) => call[0].endsWith("/checkout")),
    ).toHaveLength(2),
  );
  const calls = request.mock.calls.filter((call) =>
    call[0].endsWith("/checkout"),
  );
  expect(JSON.parse(calls[0]![1].body).idempotencyKey).toBe(
    JSON.parse(calls[1]![1].body).idempotencyKey,
  );
  expect(screen.queryByText("Your subscription is active.")).toBeNull();
});
test("an expired checkout requires a fresh click and intent before another purchase", async () => {
  request.mockImplementation((path: string) =>
    path.endsWith("/plans")
      ? Promise.resolve(response)
      : Promise.resolve({
          success: true,
          data: { status: "expired", commandId: "command", checkoutUrl: null },
        }),
  );
  mount("org-expired");
  const button = await screen.findByRole("button", {
    name: "Subscribe to Plus",
  });
  fireEvent.click(button);
  await screen.findByText(/previous checkout expired/);
  expect(
    request.mock.calls.filter((call) => call[0].endsWith("/checkout")),
  ).toHaveLength(1);
  fireEvent.click(button);
  await waitFor(() =>
    expect(
      request.mock.calls.filter((call) => call[0].endsWith("/checkout")),
    ).toHaveLength(2),
  );
  const calls = request.mock.calls.filter((call) =>
    call[0].endsWith("/checkout"),
  );
  expect(JSON.parse(calls[0]![1].body).idempotencyKey).not.toBe(
    JSON.parse(calls[1]![1].body).idempotencyKey,
  );
});
test("checkout never navigates to a provider lookalike", async () => {
  request.mockImplementation((path: string) =>
    path.endsWith("/plans")
      ? Promise.resolve(response)
      : Promise.resolve({
          success: true,
          data: {
            status: "open",
            commandId: "command",
            checkoutUrl: "https://checkout.stripe.com.attacker.example/pay",
          },
        }),
  );
  mount("org-redirect");
  fireEvent.click(
    await screen.findByRole("button", { name: "Subscribe to Plus" }),
  );
  expect(
    await screen.findByText("Checkout returned an invalid destination."),
  ).toBeTruthy();
});

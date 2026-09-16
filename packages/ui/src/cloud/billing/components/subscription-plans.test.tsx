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
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <SubscriptionPlans />
    </QueryClientProvider>,
  );
  return client;
}
afterEach(() => {
  cleanup();
  request.mockReset();
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

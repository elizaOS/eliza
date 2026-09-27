/** Exercises catalog fetch failure, retry, purchase-intent lifecycle and stale-price withdrawal through the real React Query consumer with a deterministic SDK boundary. */
// @vitest-environment jsdom
import { CloudApiError } from "@elizaos/cloud-sdk";
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
import {
  type SubscribeBlockedReason,
  SubscriptionPlans,
} from "./subscription-plans";

const sdk = vi.hoisted(() => ({
  getSubscriptionPlans: vi.fn(),
  startSubscriptionCheckout: vi.fn(),
  confirmSubscriptionCheckout: vi.fn(),
}));
vi.mock("../../lib/cloud-sdk", () => ({ sessionCloudSdk: sdk }));

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
function mount(
  organizationId?: string,
  options: { userId?: string; blocked?: SubscribeBlockedReason } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <SubscriptionPlans
        organizationId={organizationId}
        userId={options.userId ?? "user-1"}
        subscribeBlockedReason={options.blocked ?? null}
      />
    </QueryClientProvider>,
  );
  return client;
}
function checkoutKeys(): string[] {
  return sdk.startSubscriptionCheckout.mock.calls.map(
    (call) => call[0].idempotencyKey,
  );
}
function checkoutResult(status: string, checkoutUrl: string | null = null) {
  return { success: true, data: { status, commandId: "command", checkoutUrl } };
}
afterEach(() => {
  cleanup();
  for (const fn of Object.values(sdk)) fn.mockReset();
  localStorage.clear();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

test("an unavailable provider is retryable without presenting a successful purchase", async () => {
  sdk.getSubscriptionPlans
    .mockRejectedValueOnce(new Error("catalog unavailable"))
    .mockResolvedValueOnce(response);
  mount();
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText("Plus")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Plus")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(sdk.getSubscriptionPlans).toHaveBeenCalledTimes(2);
});
test("a failed provider revalidation withdraws cached offers", async () => {
  sdk.getSubscriptionPlans
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
  sdk.getSubscriptionPlans.mockResolvedValue(response);
  sdk.startSubscriptionCheckout.mockRejectedValue(
    new CloudApiError(503, {
      success: false,
      error: "Payment service unavailable",
      code: "service_unavailable",
    }),
  );
  mount("org-checkout");
  const button = await screen.findByRole("button", {
    name: "Subscribe to Plus",
  });
  fireEvent.click(button);
  await screen.findByText("Payment service unavailable");
  fireEvent.click(button);
  await waitFor(() => expect(checkoutKeys()).toHaveLength(2));
  expect(checkoutKeys()[0]).toBe(checkoutKeys()[1]);
  expect(
    Object.keys(localStorage).some((key) =>
      key.includes("user-1:org-checkout:plus_monthly"),
    ),
  ).toBe(true);
});
test("a billing conflict ends the purchase intent", async () => {
  sdk.getSubscriptionPlans.mockResolvedValue(response);
  sdk.startSubscriptionCheckout.mockRejectedValue(
    new CloudApiError(409, {
      success: false,
      error: "An existing subscription or checkout requires attention.",
      code: "billing_state_conflict",
    }),
  );
  mount("org-conflict");
  const button = await screen.findByRole("button", {
    name: "Subscribe to Plus",
  });
  fireEvent.click(button);
  await screen.findByText(/requires attention/);
  fireEvent.click(button);
  await waitFor(() => expect(checkoutKeys()).toHaveLength(2));
  expect(checkoutKeys()[0]).not.toBe(checkoutKeys()[1]);
});
test("an expired checkout requires a fresh click and intent before another purchase", async () => {
  sdk.getSubscriptionPlans.mockResolvedValue(response);
  sdk.startSubscriptionCheckout.mockResolvedValue(checkoutResult("expired"));
  mount("org-expired");
  const button = await screen.findByRole("button", {
    name: "Subscribe to Plus",
  });
  fireEvent.click(button);
  await screen.findByText(/previous checkout expired/);
  expect(checkoutKeys()).toHaveLength(1);
  fireEvent.click(button);
  await waitFor(() => expect(checkoutKeys()).toHaveLength(2));
  expect(checkoutKeys()[0]).not.toBe(checkoutKeys()[1]);
});
test("a completed purchase clears its intent so a later purchase is never a stale replay", async () => {
  sdk.getSubscriptionPlans.mockResolvedValue(response);
  sdk.startSubscriptionCheckout.mockResolvedValue(checkoutResult("completed"));
  mount("org-completed");
  const button = await screen.findByRole("button", {
    name: "Subscribe to Plus",
  });
  fireEvent.click(button);
  await screen.findByText(/Subscription payment confirmed/);
  fireEvent.click(button);
  await waitFor(() => expect(checkoutKeys()).toHaveLength(2));
  expect(checkoutKeys()[0]).not.toBe(checkoutKeys()[1]);
});
test("a spent intent is replaced once instead of reporting a false confirmation", async () => {
  sdk.getSubscriptionPlans.mockResolvedValue(response);
  sdk.startSubscriptionCheckout
    .mockResolvedValueOnce(checkoutResult("stale_intent"))
    .mockResolvedValueOnce(
      checkoutResult(
        "open",
        "https://checkout.stripe.com.attacker.example/pay",
      ),
    );
  mount("org-stale");
  fireEvent.click(
    await screen.findByRole("button", { name: "Subscribe to Plus" }),
  );
  await screen.findByText("Checkout returned an invalid destination.");
  expect(checkoutKeys()).toHaveLength(2);
  expect(checkoutKeys()[0]).not.toBe(checkoutKeys()[1]);
  expect(screen.queryByText(/Subscription payment confirmed/)).toBeNull();
});
test("checkout never navigates to a provider lookalike", async () => {
  sdk.getSubscriptionPlans.mockResolvedValue(response);
  sdk.startSubscriptionCheckout.mockResolvedValue(
    checkoutResult("open", "https://checkout.stripe.com.attacker.example/pay"),
  );
  mount("org-redirect");
  fireEvent.click(
    await screen.findByRole("button", { name: "Subscribe to Plus" }),
  );
  expect(
    await screen.findByText("Checkout returned an invalid destination."),
  ).toBeTruthy();
});
test("unavailable storage keeps retries idempotent within the tab", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  sdk.getSubscriptionPlans.mockResolvedValue(response);
  sdk.startSubscriptionCheckout.mockRejectedValue(new Error("uncertain"));
  mount("org-no-storage");
  const button = await screen.findByRole("button", {
    name: "Subscribe to Plus",
  });
  fireEvent.click(button);
  await screen.findByText("uncertain");
  fireEvent.click(button);
  await waitFor(() => expect(checkoutKeys()).toHaveLength(2));
  expect(checkoutKeys()[0]).toBe(checkoutKeys()[1]);
});
test("a confirmed return clears intents and drops the provider session marker", async () => {
  window.history.replaceState(
    null,
    "",
    "/cloud/billing?subscription_session_id=cs_test_abc&tab=1",
  );
  localStorage.setItem(
    "eliza-subscription-checkout:user-1:org-return:plus_monthly",
    "old-intent",
  );
  sdk.getSubscriptionPlans.mockResolvedValue(response);
  sdk.confirmSubscriptionCheckout.mockResolvedValue({
    success: true,
    data: { subscriptionId: "sub", replayed: false },
  });
  mount("org-return");
  await screen.findByText(/Subscription payment confirmed/);
  expect(sdk.confirmSubscriptionCheckout).toHaveBeenCalledWith("cs_test_abc");
  await waitFor(() => expect(window.location.search).toBe("?tab=1"));
  expect(
    localStorage.getItem(
      "eliza-subscription-checkout:user-1:org-return:plus_monthly",
    ),
  ).toBeNull();
});
test.each([
  ["live_subscription", /already has a subscription/],
  ["not_billing_manager", /Only organization owners and admins/],
] as const)("%s withholds the Subscribe action", async (reason, text) => {
  sdk.getSubscriptionPlans.mockResolvedValue(response);
  mount("org-blocked", { blocked: reason });
  await screen.findByText("Plus");
  expect(screen.getByText(text)).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Subscribe to Plus" }),
  ).toBeNull();
});

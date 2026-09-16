/** Cache invalidation contracts for billing mutations. */

// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());
const sessionAuth = vi.hoisted(() => ({
  value: {
    ready: true,
    authenticated: true,
    user: { id: "user-one", email: "user@example.test" } as {
      id: string;
      email: string;
    } | null,
  },
}));

vi.mock("../../lib/api-client", () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {},
}));
vi.mock("../../lib/use-session-auth", () => ({
  useSessionAuth: () => sessionAuth.value,
}));

import { useBillingUser, useInvoice, useVerifyCheckout } from "./billing-data";
import { BILLING_SNAPSHOT_V2_QUERY_KEY } from "./billing-snapshot";

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sessionAuth.value = {
    ready: true,
    authenticated: true,
    user: { id: "user-one", email: "user@example.test" },
  };
});

describe("useBillingUser", () => {
  it("maps the validated API user id instead of the session cache id", async () => {
    apiMock.mockResolvedValue({
      success: true,
      data: {
        id: "  api-user-id  ",
        organization_id: "org-one",
        wallet_address: "0xabc",
        organization: { credit_balance: "12.5" },
      },
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useBillingUser(), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.isReady).toBe(true);
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user).toEqual({
      id: "api-user-id",
      organization_id: "org-one",
      wallet_address: "0xabc",
    });
    expect(apiMock).toHaveBeenCalledWith("/api/v1/user", {
      signal: expect.any(AbortSignal),
    });
  });

  it.each(["", "   ", null, undefined, 42])(
    "rejects an invalid or blank API user id (%j)",
    async (id) => {
      apiMock.mockResolvedValue({
        success: true,
        data: {
          id,
          organization_id: "org-one",
          wallet_address: null,
          organization: { credit_balance: "12.5" },
        },
      });
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const { result } = renderHook(() => useBillingUser(), {
        wrapper: wrapper(client),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.user).toBeNull();
    },
  );

  it.each([
    {
      label: "unresolved authentication",
      session: { ready: false, authenticated: false, user: null },
      expectedReady: false,
    },
    {
      label: "a settled signed-out session",
      session: { ready: true, authenticated: false, user: null },
      expectedReady: true,
    },
  ])("does not fetch for $label", ({ session, expectedReady }) => {
    sessionAuth.value = session;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useBillingUser(), {
      wrapper: wrapper(client),
    });

    expect(result.current.isReady).toBe(expectedReady);
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.user).toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
  });
});

describe("useInvoice", () => {
  it("does not expose a cached invoice after the same user changes organizations", async () => {
    apiMock.mockResolvedValueOnce({
      invoice: {
        id: "invoice-one",
        stripeInvoiceId: "stripe-invoice-one",
        stripeCustomerId: "customer-one",
        stripePaymentIntentId: null,
        amountDue: 10,
        amountPaid: 10,
        currency: "usd",
        status: "paid",
        invoiceType: "credit_purchase",
        invoiceNumber: "INV-1",
        invoicePdf: null,
        hostedInvoiceUrl: null,
        metadata: {},
        createdAt: "2026-09-05T00:00:00.000Z",
        updatedAt: "2026-09-05T00:00:00.000Z",
      },
    });
    const pendingNewOrganization = new Promise<never>(() => {});
    apiMock.mockReturnValueOnce(pendingNewOrganization);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result, rerender } = renderHook(
      ({ organizationId }) => useInvoice("invoice-one", organizationId),
      {
        initialProps: { organizationId: "org-one" },
        wrapper: wrapper(client),
      },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.organization_id).toBe("org-one");

    rerender({ organizationId: "org-two" });

    expect(result.current.data).toBeUndefined();
    expect(result.current.isPending).toBe(true);
    expect(apiMock).toHaveBeenLastCalledWith("/api/invoices/invoice-one");
  });
});

describe("useVerifyCheckout", () => {
  it("invalidates both the legacy cache and canonical snapshot after success", async () => {
    apiMock.mockResolvedValue({ success: true });
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const invalidate = vi
      .spyOn(client, "invalidateQueries")
      .mockResolvedValue(undefined);
    const { result } = renderHook(() => useVerifyCheckout(), {
      wrapper: wrapper(client),
    });

    await act(async () => {
      await result.current.mutateAsync({ sessionId: "checkout-session" });
    });

    expect(apiMock).toHaveBeenCalledWith("/api/billing/checkout/verify", {
      method: "POST",
      json: { session_id: "checkout-session", from: undefined },
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["credits", "balance"],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: BILLING_SNAPSHOT_V2_QUERY_KEY,
    });
  });
});

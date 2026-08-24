/** Cache invalidation contracts for billing mutations. */

// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/api-client", () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {},
}));
vi.mock("../../lib/use-session-auth", () => ({
  useSessionAuth: () => ({
    ready: true,
    authenticated: true,
    user: { id: "user-one", email: "user@example.test" },
  }),
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

  it("forwards the checkout origin alongside the session id when provided", async () => {
    apiMock.mockResolvedValue({ success: true });
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const { result } = renderHook(() => useVerifyCheckout(), {
      wrapper: wrapper(client),
    });

    await act(async () => {
      await result.current.mutateAsync({
        sessionId: "sess-crypto",
        from: "crypto",
      });
    });

    expect(apiMock).toHaveBeenCalledWith("/api/billing/checkout/verify", {
      method: "POST",
      json: { session_id: "sess-crypto", from: "crypto" },
    });
  });
});

describe("useBillingUser", () => {
  it("returns a null user when the API membership carries no organization summary", async () => {
    apiMock.mockResolvedValue({
      success: true,
      data: {
        id: "api-user-id",
        organization_id: "",
        wallet_address: "0xabc",
        organization: null,
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
  });

  it("refetches a tenant-sensitive read on remount even when the cache is fresh", async () => {
    apiMock.mockResolvedValue({
      success: true,
      data: {
        id: "api-user-id",
        organization_id: "org-one",
        wallet_address: null,
        organization: { credit_balance: "12.5" },
      },
    });
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      },
    });
    const first = renderHook(
      () => useBillingUser({ requireFreshOrganization: true }),
      { wrapper: wrapper(client) },
    );

    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    expect(apiMock).toHaveBeenCalledTimes(1);
    first.unmount();

    const second = renderHook(
      () => useBillingUser({ requireFreshOrganization: true }),
      { wrapper: wrapper(client) },
    );

    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    second.unmount();
  });

  it("serves an otherwise-fresh cached membership on a plain remount", async () => {
    apiMock.mockResolvedValue({
      success: true,
      data: {
        id: "api-user-id",
        organization_id: "org-one",
        wallet_address: null,
        organization: { credit_balance: "12.5" },
      },
    });
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      },
    });
    const first = renderHook(() => useBillingUser(), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    first.unmount();

    const second = renderHook(() => useBillingUser(), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
    expect(second.result.current.user).toEqual({
      id: "api-user-id",
      organization_id: "org-one",
      wallet_address: null,
    });
    expect(apiMock).toHaveBeenCalledTimes(1);
    second.unmount();
  });
});

describe("useInvoice", () => {
  const invoicePayload = {
    id: "inv-1",
    stripeInvoiceId: "in_1756",
    stripeCustomerId: "cus_9",
    stripePaymentIntentId: "pi_3",
    amountDue: 2500,
    amountPaid: 2500,
    currency: "usd",
    status: "paid",
    invoiceType: "subscription",
    invoiceNumber: "ELZ-0007",
    invoicePdf: "https://files.example.test/inv-1.pdf",
    hostedInvoiceUrl: "https://invoice.example.test/inv-1",
    creditsAdded: 500,
    metadata: { intent: "card-topup" },
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:05:00.000Z",
    dueDate: "2026-08-15T00:00:00.000Z",
    paidAt: "2026-08-01T10:04:00.000Z",
  };

  it("adapts the camelCase payload into the org-scoped snake_case DTO", async () => {
    apiMock.mockResolvedValue({ invoice: invoicePayload });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useInvoice("inv-1", "org-one"), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual({
      id: "inv-1",
      organization_id: "org-one",
      stripe_invoice_id: "in_1756",
      stripe_customer_id: "cus_9",
      stripe_payment_intent_id: "pi_3",
      amount_due: 2500,
      amount_paid: 2500,
      currency: "usd",
      status: "paid",
      invoice_type: "subscription",
      invoice_number: "ELZ-0007",
      invoice_pdf: "https://files.example.test/inv-1.pdf",
      hosted_invoice_url: "https://invoice.example.test/inv-1",
      credits_added: 500,
      metadata: { intent: "card-topup" },
      created_at: "2026-08-01T10:00:00.000Z",
      updated_at: "2026-08-01T10:05:00.000Z",
      due_date: "2026-08-15T00:00:00.000Z",
      paid_at: "2026-08-01T10:04:00.000Z",
    });
    expect(apiMock).toHaveBeenCalledWith("/api/invoices/inv-1");
  });

  it("defaults absent optional fields instead of leaking undefined into the DTO", async () => {
    apiMock.mockResolvedValue({
      invoice: {
        ...invoicePayload,
        creditsAdded: undefined,
        metadata: null,
        dueDate: undefined,
        paidAt: undefined,
      },
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useInvoice("inv-1", "org-one"), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual({
      id: "inv-1",
      organization_id: "org-one",
      stripe_invoice_id: "in_1756",
      stripe_customer_id: "cus_9",
      stripe_payment_intent_id: "pi_3",
      amount_due: 2500,
      amount_paid: 2500,
      currency: "usd",
      status: "paid",
      invoice_type: "subscription",
      invoice_number: "ELZ-0007",
      invoice_pdf: "https://files.example.test/inv-1.pdf",
      hosted_invoice_url: "https://invoice.example.test/inv-1",
      credits_added: null,
      metadata: {},
      created_at: "2026-08-01T10:00:00.000Z",
      updated_at: "2026-08-01T10:05:00.000Z",
      due_date: null,
      paid_at: null,
    });
  });

  it.each([
    ["inv-1", undefined],
    [undefined, "org-one"],
    [undefined, undefined],
  ] as const)(
    "stays idle until both the invoice id and organization exist (id=%j, org=%j)",
    (id, organizationId) => {
      apiMock.mockResolvedValue({ invoice: invoicePayload });
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const { result } = renderHook(() => useInvoice(id, organizationId), {
        wrapper: wrapper(client),
      });

      expect(result.current.fetchStatus).toBe("idle");
      expect(result.current.data).toBeUndefined();
      expect(apiMock).not.toHaveBeenCalled();
    },
  );
});

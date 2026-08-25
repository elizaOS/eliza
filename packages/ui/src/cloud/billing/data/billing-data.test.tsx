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

import { useBillingUser, useVerifyCheckout } from "./billing-data";
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
});

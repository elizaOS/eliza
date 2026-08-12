/** Verifies public payment checkout authority, expiry, and route isolation. */
// @vitest-environment jsdom

import {
  publicPaymentRequestActiveExpiry,
  publicPaymentRequestResponseFixture,
} from "@elizaos/cloud-shared/testing/payment-request-public-response-fixture";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const paramsRef = vi.hoisted(() => ({
  current: {
    paymentRequestId: "00000000-0000-4000-8000-000000018814",
  },
}));
const apiMock = vi.hoisted(() => vi.fn());
const translate = vi.hoisted(
  () =>
    (
      key: string,
      options?: { defaultValue?: string } & Record<string, string | number>,
    ) => {
      let value = options?.defaultValue ?? key;
      for (const [name, replacement] of Object.entries(options ?? {})) {
        if (name !== "defaultValue") {
          value = value.replace(`{{${name}}}`, String(replacement));
        }
      }
      return value;
    },
);

vi.mock("react-router-dom", () => ({
  Link: ({ children, ...props }: { children: ReactNode }) => (
    <a {...props}>{children}</a>
  ),
  useParams: () => paramsRef.current,
}));

vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT: () => translate,
}));

vi.mock("../../lib/use-page-title", () => ({ usePageTitle: () => {} }));

vi.mock("../../../lib/api-client", () => ({
  ApiError: class ApiError extends Error {},
  api: apiMock,
}));

vi.mock("../../../../components/ui/button", () => ({
  Button: ({ children, ...props }: ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));

import { PaymentRequestPageView as PaymentRequestPage } from "./payment-request-page";

type Provider = "stripe" | "oxapay" | "x402" | "wallet_native";
type Status =
  | "pending"
  | "delivered"
  | "settled"
  | "expired"
  | "canceled"
  | "failed";

function publicPaymentRequest(
  overrides: Partial<{
    id: string;
    provider: Provider;
    status: Status;
    hostedUrl: string | null;
    expiresAt: string | null;
    amountCents: number;
    reason: string | null;
  }> = {},
) {
  return {
    id: "00000000-0000-4000-8000-000000018814",
    provider: "wallet_native" as const,
    amountCents: 500,
    currency: "usd",
    status: "delivered" as const,
    reason: "Test payment request",
    expiresAt: publicPaymentRequestActiveExpiry,
    hostedUrl: "https://checkout.example.test/initial",
    ...overrides,
  };
}

function response(overrides: Parameters<typeof publicPaymentRequest>[0] = {}) {
  return {
    success: true,
    paymentRequest: publicPaymentRequest(overrides),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("PaymentRequestPage checkout authority", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  beforeEach(() => {
    apiMock.mockReset();
    paramsRef.current = {
      paymentRequestId: "00000000-0000-4000-8000-000000018814",
    };
  });

  it("renders the exact public-route projection without private payment fields", async () => {
    const navigate = vi.fn();
    apiMock.mockResolvedValue(publicPaymentRequestResponseFixture);

    render(<PaymentRequestPage navigateToCheckout={navigate} />);

    expect(await screen.findByText("Premium plan")).toBeTruthy();
    expect(screen.getByText("$25.00")).toBeTruthy();
    expect(screen.getByText(/^Pending - expires /)).toBeTruthy();
    const checkout = screen.getByRole("button", { name: "Pay with Stripe" });
    expect(checkout).toHaveProperty("disabled", false);
    expect(document.body.textContent).not.toContain("private-");
    expect(
      Object.keys(publicPaymentRequestResponseFixture.paymentRequest),
    ).toHaveLength(8);

    fireEvent.click(checkout);
    await act(async () => {});
    expect(navigate).toHaveBeenCalledWith(
      publicPaymentRequestResponseFixture.paymentRequest.hostedUrl,
    );
  });

  it("maps every provider to a user-facing label", async () => {
    const controls: Array<[Provider, string]> = [
      ["stripe", "Stripe"],
      ["oxapay", "OxaPay"],
      ["x402", "x402"],
      ["wallet_native", "Wallet"],
    ];

    for (const [provider, label] of controls) {
      apiMock.mockResolvedValueOnce(response({ provider }));
      const view = render(<PaymentRequestPage />);
      expect(
        await screen.findByRole("button", { name: `Pay with ${label}` }),
      ).toHaveProperty("disabled", false);
      expect(screen.getByText(label)).toBeTruthy();
      if (provider === "wallet_native") {
        expect(screen.queryByText("wallet_native")).toBeNull();
      }
      view.unmount();
    }
  });

  it("keeps terminal requests disabled", async () => {
    apiMock.mockResolvedValue(
      response({ status: "canceled", hostedUrl: null }),
    );

    render(<PaymentRequestPage />);

    expect(await screen.findByText("Cancelled")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Pay with Wallet" }),
    ).toHaveProperty("disabled", true);
  });

  it("ignores a stale route load that completes after the current route", async () => {
    const requestA = deferred<ReturnType<typeof response>>();
    const requestB = deferred<ReturnType<typeof response>>();
    apiMock
      .mockImplementationOnce(() => requestA.promise)
      .mockImplementationOnce(() => requestB.promise);

    paramsRef.current = { paymentRequestId: "request-a" };
    const view = render(<PaymentRequestPage />);
    await act(async () => {});
    const firstSignal = apiMock.mock.calls[0]?.[1]?.signal as AbortSignal;

    paramsRef.current = { paymentRequestId: "request-b" };
    view.rerender(<PaymentRequestPage />);
    await act(async () => {});
    expect(firstSignal.aborted).toBe(true);

    requestB.resolve(
      response({
        id: "request-b",
        amountCents: 700,
        reason: "Current request B",
      }),
    );
    expect(await screen.findByText("Current request B")).toBeTruthy();

    requestA.reject(new Error("stale request A failed"));
    await act(async () => {});
    expect(screen.getByText("Current request B")).toBeTruthy();
    expect(screen.queryByText("stale request A failed")).toBeNull();
  });

  it("aborts the in-flight load on unmount", async () => {
    const pending = deferred<ReturnType<typeof response>>();
    apiMock.mockImplementation(() => pending.promise);

    const view = render(<PaymentRequestPage />);
    await act(async () => {});
    const signal = apiMock.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    view.unmount();
    expect(signal.aborted).toBe(true);
  });

  it("disables checkout exactly at the deadline while the page stays open", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T00:00:00.000Z"));
    apiMock.mockResolvedValue(
      response({ expiresAt: "2026-08-13T00:00:01.000Z" }),
    );

    render(<PaymentRequestPage />);
    await act(async () => {});
    expect(
      screen.getByRole("button", { name: "Pay with Wallet" }),
    ).toHaveProperty("disabled", false);

    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(
      screen.getByRole("button", { name: "Pay with Wallet" }),
    ).toHaveProperty("disabled", false);

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByText("Expired")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Pay with Wallet" }),
    ).toHaveProperty("disabled", true);
  });

  it.each([null, "not-a-date", "2026-08-13T00:00:00.000Z"])(
    "fails closed for a missing, malformed, or exact-deadline expiry (%s)",
    async (expiresAt) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-13T00:00:00.000Z"));
      apiMock.mockResolvedValue(response({ expiresAt }));

      render(<PaymentRequestPage />);
      await act(async () => {});

      expect(screen.getByText("Expired")).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Pay with Wallet" }),
      ).toHaveProperty("disabled", true);
    },
  );

  it("revalidates and navigates only to the newly authoritative checkout URL", async () => {
    const navigate = vi.fn();
    apiMock
      .mockResolvedValueOnce(
        response({ hostedUrl: "https://checkout.example.test/stale" }),
      )
      .mockResolvedValueOnce(
        response({ hostedUrl: "https://checkout.example.test/authoritative" }),
      );

    render(<PaymentRequestPage navigateToCheckout={navigate} />);
    const button = await screen.findByRole("button", {
      name: "Pay with Wallet",
    });
    fireEvent.click(button);

    await act(async () => {});
    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledWith(
      "https://checkout.example.test/authoritative",
    );
    expect(navigate).not.toHaveBeenCalledWith(
      "https://checkout.example.test/stale",
    );
  });

  it.each([
    { status: "expired" as const },
    { id: "another-request" },
    { hostedUrl: null },
    { expiresAt: "2000-01-01T00:00:00.000Z" },
  ])(
    "refuses navigation when click-time authority changed: %o",
    async (change) => {
      const navigate = vi.fn();
      apiMock
        .mockResolvedValueOnce(response())
        .mockResolvedValueOnce(response(change));

      render(<PaymentRequestPage navigateToCheckout={navigate} />);
      fireEvent.click(
        await screen.findByRole("button", { name: "Pay with Wallet" }),
      );
      expect(
        await screen.findByText("This payment request is no longer payable."),
      ).toBeTruthy();
      expect(navigate).not.toHaveBeenCalled();
    },
  );

  it("surfaces click-time revalidation failure without navigating", async () => {
    const navigate = vi.fn();
    apiMock
      .mockResolvedValueOnce(response())
      .mockRejectedValueOnce(new Error("revalidation unavailable"));

    render(<PaymentRequestPage navigateToCheckout={navigate} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Pay with Wallet" }),
    );

    expect(await screen.findByText("revalidation unavailable")).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });
});

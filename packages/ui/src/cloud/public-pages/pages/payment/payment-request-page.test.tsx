/**
 * Verifies the public payment request page against the server DTO contract:
 * generation-keyed loads (an out-of-order stale response cannot overwrite the
 * current route), deadline-derived Pay eligibility that rejects malformed
 * values and re-arms long timers, pre-checkout server revalidation, and
 * user-facing provider labels. The component is real; the API client and
 * router are mocked under jsdom.
 */
// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const paramsRef = vi.hoisted(() => ({
  current: { paymentRequestId: "payreq-test-1" },
}));
const apiMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", () => ({
  Link: ({ children, ...props }: { children: ReactNode }) => (
    <a {...props}>{children}</a>
  ),
  useParams: () => paramsRef.current,
}));

vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT:
    () =>
    (
      _key: string,
      options?: { defaultValue?: string } & Record<string, string | number>,
    ) => {
      let value = options?.defaultValue ?? _key;
      for (const [key, replacement] of Object.entries(options ?? {})) {
        if (key !== "defaultValue") {
          value = value.replace(`{{${key}}}`, String(replacement));
        }
      }
      return value;
    },
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

import PaymentRequestPage from "./payment-request-page";

type PublicOverrides = Partial<{
  id: string;
  provider: "stripe" | "oxapay" | "x402" | "wallet_native";
  status:
    | "pending"
    | "delivered"
    | "settled"
    | "expired"
    | "canceled"
    | "failed";
  amountCents: number;
  expiresAt: string | null;
  hostedUrl: string | null;
}>;

function publicPaymentRequest(overrides: PublicOverrides = {}) {
  return {
    id: "payreq-test-1",
    provider: "wallet_native" as const,
    amountCents: 500,
    currency: "usd",
    status: "delivered" as const,
    reason: "Test payment request",
    expiresAt: "2030-01-01T00:00:00.000Z",
    hostedUrl: "https://example.com/checkout/test",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("PaymentRequestPage public DTO contract", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  beforeEach(() => {
    apiMock.mockReset();
    paramsRef.current = { paymentRequestId: "payreq-test-1" };
  });

  it("renders wallet_native through the user-facing label and allows checkout for delivered requests", async () => {
    apiMock.mockResolvedValue({
      success: true,
      paymentRequest: publicPaymentRequest(),
    });

    render(<PaymentRequestPage />);

    const button = await screen.findByRole("button", {
      name: /pay with wallet/i,
    });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/wallet_native/)).toBeNull();
  });

  it("renders canceled requests as terminal and keeps checkout disabled", async () => {
    apiMock.mockResolvedValue({
      success: true,
      paymentRequest: publicPaymentRequest({
        status: "canceled",
        hostedUrl: null,
      }),
    });

    render(<PaymentRequestPage />);

    expect(await screen.findByText("Cancelled")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: /pay with wallet/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("ignores a stale out-of-order response for a previous route (A resolves after B)", async () => {
    const loadA = deferred<{ success: boolean; paymentRequest: unknown }>();
    const loadB = deferred<{ success: boolean; paymentRequest: unknown }>();
    apiMock.mockImplementation((path: string) =>
      path.includes("payreq-a") ? loadA.promise : loadB.promise,
    );

    paramsRef.current = { paymentRequestId: "payreq-a" };
    const { rerender } = render(<PaymentRequestPage />);

    paramsRef.current = { paymentRequestId: "payreq-b" };
    rerender(<PaymentRequestPage />);

    await act(async () => {
      loadB.resolve({
        success: true,
        paymentRequest: publicPaymentRequest({
          id: "payreq-b",
          provider: "stripe",
          amountCents: 2500,
        }),
      });
    });
    await screen.findByText("$25.00");

    // Give the stale resolution a chance to (incorrectly) commit.
    await act(async () => {
      loadA.resolve({
        success: true,
        paymentRequest: publicPaymentRequest({
          id: "payreq-a",
          provider: "oxapay",
          amountCents: 111,
        }),
      });
      await new Promise((res) => setTimeout(res, 20));
    });

    expect(screen.getByText("$25.00")).toBeTruthy();
    expect(screen.queryByText("$1.11")).toBeNull();
    expect(screen.getByText("#payreq-b")).toBeTruthy();
  });

  it("disables Pay when the deadline has already passed even if status is payable", async () => {
    apiMock.mockResolvedValue({
      success: true,
      paymentRequest: publicPaymentRequest({
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    });

    render(<PaymentRequestPage />);

    expect(await screen.findByText("Expired")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: /pay with wallet/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("fails closed and renders an explicit error for a malformed expiry date", async () => {
    apiMock.mockResolvedValue({
      success: true,
      paymentRequest: publicPaymentRequest({ expiresAt: "not-a-date" }),
    });

    render(<PaymentRequestPage />);

    expect(await screen.findByText("Invalid expiry date")).toBeTruthy();
    expect(
      screen.getByText(
        "This payment request has an invalid expiry date and cannot be paid.",
      ),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: /pay with wallet/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("re-arms timers beyond the browser delay limit until the real deadline", async () => {
    const browserTimerLimitMs = 2 ** 31 - 1;
    const startMs = Date.UTC(2030, 0, 1);
    const deadlineMs = startMs + browserTimerLimitMs + 60_000;
    vi.useFakeTimers();
    vi.setSystemTime(startMs);
    apiMock.mockResolvedValue({
      success: true,
      paymentRequest: publicPaymentRequest({
        expiresAt: new Date(deadlineMs).toISOString(),
      }),
    });

    render(<PaymentRequestPage />);
    await act(async () => {
      await Promise.resolve();
    });

    const button = screen.getByRole("button", {
      name: /pay with wallet/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(browserTimerLimitMs);
    });
    expect(button.disabled).toBe(false);
    expect(screen.queryByText("Expired")).toBeNull();
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(60_001);
    });
    expect(button.disabled).toBe(true);
    expect(screen.getByText("Expired")).toBeTruthy();
  });

  it("flips Pay to disabled when the deadline passes while the page is open", async () => {
    apiMock.mockResolvedValue({
      success: true,
      paymentRequest: publicPaymentRequest({
        expiresAt: new Date(Date.now() + 250).toISOString(),
      }),
    });

    render(<PaymentRequestPage />);

    const button = (await screen.findByRole("button", {
      name: /pay with wallet/i,
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    await waitFor(() => expect(button.disabled).toBe(true), {
      timeout: 3_000,
    });
    expect(screen.getByText("Expired")).toBeTruthy();
  });

  it("revalidates before checkout and blocks navigation when the request settled", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { assign, href: "https://eliza.example/pay" });

    apiMock
      .mockResolvedValueOnce({
        success: true,
        paymentRequest: publicPaymentRequest(),
      })
      .mockResolvedValueOnce({
        success: true,
        paymentRequest: publicPaymentRequest({ status: "settled" }),
      });

    render(<PaymentRequestPage />);

    const button = await screen.findByRole("button", {
      name: /pay with wallet/i,
    });
    fireEvent.click(button);

    expect(await screen.findByText("Paid")).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
    expect(apiMock).toHaveBeenCalledTimes(2);
  });

  it("revalidates before checkout and navigates to the fresh hosted URL", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { assign, href: "https://eliza.example/pay" });

    apiMock
      .mockResolvedValueOnce({
        success: true,
        paymentRequest: publicPaymentRequest({
          hostedUrl: "https://example.com/checkout/stale",
        }),
      })
      .mockResolvedValueOnce({
        success: true,
        paymentRequest: publicPaymentRequest({
          hostedUrl: "https://example.com/checkout/fresh",
        }),
      });

    render(<PaymentRequestPage />);

    const button = await screen.findByRole("button", {
      name: /pay with wallet/i,
    });
    fireEvent.click(button);

    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("https://example.com/checkout/fresh"),
    );
  });

  it("blocks navigation and shows an error when the hosted URL is not http(s)", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { assign, href: "https://eliza.example/pay" });

    apiMock
      .mockResolvedValueOnce({
        success: true,
        paymentRequest: publicPaymentRequest(),
      })
      .mockResolvedValueOnce({
        success: true,
        paymentRequest: publicPaymentRequest({
          hostedUrl: "javascript:alert(document.cookie)",
        }),
      });

    render(<PaymentRequestPage />);

    const button = await screen.findByRole("button", {
      name: /pay with wallet/i,
    });
    fireEvent.click(button);

    expect(
      await screen.findByText(
        "This payment request's checkout URL is not valid.",
      ),
    ).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });

  it("does not navigate when checkout revalidation resolves after unmount", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { assign, href: "https://eliza.example/pay" });
    const checkout = deferred<{
      success: boolean;
      paymentRequest: ReturnType<typeof publicPaymentRequest>;
    }>();

    apiMock
      .mockResolvedValueOnce({
        success: true,
        paymentRequest: publicPaymentRequest(),
      })
      .mockReturnValueOnce(checkout.promise);

    const { unmount } = render(<PaymentRequestPage />);
    const button = await screen.findByRole("button", {
      name: /pay with wallet/i,
    });
    fireEvent.click(button);
    unmount();

    await act(async () => {
      checkout.resolve({
        success: true,
        paymentRequest: publicPaymentRequest({
          hostedUrl: "https://example.com/checkout/must-not-open",
        }),
      });
      await checkout.promise;
    });

    expect(assign).not.toHaveBeenCalled();
  });

  it("blocks navigation when revalidation returns a malformed deadline", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { assign, href: "https://eliza.example/pay" });

    apiMock
      .mockResolvedValueOnce({
        success: true,
        paymentRequest: publicPaymentRequest(),
      })
      .mockResolvedValueOnce({
        success: true,
        paymentRequest: publicPaymentRequest({ expiresAt: "not-a-date" }),
      });

    render(<PaymentRequestPage />);

    const button = await screen.findByRole("button", {
      name: /pay with wallet/i,
    });
    fireEvent.click(button);

    expect(await screen.findByText("Invalid expiry date")).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("blocks navigation when revalidation reports the deadline has passed", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { assign, href: "https://eliza.example/pay" });

    apiMock
      .mockResolvedValueOnce({
        success: true,
        paymentRequest: publicPaymentRequest(),
      })
      .mockResolvedValueOnce({
        success: true,
        paymentRequest: publicPaymentRequest({
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
        }),
      });

    render(<PaymentRequestPage />);

    const button = await screen.findByRole("button", {
      name: /pay with wallet/i,
    });
    fireEvent.click(button);

    expect(await screen.findByText("Expired")).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});

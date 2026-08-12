/** Verifies the public payment request page against the server DTO contract. */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
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

function publicPaymentRequest(
  overrides: Partial<{
    provider: "stripe" | "oxapay" | "x402" | "wallet_native";
    status:
      | "pending"
      | "delivered"
      | "settled"
      | "expired"
      | "canceled"
      | "failed";
    hostedUrl: string | null;
  }> = {},
) {
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

describe("PaymentRequestPage public DTO contract", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    apiMock.mockReset();
    paramsRef.current = { paymentRequestId: "payreq-test-1" };
  });

  it("renders wallet_native and allows checkout for delivered requests", async () => {
    apiMock.mockResolvedValue({
      success: true,
      paymentRequest: publicPaymentRequest(),
    });

    render(<PaymentRequestPage />);

    const button = await screen.findByRole("button", {
      name: /pay with wallet_native/i,
    });
    expect(button).toBeEnabled();
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
      screen.getByRole("button", { name: /pay with wallet_native/i }),
    ).toBeDisabled();
  });
});

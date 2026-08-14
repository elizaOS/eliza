/**
 * BillingTab hero, buy-credits form, and invoice list. The real component
 * renders; api-client, i18n, navigation, and sibling cards are doubled.
 */

// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingUser, InvoiceDisplay } from "../types";

const apiMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/ui/cloud-ui", async () => {
  const React = await import("react");
  const Input = React.forwardRef<
    HTMLInputElement,
    React.InputHTMLAttributes<HTMLInputElement> & { hasError?: boolean }
  >(({ hasError, ...props }, ref) => (
    <input
      ref={ref}
      data-has-error={hasError ? "true" : undefined}
      {...props}
    />
  ));
  Input.displayName = "Input";
  return {
    BrandButton: ({
      children,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button {...props}>{children}</button>
    ),
    BrandCard: ({ children }: { children?: React.ReactNode }) => (
      <section>{children}</section>
    ),
    CornerBrackets: () => null,
    Input,
    Label: ({
      children,
      htmlFor,
      ...props
    }: React.LabelHTMLAttributes<HTMLLabelElement>) => (
      <label htmlFor={htmlFor} {...props}>
        {children}
      </label>
    ),
  };
});

vi.mock("../../lib/api-client", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
  api: (...args: unknown[]) => apiMock(...args),
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock("../../shell/CloudI18nProvider", () => {
  const t = (
    _key: string,
    options?: Record<string, unknown> & { defaultValue?: string },
  ) => {
    let value = options?.defaultValue ?? _key;
    for (const [key, replacement] of Object.entries(options ?? {})) {
      if (key !== "defaultValue") {
        value = value.replaceAll(`{{${key}}}`, String(replacement));
      }
    }
    return value;
  };
  return { useCloudT: () => t };
});

vi.mock("./auto-top-up-card", () => ({
  AutoTopUpCard: () => <div>auto top-up card</div>,
}));

vi.mock("./pay-as-you-go-card", () => ({
  PayAsYouGoCard: () => <div>pay as you go card</div>,
}));

import { BillingTab } from "./billing-tab";

const user: BillingUser = {
  organization_id: "org-1",
  wallet_address: null,
  organization: { credit_balance: "12.50" },
};

const paidInvoice: InvoiceDisplay = {
  id: "inv_paid",
  date: "Aug 1, 2026 09:00",
  total: "$25.00",
  status: "paid",
};

const openInvoice: InvoiceDisplay = {
  id: "inv_open",
  date: "Aug 2, 2026 10:00",
  total: "$10.00",
  status: "open",
};

function mockApis(options?: {
  invoices?: InvoiceDisplay[];
  invoicesError?: Error;
  checkoutUrl?: string;
}) {
  apiMock.mockImplementation((path: unknown) => {
    const url = String(path);
    if (url.startsWith("/api/credits/balance")) {
      return Promise.resolve({ balance: 12.5 });
    }
    if (url === "/api/crypto/status") {
      return Promise.resolve({ enabled: false });
    }
    if (url === "/api/invoices/list") {
      if (options?.invoicesError) {
        return Promise.reject(options.invoicesError);
      }
      return Promise.resolve({ invoices: options?.invoices ?? [] });
    }
    if (url === "/api/stripe/create-checkout-session") {
      return Promise.resolve({ url: options?.checkoutUrl ?? "/checkout" });
    }
    return Promise.reject(new Error(`Unexpected API call: ${url}`));
  });
}

describe("BillingTab", () => {
  beforeEach(() => {
    mockApis();
  });

  afterEach(() => {
    cleanup();
    apiMock.mockReset();
    toastErrorMock.mockReset();
    toastSuccessMock.mockReset();
    navigateMock.mockReset();
  });

  it("renders the credit hero with tabular money and a labeled amount field", async () => {
    render(<BillingTab user={user} />);

    expect(await screen.findByText("$12.50")).toBeTruthy();
    const balance = screen.getByText("$12.50");
    expect(balance.className).toContain("tabular-nums");

    const amount = screen.getByLabelText("Amount (USD)");
    expect(amount.getAttribute("inputmode")).toBe("decimal");
    expect(screen.getByRole("button", { name: "Buy credits" })).toBeTruthy();
    expect(
      screen.getByText("Enter an amount between $1 and $10,000."),
    ).toBeTruthy();
  });

  it("keeps Buy credits enabled and shows an instructional error next to the amount field", async () => {
    const events = userEvent.setup({ delay: null });
    render(<BillingTab user={user} />);
    await screen.findByLabelText("Amount (USD)");

    const submit = screen.getByRole("button", { name: "Buy credits" });
    expect((submit as HTMLButtonElement).disabled).toBe(false);

    await events.click(submit);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "Enter an amount between $1 and $10,000",
    );
    expect(document.activeElement).toBe(screen.getByLabelText("Amount (USD)"));
    expect(
      screen.getByLabelText("Amount (USD)").getAttribute("aria-invalid"),
    ).toBe("true");
    expect(
      apiMock.mock.calls.some(
        ([path]) => path === "/api/stripe/create-checkout-session",
      ),
    ).toBe(false);
  });

  it("tells the user to enter at least $1 when the amount is too small", async () => {
    const events = userEvent.setup({ delay: null });
    render(<BillingTab user={user} />);

    await events.type(await screen.findByLabelText("Amount (USD)"), "0.25");
    expect(screen.getByRole("alert").textContent).toContain(
      "Enter at least $1",
    );
  });

  it("submits a valid amount with Enter and keeps the verb-first buy label", async () => {
    const events = userEvent.setup({ delay: null });
    const assign = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, href: "" },
    });
    Object.defineProperty(window.location, "href", {
      configurable: true,
      set: assign,
    });

    mockApis({ checkoutUrl: "https://checkout.example/session" });
    render(<BillingTab user={user} />);

    const amount = await screen.findByLabelText("Amount (USD)");
    await events.type(amount, "25");
    expect(
      screen.getByText("$25.00 will be added to your balance").className,
    ).toContain("tabular-nums");
    await events.keyboard("{Enter}");

    await waitFor(() => {
      expect(
        apiMock.mock.calls.some(
          ([path, init]) =>
            path === "/api/stripe/create-checkout-session" &&
            Boolean(
              init &&
                typeof init === "object" &&
                "json" in init &&
                (init as { json?: { amount?: number } }).json?.amount === 25,
            ),
        ),
      ).toBe(true);
    });
    expect(assign).toHaveBeenCalledWith("https://checkout.example/session");
    expect(screen.getByRole("button", { name: "Buy credits" })).toBeTruthy();

    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("wraps invoice rows and pairs status color with a text and icon cue", async () => {
    mockApis({ invoices: [paidInvoice, openInvoice] });
    const { container } = render(<BillingTab user={user} />);

    expect(await screen.findByText("paid")).toBeTruthy();
    expect(screen.getByText("open")).toBeTruthy();
    expect(container.querySelector(".min-w-\\[600px\\]")).toBeNull();
    expect(container.querySelector(".overflow-x-auto")).toBeNull();

    const paidStatus = screen.getByText("paid").closest("p");
    expect(paidStatus?.className).toContain("text-status-success");
    expect(paidStatus?.querySelector("svg")).toBeTruthy();

    const openStatus = screen.getByText("open").closest("p");
    expect(openStatus?.className).toContain("text-status-warning");
    expect(openStatus?.querySelector("svg")).toBeTruthy();

    const totals = screen.getAllByText(/\$\d+\.\d{2}/);
    expect(totals.some((node) => node.className.includes("tabular-nums"))).toBe(
      true,
    );

    await userEvent.setup({ delay: null }).click(
      screen.getByRole("button", {
        name: "View invoice from Aug 1, 2026 09:00",
      }),
    );
    expect(navigateMock).toHaveBeenCalledWith("/cloud/invoices/inv_paid");
  });

  it("points the empty invoice list at buying credits", async () => {
    render(<BillingTab user={user} />);

    expect(await screen.findByText("No invoices yet")).toBeTruthy();
    expect(
      screen.getByText("Buy credits above to generate your first invoice."),
    ).toBeTruthy();
  });
});

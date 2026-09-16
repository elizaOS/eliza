/**
 * Verifies invoice routing waits for authentication, billing identity, and the
 * invoice query to settle before choosing a redirect or detail destination.
 */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const billingUser = vi.hoisted(() => ({
  value: {
    user: null as { id: string; organization_id: string } | null,
    isPending: true,
    isFetching: false,
    isPaused: false,
    isFetchedAfterMount: false,
    isError: false,
    error: null as Error | null,
    isReady: false,
    isAuthenticated: false,
  },
}));
const billingUserOptions = vi.hoisted(() => ({
  current: null as { requireFreshOrganization?: boolean } | null,
}));
const invoice = vi.hoisted(() => ({
  value: {
    data: null as { id: string } | null,
    isPending: true,
    isFetching: false,
    isPaused: false,
    isFetchedAfterMount: false,
    error: null as Error | null,
  },
}));

vi.mock("./data/billing-data", () => ({
  ApiError: class ApiError extends Error {
    status = 500;
  },
  useBillingUser: (options?: { requireFreshOrganization?: boolean }) => {
    billingUserOptions.current = options ?? null;
    return billingUser.value;
  },
  useInvoice: () => invoice.value,
}));

vi.mock("./components/invoice-detail-client", () => ({
  InvoiceDetailClient: ({ invoice: value }: { invoice: { id: string } }) => (
    <div>Invoice detail {value.id}</div>
  ),
}));

vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

import InvoiceDetailPage from "./InvoiceDetailPage";

function renderInvoiceRoute(path = "/cloud/invoices/invoice-1") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/cloud/invoices/:id" element={<InvoiceDetailPage />} />
        <Route path="/login" element={<div>Login destination</div>} />
        <Route path="/settings" element={<div>Billing destination</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("InvoiceDetailPage", () => {
  afterEach(() => {
    cleanup();
    billingUserOptions.current = null;
    billingUser.value = {
      user: null,
      isPending: true,
      isFetching: false,
      isPaused: false,
      isFetchedAfterMount: false,
      isError: false,
      error: null,
      isReady: false,
      isAuthenticated: false,
    };
    invoice.value = {
      data: null,
      isPending: true,
      isFetching: false,
      isPaused: false,
      isFetchedAfterMount: false,
      error: null,
    };
  });

  it("shows loading instead of redirecting while authentication is unresolved", () => {
    renderInvoiceRoute();

    expect(
      screen.getByRole("status", { name: "Loading invoice" }),
    ).toBeTruthy();
    expect(screen.queryByText("Login destination")).toBeNull();
    expect(screen.queryByText("Billing destination")).toBeNull();
  });

  it("shows loading for an authenticated initial user query paused offline", () => {
    billingUser.value = {
      user: null,
      isPending: true,
      isFetching: false,
      isPaused: true,
      isFetchedAfterMount: false,
      isError: false,
      error: null,
      isReady: true,
      isAuthenticated: true,
    };
    renderInvoiceRoute();

    expect(
      screen.getByRole("status", { name: "Loading invoice" }),
    ).toBeTruthy();
    expect(screen.queryByText("Billing destination")).toBeNull();
  });

  it("redirects only after a signed-out session settles", () => {
    billingUser.value = {
      user: null,
      isPending: true,
      isFetching: false,
      isPaused: false,
      isFetchedAfterMount: false,
      isError: false,
      error: null,
      isReady: true,
      isAuthenticated: false,
    };
    renderInvoiceRoute();

    expect(screen.getByText("Login destination")).toBeTruthy();
  });

  it("waits for the invoice query after the billing identity resolves", () => {
    billingUser.value = {
      user: { id: "user-1", organization_id: "org-1" },
      isPending: false,
      isFetching: false,
      isPaused: false,
      isFetchedAfterMount: true,
      isError: false,
      error: null,
      isReady: true,
      isAuthenticated: true,
    };
    renderInvoiceRoute();

    expect(
      screen.getByRole("status", { name: "Loading invoice" }),
    ).toBeTruthy();
    expect(screen.queryByText("Billing destination")).toBeNull();
    expect(billingUserOptions.current).toEqual({
      requireFreshOrganization: true,
    });
  });

  it.each([
    {
      label: "membership refresh",
      userState: { isFetching: true },
      invoiceState: {},
    },
    {
      label: "paused membership refresh",
      userState: { isPaused: true },
      invoiceState: {},
    },
    {
      label: "invoice ownership refresh",
      userState: {},
      invoiceState: { isFetching: true },
    },
    {
      label: "paused invoice ownership refresh",
      userState: {},
      invoiceState: { isPaused: true },
    },
  ])(
    "does not paint a cached invoice during $label",
    ({ userState, invoiceState }) => {
      billingUser.value = {
        user: { id: "user-1", organization_id: "org-2" },
        isPending: false,
        isFetching: false,
        isPaused: false,
        isFetchedAfterMount: true,
        isError: false,
        error: null,
        isReady: true,
        isAuthenticated: true,
        ...userState,
      };
      invoice.value = {
        data: { id: "cached-org-1-invoice" },
        isPending: false,
        isFetching: false,
        isPaused: false,
        isFetchedAfterMount: true,
        error: null,
        ...invoiceState,
      };
      renderInvoiceRoute();

      expect(
        screen.getByRole("status", { name: "Loading invoice" }),
      ).toBeTruthy();
      expect(screen.queryByText(/cached-org-1-invoice/)).toBeNull();
    },
  );

  it("renders the invoice after both queries resolve", () => {
    billingUser.value = {
      user: { id: "user-1", organization_id: "org-1" },
      isPending: false,
      isFetching: false,
      isPaused: false,
      isFetchedAfterMount: true,
      isError: false,
      error: null,
      isReady: true,
      isAuthenticated: true,
    };
    invoice.value = {
      data: { id: "invoice-1" },
      isPending: false,
      isFetching: false,
      isPaused: false,
      isFetchedAfterMount: true,
      error: null,
    };
    renderInvoiceRoute();

    expect(screen.getByText("Invoice detail invoice-1")).toBeTruthy();
  });
});

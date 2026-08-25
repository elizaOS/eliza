/** Verifies that lifted cloud sections keep their contextual header actions. */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSetPageHeader } from "../../cloud-ui/components/layout";
import { CloudSettingsSectionShell } from "./CloudSettingsSectionShell";

const invoiceRouteParam = vi.hoisted(() => ({
  current: null as string | null,
}));

vi.mock("../shell/CloudI18nProvider", () => ({
  CloudI18nProvider: ({ children }: { children: ReactNode }) => children,
  resolveInitialCloudLang: () => "en",
  useCloudT: () => (key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? key,
}));

vi.mock("../shell/StewardProvider", () => ({
  StewardAuthProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("../billing/data/billing-data", () => ({
  ApiError: class ApiError extends Error {
    status: number;

    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
  useBillingUser: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: { id: "user-1", organization_id: "org-1" },
  }),
  useInvoice: (id: string | undefined) => {
    invoiceRouteParam.current = id ?? null;
    return {
      data: {
        id: "invoice-42",
        organization_id: "org-1",
        stripe_invoice_id: "stripe-invoice-42",
        stripe_customer_id: "stripe-customer-1",
        stripe_payment_intent_id: null,
        amount_due: 42,
        amount_paid: 42,
        currency: "usd",
        status: "paid",
        invoice_type: "one_time_purchase",
        invoice_number: "INV-0042",
        invoice_pdf: null,
        hosted_invoice_url: null,
        credits_added: 42,
        metadata: {},
        created_at: "2026-08-23T08:00:00.000Z",
        updated_at: "2026-08-23T08:00:00.000Z",
        due_date: null,
        paid_at: "2026-08-23T08:00:00.000Z",
      },
      error: null,
      isLoading: false,
    };
  },
}));

function SectionWithHeaderAction({ onAction }: { onAction: () => void }) {
  useSetPageHeader(
    {
      title: "API Keys",
      actions: (
        <button type="button" onClick={onAction}>
          Generate key
        </button>
      ),
    },
    [onAction],
  );

  return <div>API key settings</div>;
}

function BillingInvoiceNavigationProbe() {
  const navigate = useNavigate();
  return (
    <div>
      <span>Billing settings</span>
      <button
        type="button"
        onClick={() => navigate("/cloud/invoices/invoice-42")}
      >
        View invoice
      </button>
    </div>
  );
}

describe("CloudSettingsSectionShell", () => {
  afterEach(() => cleanup());

  it("renders actions published through the cloud page-header context", async () => {
    const onAction = vi.fn();
    const view = render(
      <CloudSettingsSectionShell>
        <SectionWithHeaderAction onAction={onAction} />
      </CloudSettingsSectionShell>,
    );

    expect(screen.getByText("API key settings")).toBeTruthy();
    const action = await screen.findByRole("button", { name: "Generate key" });
    fireEvent.click(action);
    expect(onAction).toHaveBeenCalledTimes(1);

    view.rerender(
      <CloudSettingsSectionShell>
        <div>Organization settings</div>
      </CloudSettingsSectionShell>,
    );
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Generate key" })).toBeNull();
    });
  });

  it("renders the canonical invoice detail route after in-settings navigation", async () => {
    render(
      <CloudSettingsSectionShell>
        <BillingInvoiceNavigationProbe />
      </CloudSettingsSectionShell>,
    );

    fireEvent.click(screen.getByRole("button", { name: "View invoice" }));

    expect(
      await screen.findByRole(
        "heading",
        {
          level: 1,
          name: "Invoice Details",
        },
        { timeout: 10_000 },
      ),
    ).toBeTruthy();
    expect(screen.getByText("INV-0042")).toBeTruthy();
    expect(invoiceRouteParam.current).toBe("invoice-42");
    expect(screen.queryByText("Billing settings")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to Billing" }));
    expect(await screen.findByText("Billing settings")).toBeTruthy();
  }, 15_000);
});

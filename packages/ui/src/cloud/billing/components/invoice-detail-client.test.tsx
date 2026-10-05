/**
 * Verifies the receipt renders the affiliate surcharge as separate lines from
 * the server breakdown (#23020), and adds no lines when none applies.
 */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? key,
}));

import type { InvoiceDto } from "../types";
import { InvoiceDetailClient } from "./invoice-detail-client";

function invoice(overrides: Partial<InvoiceDto> = {}): InvoiceDto {
  return {
    id: "invoice-1",
    organization_id: "org-1",
    stripe_invoice_id: "pi_pi_1",
    stripe_customer_id: "cus_1",
    stripe_payment_intent_id: "pi_1",
    amount_due: 32.5,
    amount_paid: 32.5,
    currency: "usd",
    status: "paid",
    invoice_type: "auto_top_up",
    invoice_number: null,
    invoice_pdf: null,
    hosted_invoice_url: null,
    credits_added: 25,
    metadata: {},
    charge_breakdown: null,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    due_date: null,
    paid_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderInvoice(value: InvoiceDto) {
  return render(
    <MemoryRouter>
      <InvoiceDetailClient invoice={value} />
    </MemoryRouter>,
  );
}

describe("InvoiceDetailClient affiliate surcharge lines", () => {
  afterEach(cleanup);

  it("shows the affiliate markup, platform fee and total charged separately", () => {
    renderInvoice(
      invoice({
        charge_breakdown: {
          creditedBaseUsd: "25.00",
          affiliateMarkupUsd: "2.50",
          platformFeeUsd: "5.00",
          totalChargeUsd: "32.50",
          surchargeApplies: true,
        },
      }),
    );

    expect(screen.getByText("Credits Added")).toBeTruthy();
    expect(
      screen.getByTestId("invoice-charge-affiliate").textContent,
    ).toContain("$2.50");
    expect(screen.getByTestId("invoice-charge-platform").textContent).toContain(
      "$5.00",
    );
    expect(screen.getByTestId("invoice-charge-total").textContent).toContain(
      "$32.50",
    );
  });

  it("adds no surcharge lines when no affiliate surcharge applied", () => {
    renderInvoice(invoice({ amount_due: 25, amount_paid: 25 }));

    expect(screen.queryByTestId("invoice-charge-affiliate")).toBeNull();
    expect(screen.queryByTestId("invoice-charge-total")).toBeNull();
  });
});

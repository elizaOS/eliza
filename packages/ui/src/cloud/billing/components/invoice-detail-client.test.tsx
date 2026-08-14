/**
 * Renders InvoiceDetailClient as a BrandCard invoice document: 3-column
 * header, payment grid, real header links, status badge. jsdom, no backend.
 */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InvoiceDto } from "../types";
import { InvoiceDetailClient } from "./invoice-detail-client";

vi.mock("../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

function makeInvoice(overrides: Partial<InvoiceDto> = {}): InvoiceDto {
  return {
    id: "inv-1",
    organization_id: "org-1",
    stripe_invoice_id: "in_12345678abcdefgh",
    stripe_customer_id: "cus_1",
    stripe_payment_intent_id: "pi_abc123",
    amount_due: "10.00",
    amount_paid: "10.00",
    currency: "usd",
    status: "paid",
    invoice_type: "one_time_purchase",
    invoice_number: "INV-1001",
    invoice_pdf: "https://example.test/invoice.pdf",
    hosted_invoice_url: "https://example.test/stripe-invoice",
    credits_added: "10.00",
    metadata: null,
    created_at: "2026-03-15T12:00:00.000Z",
    updated_at: "2026-03-15T12:00:00.000Z",
    due_date: null,
    paid_at: "2026-03-15T12:05:00.000Z",
    ...overrides,
  };
}

function renderInvoice(invoice: InvoiceDto = makeInvoice()) {
  return render(
    <MemoryRouter>
      <InvoiceDetailClient invoice={invoice} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

describe("InvoiceDetailClient", () => {
  it("renders the invoice as a compact document, not a settings list", () => {
    renderInvoice();

    expect(screen.getByTestId("cloud-invoice-detail")).toBeTruthy();
    expect(screen.getByText("Invoice Details")).toBeTruthy();
    expect(screen.getByText("Invoice Number")).toBeTruthy();
    expect(screen.getByText("INV-1001")).toBeTruthy();
    expect(screen.getByText("Date")).toBeTruthy();
    expect(screen.getByText("Status")).toBeTruthy();
    expect(screen.getByText("Paid")).toBeTruthy();
    expect(screen.getByText("Payment Information")).toBeTruthy();
    expect(screen.getByText("Amount Due")).toBeTruthy();
    expect(screen.getByText("Amount Paid")).toBeTruthy();
    expect(screen.getAllByText("$10.00").length).toBeGreaterThan(0);
    expect(screen.getByText("Currency")).toBeTruthy();
    expect(screen.getByText("usd")).toBeTruthy();
    expect(screen.getByText("Type")).toBeTruthy();
    expect(screen.getByText("One-Time Purchase")).toBeTruthy();
    expect(screen.getByText("Payment Intent ID")).toBeTruthy();
    expect(screen.getByText("pi_abc123")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/SettingsStack/);
  });

  it("keeps the transaction table and header actions as real links", () => {
    renderInvoice();

    expect(screen.getByText("Transaction Summary")).toBeTruthy();
    expect(screen.getByText("Description")).toBeTruthy();
    expect(screen.getByText("Amount")).toBeTruthy();
    expect(screen.getByText("One-Time Credit Purchase")).toBeTruthy();
    expect(screen.getByText("Credits Added")).toBeTruthy();

    const pdf = screen.getByRole("link", { name: "Download PDF" });
    expect(pdf.getAttribute("href")).toBe("https://example.test/invoice.pdf");
    expect(pdf.getAttribute("target")).toBe("_blank");

    const stripe = screen.getByRole("link", { name: "View in Stripe" });
    expect(stripe.getAttribute("href")).toBe(
      "https://example.test/stripe-invoice",
    );

    const back = screen.getByRole("link", { name: "Back to Billing" });
    expect(back.getAttribute("href")).toBe("/settings#cloud-billing");
  });

  it("falls back to a derived invoice number and omits optional rows", () => {
    renderInvoice(
      makeInvoice({
        invoice_number: null,
        stripe_payment_intent_id: null,
        invoice_pdf: null,
        hosted_invoice_url: null,
        credits_added: null,
        paid_at: null,
        status: "open",
        invoice_type: "auto_top_up",
      }),
    );

    expect(screen.getByText("INV-ABCDEFGH")).toBeTruthy();
    expect(screen.getByText("Open")).toBeTruthy();
    expect(screen.queryByText("Paid")).toBeNull();
    expect(screen.getAllByText("Auto Top-Up").length).toBeGreaterThan(0);
    expect(screen.queryByText("Payment intent ID")).toBeNull();
    expect(screen.queryByRole("link", { name: "Download PDF" })).toBeNull();
    expect(screen.queryByRole("link", { name: "View in Stripe" })).toBeNull();
    expect(screen.queryByText("Credits Added")).toBeNull();
    expect(screen.queryByText("Payment Date")).toBeNull();
  });
});

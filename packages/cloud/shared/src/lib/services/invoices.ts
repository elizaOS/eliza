/**
 * Service for managing invoices from Stripe payments.
 */

import Decimal from "decimal.js";
import { desc, eq } from "drizzle-orm";
import { type DbTransaction, dbRead, dbWrite } from "../../db/client";
import { type Invoice, invoices, type NewInvoice } from "../../db/schemas";
import { logger } from "../utils/logger";

/**
 * Service for invoice CRUD operations.
 */
class InvoicesService {
  async create(data: NewInvoice, transaction?: DbTransaction): Promise<Invoice> {
    const executor = transaction ?? dbWrite;
    const [created] = await executor
      .insert(invoices)
      .values({
        ...data,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .onConflictDoNothing({ target: invoices.stripe_invoice_id })
      .returning();
    const invoice =
      created ??
      (
        await executor
          .select()
          .from(invoices)
          .where(eq(invoices.stripe_invoice_id, data.stripe_invoice_id))
          .limit(1)
      )[0];
    if (!invoice) {
      throw new Error("Invoice replay could not recover the committed invoice");
    }
    const creditsMatch =
      invoice.credits_added === null && data.credits_added == null
        ? true
        : invoice.credits_added !== null && data.credits_added != null
          ? new Decimal(invoice.credits_added).equals(data.credits_added)
          : false;
    if (
      invoice.organization_id !== data.organization_id ||
      invoice.stripe_customer_id !== data.stripe_customer_id ||
      invoice.stripe_payment_intent_id !== (data.stripe_payment_intent_id ?? null) ||
      !new Decimal(invoice.amount_due).equals(data.amount_due) ||
      !new Decimal(invoice.amount_paid).equals(data.amount_paid) ||
      invoice.currency !== (data.currency ?? "usd") ||
      invoice.status !== data.status ||
      invoice.invoice_type !== data.invoice_type ||
      !creditsMatch
    ) {
      throw new Error("Invoice idempotency replay does not match the original settlement");
    }

    logger.info("invoices-service", "Invoice created", {
      invoiceId: invoice.id,
      organizationId: data.organization_id,
      stripeInvoiceId: data.stripe_invoice_id,
    });

    return invoice;
  }

  async getByStripeInvoiceId(stripeInvoiceId: string): Promise<Invoice | undefined> {
    const [invoice] = await dbRead
      .select()
      .from(invoices)
      .where(eq(invoices.stripe_invoice_id, stripeInvoiceId))
      .limit(1);

    return invoice;
  }

  async listByOrganization(organizationId: string): Promise<Invoice[]> {
    const orgInvoices = await dbRead
      .select()
      .from(invoices)
      .where(eq(invoices.organization_id, organizationId))
      .orderBy(desc(invoices.created_at));

    logger.info("invoices-service", "Listed invoices", {
      organizationId,
      count: orgInvoices.length,
    });

    return orgInvoices;
  }

  async update(id: string, data: Partial<NewInvoice>): Promise<void> {
    await dbWrite
      .update(invoices)
      .set({
        ...data,
        updated_at: new Date(),
      })
      .where(eq(invoices.id, id));

    logger.info("invoices-service", "Invoice updated", {
      invoiceId: id,
    });
  }

  async getById(id: string): Promise<Invoice | undefined> {
    const [invoice] = await dbRead.select().from(invoices).where(eq(invoices.id, id)).limit(1);

    return invoice;
  }
}

export const invoicesService = new InvoicesService();

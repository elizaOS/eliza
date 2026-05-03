/**
 * Service for managing invoices from Stripe payments.
 */

import { desc, eq } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/client";
import { type Invoice, invoices, type NewInvoice } from "@/db/schemas";
import { logger } from "@/lib/utils/logger";

/**
 * Service for invoice CRUD operations.
 */
class InvoicesService {
  async create(data: NewInvoice): Promise<Invoice> {
    const [invoice] = await dbWrite
      .insert(invoices)
      .values({
        ...data,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .returning();

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

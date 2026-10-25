/** Exercises receipt ownership and rejection against actual completed commercial commands. */
import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  createSubscriptionInvoiceEventEvidence,
  type SubscriptionInvoiceEventEvidence,
} from "../../../lib/services/subscription-invoice-event-evidence";

export async function assertReceiptCommercialSelection(input: {
  query: (q: string, v: unknown[]) => Promise<unknown>;
  original: SubscriptionInvoiceEventEvidence;
  commandId: string;
}) {
  const { recordOriginalInvoiceEvent } = await import("../subscription-invoice-event-evidence");
  const { readOriginalInvoiceCommercialSelection: read } = await import(
    "../subscription-invoice-commercial-selection"
  );
  const eventId = `evt_${randomUUID().replaceAll("-", "")}`;
  const original = createSubscriptionInvoiceEventEvidence(
    { ...input.original.event, id: eventId },
    { ...input.original.scope, providerEventId: eventId },
  );
  const scope = original.scope;
  const retained = await recordOriginalInvoiceEvent(
    {
      organizationId: scope.organizationId,
      subscriptionId: scope.subscriptionId,
      providerEventId: scope.providerEventId,
      eventType: "invoice.paid",
      providerObjectType: "invoice",
      providerObjectId: scope.invoiceId,
      livemode: scope.livemode,
      eventCreatedAt: new Date(original.event.created * 1000),
      payloadDigest: original.digest,
      now: new Date(),
    },
    original,
  );
  const request = { organizationId: scope.organizationId, receiptId: retained.value.id };
  const selected = await read(request);
  const { agreeOriginalInvoiceCommercialTerms: agree } = await import(
    "../subscription-invoice-commercial-selection"
  );
  const proven = selected.origins[0]!;
  expect(agree([proven, { ...proven, commandId: randomUUID() }])).toEqual(selected.terms);
  expect(() => agree([])).toThrow();
  for (const change of [
    { allowanceAmountUsd: "0.000001" },
    { catalogVersion: "different" },
    { periodEnd: proven.periodEnd + 1 },
    { productId: "prod_other" },
    { subscriptionItemId: "si_other" },
    { baseAmountCents: proven.baseAmountCents + 1 },
  ])
    expect(() => agree([proven, { ...proven, ...change } as typeof proven])).toThrow();
  expect(selected.origins.map((row) => row.commandId)).toEqual([input.commandId]);
  expect(selected.originalEvidenceDigest).toBe(original.digest);
  expect(selected.terms.periodStart).toBe(original.event.data.object.lines.data[0]!.period.start);
  expect(await read(request)).toEqual(selected);
  const { writeTransaction } = await import("../../helpers");
  expect(await writeTransaction((tx) => read(request, tx))).toEqual(selected);
  await expect(read({ ...request, organizationId: randomUUID() })).rejects.toMatchObject({
    code: "SUBSCRIPTION_INVOICE_COMMERCIAL_SELECTION_UNAVAILABLE",
  });
  await expect(read({ ...request, receiptId: randomUUID() })).rejects.toMatchObject({
    code: "SUBSCRIPTION_INVOICE_COMMERCIAL_SELECTION_UNAVAILABLE",
  });
  await expect(
    read({ ...request, commandId: randomUUID() } as typeof request),
  ).rejects.toMatchObject({ code: "SUBSCRIPTION_INVOICE_COMMERCIAL_SELECTION_UNAVAILABLE" });
  await input.query("UPDATE organizations SET is_active=false WHERE id=$1", [scope.organizationId]);
  await expect(read(request)).rejects.toMatchObject({
    code: "SUBSCRIPTION_INVOICE_COMMERCIAL_SELECTION_UNAVAILABLE",
  });
  await input.query("UPDATE organizations SET is_active=true WHERE id=$1", [scope.organizationId]);
  expect(await read(request)).toEqual(selected);
  const rollback = new Error("rollback test restriction");
  await expect(
    writeTransaction(async (tx) => {
      await tx.execute(sql`INSERT INTO subscription_billing_fences(organization_id,subscription_id,state,provider_object_digest)
      VALUES(${scope.organizationId},${scope.subscriptionId},'open',${"c".repeat(64)})
      ON CONFLICT(subscription_id) DO UPDATE SET fence_revision=subscription_billing_fences.fence_revision+1`);
      const advanced = await read(request, tx);
      expect(advanced.fence?.state).toBe("open");
      expect(advanced.terms).toEqual(selected.terms);
      expect(advanced.digest).not.toBe(selected.digest);
      await tx.execute(
        sql`UPDATE subscription_billing_fences SET state='quarantined',fence_revision=fence_revision+1 WHERE subscription_id=${scope.subscriptionId}`,
      );
      await expect(read(request, tx)).rejects.toMatchObject({
        code: "SUBSCRIPTION_INVOICE_DEBT_SOURCES_UNAVAILABLE",
      });
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  expect(await read(request)).toEqual(selected);
  // A canonical, retained but unknown price is unavailable; selection cannot use today's plan.
  const unknown = structuredClone(original.event),
    unknownId = `evt_${randomUUID().replaceAll("-", "")}`;
  unknown.id = unknownId;
  unknown.data.object.id = `in_${randomUUID().replaceAll("-", "")}`;
  unknown.data.object.lines.data[0]!.price.id = "price_unknown";
  const unknownEvidence = createSubscriptionInvoiceEventEvidence(unknown, {
    ...scope,
    providerEventId: unknownId,
    invoiceId: unknown.data.object.id,
  });
  const unknownReceipt = await recordOriginalInvoiceEvent(
    {
      organizationId: scope.organizationId,
      subscriptionId: scope.subscriptionId,
      providerEventId: unknownId,
      eventType: "invoice.paid",
      providerObjectType: "invoice",
      providerObjectId: unknown.data.object.id,
      livemode: scope.livemode,
      eventCreatedAt: new Date(unknown.created * 1000),
      payloadDigest: unknownEvidence.digest,
      now: new Date(),
    },
    unknownEvidence,
  );
  await expect(read({ ...request, receiptId: unknownReceipt.value.id })).rejects.toMatchObject({
    code: "SUBSCRIPTION_INVOICE_COMMERCIAL_SELECTION_UNAVAILABLE",
    context: { reason: "matching_origin_missing" },
  });
}

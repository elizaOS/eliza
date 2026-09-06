/** Projects authorized database and merchant records into the buyer SDK's lossless pagination contract. */
import type {
  AppBillingInvoice,
  AppBillingSeat,
  AppBillingUsage,
} from "@elizaos/cloud-sdk/app-billing";
import { z } from "zod";
import type { AppBillingReadIdentity } from "../../db/repositories/app-billing-queries";
import {
  type AppBillingRecordsRepository,
  appBillingRecordsRepository,
} from "../../db/repositories/app-billing-records";
import { appBillingConflict } from "../../db/repositories/app-subscription-authority";
import { getAppBillingProvider } from "./generic-billing-provider-runtime";

const pageSize = 100;
const cursorSchema = z
  .object({
    version: z.literal(1),
    appId: z.string().uuid(),
    accountId: z.string().uuid(),
    family: z.string(),
    livemode: z.boolean(),
    position: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("seats"), id: z.string().uuid() }).strict(),
      z
        .object({
          kind: z.literal("usage"),
          reservationId: z.string().uuid(),
          source: z.enum(["trial_claim", "paid_invoice"]),
        })
        .strict(),
      z
        .object({
          kind: z.literal("invoices"),
          subscriptionId: z.string().uuid(),
          invoiceId: z
            .string()
            .regex(/^in_[A-Za-z0-9]+$/u)
            .nullable(),
        })
        .strict(),
    ]),
  })
  .strict();
type Position = z.infer<typeof cursorSchema>["position"];

function readCursor(identity: AppBillingReadIdentity, kind: Position["kind"], value?: string) {
  if (value === undefined) return null;
  z.string().max(2048).parse(value);
  let parsed: z.infer<typeof cursorSchema>;
  try {
    parsed = cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    // error-policy:J3 reject malformed pagination data instead of selecting the first page.
    appBillingConflict("Billing records cursor is invalid");
  }
  if (
    parsed.appId !== identity.appId ||
    parsed.accountId !== identity.billingAccountId ||
    parsed.family !== identity.productFamilyKey ||
    parsed.livemode !== identity.livemode ||
    parsed.position.kind !== kind
  )
    appBillingConflict(
      "Billing records cursor belongs to a different app subscription or record type",
    );
  return parsed.position;
}

function cursor(identity: AppBillingReadIdentity, position: Position) {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      appId: identity.appId,
      accountId: identity.billingAccountId,
      family: identity.productFamilyKey,
      livemode: identity.livemode,
      position,
    }),
  ).toString("base64url");
}

export class GenericBillingRecordsService {
  constructor(
    private readonly repository: AppBillingRecordsRepository = appBillingRecordsRepository,
    private readonly provider: typeof getAppBillingProvider = getAppBillingProvider,
  ) {}

  async seats(
    identity: AppBillingReadIdentity,
    value?: string,
  ): Promise<{ items: AppBillingSeat[]; nextCursor: string | null }> {
    const after = readCursor(identity, "seats", value);
    if (after !== null && after.kind !== "seats") appBillingConflict("Seat cursor is invalid");
    const rows = await this.repository.seats(identity, after?.id ?? null, pageSize);
    const page = rows.slice(0, pageSize);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        subject: row.subject,
        assignedAt: row.assigned_at.toISOString(),
      })),
      nextCursor:
        rows.length > pageSize && last ? cursor(identity, { kind: "seats", id: last.id }) : null,
    };
  }

  async assignSeat(
    identity: AppBillingReadIdentity,
    input: { subject: string; idempotencyKey: string },
  ) {
    z.string().uuid().parse(input.subject);
    const result = await this.repository.seatMutation(identity, { kind: "assign", ...input });
    if (result.kind !== "assign") appBillingConflict("Seat assignment journal is inconsistent");
    return result.seat;
  }

  async revokeSeat(
    identity: AppBillingReadIdentity,
    input: { seatId: string; idempotencyKey: string },
  ) {
    const result = await this.repository.seatMutation(identity, { kind: "revoke", ...input });
    if (result.kind !== "revoke") appBillingConflict("Seat revocation journal is inconsistent");
    return { revoked: result.revoked };
  }

  async invoices(
    identity: AppBillingReadIdentity,
    value?: string,
  ): Promise<{ items: AppBillingInvoice[]; nextCursor: string | null }> {
    const after = readCursor(identity, "invoices", value);
    if (after !== null && after.kind !== "invoices")
      appBillingConflict("Invoice cursor is invalid");
    const { scope, subscriptions } = await this.repository.invoiceContext(identity);
    if (!scope || subscriptions.length === 0) {
      if (after) appBillingConflict("Invoice cursor has no current billing scope");
      return { items: [], nextCursor: null };
    }
    if (scope.stripeCustomerId === null)
      appBillingConflict("Subscription customer binding is unavailable");
    const index = after ? subscriptions.findIndex((row) => row.id === after.subscriptionId) : 0;
    const subscription = subscriptions[index];
    if (!subscription)
      appBillingConflict("Invoice cursor subscription is outside this billing scope");
    const provider = await this.provider(scope.merchantId, scope.livemode);
    const page = await provider.listInvoices(scope, {
      customerId: scope.stripeCustomerId,
      subscriptionId: subscription.providerId,
      startingAfter: after?.invoiceId ?? null,
    });
    const fresh = await this.repository.invoiceContext(identity);
    if (
      fresh.scope?.scopeId !== scope.scopeId ||
      fresh.scope.stripeCustomerId !== scope.stripeCustomerId ||
      fresh.scope.merchantId !== scope.merchantId ||
      fresh.scope.livemode !== scope.livemode
    )
      appBillingConflict("Billing ownership changed during invoice retrieval; reload records");
    const nextSubscription = subscriptions[index + 1];
    const nextCursor = page.value.nextCursor
      ? cursor(identity, {
          kind: "invoices",
          subscriptionId: subscription.id,
          invoiceId: page.value.nextCursor,
        })
      : nextSubscription
        ? cursor(identity, {
            kind: "invoices",
            subscriptionId: nextSubscription.id,
            invoiceId: null,
          })
        : null;
    return { items: page.value.items, nextCursor };
  }

  async usage(
    identity: AppBillingReadIdentity,
    value?: string,
  ): Promise<{ items: AppBillingUsage[]; nextCursor: string | null }> {
    const after = readCursor(identity, "usage", value);
    if (after !== null && after.kind !== "usage") appBillingConflict("Usage cursor is invalid");
    const rows = await this.repository.usage(identity, after, pageSize);
    const page = rows.slice(0, pageSize);
    const items = page.map((row): AppBillingUsage => {
      if (row.occurredAt === null) appBillingConflict("Finalized app usage has no settlement time");
      return {
        operationId: row.operationId,
        fundingSource: row.source === "trial_claim" ? "trial" : "paid_invoice",
        amountUsd: row.amountUsd,
        occurredAt: row.occurredAt.toISOString(),
      };
    });
    const last = page.at(-1);
    return {
      items,
      nextCursor:
        rows.length > pageSize && last
          ? cursor(identity, {
              kind: "usage",
              reservationId: last.reservationId,
              source: last.source,
            })
          : null,
    };
  }
}

export const genericBillingRecordsService = new GenericBillingRecordsService();

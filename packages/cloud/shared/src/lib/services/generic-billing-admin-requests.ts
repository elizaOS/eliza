/** Validates complete app-owner billing requests before durable commands or provider operations. */
import { z } from "zod";

const uuid = z.string().uuid();
const idempotencyKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
const key = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/);
const integer = z.number().int().positive().max(2147483647);
const usd = z.string().regex(/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,6})?$/);
const intent = { clientRegistrationId: uuid, idempotencyKey };
export const registerAppBillingMerchantSchema = z.discriminatedUnion("mode", [
  z
    .object({
      ...intent,
      mode: z.literal("create_connected"),
      country: z.string().regex(/^[A-Z]{2}$/),
    })
    .strict(),
  z.object({ ...intent, mode: z.literal("adopt_creator"), creatorConnectionId: uuid }).strict(),
  z.object({ ...intent, mode: z.literal("platform") }).strict(),
]);
export const appBillingMerchantRequestSchema = z.object({ ...intent, merchantId: uuid }).strict();
export const disconnectAppBillingMerchantSchema = appBillingMerchantRequestSchema
  .extend({
    expectedRevision: z.string().regex(/^[1-9][0-9]*$/),
    confirmation: z.literal("disable_new_sales_for_merchant"),
  })
  .strict();
const planShape = {
  ...intent,
  merchantId: uuid,
  productFamilyKey: key,
  planKey: key,
  name: z.string().trim().min(1).max(200),
  amountCents: integer,
  currency: z.literal("usd"),
  interval: z.enum(["day", "week", "month", "year"]),
  intervalCount: integer,
  seats: z
    .object({ minimum: integer, maximum: integer })
    .strict()
    .refine((value) => value.maximum >= value.minimum, "Maximum seats must include minimum seats"),
  trial: z.object({ days: z.literal(7), allowanceUsd: usd }).strict(),
  allowanceUsd: usd,
  featureKeys: z
    .array(key)
    .refine((value) => new Set(value).size === value.length, "Feature keys must be unique"),
  expiredAccess: z.enum(["read_only", "denied"]),
  rateLimits: z
    .object({
      completionsRpm: integer,
      embeddingsRpm: integer,
      standardRpm: integer,
      strictRpm: integer,
    })
    .strict(),
};
export const createAppBillingPlanSchema = z.object(planShape).strict();
export const adoptAppBillingPlanSchema = z
  .object({
    ...planShape,
    priceReference: z.string().regex(/^price_[A-Za-z0-9]+$/),
    productReference: z.string().regex(/^prod_[A-Za-z0-9]+$/),
  })
  .strict();
export const appBillingPlanRevisionRequestSchema = z
  .object({ ...intent, planRevisionId: uuid })
  .strict();

export const appBillingRefundRequestSchema = z
  .object({
    ...intent,
    paidPeriodId: uuid,
    amountCents: integer,
    accessPolicy: z.literal("preserve"),
    confirmation: z.literal("refund_original_payment_preserve_access"),
  })
  .strict();

/** Validates purchaser billing intents before they reach durable commands or any provider mutation. */

import { z } from "zod";

const idempotencyKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u);
const expectedSubscriptionRevision = z
  .string()
  .regex(/^[1-9]\d*$/u)
  .refine(
    (value) => Number.isSafeInteger(Number(value)),
    "Subscription revision exceeds the supported authority range",
  )
  .transform(Number)
  .nullable();
const quantity = z.number().int().positive().safe().max(2_147_483_647);
const resourceKey = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u);

export const appBillingScopeInput = z
  .object({
    appId: z.string().uuid(),
    billingAccountId: z.string().uuid(),
    productFamilyKey: resourceKey,
  })
  .strict();

export const resolveAppBillingAccountInput = z
  .object({
    externalReference: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => value.trim() === value)
      .nullable(),
    displayName: z.string().trim().min(1).max(200),
  })
  .strict();

export const appBillingCommandInput = z
  .object({ idempotencyKey, expectedSubscriptionRevision })
  .strict();

export const startAppBillingTrialInput = appBillingCommandInput
  .extend({
    planRevisionId: z.string().uuid(),
    quantity,
  })
  .strict();

export const createAppBillingCheckoutInput = startAppBillingTrialInput
  .extend({
    billingConsent: z.literal("accepted"),
  })
  .strict();

export const expireAppBillingCheckoutInput = appBillingCommandInput
  .extend({
    operationId: z.string().uuid(),
  })
  .strict();

export const quoteAppBillingUpdateInput = appBillingCommandInput
  .extend({
    planRevisionId: z.string().uuid(),
    quantity,
  })
  .strict();

export const updateAppBillingSubscriptionInput = createAppBillingCheckoutInput
  .extend({
    quoteId: z.string().uuid(),
  })
  .strict();

export const cancelAppBillingSubscriptionInput = appBillingCommandInput
  .extend({
    timing: z.enum(["period_end", "immediate"]),
  })
  .strict();

export const assignAppBillingSeatInput = z
  .object({
    subject: z.string().min(1).max(200),
    idempotencyKey,
  })
  .strict();

export const revokeAppBillingSeatInput = z.object({ idempotencyKey }).strict();

export type AppBillingScopeInput = z.infer<typeof appBillingScopeInput>;
export type ResolveAppBillingAccountInput = z.infer<typeof resolveAppBillingAccountInput>;
export type StartAppBillingTrialInput = z.infer<typeof startAppBillingTrialInput>;
export type CreateAppBillingCheckoutInput = z.infer<typeof createAppBillingCheckoutInput>;
export type ExpireAppBillingCheckoutInput = z.infer<typeof expireAppBillingCheckoutInput>;
export type QuoteAppBillingUpdateInput = z.infer<typeof quoteAppBillingUpdateInput>;
export type UpdateAppBillingSubscriptionInput = z.infer<typeof updateAppBillingSubscriptionInput>;
export type CancelAppBillingSubscriptionInput = z.infer<typeof cancelAppBillingSubscriptionInput>;
export type AssignAppBillingSeatInput = z.infer<typeof assignAppBillingSeatInput>;

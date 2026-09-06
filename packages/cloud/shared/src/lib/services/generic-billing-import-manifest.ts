/** Validates operator-owned billing migration manifests; these documents are never accepted by purchaser HTTP routes. */
import { z } from "zod";

const uuid = z.string().uuid();
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const utc = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const trial = z
  .object({ startsAt: utc, endsAt: utc, planRevisionId: uuid })
  .strict()
  .refine(
    (value) => Date.parse(value.endsAt) - Date.parse(value.startsAt) === 604_800_000,
    "Imported trial must retain its original seven-day interval",
  );
const base = {
  version: z.literal(1),
  sourceSystem: z.string().min(1).max(100),
  sourceRecordId: z.string().min(1).max(200),
  sourceDigest: digest,
};
export const appBillingSlotManifestSchema = z
  .object({
    ...base,
    kind: z.literal("application_slot"),
    slotKey: z.string().regex(/^[a-z][a-z0-9_-]{0,99}$/u),
    appId: uuid,
    developerOrganizationId: uuid,
    merchantId: uuid,
    livemode: z.boolean(),
    productFamilyKey: z.string().min(1).max(100),
  })
  .strict();
export const appBillingImportManifestSchema = z
  .object({
    ...base,
    kind: z.literal("subscription_import"),
    scopeId: uuid,
    planRevisionId: uuid,
    principalUserId: uuid,
    quantity: z.number().int().positive().safe(),
    trial: trial.nullable(),
    provider: z
      .object({
        customerId: z.string().regex(/^cus_[A-Za-z0-9]+$/u),
        subscriptionId: z.string().regex(/^sub_[A-Za-z0-9]+$/u),
        invoiceId: z
          .string()
          .regex(/^in_[A-Za-z0-9]+$/u)
          .nullable(),
      })
      .strict()
      .nullable(),
    allowance: z
      .object({ availableUsd: z.string().regex(/^(?:0|[1-9]\d{0,9})\.\d{6}$/u) })
      .strict()
      .nullable(),
  })
  .strict()
  .refine(
    (value) => value.trial !== null || value.provider !== null,
    "Import requires trial or provider history",
  );
export const appBillingOperatorManifestSchema = z.discriminatedUnion("kind", [
  appBillingSlotManifestSchema,
  appBillingImportManifestSchema,
]);
export type AppBillingSlotManifest = z.infer<typeof appBillingSlotManifestSchema>;
export type AppBillingImportManifest = z.infer<typeof appBillingImportManifestSchema>;

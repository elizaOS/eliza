/** Validates immutable checkout dispatch authority without retaining credentials or payment details. */
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import { isProductionDeployment } from "../config/deployment-environment";

const identity = z
  .object({
    app: z.literal("eliza-cloud"),
    organization_id: z.string().uuid(),
    command_id: z.string().uuid(),
  })
  .strict();
export const checkoutContractSchema = z
  .object({
    version: z.literal(1),
    catalogVersion: z.literal("v1"),
    planKey: z.enum(["plus_monthly", "pro_monthly"]),
    accountId: z.string().regex(/^acct_[A-Za-z0-9]+$/),
    expectedLivemode: z.boolean(),
    priceId: z.string().regex(/^price_[A-Za-z0-9]+$/),
    productId: z.string().regex(/^prod_[A-Za-z0-9]+$/),
    params: z
      .object({
        mode: z.literal("subscription"),
        customer: z.string().regex(/^cus_[A-Za-z0-9]+$/),
        client_reference_id: z.string().uuid(),
        line_items: z.tuple([z.object({ price: z.string(), quantity: z.literal(1) }).strict()]),
        payment_method_types: z.tuple([z.literal("card")]),
        allow_promotion_codes: z.literal(false),
        automatic_tax: z.object({ enabled: z.literal(false) }).strict(),
        metadata: identity,
        subscription_data: z.object({ metadata: identity }).strict(),
        success_url: z.string().url(),
        cancel_url: z.string().url(),
        expires_at: z.number().int().positive().safe(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const p = value.params;
    if (!URL.canParse(p.cancel_url) || !URL.canParse(p.success_url)) {
      ctx.addIssue({ code: "custom", message: "Checkout return URL is invalid" });
      return;
    }
    const cancel = new URL(p.cancel_url),
      success = new URL(p.success_url);
    if (
      p.line_items[0].price !== value.priceId ||
      p.client_reference_id !== p.metadata.command_id ||
      JSON.stringify(p.metadata) !== JSON.stringify(p.subscription_data.metadata) ||
      cancel.protocol !== "https:" ||
      cancel.username ||
      cancel.password ||
      success.origin !== cancel.origin ||
      p.cancel_url !== `${cancel.origin}/cloud/billing` ||
      p.success_url !==
        `${cancel.origin}/cloud/billing?subscription_session_id={CHECKOUT_SESSION_ID}`
    )
      ctx.addIssue({ code: "custom", message: "Checkout contract identities differ" });
  });
export type CheckoutContract = z.infer<typeof checkoutContractSchema>;
export function requireCheckoutContract(raw: unknown): CheckoutContract {
  const result = checkoutContractSchema.safeParse(raw);
  if (!result.success)
    throw new ElizaError("Original checkout authority is unavailable", {
      code: "SUBSCRIPTION_CHECKOUT_UNAVAILABLE",
      context: { reason: "original_contract_unavailable" },
    });
  return result.data;
}
export function checkoutContractDigest(value: CheckoutContract): string {
  return createHash("sha256")
    .update(JSON.stringify(checkoutContractSchema.parse(value)))
    .digest("hex");
}
/** Overrides only the purchased binding, retaining current deployment and credential validation. */
export function checkoutContractEnvironment(
  contract: CheckoutContract,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...env,
    ...(contract.planKey === "plus_monthly"
      ? {
          STRIPE_PLUS_MONTHLY_PRICE_ID: contract.priceId,
          STRIPE_PLUS_PRODUCT_ID: contract.productId,
        }
      : {
          STRIPE_PRO_MONTHLY_PRICE_ID: contract.priceId,
          STRIPE_PRO_PRODUCT_ID: contract.productId,
        }),
  };
}

export function readCheckoutContract(command: {
  id: string;
  organization_id: string;
  target_plan_key: string | null;
  checkout_contract: unknown;
}): CheckoutContract {
  const stored = z
    .object({ payload: checkoutContractSchema, digest: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict()
    .safeParse(command.checkout_contract);
  if (!stored.success) return requireCheckoutContract(null);
  const { payload, digest } = stored.data;
  if (
    checkoutContractDigest(payload) !== digest ||
    payload.params.client_reference_id !== command.id ||
    payload.params.metadata.organization_id !== command.organization_id ||
    payload.planKey !== command.target_plan_key
  )
    return requireCheckoutContract(null);
  return payload;
}
export function assertCheckoutProviderAuthority(
  contract: CheckoutContract,
  accountId: string,
  environment: NodeJS.ProcessEnv,
): void {
  if (accountId !== contract.accountId)
    throw new ElizaError("Checkout provider authority changed", {
      code: "SUBSCRIPTION_CHECKOUT_UNAVAILABLE",
      context: { reason: "provider_authority_changed" },
    });
  assertCheckoutProviderMode(contract.expectedLivemode, environment);
}

export function assertCheckoutProviderMode(
  expectedLivemode: boolean,
  environment: NodeJS.ProcessEnv,
): void {
  const mode = environment.STRIPE_SECRET_KEY?.trim().match(/^(?:sk|rk)_(test|live)_/);
  if (
    isProductionDeployment(environment) !== expectedLivemode ||
    !mode ||
    (mode[1] === "live") !== expectedLivemode
  )
    throw new ElizaError("Checkout provider authority changed", {
      code: "SUBSCRIPTION_CHECKOUT_UNAVAILABLE",
      context: { reason: "provider_authority_changed" },
    });
}

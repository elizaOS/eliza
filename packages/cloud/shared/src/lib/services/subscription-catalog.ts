/**
 * Owns the immutable recurring subscription catalog and validates its exact
 * server-only Stripe bindings before any public plan projection is published.
 * The provider lookup is read-only and every mismatch fails closed.
 */

import { ElizaError } from "@elizaos/core";
import type Stripe from "stripe";
import { z } from "zod";
import { isProductionDeployment } from "../config/deployment-environment";
import type {
  SubscriptionPlanDto,
  SubscriptionPlanKey,
  SubscriptionPlansDto,
} from "../types/cloud-api";
import { logger } from "../utils/logger";

const CATALOG_VERSION = "v1" as const;
const VERIFIED_CACHE_TTL_MS = 5 * 60 * 1_000;

const planDefinitionSchema = z
  .object({
    key: z.enum(["plus_monthly", "pro_monthly"]),
    name: z.enum(["Plus", "Pro"]),
    catalogVersion: z.literal(CATALOG_VERSION),
    active: z.literal(true),
    interval: z.literal("month"),
    intervalCount: z.literal(1),
    currency: z.literal("usd"),
    amountCents: z.number().int().positive().safe(),
    allowance: z
      .object({
        amountUsd: z.string().regex(/^(?:0|[1-9]\d*)\.\d{6}$/),
        fundingClass: z.literal("allowance_eligible"),
        rollover: z.literal(false),
        expiresAt: z.literal("billing_period_end"),
      })
      .strict(),
    fundingClasses: z.tuple([z.literal("allowance_eligible"), z.literal("cash_only")]),
    rateLimits: z
      .object({
        completionsRpm: z.number().int().positive().safe(),
        embeddingsRpm: z.number().int().positive().safe(),
        standardRpm: z.number().int().positive().safe(),
        strictRpm: z.number().int().positive().safe(),
      })
      .strict(),
    // Candidate ceilings are recommendations, not ratified enforcement policy.
    resourceCeilings: z.null(),
  })
  .strict();

type PlanDefinition = z.infer<typeof planDefinitionSchema>;

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function buildCatalog(definitions: readonly unknown[]): readonly Readonly<PlanDefinition>[] {
  const parsed = definitions.map((definition) => planDefinitionSchema.parse(definition));
  const keys = new Set<SubscriptionPlanKey>();
  for (const plan of parsed) {
    if (keys.has(plan.key)) {
      throw new SubscriptionCatalogError(
        "SUBSCRIPTION_CATALOG_DUPLICATE_KEY",
        "Subscription catalog contains a duplicate plan key",
        { planKey: plan.key },
      );
    }
    keys.add(plan.key);
  }
  if (parsed.length !== 2 || !keys.has("plus_monthly") || !keys.has("pro_monthly")) {
    throw new SubscriptionCatalogError(
      "SUBSCRIPTION_CATALOG_PLAN_SET_INVALID",
      "Subscription catalog must contain exactly the two approved v1 plans",
    );
  }
  return deepFreeze(parsed);
}

const SUBSCRIPTION_CATALOG = buildCatalog([
  {
    key: "plus_monthly",
    name: "Plus",
    catalogVersion: CATALOG_VERSION,
    active: true,
    interval: "month",
    intervalCount: 1,
    currency: "usd",
    amountCents: 3_000,
    allowance: {
      amountUsd: "25.000000",
      fundingClass: "allowance_eligible",
      rollover: false,
      expiresAt: "billing_period_end",
    },
    fundingClasses: ["allowance_eligible", "cash_only"],
    rateLimits: {
      completionsRpm: 120,
      embeddingsRpm: 200,
      standardRpm: 60,
      strictRpm: 10,
    },
    resourceCeilings: null,
  },
  {
    key: "pro_monthly",
    name: "Pro",
    catalogVersion: CATALOG_VERSION,
    active: true,
    interval: "month",
    intervalCount: 1,
    currency: "usd",
    amountCents: 10_000,
    allowance: {
      amountUsd: "90.000000",
      fundingClass: "allowance_eligible",
      rollover: false,
      expiresAt: "billing_period_end",
    },
    fundingClasses: ["allowance_eligible", "cash_only"],
    rateLimits: {
      completionsRpm: 300,
      embeddingsRpm: 600,
      standardRpm: 120,
      strictRpm: 30,
    },
    resourceCeilings: null,
  },
]);

const providerIdSchemas = {
  price: z
    .string()
    .trim()
    .regex(/^price_[A-Za-z0-9]+$/),
  product: z
    .string()
    .trim()
    .regex(/^prod_[A-Za-z0-9]+$/),
} as const;
const stripeSecretSchema = z
  .string()
  .trim()
  .regex(/^(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+$/);

interface PlanBinding {
  priceId: string;
  productId: string;
}

interface SubscriptionCatalogBindings {
  expectedLivemode: boolean;
  credential: string;
  plans: Readonly<Record<SubscriptionPlanKey, Readonly<PlanBinding>>>;
}

export interface SubscriptionCatalogProviderPrice {
  active: boolean;
  currency: string;
  unitAmount: number | null;
  type: string;
  billingScheme: string;
  transformQuantity: {
    divideBy: number;
    round: string;
  } | null;
  recurring: {
    interval: string;
    intervalCount: number;
    trialPeriodDays: number | null;
    usageType: string;
  } | null;
  productId: string | null;
  livemode: boolean;
}

export interface SubscriptionCatalogProviderProduct {
  active: boolean;
  deleted: boolean;
  livemode: boolean | null;
}

export interface SubscriptionCatalogProvider {
  retrievePrice(priceId: string): Promise<SubscriptionCatalogProviderPrice>;
  retrieveProduct(productId: string): Promise<SubscriptionCatalogProviderProduct>;
}

const providerPriceSchema = z
  .object({
    active: z.boolean(),
    currency: z.string().min(1),
    unitAmount: z.number().int().safe().nullable(),
    type: z.string().min(1),
    billingScheme: z.string().min(1),
    transformQuantity: z
      .object({
        divideBy: z.number().int().positive().safe(),
        round: z.string().min(1),
      })
      .strict()
      .nullable(),
    recurring: z
      .object({
        interval: z.string().min(1),
        intervalCount: z.number().int().positive().safe(),
        trialPeriodDays: z.number().int().nonnegative().safe().nullable(),
        usageType: z.string().min(1),
      })
      .strict()
      .nullable(),
    productId: z.string().min(1).nullable(),
    livemode: z.boolean(),
  })
  .strict();

const providerProductSchema = z
  .object({
    active: z.boolean(),
    deleted: z.boolean(),
    livemode: z.boolean().nullable(),
  })
  .strict();

export class SubscriptionCatalogError extends ElizaError {
  override readonly name = "SubscriptionCatalogError";

  constructor(
    code: string,
    message: string,
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message, { code, context, severity: "fatal", cause });
  }
}

function requiredProviderId(
  env: NodeJS.ProcessEnv,
  name: string,
  kind: keyof typeof providerIdSchemas,
): string {
  const result = providerIdSchemas[kind].safeParse(env[name]);
  if (!result.success) {
    throw new SubscriptionCatalogError(
      "SUBSCRIPTION_CATALOG_BINDING_INVALID",
      "Subscription catalog provider binding is missing or malformed",
      { field: name },
    );
  }
  return result.data;
}

function parseBindings(env: NodeJS.ProcessEnv): SubscriptionCatalogBindings {
  const secret = stripeSecretSchema.safeParse(env.STRIPE_SECRET_KEY);
  if (!secret.success) {
    throw new SubscriptionCatalogError(
      "SUBSCRIPTION_CATALOG_STRIPE_KEY_INVALID",
      "Subscription catalog Stripe key is missing or malformed",
      { field: "STRIPE_SECRET_KEY" },
    );
  }

  const expectedLivemode = isProductionDeployment(env);
  const keyIsLive = /^(?:sk|rk)_live_/.test(secret.data);
  if (keyIsLive !== expectedLivemode) {
    throw new SubscriptionCatalogError(
      "SUBSCRIPTION_CATALOG_DEPLOYMENT_MODE_MISMATCH",
      "Subscription catalog Stripe mode does not match the deployment",
      { expectedLivemode },
    );
  }

  const plans = {
    plus_monthly: {
      priceId: requiredProviderId(env, "STRIPE_PLUS_MONTHLY_PRICE_ID", "price"),
      productId: requiredProviderId(env, "STRIPE_PLUS_PRODUCT_ID", "product"),
    },
    pro_monthly: {
      priceId: requiredProviderId(env, "STRIPE_PRO_MONTHLY_PRICE_ID", "price"),
      productId: requiredProviderId(env, "STRIPE_PRO_PRODUCT_ID", "product"),
    },
  } as const;

  if (plans.plus_monthly.priceId === plans.pro_monthly.priceId) {
    throw new SubscriptionCatalogError(
      "SUBSCRIPTION_CATALOG_DUPLICATE_PRICE_BINDING",
      "Subscription plans cannot share a provider price binding",
    );
  }
  if (plans.plus_monthly.productId === plans.pro_monthly.productId) {
    throw new SubscriptionCatalogError(
      "SUBSCRIPTION_CATALOG_DUPLICATE_PRODUCT_BINDING",
      "Subscription plans cannot share an approved provider product",
    );
  }
  return deepFreeze({ expectedLivemode, credential: secret.data, plans });
}

function mismatch(planKey: SubscriptionPlanKey, field: string): never {
  throw new SubscriptionCatalogError(
    "SUBSCRIPTION_CATALOG_PROVIDER_DRIFT",
    "Subscription catalog provider object does not match the approved catalog",
    { planKey, field },
  );
}

async function verifyPlan(
  plan: Readonly<PlanDefinition>,
  binding: Readonly<PlanBinding>,
  expectedLivemode: boolean,
  provider: SubscriptionCatalogProvider,
): Promise<void> {
  const [rawPrice, rawProduct] = await Promise.all([
    provider.retrievePrice(binding.priceId),
    provider.retrieveProduct(binding.productId),
  ]);
  const priceResult = providerPriceSchema.safeParse(rawPrice);
  if (!priceResult.success) mismatch(plan.key, "price.shape");
  const productResult = providerProductSchema.safeParse(rawProduct);
  if (!productResult.success) mismatch(plan.key, "product.shape");
  const price = priceResult.data;
  const product = productResult.data;

  if (!price.active) mismatch(plan.key, "price.active");
  if (price.currency !== plan.currency) mismatch(plan.key, "price.currency");
  if (price.unitAmount !== plan.amountCents) mismatch(plan.key, "price.unit_amount");
  if (price.type !== "recurring") mismatch(plan.key, "price.type");
  if (price.billingScheme !== "per_unit") mismatch(plan.key, "price.billing_scheme");
  if (price.transformQuantity !== null) mismatch(plan.key, "price.transform_quantity");
  if (!price.recurring) mismatch(plan.key, "price.recurring");
  if (price.recurring.interval !== plan.interval) mismatch(plan.key, "price.recurring.interval");
  if (price.recurring.intervalCount !== plan.intervalCount) {
    mismatch(plan.key, "price.recurring.interval_count");
  }
  if (price.recurring.trialPeriodDays !== null) {
    mismatch(plan.key, "price.recurring.trial_period_days");
  }
  if (price.recurring.usageType !== "licensed") {
    mismatch(plan.key, "price.recurring.usage_type");
  }
  if (price.productId !== binding.productId) mismatch(plan.key, "price.product");
  if (price.livemode !== expectedLivemode) mismatch(plan.key, "price.livemode");
  if (product.deleted || !product.active) mismatch(plan.key, "product.active");
  if (product.livemode !== expectedLivemode) mismatch(plan.key, "product.livemode");
}

function publicPlans(): SubscriptionPlansDto {
  return deepFreeze({
    catalogVersion: CATALOG_VERSION,
    plans: SUBSCRIPTION_CATALOG.map((plan) => ({
      key: plan.key,
      name: plan.name,
      catalogVersion: plan.catalogVersion,
      active: plan.active,
      interval: plan.interval,
      intervalCount: plan.intervalCount,
      currency: plan.currency,
      amountCents: plan.amountCents,
      allowance: { ...plan.allowance },
      fundingClasses: [...plan.fundingClasses],
      rateLimits: { ...plan.rateLimits },
      resourceCeilings: plan.resourceCeilings,
    })) as SubscriptionPlanDto[],
  });
}

function bindingCacheKey(bindings: SubscriptionCatalogBindings): string {
  return [
    CATALOG_VERSION,
    bindings.expectedLivemode ? "live" : "test",
    // The Stripe client is also keyed by the complete credential. Keeping the
    // same identity here prevents a valid test/live key rotation from reusing
    // a provider verification performed under the previous Stripe account.
    // This process-local key is never logged, serialized, or returned.
    bindings.credential,
    bindings.plans.plus_monthly.priceId,
    bindings.plans.plus_monthly.productId,
    bindings.plans.pro_monthly.priceId,
    bindings.plans.pro_monthly.productId,
  ].join("\0");
}

interface VerificationCacheEntry {
  expiresAt: number;
  pending: Promise<SubscriptionPlansDto>;
}

const verificationCache = new Map<string, VerificationCacheEntry>();

/** Synchronous startup/deploy validation of all required server bindings. */
export function validateSubscriptionCatalogConfiguration(env: NodeJS.ProcessEnv): void {
  parseBindings(env);
}

/**
 * Read and validate both approved provider objects, then return only the public
 * catalog projection. Successful checks are briefly coalesced per isolate;
 * failures are never cached and stale success is never served after expiry.
 */
export async function getVerifiedSubscriptionPlans(options: {
  env: NodeJS.ProcessEnv;
  provider: SubscriptionCatalogProvider;
  now?: () => number;
}): Promise<SubscriptionPlansDto> {
  const bindings = parseBindings(options.env);
  const now = options.now ?? Date.now;
  const cacheKey = bindingCacheKey(bindings);
  const existing = verificationCache.get(cacheKey);
  if (existing && existing.expiresAt > now()) return await existing.pending;
  if (existing) verificationCache.delete(cacheKey);

  const pending = Promise.all(
    SUBSCRIPTION_CATALOG.map((plan) =>
      verifyPlan(plan, bindings.plans[plan.key], bindings.expectedLivemode, options.provider),
    ),
  )
    .then(() => publicPlans())
    .catch((error) => {
      // error-policy:J2 Provider transport failures become one typed catalog
      // failure while preserving the SDK error as the native cause.
      verificationCache.delete(cacheKey);
      const catalogError =
        error instanceof SubscriptionCatalogError
          ? error
          : new SubscriptionCatalogError(
              "SUBSCRIPTION_CATALOG_PROVIDER_UNAVAILABLE",
              "Subscription catalog provider lookup failed",
              {},
              error,
            );
      logger.error("[SubscriptionCatalog] Catalog publication rejected", {
        code: catalogError.code,
        context: catalogError.context,
      });
      throw catalogError;
    });

  verificationCache.set(cacheKey, {
    expiresAt: now() + VERIFIED_CACHE_TTL_MS,
    pending,
  });
  return await pending;
}

function providerProductId(
  product: string | Stripe.Product | Stripe.DeletedProduct,
): string | null {
  if (typeof product === "string") return product;
  return typeof product.id === "string" ? product.id : null;
}

/** Restricts the Stripe SDK to the read-only catalog preflight surface. */
export function adaptStripeSubscriptionCatalogProvider(
  stripe: Pick<Stripe, "prices" | "products">,
): SubscriptionCatalogProvider {
  return {
    async retrievePrice(priceId) {
      const price = await stripe.prices.retrieve(priceId);
      return {
        active: price.active,
        currency: price.currency,
        unitAmount: price.unit_amount,
        type: price.type,
        billingScheme: price.billing_scheme,
        transformQuantity: price.transform_quantity
          ? {
              divideBy: price.transform_quantity.divide_by,
              round: price.transform_quantity.round,
            }
          : null,
        recurring: price.recurring
          ? {
              interval: price.recurring.interval,
              intervalCount: price.recurring.interval_count,
              trialPeriodDays: price.recurring.trial_period_days,
              usageType: price.recurring.usage_type,
            }
          : null,
        productId: providerProductId(price.product),
        livemode: price.livemode,
      };
    },
    async retrieveProduct(productId) {
      const product = await stripe.products.retrieve(productId);
      return product.deleted
        ? { active: false, deleted: true, livemode: null }
        : { active: product.active, deleted: false, livemode: product.livemode };
    },
  };
}

/** Test hook for duplicate-key and immutability assertions. */
export function __buildSubscriptionCatalogForTests(
  definitions: readonly unknown[],
): readonly Readonly<PlanDefinition>[] {
  return buildCatalog(definitions);
}

/** Test hook for exact catalog snapshots without provider identifiers. */
export function __publicSubscriptionPlansForTests(): SubscriptionPlansDto {
  return publicPlans();
}

/** Test hook: isolate the per-Worker verification cache. */
export function __resetSubscriptionCatalogCacheForTests(): void {
  verificationCache.clear();
}

/**
 * Creates and adopts organization-owned Connect merchant accounts under durable intents.
 * OAuth tokens never leave this adapter. Account ownership remains a stored binding; metadata
 * confirms that binding when reconciling provider objects and cannot authorize an app on its own.
 */
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import type Stripe from "stripe";
import { z } from "zod";
import {
  type DurableProviderIntent,
  GENERIC_BILLING_STRIPE_API_VERSION,
} from "./generic-billing-provider-types";

export interface BillingMerchantOwner {
  merchantId: string;
  ownerOrganizationId: string;
}
export interface BillingMerchantConnection {
  accountId: string;
  accountType: "standard" | "express" | "custom" | "none";
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  cardPaymentsActive: boolean;
  disabledReason: string | null;
  requirementsDue: string[];
}
const accountSchema = z.object({
  id: z.string().regex(/^acct_[A-Za-z0-9]+$/),
  type: z.enum(["standard", "express", "custom", "none"]),
  metadata: z.record(z.string(), z.string()),
  charges_enabled: z.boolean(),
  payouts_enabled: z.boolean(),
  details_submitted: z.boolean(),
  capabilities: z.object({ card_payments: z.string().optional() }),
  requirements: z.object({
    disabled_reason: z.string().nullable(),
    currently_due: z.array(z.string()),
  }),
});
function fail(message: string): never {
  throw new ElizaError(message, { code: "BILLING_MERCHANT_AUTHORITY" });
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail("Stripe merchant response failed validation");
  return parsed.data;
}
function intentOptions(intent: DurableProviderIntent): Stripe.RequestOptions {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/.test(intent.idempotencyKey) ||
    !/^[a-f0-9]{64}$/.test(intent.requestDigest) ||
    !intent.commandId
  )
    fail("Merchant provider intent is invalid");
  return { apiVersion: GENERIC_BILLING_STRIPE_API_VERSION, idempotencyKey: intent.idempotencyKey };
}

/** The caller chooses a platform credential with the persisted expected test/live mode. */
export function createGenericBillingMerchantProvider(stripe: Stripe, expectedLivemode: boolean) {
  let credentialMode: Promise<void> | undefined;
  const ensureCredentialMode = () =>
    (credentialMode ??= (async () => {
      const balance = parse(
        z.object({ livemode: z.boolean() }),
        await stripe.balance.retrieve({}, { apiVersion: GENERIC_BILLING_STRIPE_API_VERSION }),
      );
      if (balance.livemode !== expectedLivemode)
        fail("Stripe platform credential belongs to a different environment");
    })());
  const metadata = (owner: BillingMerchantOwner) => {
    if (!owner.merchantId || !owner.ownerOrganizationId) fail("Merchant owner binding is missing");
    return {
      eliza_merchant_id: owner.merchantId,
      eliza_merchant_owner_organization_id: owner.ownerOrganizationId,
    };
  };
  const bind = (owner: BillingMerchantOwner, account: z.infer<typeof accountSchema>) => {
    if (!Object.entries(metadata(owner)).every(([key, value]) => account.metadata[key] === value))
      fail("Connected account belongs to a different merchant owner");
    return {
      accountId: account.id,
      accountType: account.type,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
      cardPaymentsActive: account.capabilities.card_payments === "active",
      disabledReason: account.requirements.disabled_reason,
      requirementsDue: account.requirements.currently_due,
    } satisfies BillingMerchantConnection;
  };
  const retrieve = async (owner: BillingMerchantOwner, accountId: string) => {
    await ensureCredentialMode();
    const account = parse(
      accountSchema,
      await stripe.accounts.retrieve(
        accountId,
        {},
        { apiVersion: GENERIC_BILLING_STRIPE_API_VERSION },
      ),
    );
    if (account.id !== accountId) fail("Provider returned a different merchant account");
    return bind(owner, account);
  };
  const url = (value: string) => {
    const parsed = z.url().safeParse(value);
    if (!parsed.success || new URL(parsed.data).protocol !== "https:")
      fail("Merchant onboarding redirect must be a registered HTTPS URL");
    return parsed.data;
  };
  return {
    retrieve,
    async create(
      owner: BillingMerchantOwner,
      input: { country: string; accountType: "standard" | "express" },
      intent: DurableProviderIntent,
    ) {
      await ensureCredentialMode();
      if (!/^[A-Z]{2}$/.test(input.country))
        fail("Merchant country must be an explicit ISO country code");
      const account = parse(
        accountSchema,
        await stripe.accounts.create(
          {
            type: input.accountType,
            country: input.country,
            capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
            metadata: {
              ...metadata(owner),
              eliza_command_id: intent.commandId,
              eliza_request_digest: intent.requestDigest,
            },
          },
          intentOptions(intent),
        ),
      );
      return {
        value: bind(owner, account),
        inputDigest: intent.requestDigest,
        livemode: expectedLivemode,
      };
    },
    async createOnboardingLink(
      owner: BillingMerchantOwner,
      input: { accountId: string; refreshUrl: string; returnUrl: string },
      intent: DurableProviderIntent,
    ) {
      await retrieve(owner, input.accountId);
      const link = parse(
        z.object({
          object: z.literal("account_link"),
          url: z.string().url(),
          expires_at: z.number().int().positive(),
        }),
        await stripe.accountLinks.create(
          {
            account: input.accountId,
            type: "account_onboarding",
            refresh_url: url(input.refreshUrl),
            return_url: url(input.returnUrl),
          },
          intentOptions(intent),
        ),
      );
      return { url: link.url, expiresAt: link.expires_at, inputDigest: intent.requestDigest };
    },
    async adoptOAuth(
      owner: BillingMerchantOwner,
      authorizationCode: string,
      intent: DurableProviderIntent,
    ) {
      await ensureCredentialMode();
      if (!authorizationCode) fail("OAuth authorization code is missing");
      const authorization = parse(
        z.object({
          stripe_user_id: z.string().regex(/^acct_[A-Za-z0-9]+$/),
          livemode: z.boolean(),
          scope: z.literal("read_write"),
        }),
        await stripe.oauth.token(
          { grant_type: "authorization_code", code: authorizationCode },
          intentOptions(intent),
        ),
      );
      if (authorization.livemode !== expectedLivemode)
        fail("OAuth authorization belongs to a different Stripe environment");
      const account = parse(
        accountSchema,
        await stripe.accounts.retrieve(
          authorization.stripe_user_id,
          {},
          { apiVersion: GENERIC_BILLING_STRIPE_API_VERSION },
        ),
      );
      if (account.type !== "standard" || account.id !== authorization.stripe_user_id)
        fail("OAuth adoption requires the authorized Standard account");
      for (const [key, value] of Object.entries(metadata(owner)))
        if (account.metadata[key] !== undefined && account.metadata[key] !== value)
          fail("OAuth account is already bound to a different merchant owner");
      const bound = parse(
        accountSchema,
        await stripe.accounts.update(
          account.id,
          { metadata: metadata(owner) },
          intentOptions({
            ...intent,
            idempotencyKey: `merchant-adopt:${createHash("sha256").update(intent.idempotencyKey).digest("hex")}`,
          }),
        ),
      );
      return {
        value: bind(owner, bound),
        inputDigest: intent.requestDigest,
        livemode: expectedLivemode,
      };
    },
    async disconnectStandardAccount(
      owner: BillingMerchantOwner,
      input: { accountId: string; clientId: string },
      intent: DurableProviderIntent,
    ) {
      const account = await retrieve(owner, input.accountId);
      if (account.accountType !== "standard")
        fail(
          "Managed accounts require explicit retirement; OAuth disconnection applies only to Standard accounts",
        );
      if (!input.clientId.startsWith("ca_")) fail("Stored Connect application binding is missing");
      const result = parse(
        z.object({ stripe_user_id: z.string() }),
        await stripe.oauth.deauthorize(
          { client_id: input.clientId, stripe_user_id: account.accountId },
          intentOptions(intent),
        ),
      );
      if (result.stripe_user_id !== account.accountId)
        fail("Provider disconnected a different account");
      return {
        accountId: account.accountId,
        disconnected: true as const,
        inputDigest: intent.requestDigest,
      };
    },
  };
}

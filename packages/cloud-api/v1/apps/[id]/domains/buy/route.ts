/**
 * POST /api/v1/apps/:id/domains/buy
 *
 * Atomic buy flow: claim an idempotency key → check availability → debit
 * credits → register via cloudflare → write managed_domains row + assign to app
 * → CNAME the new zone at the app's container public URL. Refunds credits and
 * surfaces the error if cloudflare registration fails after the debit.
 *
 * The idempotency claim (a UNIQUE row inserted BEFORE any money moves) makes the
 * debit + register pair single-flighted: a retried or concurrent buy of the same
 * domain short-circuits on the completed row's cached response instead of
 * charging twice. Mirrors apps/[id]/generate-image's idempotent-charge pattern.
 */

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { dbRead, dbWrite } from "@/db/client";
import { domainPurchaseIdempotency } from "@/db/schemas/domain-purchase-idempotency";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import { appDomainsCompat } from "@/lib/services/app-domains-compat";
import { appsService } from "@/lib/services/apps";
import {
  cloudflareDnsService,
  type DnsRecordType,
} from "@/lib/services/cloudflare-dns";
import {
  cloudflareRegistrarService,
  type RegisteredDomain,
} from "@/lib/services/cloudflare-registrar";
import {
  creditsService,
  InsufficientCreditsError,
} from "@/lib/services/credits";
import { computeDomainPrice } from "@/lib/services/domain-pricing";
import { managedDomainsService } from "@/lib/services/managed-domains";
import { extractErrorMessage } from "@/lib/utils/error-handling";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const BuySchema = z.object({
  domain: z
    .string()
    .min(4)
    .max(253)
    .regex(
      /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i,
      "Invalid domain format",
    )
    .transform((d) => d.toLowerCase().trim()),
});

/**
 * Idempotency claim lifetime. A claim that never reaches `completed` within this
 * window (e.g. the worker died mid-purchase) is treated as stale and a retry may
 * re-claim it. Matches the app-image-generation idempotency TTL.
 */
const DOMAIN_PURCHASE_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

type PurchaseOutcome = {
  status: 200 | 402 | 409 | 502;
  body: Record<string, unknown>;
};

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  let idempotencyKey: string | undefined;
  let claimed = false;
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const appId = c.req.param("id");
    if (!appId) return c.json({ success: false, error: "Missing app id" }, 400);

    const parsed = BuySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "invalid input",
        },
        400,
      );
    }
    const { domain } = parsed.data;

    const appRow = await appsService.getById(appId);
    if (!appRow) return c.json({ success: false, error: "App not found" }, 404);
    if (appRow.organization_id !== user.organization_id) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }

    // Claim the idempotency key BEFORE any debit/register. The unique insert is
    // the single point of serialization: only the winner runs the purchase; a
    // concurrent/retried buy of the same domain short-circuits below.
    idempotencyKey = `domain-buy:${user.organization_id}:${domain}`;
    const [claim] = await dbWrite
      .insert(domainPurchaseIdempotency)
      .values({
        key: idempotencyKey,
        organization_id: user.organization_id,
        app_id: appId,
        domain,
        status: "processing",
        expires_at: new Date(Date.now() + DOMAIN_PURCHASE_IDEMPOTENCY_TTL_MS),
      })
      .onConflictDoNothing({ target: domainPurchaseIdempotency.key })
      .returning({ id: domainPurchaseIdempotency.id });

    if (!claim) {
      const [existingClaim] = await dbRead
        .select()
        .from(domainPurchaseIdempotency)
        .where(eq(domainPurchaseIdempotency.key, idempotencyKey))
        .limit(1);
      if (!existingClaim || existingClaim.expires_at < new Date()) {
        await dbWrite
          .delete(domainPurchaseIdempotency)
          .where(eq(domainPurchaseIdempotency.key, idempotencyKey));
        return c.json(
          { success: false, error: "Retry request", code: "idempotency_retry" },
          409,
        );
      }
      if (existingClaim.status === "completed" && existingClaim.response_body) {
        return c.json(
          existingClaim.response_body as Record<string, unknown>,
          200,
        );
      }
      return c.json(
        {
          success: false,
          error: "Domain purchase already in progress",
          code: "idempotency_in_progress",
        },
        409,
      );
    }
    claimed = true;

    const outcome = await executeDomainPurchase({
      organizationId: user.organization_id,
      appId,
      appUrl: appRow.app_url,
      domain,
    });

    if (outcome.status === 200) {
      // Cache the success so a retry replays it instead of charging again.
      await dbWrite
        .update(domainPurchaseIdempotency)
        .set({
          status: "completed",
          response_body: outcome.body,
          updated_at: new Date(),
        })
        .where(eq(domainPurchaseIdempotency.key, idempotencyKey))
        .catch((stateError) => {
          logger.error(
            "[Domains Buy] failed to persist idempotent completion",
            {
              appId,
              domain,
              error: extractErrorMessage(stateError),
            },
          );
        });
    } else {
      // Failure (insufficient credits / unavailable / refunded register): drop
      // the claim so a genuine retry can proceed.
      await releaseClaim(idempotencyKey);
    }

    return c.json(outcome.body, outcome.status);
  } catch (error) {
    if (claimed && idempotencyKey) await releaseClaim(idempotencyKey);
    logger.error("[Domains Buy] unhandled error", { error });
    return failureResponse(c, error);
  }
});

interface PurchaseContext {
  organizationId: string;
  appId: string;
  appUrl: string | null | undefined;
  domain: string;
}

/**
 * Run the actual purchase (availability → debit → register → persist) for a
 * claim winner and return the HTTP outcome. Throws only on truly unexpected
 * errors (the caller releases the claim and maps them via failureResponse).
 */
async function executeDomainPurchase(
  ctx: PurchaseContext,
): Promise<PurchaseOutcome> {
  const { organizationId, appId, appUrl, domain } = ctx;

  const existing = await managedDomainsService.getDomainByName(domain);
  if (existing) {
    if (existing.organizationId !== organizationId) {
      return {
        status: 409,
        body: {
          success: false,
          error: "Domain is already registered to a different organization",
        },
      };
    }

    const registered = await fetchRegisteredDomainForRecovery(
      domain,
      appId,
      "existing-row",
    );
    if (existing.registrar === "cloudflare" || registered) {
      const result = await persistAndAssignCloudflareDomain({
        organizationId,
        appId,
        appUrl,
        domain,
        existingCloudflareRegistrationId: existing.cloudflareRegistrationId,
        registered,
        existingZoneId: existing.cloudflareZoneId,
        existingStatus: existing.status,
        existingVerified: existing.verified,
      });
      return {
        status: 200,
        body: {
          success: true,
          domain,
          appDomainId: result.appDomainId,
          zoneId: result.zoneId,
          status: result.status,
          verified: result.verified,
          alreadyRegistered: true,
          recoveredFromRegistrar:
            existing.registrar !== "cloudflare" && Boolean(registered),
          pendingZoneProvisioning: !result.zoneId,
        },
      };
    }

    return {
      status: 409,
      body: {
        success: false,
        error:
          "Domain is already attached as an external domain. Verify or detach it before buying it through Cloudflare.",
      },
    };
  }

  // 1. availability + price quote
  const availability =
    await cloudflareRegistrarService.checkAvailability(domain);
  if (!availability.available) {
    const registered = await fetchRegisteredDomainForRecovery(
      domain,
      appId,
      "unavailable",
    );
    if (registered) {
      const result = await persistAndAssignCloudflareDomain({
        organizationId,
        appId,
        appUrl,
        domain,
        registered,
      });
      return {
        status: 200,
        body: {
          success: true,
          domain,
          appDomainId: result.appDomainId,
          zoneId: result.zoneId,
          status: result.status,
          verified: result.verified,
          alreadyRegistered: true,
          recoveredFromRegistrar: true,
          pendingZoneProvisioning: !result.zoneId,
        },
      };
    }
    return {
      status: 409,
      body: {
        success: false,
        error: "Domain is not available for registration",
      },
    };
  }
  const price = computeDomainPrice(availability.priceUsdCents);
  const renewalPrice = computeDomainPrice(
    availability.renewalUsdCents ?? availability.priceUsdCents,
  );

  // 2. debit user's org credit balance
  const debitDescription = `domain registration: ${domain}`;
  const debitMetadata = {
    type: "domain_purchase" as const,
    domain,
    appId,
    wholesaleUsdCents: price.wholesaleUsdCents,
    marginUsdCents: price.marginUsdCents,
  };
  try {
    await creditsService.deductCredits({
      organizationId,
      amount: price.totalUsdCents / 100,
      description: debitDescription,
      metadata: debitMetadata,
    });
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      return {
        status: 402,
        body: {
          success: false,
          error: "Insufficient credit balance for this domain",
        },
      };
    }
    throw err;
  }

  // 3. register via cloudflare
  let registrationId: string;
  try {
    const reg = await cloudflareRegistrarService.registerDomain(domain);
    registrationId = reg.registrationId;
  } catch (err) {
    await creditsService.refundCredits({
      organizationId,
      amount: price.totalUsdCents / 100,
      description: `${debitDescription} (refund: registration failed)`,
      metadata: { ...debitMetadata, type: "domain_purchase_refund" },
    });
    const message = extractErrorMessage(err);
    logger.error("[Domains Buy] cloudflare register failed; refunded", {
      appId,
      domain,
      error: message,
    });
    return { status: 502, body: { success: false, error: message } };
  }

  // 4. fetch the registered domain to get zone_id
  const reg = await fetchRegisteredDomainForRecovery(
    domain,
    appId,
    "post-register",
  );
  const result = await persistAndAssignCloudflareDomain({
    organizationId,
    appId,
    appUrl,
    domain,
    cloudflareRegistrationId: registrationId,
    purchasePriceCents: price.totalUsdCents,
    renewalPriceCents: renewalPrice.totalUsdCents,
    registered: reg,
  });

  return {
    status: 200,
    body: {
      success: true,
      domain,
      appDomainId: result.appDomainId,
      zoneId: result.zoneId,
      status: result.status,
      verified: result.verified,
      expiresAt: reg?.expiresAt ?? null,
      pendingZoneProvisioning: !result.zoneId,
      debited: {
        totalUsdCents: price.totalUsdCents,
        currency: availability.currency,
      },
    },
  };
}

async function releaseClaim(key: string): Promise<void> {
  await dbWrite
    .delete(domainPurchaseIdempotency)
    .where(eq(domainPurchaseIdempotency.key, key))
    .catch((err) => {
      logger.warn("[Domains Buy] failed to release idempotency claim", {
        key,
        error: extractErrorMessage(err),
      });
    });
}

interface PersistCloudflareDomainInput {
  organizationId: string;
  appId: string;
  appUrl: string | null | undefined;
  domain: string;
  registered: RegisteredDomain | null;
  cloudflareRegistrationId?: string | null;
  existingCloudflareRegistrationId?: string | null;
  existingZoneId?: string | null;
  existingStatus?:
    | "pending"
    | "active"
    | "expired"
    | "suspended"
    | "transferring";
  existingVerified?: boolean;
  purchasePriceCents?: number | null;
  renewalPriceCents?: number | null;
}

async function persistAndAssignCloudflareDomain(
  input: PersistCloudflareDomainInput,
): Promise<{
  appDomainId: string;
  zoneId: string | null;
  status: "pending" | "active" | "expired" | "suspended" | "transferring";
  verified: boolean;
}> {
  const zoneId = input.registered?.zoneId ?? input.existingZoneId ?? null;
  const status = zoneId ? "active" : (input.existingStatus ?? "pending");
  const verified = zoneId ? true : (input.existingVerified ?? false);
  const stored = await managedDomainsService.upsertCloudflareRegisteredDomain({
    organizationId: input.organizationId,
    domain: input.domain,
    cloudflareZoneId: zoneId,
    cloudflareRegistrationId:
      input.cloudflareRegistrationId ??
      input.existingCloudflareRegistrationId ??
      null,
    purchasePriceCents: input.purchasePriceCents,
    renewalPriceCents: input.renewalPriceCents,
    expiresAt: input.registered?.expiresAt
      ? new Date(input.registered.expiresAt)
      : undefined,
    autoRenew: input.registered?.autoRenew,
    status,
    verified,
    registrantInfo: null,
  });
  const assigned = await managedDomainsService.assignToResource(stored.id, {
    type: "app",
    id: input.appId,
  });
  await appDomainsCompat.setCustomDomain({
    appId: input.appId,
    domain: input.domain,
    verified: stored.verified,
  });

  if (zoneId) {
    await configureDomainDns({
      appId: input.appId,
      appUrl: input.appUrl,
      domain: input.domain,
      zoneId,
    });
  } else {
    logger.warn(
      "[Domains Buy] domain registered but zone provisioning is still pending",
      {
        appId: input.appId,
        domain: input.domain,
      },
    );
  }

  return {
    appDomainId: assigned.id,
    zoneId,
    status: stored.status,
    verified: stored.verified,
  };
}

async function fetchRegisteredDomainForRecovery(
  domain: string,
  appId: string,
  reason: string,
): Promise<RegisteredDomain | null> {
  try {
    return await cloudflareRegistrarService.getRegisteredDomain(domain);
  } catch (err) {
    logger.warn("[Domains Buy] registered-domain lookup failed", {
      appId,
      domain,
      reason,
      error: extractErrorMessage(err),
    });
    return null;
  }
}

async function configureDomainDns(input: {
  appId: string;
  appUrl: string | null | undefined;
  domain: string;
  zoneId: string;
}): Promise<void> {
  const dnsTarget = resolveCustomDomainDnsTarget(input.appUrl);
  if (!dnsTarget) {
    logger.warn(
      "[Domains Buy] no container target — DNS not configured automatically",
      {
        appId: input.appId,
        domain: input.domain,
      },
    );
    return;
  }

  const records = await cloudflareDnsService
    .listRecords(input.zoneId)
    .catch((err) => {
      logger.warn("[Domains Buy] DNS record lookup failed before CNAME setup", {
        appId: input.appId,
        domain: input.domain,
        error: extractErrorMessage(err),
      });
      return null;
    });
  const existing = records?.find((record) => record.name === input.domain);
  if (existing) {
    if (
      existing.type === dnsTarget.type &&
      normalizeDnsContent(existing.content) ===
        normalizeDnsContent(dnsTarget.content) &&
      existing.proxied === true
    ) {
      return;
    }
    await cloudflareDnsService
      .updateRecord(input.zoneId, existing.id, {
        type: dnsTarget.type,
        name: input.domain,
        content: dnsTarget.content,
        ttl: 1,
        proxied: true,
      })
      .catch((err) => {
        logger.warn("[Domains Buy] DNS record update failed (non-fatal)", {
          appId: input.appId,
          domain: input.domain,
          recordType: dnsTarget.type,
          target: dnsTarget.content,
          error: extractErrorMessage(err),
        });
      });
    return;
  }

  await cloudflareDnsService
    .createRecord(input.zoneId, {
      type: dnsTarget.type,
      name: input.domain,
      content: dnsTarget.content,
      ttl: 1,
      proxied: true,
    })
    .catch((err) => {
      logger.warn("[Domains Buy] DNS record creation failed (non-fatal)", {
        appId: input.appId,
        domain: input.domain,
        recordType: dnsTarget.type,
        target: dnsTarget.content,
        error: extractErrorMessage(err),
      });
    });
}

function normalizeDnsContent(value: string): string {
  return value.toLowerCase().replace(/\.$/, "");
}

function resolveCustomDomainDnsTarget(
  appUrl: string | null | undefined,
): { type: DnsRecordType; content: string } | null {
  const env = getCloudAwareEnv();
  const originIp =
    typeof env.ELIZA_CUSTOM_DOMAIN_ORIGIN_IP === "string"
      ? env.ELIZA_CUSTOM_DOMAIN_ORIGIN_IP.trim()
      : "";
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(originIp)) {
    return { type: "A", content: originIp };
  }

  const originHost =
    typeof env.ELIZA_CUSTOM_DOMAIN_ORIGIN_HOST === "string"
      ? env.ELIZA_CUSTOM_DOMAIN_ORIGIN_HOST.trim()
      : "";
  if (originHost) {
    return { type: "CNAME", content: originHost };
  }

  if (!appUrl || appUrl === "https://placeholder.invalid") return null;
  try {
    return { type: "CNAME", content: new URL(appUrl).hostname };
  } catch {
    return null;
  }
}

export default app;

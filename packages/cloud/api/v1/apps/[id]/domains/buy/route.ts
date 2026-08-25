/**
 * POST /api/v1/apps/:id/domains/buy
 *
 * Durably pins the quote and keyed debit before claiming a registrar lease.
 * Once the provider may have observed a registration request, retries reconcile
 * Cloudflare status instead of repeating the purchase or guessing that it
 * failed. Terminal responses are replayed byte-for-byte; a different app in the
 * same organization may reassign the already-owned domain without another debit.
 */

import { Hono } from "hono";
import { creditTransactionsRepository } from "@/db/repositories/credit-transactions";
import { domainPurchaseAttemptsRepository } from "@/db/repositories/domain-purchase-attempts";
import type { CreditTransaction } from "@/db/schemas/credit-transactions";
import type { DomainPurchaseIdempotency } from "@/db/schemas/domain-purchase-idempotency";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { isAppKeyOutOfScope } from "@/lib/auth/app-key-scope";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  moneyRateLimit,
  RateLimitPresets,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
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
import { creditsService } from "@/lib/services/credits";
import { computeDomainPrice } from "@/lib/services/domain-pricing";
import { managedDomainsService } from "@/lib/services/managed-domains";
import { extractErrorMessage } from "@/lib/utils/error-handling";
import { decodeRequestJson } from "@/lib/utils/json-parsing";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { domainBodySchema as BuySchema } from "../schemas";

const DOMAIN_PURCHASE_PROVIDER_LEASE_MS = 2 * 60 * 1000;
const DOMAIN_PURCHASE_RECONCILE_DELAY_MS = 60 * 1000;
const DOMAIN_PURCHASE_REPLAY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type PurchaseOutcome = {
  status: 200 | 402 | 409 | 502;
  body: Record<string, unknown>;
};

const app = new Hono<AppEnv>();

// A domain registration spends credits and commits an external purchase. If
// the shared limiter is unavailable, reject before route authentication and
// before any idempotency, ledger, registrar, persistence, or DNS side effect.
const domainBuyRateLimit = moneyRateLimit(RateLimitPresets.CRITICAL);

app.post("/", domainBuyRateLimit, async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const appId = c.req.param("id");
    if (!appId) return c.json({ success: false, error: "Missing app id" }, 400);

    const decodedBody = await decodeRequestJson(c.req);
    if (!decodedBody.ok) {
      // error-policy:J3 malformed JSON is invalid request input.
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }
    const rawBody = decodedBody.value;
    const parsed = BuySchema.safeParse(rawBody);
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
    if (await isAppKeyOutOfScope(c.get("apiKeyId"), appId)) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }

    const idempotencyKey = `domain-buy:${user.organization_id}:${domain}`;
    const existingAttempt =
      await domainPurchaseAttemptsRepository.read(idempotencyKey);
    const pinnedYears = existingAttempt
      ? readPinnedOrLegacyRegistrationYears(existingAttempt)
      : null;
    const proposedYears =
      pinnedYears ??
      (await cloudflareRegistrarService.getMinimumRegistrationYears(domain));
    const proposedRequestDigest = await digestDomainPurchaseRequest({
      organizationId: user.organization_id,
      domain,
      years: proposedYears,
    });
    const { attempt, created } =
      await domainPurchaseAttemptsRepository.createOrRead({
        key: idempotencyKey,
        organizationId: user.organization_id,
        appId,
        domain,
        requestDigest: proposedRequestDigest,
        registrationYears: proposedYears,
        expiresAt: new Date(Date.now() + DOMAIN_PURCHASE_PROVIDER_LEASE_MS),
      });

    if (
      attempt.organization_id !== user.organization_id ||
      attempt.domain !== domain
    ) {
      return c.json(
        { success: false, error: "Idempotency key binding mismatch" },
        409,
      );
    }
    if (
      attempt.response_body &&
      attempt.response_status &&
      (attempt.status !== "completed" || attempt.app_id === appId)
    ) {
      return c.json(
        attempt.response_body,
        attempt.response_status as PurchaseOutcome["status"],
      );
    }
    const legacyCompletedReassignment =
      attempt.request_digest === null &&
      attempt.status === "completed" &&
      attempt.response_body !== null &&
      attempt.response_status === 200 &&
      attempt.app_id !== appId;
    if (
      attempt.request_digest !== proposedRequestDigest &&
      !legacyCompletedReassignment
    ) {
      if (attempt.request_digest === null && attempt.expires_at <= new Date()) {
        if (
          await domainPurchaseAttemptsRepository.deleteExpiredLegacyUncharged({
            key: attempt.key,
            organizationId: user.organization_id,
            now: new Date(),
          })
        ) {
          return c.json(
            {
              success: false,
              error: "Retry request",
              code: "idempotency_retry",
            },
            409,
          );
        }
        return c.json(
          {
            success: false,
            error:
              "A legacy domain purchase debit may still require registrar reconciliation. Contact support before retrying.",
            code: "legacy_purchase_reconciliation_required",
          },
          409,
        );
      }
      return c.json(
        { success: false, error: "Idempotency request digest mismatch" },
        409,
      );
    }
    const years = readPinnedOrLegacyRegistrationYears(attempt);
    if (years === null) {
      return c.json(
        {
          success: false,
          error: "Domain purchase registration term is not durably pinned",
          code: "domain_purchase_term_missing",
        },
        409,
      );
    }
    const requestDigest = await digestDomainPurchaseRequest({
      organizationId: user.organization_id,
      domain,
      years,
    });
    if (
      attempt.request_digest !== requestDigest &&
      !legacyCompletedReassignment
    ) {
      return c.json(
        { success: false, error: "Idempotency request digest mismatch" },
        409,
      );
    }
    if (
      !created &&
      ["processing", "quoted", "charged"].includes(attempt.status) &&
      attempt.expires_at > new Date()
    ) {
      return c.json(
        {
          success: false,
          error: "Domain purchase already in progress",
          code: "idempotency_in_progress",
        },
        409,
      );
    }

    const outcome = await executeDomainPurchase({
      organizationId: user.organization_id,
      appId,
      appUrl: appRow.app_url,
      domain,
      requestDigest,
      years,
      attempt,
    });
    return c.json(outcome.body, outcome.status);
  } catch (error) {
    // error-policy:J1 The HTTP boundary returns the shared structured cloud error.
    logger.error("[Domains Buy] unhandled error", { error });
    return failureResponse(c, error);
  }
});

interface PurchaseContext {
  organizationId: string;
  appId: string;
  appUrl: string | null | undefined;
  domain: string;
  requestDigest: string;
  years: number;
  attempt: DomainPurchaseIdempotency;
}

/**
 * Run the actual purchase (availability → debit → register → persist) for a
 * claim winner and return the HTTP outcome. Throws only on truly unexpected
 * errors (the caller releases the claim and maps them via failureResponse).
 */
export async function executeDomainPurchase(
  ctx: PurchaseContext,
): Promise<PurchaseOutcome> {
  const { organizationId, appId, appUrl, domain, requestDigest, years } = ctx;
  const key = ctx.attempt.key;
  let attempt = ctx.attempt;

  const existing = await managedDomainsService.getDomainByName(domain);
  if (existing) {
    if (existing.organizationId !== organizationId) {
      if (attempt.status === "charged") {
        const quote = readPinnedDomainQuote(attempt);
        attempt =
          await domainPurchaseAttemptsRepository.markChargedRefundPending({
            key,
            organizationId,
            errorCode: "domain_owned_by_another_org",
          });
        return refundDomainPurchaseAttempt(attempt, quote, {
          type: "domain_purchase",
          domain,
          appId,
          domainPurchaseKey: key,
          wholesaleUsdCents: quote.wholesaleUsdCents,
          marginUsdCents: quote.marginUsdCents,
          totalUsdCents: quote.totalUsdCents,
        });
      }
      if (
        attempt.status === "provider_started" ||
        attempt.status === "provider_ambiguous"
      ) {
        attempt = await reconcileDomainPurchaseAttempt(attempt);
        if (attempt.status === "refund_pending") {
          const quote = readPinnedDomainQuote(attempt);
          return refundDomainPurchaseAttempt(attempt, quote, {
            type: "domain_purchase",
            domain,
            appId,
            domainPurchaseKey: key,
            wholesaleUsdCents: quote.wholesaleUsdCents,
            marginUsdCents: quote.marginUsdCents,
            totalUsdCents: quote.totalUsdCents,
          });
        }
        if (attempt.status !== "registered") return reconcilingOutcome();
      }
      if (attempt.charge_id) {
        return {
          status: 409,
          body: {
            success: false,
            error:
              "Domain ownership conflicts with a charged registrar attempt; support review is required",
            code: "domain_ownership_conflict",
          },
        };
      }
      return terminalUnchargedFailure(
        attempt,
        409,
        "domain_owned_by_another_org",
        {
          success: false,
          error: "Domain is already registered to a different organization",
        },
      );
    }
    const registered = await fetchRegisteredDomainForRecovery(
      domain,
      appId,
      "existing-row",
    );
    if (existing.registrar !== "cloudflare" && !registered) {
      return terminalUnchargedFailure(
        attempt,
        409,
        "external_domain_conflict",
        {
          success: false,
          error:
            "Domain is already attached as an external domain. Verify or detach it before buying it through Cloudflare.",
        },
      );
    }
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
    const body = {
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
    };
    if (attempt.status !== "completed") {
      await domainPurchaseAttemptsRepository.complete({
        key,
        organizationId,
        managedDomainId: result.managedDomainId,
        responseStatus: 200,
        responseBody: body,
        replayUntil: replayUntil(),
      });
    }
    return { status: 200, body };
  }

  if (attempt.status === "processing") {
    const availability =
      await cloudflareRegistrarService.checkAvailability(domain);
    if (!availability.available) {
      const registered = await fetchRegisteredDomainForRecovery(
        domain,
        appId,
        "unavailable",
      );
      const ownsLegacyOrphan =
        registered &&
        (await creditTransactionsRepository.hasUnrefundedDomainPurchase(
          organizationId,
          domain,
        ));
      if (!registered || !ownsLegacyOrphan) {
        return terminalUnchargedFailure(attempt, 409, "domain_unavailable", {
          success: false,
          error: "Domain is not available for registration",
        });
      }
      const result = await persistAndAssignCloudflareDomain({
        organizationId,
        appId,
        appUrl,
        domain,
        registered,
      });
      const body = {
        success: true,
        domain,
        appDomainId: result.appDomainId,
        zoneId: result.zoneId,
        status: result.status,
        verified: result.verified,
        alreadyRegistered: true,
        recoveredFromRegistrar: true,
        pendingZoneProvisioning: !result.zoneId,
      };
      await domainPurchaseAttemptsRepository.complete({
        key,
        organizationId,
        managedDomainId: result.managedDomainId,
        responseStatus: 200,
        responseBody: body,
        replayUntil: replayUntil(),
      });
      return { status: 200, body };
    }
    if (availability.currency !== "USD") {
      throw new Error("Cloudflare returned a non-USD registrar quote");
    }
    const registrationWholesaleUsdCents = availability.priceUsdCents;
    const renewalWholesaleUsdCents =
      availability.renewalUsdCents ?? availability.priceUsdCents;
    const aggregateWholesaleUsdCents =
      registrationWholesaleUsdCents + renewalWholesaleUsdCents * (years - 1);
    if (!Number.isSafeInteger(aggregateWholesaleUsdCents)) {
      throw new Error("Cloudflare registrar quote exceeds safe integer cents");
    }
    const price = computeDomainPrice(aggregateWholesaleUsdCents);
    const renewal = computeDomainPrice(renewalWholesaleUsdCents);
    attempt = await domainPurchaseAttemptsRepository.storeQuote({
      key,
      organizationId,
      requestDigest,
      quote: {
        totalUsdCents: price.totalUsdCents,
        wholesaleUsdCents: price.wholesaleUsdCents,
        marginUsdCents: price.marginUsdCents,
        registrationWholesaleUsdCents,
        renewalWholesaleUsdCents,
        renewalUsdCents: renewal.totalUsdCents,
        years,
        currency: "USD",
      },
      expiresAt: new Date(Date.now() + DOMAIN_PURCHASE_PROVIDER_LEASE_MS),
    });
  }

  const quote = readPinnedDomainQuote(attempt);
  const debitMetadata = {
    type: "domain_purchase" as const,
    domain,
    appId,
    domainPurchaseKey: key,
    wholesaleUsdCents: quote.wholesaleUsdCents,
    marginUsdCents: quote.marginUsdCents,
    totalUsdCents: quote.totalUsdCents,
  };
  if (attempt.status === "quoted") {
    const debit = await creditsService.deductCredits({
      organizationId,
      amount: quote.totalUsdCents / 100,
      description: `domain registration: ${domain}`,
      metadata: debitMetadata,
      stripePaymentIntentId: domainPurchaseChargeKey(organizationId, domain),
    });
    if (!debit.success) {
      return terminalUnchargedFailure(
        attempt,
        402,
        debit.reason ?? "insufficient_balance",
        {
          success: false,
          error:
            debit.reason === "org_not_found"
              ? "Organization not found"
              : "Insufficient credit balance for this domain",
          code: debit.reason ?? "insufficient_balance",
        },
      );
    }
    if (!debit.transaction) {
      throw new Error("Domain purchase debit succeeded without a transaction");
    }
    assertDomainPurchaseCharge(debit.transaction, {
      organizationId,
      domain,
      key,
      totalUsdCents: quote.totalUsdCents,
    });
    attempt = await domainPurchaseAttemptsRepository.attachCharge({
      key,
      organizationId,
      requestDigest,
      chargeId: debit.transaction.id,
    });
  }

  if (attempt.status === "charged") {
    const leaseToken = crypto.randomUUID();
    const claimed = await domainPurchaseAttemptsRepository.claimRegistrarStart({
      key,
      organizationId,
      leaseToken,
      claimedUntil: new Date(Date.now() + DOMAIN_PURCHASE_PROVIDER_LEASE_MS),
    });
    if (claimed) {
      attempt = claimed;
      try {
        const registration = await cloudflareRegistrarService.registerDomain(
          domain,
          quote.years,
        );
        attempt =
          registration.status === "failed" || registration.status === "expired"
            ? await domainPurchaseAttemptsRepository.markRefundPending({
                key,
                organizationId,
                leaseToken,
                errorCode: `registration_${registration.status}`,
              })
            : await domainPurchaseAttemptsRepository.markRegistered({
                key,
                organizationId,
                leaseToken,
                registrationId: registration.registrationId,
              });
      } catch (error) {
        // error-policy:J4 An uncertain provider result is persisted as visibly reconciling.
        await domainPurchaseAttemptsRepository.markProviderAmbiguous({
          key,
          organizationId,
          leaseToken,
          errorCode: "registrar_start_ambiguous",
          nextReconcileAt: nextDomainReconcileAt(attempt.attempt_count),
        });
        logger.warn(
          "[Domains Buy] registrar start is ambiguous; queued reconciliation",
          {
            appId,
            domain,
            error: extractErrorMessage(error),
          },
        );
        return reconcilingOutcome();
      }
    } else {
      attempt = (await domainPurchaseAttemptsRepository.read(key)) ?? attempt;
    }
  }

  if (
    attempt.status === "provider_started" ||
    attempt.status === "provider_ambiguous"
  ) {
    attempt = await reconcileDomainPurchaseAttempt(attempt);
  }
  if (attempt.status === "refund_pending") {
    return refundDomainPurchaseAttempt(attempt, quote, debitMetadata);
  }
  if (attempt.status === "refunded" && attempt.response_body) {
    return {
      status: (attempt.response_status ?? 502) as PurchaseOutcome["status"],
      body: attempt.response_body,
    };
  }
  if (attempt.status !== "registered") return reconcilingOutcome();

  const registered = await fetchRegisteredDomainForRecovery(
    domain,
    appId,
    "post-register",
  );
  let result: Awaited<ReturnType<typeof persistAndAssignCloudflareDomain>>;
  try {
    result = await persistAndAssignCloudflareDomain({
      organizationId,
      appId,
      appUrl,
      domain,
      cloudflareRegistrationId: attempt.cloudflare_registration_id,
      purchasePriceCents: quote.totalUsdCents,
      renewalPriceCents: quote.renewalUsdCents,
      registered,
    });
  } catch (error) {
    // error-policy:J4 The charged registration stays durable and visibly recoverable.
    logger.error(
      "[Domains Buy] registered purchase awaits local persistence retry",
      {
        appId,
        domain,
        error: extractErrorMessage(error),
      },
    );
    return {
      status: 502,
      body: {
        success: false,
        error:
          "Domain was registered and charged, but final setup did not complete. Retry to finish assigning it to your app.",
        code: "persist_failed_recoverable",
        domain,
      },
    };
  }

  const body = {
    success: true,
    domain,
    appDomainId: result.appDomainId,
    zoneId: result.zoneId,
    status: result.status,
    verified: result.verified,
    expiresAt: registered?.expiresAt ?? null,
    pendingZoneProvisioning: !result.zoneId,
    debited: { totalUsdCents: quote.totalUsdCents, currency: quote.currency },
  };
  await domainPurchaseAttemptsRepository.complete({
    key,
    organizationId,
    managedDomainId: result.managedDomainId,
    responseStatus: 200,
    responseBody: body,
    replayUntil: replayUntil(),
  });
  return { status: 200, body };
}

async function terminalUnchargedFailure(
  attempt: DomainPurchaseIdempotency,
  status: 402 | 409,
  errorCode: string,
  body: Record<string, unknown>,
): Promise<PurchaseOutcome> {
  await domainPurchaseAttemptsRepository.markTerminalFailure({
    key: attempt.key,
    organizationId: attempt.organization_id,
    errorCode,
    responseStatus: status,
    responseBody: body,
    replayUntil: replayUntil(),
  });
  return { status, body };
}

async function reconcileDomainPurchaseAttempt(
  attempt: DomainPurchaseIdempotency,
): Promise<DomainPurchaseIdempotency> {
  if (attempt.expires_at > new Date()) return attempt;
  const leaseToken = crypto.randomUUID();
  const claimed = await domainPurchaseAttemptsRepository.claimReconciliation({
    key: attempt.key,
    organizationId: attempt.organization_id,
    leaseToken,
    now: new Date(),
    claimedUntil: new Date(Date.now() + DOMAIN_PURCHASE_PROVIDER_LEASE_MS),
  });
  if (!claimed)
    return (
      (await domainPurchaseAttemptsRepository.read(attempt.key)) ?? attempt
    );

  try {
    const status = await cloudflareRegistrarService.getRegistrationStatus(
      attempt.domain,
    );
    if (status.status === "active") {
      return domainPurchaseAttemptsRepository.markRegistered({
        key: attempt.key,
        organizationId: attempt.organization_id,
        leaseToken,
        registrationId: status.domain,
      });
    }
    if (status.status === "failed" || status.status === "expired") {
      return domainPurchaseAttemptsRepository.markRefundPending({
        key: attempt.key,
        organizationId: attempt.organization_id,
        leaseToken,
        errorCode: `registration_${status.status}`,
      });
    }
    return domainPurchaseAttemptsRepository.markProviderAmbiguous({
      key: attempt.key,
      organizationId: attempt.organization_id,
      leaseToken,
      errorCode: "registration_pending",
      nextReconcileAt: nextDomainReconcileAt(claimed.attempt_count),
    });
  } catch (error) {
    // error-policy:J4 Provider lookup failure stays pending for a bounded-backoff retry.
    logger.warn("[Domains Buy] registration reconciliation failed", {
      domain: attempt.domain,
      error: extractErrorMessage(error),
    });
    return domainPurchaseAttemptsRepository.markProviderAmbiguous({
      key: attempt.key,
      organizationId: attempt.organization_id,
      leaseToken,
      errorCode: "registration_lookup_failed",
      nextReconcileAt: nextDomainReconcileAt(claimed.attempt_count),
    });
  }
}

async function refundDomainPurchaseAttempt(
  attempt: DomainPurchaseIdempotency,
  quote: ReturnType<typeof readPinnedDomainQuote>,
  debitMetadata: Record<string, unknown>,
): Promise<PurchaseOutcome> {
  const refund = await creditsService.refundCredits({
    organizationId: attempt.organization_id,
    amount: quote.totalUsdCents / 100,
    description: `domain registration: ${attempt.domain} (refund)`,
    metadata: { ...debitMetadata, type: "domain_purchase_refund" },
    stripePaymentIntentId: `domain-purchase-refund:${attempt.organization_id}:${attempt.domain}`,
  });
  assertDomainPurchaseRefund(refund.transaction, {
    organizationId: attempt.organization_id,
    domain: attempt.domain,
    key: attempt.key,
    totalUsdCents: quote.totalUsdCents,
  });
  const body = {
    success: false,
    error: "Domain registration failed and the purchase was refunded",
    code: attempt.error_code ?? "registration_failed",
  };
  await domainPurchaseAttemptsRepository.markRefunded({
    key: attempt.key,
    organizationId: attempt.organization_id,
    refundId: refund.transaction.id,
    responseStatus: 502,
    responseBody: body,
    replayUntil: replayUntil(),
  });
  return { status: 502, body };
}

function readPinnedDomainQuote(attempt: DomainPurchaseIdempotency) {
  const quote = attempt.charge;
  const totalUsdCents = quote?.totalUsdCents;
  const wholesaleUsdCents = quote?.wholesaleUsdCents;
  const marginUsdCents = quote?.marginUsdCents;
  const renewalUsdCents = quote?.renewalUsdCents;
  const registrationWholesaleUsdCents = quote?.registrationWholesaleUsdCents;
  const renewalWholesaleUsdCents = quote?.renewalWholesaleUsdCents;
  const years = quote?.years;
  if (
    quote?.currency !== "USD" ||
    typeof totalUsdCents !== "number" ||
    typeof wholesaleUsdCents !== "number" ||
    typeof marginUsdCents !== "number" ||
    typeof renewalUsdCents !== "number" ||
    typeof registrationWholesaleUsdCents !== "number" ||
    typeof renewalWholesaleUsdCents !== "number" ||
    typeof years !== "number" ||
    !Number.isSafeInteger(totalUsdCents) ||
    !Number.isSafeInteger(wholesaleUsdCents) ||
    !Number.isSafeInteger(marginUsdCents) ||
    !Number.isSafeInteger(renewalUsdCents) ||
    !Number.isSafeInteger(registrationWholesaleUsdCents) ||
    !Number.isSafeInteger(renewalWholesaleUsdCents) ||
    !Number.isSafeInteger(years) ||
    totalUsdCents <= 0 ||
    wholesaleUsdCents < 0 ||
    marginUsdCents < 0 ||
    renewalUsdCents <= 0 ||
    registrationWholesaleUsdCents < 0 ||
    renewalWholesaleUsdCents < 0 ||
    years < 1 ||
    years > 10 ||
    wholesaleUsdCents !==
      registrationWholesaleUsdCents + renewalWholesaleUsdCents * (years - 1)
  ) {
    throw new Error("Domain purchase has no valid pinned USD quote");
  }
  return {
    currency: "USD" as const,
    totalUsdCents,
    wholesaleUsdCents,
    marginUsdCents,
    renewalUsdCents,
    registrationWholesaleUsdCents,
    renewalWholesaleUsdCents,
    years,
  };
}

/** Read the provider term already committed to the durable quote. */
export function getPinnedDomainPurchaseYears(
  attempt: DomainPurchaseIdempotency,
): number {
  return readPinnedDomainQuote(attempt).years;
}

function readPinnedOrLegacyRegistrationYears(
  attempt: DomainPurchaseIdempotency,
): number | null {
  const years = attempt.registration_years ?? attempt.charge?.years;
  if (
    typeof years === "number" &&
    Number.isSafeInteger(years) &&
    years >= 1 &&
    years <= 10
  ) {
    return years;
  }
  // Rows completed before migration 0260 did not record their provider term.
  // They may be replayed/reassigned, but never enter a new debit or POST path.
  if (attempt.request_digest === null && attempt.status === "completed")
    return 1;
  if (attempt.request_digest === null) return null;
  throw new Error("Domain purchase has no valid pinned registration term");
}

function reconcilingOutcome(): PurchaseOutcome {
  return {
    status: 409,
    body: {
      success: false,
      error: "Domain registration is still being reconciled",
      code: "registration_in_progress",
    },
  };
}

function domainPurchaseChargeKey(
  organizationId: string,
  domain: string,
): string {
  return `domain-purchase:${organizationId}:${domain}`;
}

function assertDomainPurchaseCharge(
  transaction: CreditTransaction,
  expected: {
    organizationId: string;
    domain: string;
    key: string;
    totalUsdCents: number;
  },
): void {
  const metadata = transaction.metadata;
  if (
    transaction.organization_id !== expected.organizationId ||
    transaction.type !== "debit" ||
    Number(transaction.amount) !== -expected.totalUsdCents / 100 ||
    metadata.type !== "domain_purchase" ||
    metadata.domain !== expected.domain ||
    metadata.domainPurchaseKey !== expected.key ||
    metadata.totalUsdCents !== expected.totalUsdCents
  ) {
    throw new Error("Domain purchase debit idempotency binding mismatch");
  }
}

function assertDomainPurchaseRefund(
  transaction: CreditTransaction,
  expected: {
    organizationId: string;
    domain: string;
    key: string;
    totalUsdCents: number;
  },
): void {
  const metadata = transaction.metadata;
  if (
    transaction.organization_id !== expected.organizationId ||
    transaction.type !== "refund" ||
    Number(transaction.amount) !== expected.totalUsdCents / 100 ||
    metadata.type !== "domain_purchase_refund" ||
    metadata.domain !== expected.domain ||
    metadata.domainPurchaseKey !== expected.key
  ) {
    throw new Error("Domain purchase refund idempotency binding mismatch");
  }
}

function replayUntil(): Date {
  return new Date(Date.now() + DOMAIN_PURCHASE_REPLAY_TTL_MS);
}

function nextDomainReconcileAt(attemptCount: number): Date {
  const exponent = Math.max(0, Math.min(attemptCount - 1, 8));
  const delayMs = Math.min(
    DOMAIN_PURCHASE_RECONCILE_DELAY_MS * 2 ** exponent,
    6 * 60 * 60 * 1000,
  );
  return new Date(Date.now() + delayMs);
}

async function digestDomainPurchaseRequest(input: {
  organizationId: string;
  domain: string;
  years: number;
}): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      organizationId: input.organizationId,
      domain: input.domain,
      years: input.years,
    }),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
  managedDomainId: string;
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
    managedDomainId: stored.id,
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
    // error-policy:J4 Recovery callers distinguish the unavailable lookup from ownership proof.
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
      // error-policy:J6 best-effort DNS reconciliation AFTER the domain purchase already committed+debited; a failed record lookup degrades to "attempt a create" (itself non-fatal below), never failing the completed purchase. Observed via this warn.
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

/**
 * Domain renewal billing (#10245).
 *
 * Purchased domains renew annually on Eliza's Cloudflare registrar account.
 * Without a renewal-billing cron the org is never re-charged and Eliza eats the
 * renewal (or the domain lapses). This service — driven by the daily
 * `cron/domain-renewals` route — finds domains nearing expiry and, for each:
 *
 *   1. Skips if the org was already charged for this renewal period (idempotent
 *      per (domain, period) via the credit ledger).
 *   2. Debits the org's credit balance for the renewal price BEFORE touching the
 *      registrar (fail-closed, same ordering as the buy path).
 *   3. On success, renews via the registrar and advances the stored expiry.
 *   4. On a declined debit, disables auto-renew (so Cloudflare stops renewing on
 *      our account) and lets the domain lapse per policy.
 *   5. If the registrar fails after the debit, refunds exactly once.
 */

import { creditTransactionsRepository } from "../../db/repositories/credit-transactions";
import type { ManagedDomain } from "../../db/schemas/managed-domains";
import { logger } from "../utils/logger";
import { cloudflareRegistrarService } from "./cloudflare-registrar";
import { creditsService } from "./credits";
import { managedDomainsService } from "./managed-domains";

/** How far ahead of expiry the cron starts attempting a renewal. */
export const DOMAIN_RENEWAL_WINDOW_DAYS = 14;

export type DomainRenewalOutcome =
  | "renewed"
  | "already_charged"
  | "debit_declined"
  | "registrar_failed"
  | "missing_price";

export interface DomainRenewalResult {
  domain: string;
  organizationId: string;
  outcome: DomainRenewalOutcome;
  chargedUsdCents?: number;
  reason?: string;
}

export interface DomainRenewalRunSummary {
  ranAt: string;
  due: number;
  renewed: number;
  alreadyCharged: number;
  declined: number;
  failed: number;
  results: DomainRenewalResult[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function addOneYear(from: Date): Date {
  const next = new Date(from);
  next.setUTCFullYear(next.getUTCFullYear() + 1);
  return next;
}

async function renewOne(domain: ManagedDomain): Promise<DomainRenewalResult> {
  const base = { domain: domain.domain, organizationId: domain.organizationId };

  if (!domain.expiresAt) {
    return { ...base, outcome: "missing_price", reason: "no expiry on record" };
  }
  const renewalPeriod = domain.expiresAt.toISOString();
  const renewalPriceCents = Math.round(Number(domain.renewalPrice ?? 0));
  if (!Number.isFinite(renewalPriceCents) || renewalPriceCents <= 0) {
    logger.warn("[Domain Renewals] missing renewal price — skipping", base);
    return { ...base, outcome: "missing_price" };
  }

  // Idempotency: never charge the same (domain, period) twice.
  if (
    await creditTransactionsRepository.hasUnrefundedDomainRenewal(
      domain.organizationId,
      domain.domain,
      renewalPeriod,
    )
  ) {
    return { ...base, outcome: "already_charged" };
  }

  const debitMetadata = {
    type: "domain_renewal" as const,
    domain: domain.domain,
    renewalPeriod,
    managedDomainId: domain.id,
  };

  // Debit BEFORE the registrar action so a renewal can never run for free.
  const debit = await creditsService.deductCredits({
    organizationId: domain.organizationId,
    amount: renewalPriceCents / 100,
    description: `domain renewal: ${domain.domain}`,
    metadata: debitMetadata,
  });
  if (!debit.success) {
    // Lapse policy: stop auto-renewing on our Cloudflare account, warn the org.
    await managedDomainsService.setAutoRenew(domain.id, false);
    await cloudflareRegistrarService
      .setDomainAutoRenew(domain.domain, false)
      .catch((err) =>
        logger.warn(
          "[Domain Renewals] failed to disable Cloudflare auto-renew after declined debit",
          { ...base, error: errorMessage(err) },
        ),
      );
    logger.warn("[Domain Renewals] renewal debit declined — domain will lapse", {
      ...base,
      reason: debit.reason ?? "insufficient_balance",
    });
    return {
      ...base,
      outcome: "debit_declined",
      reason: debit.reason ?? "insufficient_balance",
    };
  }

  try {
    const renewed = await cloudflareRegistrarService.renewDomain(domain.domain);
    const newExpiry = renewed.expiresAt
      ? new Date(renewed.expiresAt)
      : addOneYear(domain.expiresAt);
    await managedDomainsService.recordRenewal(domain.id, newExpiry);
    logger.info("[Domain Renewals] renewed", {
      ...base,
      chargedUsdCents: renewalPriceCents,
      newExpiry: newExpiry.toISOString(),
    });
    return { ...base, outcome: "renewed", chargedUsdCents: renewalPriceCents };
  } catch (err) {
    // Registrar failed after the debit — refund exactly once, reconciling the
    // period so the next run retries instead of seeing it as already charged.
    await creditsService.refundCredits({
      organizationId: domain.organizationId,
      amount: renewalPriceCents / 100,
      description: `domain renewal: ${domain.domain} (refund: registrar failed)`,
      metadata: { ...debitMetadata, type: "domain_renewal_refund" },
    });
    logger.error("[Domain Renewals] registrar renew failed; refunded", {
      ...base,
      error: errorMessage(err),
    });
    return { ...base, outcome: "registrar_failed", reason: errorMessage(err) };
  }
}

export async function processDomainRenewals(
  now: Date = new Date(),
): Promise<DomainRenewalRunSummary> {
  const due = await managedDomainsService.listCloudflareRenewalsDue(
    now,
    DOMAIN_RENEWAL_WINDOW_DAYS,
  );

  const results: DomainRenewalResult[] = [];
  for (const domain of due) {
    try {
      results.push(await renewOne(domain));
    } catch (err) {
      logger.error("[Domain Renewals] unexpected error renewing domain", {
        domain: domain.domain,
        error: errorMessage(err),
      });
      results.push({
        domain: domain.domain,
        organizationId: domain.organizationId,
        outcome: "registrar_failed",
        reason: "unexpected error",
      });
    }
  }

  return {
    ranAt: now.toISOString(),
    due: due.length,
    renewed: results.filter((r) => r.outcome === "renewed").length,
    alreadyCharged: results.filter((r) => r.outcome === "already_charged").length,
    declined: results.filter((r) => r.outcome === "debit_declined").length,
    failed: results.filter((r) => r.outcome === "registrar_failed" || r.outcome === "missing_price")
      .length,
    results,
  };
}

export const domainRenewalsService = { processDomainRenewals };

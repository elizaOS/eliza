/**
 * Domain Pricing
 *
 * Single source of truth for the eliza cloud margin applied on top of
 * cloudflare's at-cost wholesale registrar pricing. Lives in its own file
 * so future tuning (per-tld margins, promo codes, etc.) doesn't touch
 * the route or service layers.
 *
 * Default 36% margin (3600 basis points): cloudflare $10.99 .com → user
 * $14.99. Override via ELIZA_CF_REGISTRAR_MARGIN_BPS env.
 */

import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";

const DEFAULT_MARGIN_BPS = 3600;

function getMarginBps(): number {
  const raw =
    getCloudAwareEnv().ELIZA_CF_REGISTRAR_MARGIN_BPS ?? process.env.ELIZA_CF_REGISTRAR_MARGIN_BPS;
  if (!raw) return DEFAULT_MARGIN_BPS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MARGIN_BPS;
}

export interface DomainPriceBreakdown {
  wholesaleUsdCents: number;
  marginUsdCents: number;
  totalUsdCents: number;
  marginBps: number;
}

/**
 * Compute the user-facing price for a domain registration.
 *
 * Always rounds margin UP to the nearest cent so eliza cloud never
 * accidentally absorbs a half-cent on rounding.
 */
export function computeDomainPrice(wholesaleUsdCents: number): DomainPriceBreakdown {
  const marginBps = getMarginBps();
  const marginUsdCents = Math.ceil((wholesaleUsdCents * marginBps) / 10000);
  return {
    wholesaleUsdCents,
    marginUsdCents,
    totalUsdCents: wholesaleUsdCents + marginUsdCents,
    marginBps,
  };
}

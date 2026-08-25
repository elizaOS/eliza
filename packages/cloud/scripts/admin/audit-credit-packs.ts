/**
 * Read-only credit-pack reconciliation audit (#22963).
 *
 * Classifies every seeded credit pack as ACTIVE / DEPRECATED / ERRONEOUS /
 * UNKNOWN using server state and read-only Stripe retrievals — no charges, no
 * writes, no provider mutation. Produces the exact data the product owner
 * needs for the retain/remove/reprice decision (issue AC1-AC2).
 *
 * Classification rules mirror the LIVE checkout verification seam
 * (packages/cloud/api/stripe/create-checkout-session/route.ts):
 * a pack can only be purchased when the deployment currency is USD, its
 * Stripe price exists, is active, is USD, one-off (non-recurring), and its
 * unit_amount equals the DB price_cents. Anything else cannot be bought
 * through the live path.
 *
 * Provider uncertainty (missing credentials, auth/permission/rate-limit/
 * transient errors) is reported as UNKNOWN — never conflated with pack
 * defects. Only Stripe's explicit missing-resource response means a stale
 * price id.
 *
 * Usage:
 *   bun packages/cloud/scripts/admin/audit-credit-packs.ts [--json]
 *
 * Reads DATABASE_URL + STRIPE_SECRET_KEY (+ STRIPE_CURRENCY and optional
 * per-pack STRIPE_*_PACK_* env vars to cross-check the seeder's wiring) from
 * .env/.env.local, same loading convention as seed-credit-packs.ts.
 */
import { loadEnvFiles } from "./local-dev-helpers";

// In --json mode the script's stdout is machine-parsed; silence dotenv banners.
if (process.argv.includes("--json")) {
  const origLog = console.log;
  const origInfo = console.info;
  console.log = (...a: unknown[]) => process.stderr.write(`${a.join(" ")}\n`);
  console.info = (...a: unknown[]) => process.stderr.write(`${a.join(" ")}\n`);
  loadEnvFiles([".env", { path: ".env.local", override: true }]);
  console.log = origLog;
  console.info = origInfo;
} else {
  loadEnvFiles([".env", { path: ".env.local", override: true }]);
}

type Classification = "ACTIVE" | "DEPRECATED" | "ERRONEOUS" | "UNKNOWN";

/** Provider-side per-price read result, separating defect from uncertainty. */
type PriceRead =
  | {
      kind: "ok";
      active: boolean;
      usd: boolean;
      oneOff: boolean;
      amountMatchesDb: boolean;
    }
  | { kind: "missing" }
  | { kind: "provider-error"; errorType: string };

interface PackAudit {
  id: string;
  name: string;
  dbActive: boolean;
  credits: number;
  priceCents: number;
  impliedUsdPerCredit: number | null;
  customPathUsdPerCredit: number; // live custom top-up economics: 1 credit = $1
  economicsNote: string | null;
  stripePriceId: string | null;
  stripeChecks: PriceRead | null;
  deploymentCurrencyUsd: boolean | null;
  seededWiringMatches: boolean | null;
  classification: Classification;
  reasons: string[];
}

function readStripePrice(
  stripe: {
    prices: {
      retrieve: (id: string) => Promise<{
        active: boolean;
        currency: string;
        recurring: unknown;
        unit_amount: number | null;
      }>;
    };
  },
  priceId: string,
  priceCents: number,
): Promise<PriceRead> {
  return stripe.prices.retrieve(priceId).then(
    (price) => ({
      kind: "ok" as const,
      active: price.active,
      usd: price.currency.toLowerCase() === "usd",
      oneOff: !price.recurring,
      amountMatchesDb: price.unit_amount === priceCents,
    }),
    (error: unknown) => {
      const err = error as { type?: string; code?: string };
      // error-policy:J1 Stripe's resource-missing boundary is the ONLY signal
      // that the price id is stale (stripe-customer-authority.ts precedent).
      // StripeInvalidRequestError alone covers invalid requests generally.
      if (err.code === "resource_missing") {
        return { kind: "missing" as const };
      }
      // Auth, permission, rate-limit, and transient failures are operator
      // uncertainty, not pack defects; the audit must not fabricate a
      // classification from them.
      return {
        kind: "provider-error" as const,
        errorType: err.type ?? err.code ?? "unknown",
      };
    },
  );
}

async function main() {
  const asJson = process.argv.includes("--json");

  const [{ db }, { creditPacks }, { requireStripe, isStripeConfigured }] =
    await Promise.all([
      import("../../shared/src/db/client"),
      import("../../shared/src/db/schemas/credit-packs"),
      import("../../shared/src/lib/stripe"),
    ]);

  const packs = await db.select().from(creditPacks);
  const deploymentCurrencyUsd =
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone admin script run manually with bun; outside Turbo task caching.
    (process.env.STRIPE_CURRENCY || "usd").trim().toLowerCase() === "usd";
  if (packs.length === 0) {
    const empty = {
      summary: "No credit packs exist in the database.",
      packs: [] as PackAudit[],
      note: "The seed script has never been run against this environment; the credit_packs table is empty and only the custom-amount path ($1-$1000, 1:1 credits) is sellable.",
    };
    console.log(asJson ? JSON.stringify(empty, null, 2) : empty.summary);
    return;
  }

  const stripe = isStripeConfigured() ? requireStripe() : null;
  if (!stripe) {
    // Without provider credentials the audit cannot certify anything; warn
    // loudly and classify DB-active packs UNKNOWN below.
    console.error(
      "WARNING: STRIPE_SECRET_KEY is not configured — provider state cannot be verified; DB-active packs will report UNKNOWN.",
    );
  }

  // The seeder's expected wiring, for cross-checking which env vars seeded rows.
  const expectedWiring: Array<[string, string | undefined]> = [
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone admin script run manually with bun; outside Turbo task caching.
    ["Small Pack", process.env.STRIPE_SMALL_PACK_PRICE_ID],
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone admin script run manually with bun; outside Turbo task caching.
    ["Medium Pack", process.env.STRIPE_MEDIUM_PACK_PRICE_ID],
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone admin script run manually with bun; outside Turbo task caching.
    ["Large Pack", process.env.STRIPE_LARGE_PACK_PRICE_ID],
  ];

  const results: PackAudit[] = [];
  for (const pack of packs) {
    const reasons: string[] = [];
    let classification: Classification = "ACTIVE";

    const credits = Number(pack.credits);
    const priceUsd = pack.price_cents / 100;
    const impliedUsdPerCredit = credits > 0 ? priceUsd / credits : null;
    const economicsNote =
      impliedUsdPerCredit !== null && impliedUsdPerCredit !== 1
        ? `Purchasable economics diverge from the live custom path: $${impliedUsdPerCredit.toFixed(2)} per credit vs $1.00 — retain/reprice decision belongs to product approval (AC2)`
        : null;

    const wiring = expectedWiring.find(([n]) => n === pack.name);
    const seededWiringMatches = wiring
      ? wiring[1] === undefined
        ? null // env var unset — nothing to compare against
        : wiring[1] === pack.stripe_price_id
      : null;

    if (!deploymentCurrencyUsd) {
      reasons.push(
        "STRIPE_CURRENCY is not usd — the live checkout rejects ALL credit-pack purchases with 503 (deployment currency guard)",
      );
      classification = "ERRONEOUS";
    }

    let stripeChecks: PriceRead | null = null;
    if (stripe) {
      stripeChecks = await readStripePrice(
        stripe,
        pack.stripe_price_id,
        pack.price_cents,
      );
      if (stripeChecks.kind === "ok") {
        const purchasable =
          stripeChecks.active &&
          stripeChecks.usd &&
          stripeChecks.oneOff &&
          stripeChecks.amountMatchesDb;
        if (!pack.is_active) {
          if (classification !== "ERRONEOUS") classification = "DEPRECATED";
          reasons.push(
            purchasable
              ? "DB-inactive but the Stripe price is still live — consider archiving the price in Stripe when the catalogue decision lands"
              : "DB-inactive; not purchasable through the live path",
          );
        } else if (classification !== "ERRONEOUS") {
          if (!purchasable) {
            classification = "ERRONEOUS";
            if (!stripeChecks.active)
              reasons.push("Stripe price is archived/inactive");
            if (!stripeChecks.usd)
              reasons.push("Stripe price is non-USD currency");
            if (!stripeChecks.oneOff)
              reasons.push(
                "Stripe price is recurring — live path only accepts one-off prices",
              );
            if (!stripeChecks.amountMatchesDb)
              reasons.push(
                "Stripe unit_amount disagrees with DB price_cents — checkout would 503",
              );
          }
        }
      } else if (stripeChecks.kind === "missing") {
        if (pack.is_active) {
          classification = "ERRONEOUS";
          reasons.push("Stripe price does not exist (stale/unseeded price id)");
        } else if (classification !== "ERRONEOUS") {
          classification = "DEPRECATED";
          reasons.push("DB-inactive and the Stripe price no longer exists");
        }
      } else {
        // provider-error: never a pack defect — but a prior deployment-currency
        // ERRONEOUS verdict stands (the pack is unsellable regardless of
        // provider state).
        if (classification !== "ERRONEOUS") {
          classification = "UNKNOWN";
        }
        reasons.push(
          `Provider state unverifiable (Stripe error type: ${stripeChecks.errorType}) — classify after resolving provider access`,
        );
      }
    } else if (!stripe && pack.is_active) {
      if (classification !== "ERRONEOUS") {
        classification = "UNKNOWN";
      }
      reasons.push(
        "STRIPE_SECRET_KEY not configured — provider state unverifiable",
      );
    } else if (!stripe && !pack.is_active && classification !== "ERRONEOUS") {
      classification = "DEPRECATED";
      reasons.push("DB-inactive");
    }

    if (seededWiringMatches === false) {
      reasons.push(
        "stripe_price_id does not match the seeder's STRIPE_*_PACK_PRICE_ID env wiring for this pack name",
      );
    }
    if (economicsNote) reasons.push(economicsNote);

    results.push({
      id: pack.id,
      name: pack.name,
      dbActive: pack.is_active,
      credits,
      priceCents: pack.price_cents,
      impliedUsdPerCredit,
      customPathUsdPerCredit: 1,
      economicsNote,
      stripePriceId: pack.stripe_price_id,
      stripeChecks,
      deploymentCurrencyUsd,
      seededWiringMatches,
      classification,
      reasons,
    });
  }

  const summary = {
    total: results.length,
    active: results.filter((r) => r.classification === "ACTIVE").length,
    deprecated: results.filter((r) => r.classification === "DEPRECATED").length,
    erroneous: results.filter((r) => r.classification === "ERRONEOUS").length,
    unknown: results.filter((r) => r.classification === "UNKNOWN").length,
    liveCustomPath: { minUsd: 1, maxUsd: 1000, usdPerCredit: 1 },
    deploymentCurrencyUsd,
  };

  if (asJson) {
    console.log(JSON.stringify({ summary, packs: results }, null, 2));
    return;
  }

  console.log("\n=== Credit-pack reconciliation audit (#22963) ===\n");
  console.log(`Live custom-amount path: $1-$1000, 1 credit = $1.00\n`);
  for (const r of results) {
    console.log(`${r.classification.padEnd(10)} ${r.name}`);
    console.log(
      `  credits=$${r.credits.toFixed(2)}  price=$${(r.priceCents / 100).toFixed(2)}  implied=$${r.impliedUsdPerCredit?.toFixed(2) ?? "?"}/credit  dbActive=${r.dbActive}`,
    );
    if (r.stripeChecks?.kind === "ok") {
      console.log(
        `  stripe: active=${r.stripeChecks.active} usd=${r.stripeChecks.usd} oneOff=${r.stripeChecks.oneOff} amountMatchesDb=${r.stripeChecks.amountMatchesDb}`,
      );
    } else if (r.stripeChecks) {
      console.log(`  stripe: ${r.stripeChecks.kind}`);
    }
    for (const reason of r.reasons) console.log(`  - ${reason}`);
    console.log();
  }
  console.log(JSON.stringify(summary, null, 2));
}

// error-policy:J1 process-boundary translation — the CLI exits non-zero with
// the failure reason; never swallow.
main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("Audit failed:", error);
    process.exit(1);
  });

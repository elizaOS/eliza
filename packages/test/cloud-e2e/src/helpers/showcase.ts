/**
 * CI showcase-account seeding (#9300).
 *
 * The flagship example apps (EDAD, Clone Ur Crush) are continuously deployed and
 * exercised against Eliza Cloud by a dedicated CI showcase account funded with
 * effectively-infinite credits. This helper seeds that account THROUGH THE REAL
 * billing code path - `creditsService.addCredits` - so the showcase loop drives
 * the production credit ledger (the org `credit_balance` column and a real
 * `credit_transactions` row), NOT a mock balance. That is the whole point of the
 * "infinite credits" requirement: a CI bypass that still exercises the real
 * usage/billing pipeline so a regression in it fails the loop.
 *
 * ## Why "effectively infinite" instead of a literal bypass
 *
 * Granting a very large real balance ($1,000,000) keeps EVERY downstream check
 * honest: each monetized transaction runs `appCreditsService.deductCredits`, which
 * debits the same `FOR UPDATE` org ledger a paying customer hits, computes the
 * creator markup from app settings, and records the creator earning. The account
 * simply never runs dry across a run. A special-cased "skip billing" branch would
 * do the opposite - it would route the showcase account around the code we most
 * want to keep green.
 *
 * ## Isolation from real revenue
 *
 * Two layers, both observable:
 *  1. **Ephemeral DB (mock-stack loop).** The per-PR / nightly mock-stack loop
 *     runs against an in-process PGlite DB that is created and torn down per run.
 *     Nothing it writes can ever touch production revenue - there is no shared
 *     store.
 *  2. **Tagged ledger + reserved namespace (real-staging loop).** Every grant is
 *     stamped with {@link SHOWCASE_SEED_METADATA} (`type: "showcase_seed"`,
 *     `isolated: true`) and the account uses the reserved
 *     `@ci-showcase.elizacloud.test` email namespace and `ci-showcase-` slug
 *     prefix, so a revenue-reporting query CAN exclude showcase activity by that
 *     tag/namespace — auditable and excludable rather than silently mixed in.
 *     (Wiring that exclusion filter on the real revenue dashboard is the operator
 *     step when the real-staging showcase account is provisioned; the tag exists
 *     so it is a filter, not a schema migration.)
 *
 * See `packages/test/cloud-e2e/docs/showcase-apps-coverage.md` for the full
 * runbook (how it is seeded, kept isolated, and activated on real staging).
 */

import { randomUUID } from "node:crypto";
import { type SeededUser, seedTestUser } from "../fixtures/seed";

/** Reserved slug prefix for the CI showcase account. */
export const SHOWCASE_ACCOUNT_SLUG_PREFIX = "ci-showcase";

/** Reserved email namespace - revenue reporting excludes this domain. */
export const SHOWCASE_ACCOUNT_EMAIL_DOMAIN = "ci-showcase.elizacloud.test";

/**
 * The grant size, in USD. Large enough to be "infinite" for any run (a run
 * spends cents), small enough to stay an ordinary `numeric(12,6)` ledger value.
 */
export const SHOWCASE_CREDIT_GRANT_USD = 1_000_000;

/**
 * Metadata stamped on the showcase credit grant so it is auditable and excluded
 * from real-revenue reporting. Kept as a literal so a reporting filter can match
 * it exactly.
 */
export const SHOWCASE_SEED_METADATA = {
  type: "showcase_seed",
  account: "ci-showcase",
  isolated: true,
  issue: 9300,
} as const;

export interface ShowcaseAccount extends SeededUser {
  /** Credits granted via the real ledger on top of the seed balance (USD). */
  grantedCreditsUsd: number;
}

/**
 * Seed a CI showcase account with effectively-infinite credits via the real
 * credits ledger. The returned account owns the showcase apps and accrues their
 * creator earnings.
 *
 * The caller must ensure `DATABASE_URL` points at the running PGlite bridge
 * before calling (the `stack` fixture guarantees this).
 */
export async function seedShowcaseAccount(
  opts: { slug?: string } = {},
): Promise<ShowcaseAccount> {
  const slug =
    opts.slug ?? `${SHOWCASE_ACCOUNT_SLUG_PREFIX}-${randomUUID().slice(0, 8)}`;
  const user = await seedTestUser({
    slug,
    email: `${slug}@${SHOWCASE_ACCOUNT_EMAIL_DOMAIN}`,
  });

  // Grant through the REAL ledger - same path a Stripe credit-grant takes.
  const { creditsService } = await import(
    "@elizaos/cloud-shared/lib/services/credits"
  );
  await creditsService.addCredits({
    organizationId: user.organizationId,
    amount: SHOWCASE_CREDIT_GRANT_USD,
    description: "CI showcase account - effectively-infinite credits (#9300)",
    metadata: SHOWCASE_SEED_METADATA,
  });

  return { ...user, grantedCreditsUsd: SHOWCASE_CREDIT_GRANT_USD };
}

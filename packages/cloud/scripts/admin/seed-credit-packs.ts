/**
 * Seeds the cloud billing DB with the default credit-pack catalogue
 * (Small/Medium/Large), wiring each pack to the Stripe price/product ids
 * provided via STRIPE_*_PACK_* env vars. One-off admin script run manually
 * with bun against the DATABASE_URL from .env/.env.local.
 *
 * Idempotent by design (#22963): a pack whose `stripe_price_id` already
 * exists is left untouched — existing rows carry provider linkage and
 * historical receipts and must not be silently rewritten. The seeded
 * economics are pending product approval (AC2); changing them is a
 * deliberate operator decision, not a side effect of rerunning this script.
 * Use --dry-run to print the plan without writing.
 */
import { eq } from "drizzle-orm";

import { loadEnvFiles } from "./local-dev-helpers";

const dryRun = process.argv.includes("--dry-run");
const asJson = process.argv.includes("--json");

if (asJson) {
  // dotenv prints its injection banner to stdout; machine output must stay
  // pure. Must be set before loadEnvFiles below runs.
  process.env.DOTENV_CONFIG_QUIET ??= "true";
}

loadEnvFiles([".env", { path: ".env.local", override: true }]);

/**
 * Pending product approval (#22963 AC2): these USD credit grants are carried
 * verbatim from the original seed so reruns never change economics silently.
 * Any retained/repriced catalogue lands as an explicit follow-up edit here.
 */
const creditPacks = [
  {
    name: "Small Pack",
    description: "Perfect for testing and small projects",
    credits: 5.0, // $5.00 in credits
    price_cents: 4999, // $49.99 USD
    stripePriceIdEnv: "STRIPE_SMALL_PACK_PRICE_ID",
    stripeProductIdEnv: "STRIPE_SMALL_PACK_PRODUCT_ID",
    sort_order: 1,
  },
  {
    name: "Medium Pack",
    description: "Best value for regular usage",
    credits: 15.0, // $15.00 in credits
    price_cents: 12999, // $129.99 USD
    stripePriceIdEnv: "STRIPE_MEDIUM_PACK_PRICE_ID",
    stripeProductIdEnv: "STRIPE_MEDIUM_PACK_PRODUCT_ID",
    sort_order: 2,
  },
  {
    name: "Large Pack",
    description: "Maximum savings for power users",
    credits: 50.0, // $50.00 in credits
    price_cents: 39999, // $399.99 USD
    stripePriceIdEnv: "STRIPE_LARGE_PACK_PRICE_ID",
    stripeProductIdEnv: "STRIPE_LARGE_PACK_PRODUCT_ID",
    sort_order: 3,
  },
] as const;

interface PackPlan {
  name: string;
  stripe_price_id: string;
  stripe_product_id: string;
  credits: string;
  price_cents: number;
  sort_order: number;
  description: string;
  /** Set when the row already exists; the plan is to leave it untouched. */
  existing?: { credits: string; price_cents: number; is_active: boolean };
}

async function seedCreditPacks() {
  const plans: PackPlan[] = [];
  const missingEnv: string[] = [];
  for (const pack of creditPacks) {
    const stripePriceId = process.env[pack.stripePriceIdEnv];
    const stripeProductId = process.env[pack.stripeProductIdEnv];
    if (!stripePriceId || !stripeProductId) {
      missingEnv.push(
        `${pack.stripePriceIdEnv}${stripePriceId ? "" : " (missing)"} / ${pack.stripeProductIdEnv}${stripeProductId ? "" : " (missing)"}`,
      );
      continue;
    }
    plans.push({
      name: pack.name,
      description: pack.description,
      credits: pack.credits.toFixed(2),
      price_cents: pack.price_cents,
      sort_order: pack.sort_order,
      stripe_price_id: stripePriceId,
      stripe_product_id: stripeProductId,
    });
  }
  if (missingEnv.length > 0) {
    throw new Error(
      `Missing Stripe pack identifiers — refusing to seed partially:\n  ${missingEnv.join("\n  ")}`,
    );
  }

  const [{ db }, { creditPacks: creditPacksTable }] = await Promise.all([
    import("../../shared/src/db/client"),
    import("../../shared/src/db/schemas/credit-packs"),
  ]);

  if (!asJson) {
    console.log("🌱 Seeding credit packs...");
  }

  const inserted: string[] = [];
  const kept: PackPlan[] = [];
  const deprecated: string[] = [];
  const configuredPriceIds = new Set(plans.map((plan) => plan.stripe_price_id));
  for (const plan of plans) {
    const [existingRow] = await db
      .select({
        credits: creditPacksTable.credits,
        price_cents: creditPacksTable.price_cents,
        is_active: creditPacksTable.is_active,
      })
      .from(creditPacksTable)
      .where(eq(creditPacksTable.stripe_price_id, plan.stripe_price_id))
      .limit(1);
    if (existingRow) {
      // Never rewrite an existing pack row: it may already be referenced by
      // checkout orders and receipts. Reruns are read-only for present rows.
      plan.existing = {
        credits: existingRow.credits,
        price_cents: existingRow.price_cents,
        is_active: existingRow.is_active,
      };
      kept.push(plan);
      if (!asJson) {
        console.log(
          `• ${plan.name}: already present (credits=${existingRow.credits}, price_cents=${existingRow.price_cents}, active=${existingRow.is_active}) — left untouched`,
        );
      }
      continue;
    }
    if (dryRun) {
      if (!asJson) {
        console.log(
          `• ${plan.name}: would insert (credits=${plan.credits}, price_cents=${plan.price_cents}, price=${plan.stripe_price_id})`,
        );
      }
      continue;
    }
    const [result] = await db
      .insert(creditPacksTable)
      .values({
        name: plan.name,
        description: plan.description,
        credits: plan.credits,
        price_cents: plan.price_cents,
        stripe_price_id: plan.stripe_price_id,
        stripe_product_id: plan.stripe_product_id,
        sort_order: plan.sort_order,
      })
      .onConflictDoNothing({ target: creditPacksTable.stripe_price_id })
      .returning();
    if (result) {
      inserted.push(result.id);
      if (!asJson) {
        console.log(`✓ Created: ${plan.name} (${result.id})`);
      }
    } else {
      // Lost an insert race with a concurrent seeder: the row exists now.
      kept.push(plan);
      if (!asJson) {
        console.log(
          `• ${plan.name}: inserted concurrently — no duplicate created`,
        );
      }
    }
  }

  // AC4 stale-row repair: a catalogue row whose stripe_price_id is no longer
  // configured must stop being sellable. The row is preserved (historical
  // receipts and checkout orders reference it by id) but deactivated and
  // stamped exactly once; reruns find it already stamped and change nothing.
  for (const row of await db
    .select({
      id: creditPacksTable.id,
      name: creditPacksTable.name,
      stripe_price_id: creditPacksTable.stripe_price_id,
      is_active: creditPacksTable.is_active,
      metadata: creditPacksTable.metadata,
    })
    .from(creditPacksTable)) {
    if (configuredPriceIds.has(row.stripe_price_id)) continue;
    const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
    const stamps = Array.isArray(metadata.deprecation_stamps)
      ? (metadata.deprecation_stamps as unknown[])
      : [];
    const hasRepairStamp = stamps.some(
      (stamp) =>
        (stamp as { reason?: unknown })?.reason ===
        "stripe_price_id_no_longer_configured",
    );
    if (!row.is_active && hasRepairStamp) {
      // Already repaired by a previous run — a rerun must be a no-op. The
      // stamp is identified by its reason, not by stamp count, so unrelated
      // metadata stamps never mask a missing repair stamp (#22963).
      continue;
    }
    if (row.is_active && hasRepairStamp) {
      // Rare drift shape: the repair stamp exists but the row was reactivated
      // out-of-band. Repair only the activation — never append a second
      // matching stamp (#22963).
      if (dryRun) {
        deprecated.push(row.id);
        continue;
      }
      await db
        .update(creditPacksTable)
        .set({ is_active: false, updated_at: new Date() })
        .where(eq(creditPacksTable.id, row.id));
      deprecated.push(row.id);
      continue;
    }
    if (dryRun) {
      deprecated.push(row.id);
      if (!asJson) {
        console.log(
          `• ${row.name}: would deprecate (price ${row.stripe_price_id} no longer configured)`,
        );
      }
      continue;
    }
    await db
      .update(creditPacksTable)
      .set({
        is_active: false,
        metadata: {
          ...((row.metadata as Record<string, unknown> | null) ?? {}),
          deprecation_stamps: [
            ...stamps,
            {
              reason: "stripe_price_id_no_longer_configured",
              at: new Date().toISOString(),
            },
          ],
        },
        updated_at: new Date(),
      })
      .where(eq(creditPacksTable.id, row.id));
    deprecated.push(row.id);
    if (!asJson) {
      console.log(
        `• ${row.name}: deprecated (price ${row.stripe_price_id} no longer configured) — row preserved for historical receipts`,
      );
    }
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          dryRun,
          inserted,
          kept: kept.map((p) => ({
            name: p.name,
            stripe_price_id: p.stripe_price_id,
            credits: p.existing?.credits ?? p.credits,
            price_cents: p.existing?.price_cents ?? p.price_cents,
            is_active: p.existing?.is_active ?? null,
          })),
          deprecated,
        },
        null,
        2,
      ),
    );
  } else if (dryRun) {
    console.log("Dry run — no rows written.");
  } else {
    console.log(
      `✅ Credit pack seed complete: ${inserted.length} created, ${kept.length} already present, ${deprecated.length} deprecated.`,
    );
  }
}

seedCreditPacks()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error("❌ Error seeding credit packs:", error);
    process.exit(1);
  });

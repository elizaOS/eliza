/**
 * Seeds the cloud billing DB with the default credit-pack catalogue
 * (Small/Medium/Large), wiring each pack to the Stripe price/product ids
 * provided via STRIPE_*_PACK_* env vars. One-off admin script run manually
 * with bun against the DATABASE_URL from .env/.env.local.
 *
 * Idempotent by design (#22963): a pack whose `stripe_price_id` already
 * exists is left untouched — existing rows carry provider linkage and
 * historical receipts and must not be silently rewritten. One exception:
 * a row the script's own stale-repair deactivated is reactivated when its
 * price id is configured again (configuration rollback). Reactivation is
 * authorized by the row's recorded last-lifecycle-event provenance and is
 * applied as a compare-and-set on the observed row state, so concurrent
 * writers are never overwritten and an operator archive made after any
 * OBSERVED lifecycle change is never reverted. Rows deactivated by an
 * earlier revision of this script (deprecation_stamps but no
 * last_lifecycle_event) are deliberately treated as unproven: they are
 * never auto-reactivated — if a persistent DB carries one, reactivate it
 * manually after a repoint rather than relying on this script. Known
 * residual: an operator
 * toggling a repair-deactivated row active and then inactive with no
 * metadata write and no intervening run leaves the row byte-identical to
 * a repair-deactivated row; such a row is reactivated on rollback (a
 * later plain archive after that reactivation IS respected). A second
 * residual: archiving an UNCONFIGURED inactive row (a plain operator
 * archive of a pack whose price id is not currently configured) gets the
 * first-time deprecation stamp on the next run, which authorizes a future
 * rollback reactivation — archive again after that rollback run if this
 * matters (that second archive sticks). Under --dry-run the reactivation
 * branch reports the projected post-run state (kept[].is_active = true
 * and the "reactivated" wording) while writing nothing; the JSON
 * envelope's dryRun flag disambiguates for machines. The `reactivated`
 * array carries price ids (not row ids) — filter it against
 * `kept[].stripe_price_id` when joining with `inserted`/`deprecated`,
 * which carry row ids. The seeded
 * economics are pending product approval (AC2); changing them is a
 * deliberate operator decision, not a side effect of rerunning this
 * script. Use --dry-run to print the plan without writing.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";

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
  const reactivated: string[] = [];
  const configuredPriceIds = new Set(plans.map((plan) => plan.stripe_price_id));
  for (const plan of plans) {
    const [existingRow] = await db
      .select({
        id: creditPacksTable.id,
        credits: creditPacksTable.credits,
        price_cents: creditPacksTable.price_cents,
        is_active: creditPacksTable.is_active,
        metadata: creditPacksTable.metadata,
      })
      .from(creditPacksTable)
      .where(eq(creditPacksTable.stripe_price_id, plan.stripe_price_id))
      .limit(1);
    if (existingRow?.is_active) {
      // Provenance normalization: the row is ACTIVE but its recorded last
      // lifecycle event says "deactivated" — someone revived it out-of-band.
      // A stale marker would later authorize reactivation and defeat a
      // subsequent operator archive. Record what was observed so the marker
      // reflects reality; nothing else about the row changes.
      const activeMetadata =
        (existingRow.metadata as Record<string, unknown> | null) ?? {};
      const lastActive = activeMetadata.last_lifecycle_event as {
        kind?: unknown;
      } | null;
      if (lastActive?.kind === "deactivated" && !dryRun) {
        const observedEvent = {
          kind: "activated_out_of_band",
          reason: "observed_active_after_repair_deactivation",
          at: new Date().toISOString(),
        };
        await db
          .update(creditPacksTable)
          .set({
            metadata: {
              ...activeMetadata,
              last_lifecycle_event: observedEvent,
            },
            updated_at: new Date(),
          })
          .where(
            and(
              eq(creditPacksTable.id, existingRow.id),
              eq(creditPacksTable.is_active, true),
              eq(creditPacksTable.metadata, existingRow.metadata),
            ),
          );
      }
    }
    if (existingRow && !existingRow.is_active) {
      // Configuration rollback (A→B→A): the price id is configured again
      // while the row sits deactivated. Reactivation is authorized by the
      // row's CURRENT-STATE provenance — the last lifecycle event recorded
      // on the row must be this script's own deactivation — never by the
      // mere existence of historical repair stamps, which would silently
      // revert a later operator archive. Economics and provider identity
      // are never rewritten; stamp history stays append-only; the update
      // is guarded on the observed current state so a concurrent writer
      // that changed the row between read and write is never overridden.
      const metadata =
        (existingRow.metadata as Record<string, unknown> | null) ?? {};
      const lastLifecycle = metadata.last_lifecycle_event as {
        kind?: unknown;
        reason?: unknown;
      } | null;
      const deactivatedByRepair =
        lastLifecycle?.kind === "deactivated" &&
        lastLifecycle?.reason === "stripe_price_id_no_longer_configured";
      if (deactivatedByRepair) {
        const reactStamps = Array.isArray(metadata.reactivation_stamps)
          ? (metadata.reactivation_stamps as unknown[])
          : [];
        const nextEvent = {
          kind: "reactivated",
          reason: "stripe_price_id_configured_again",
          at: new Date().toISOString(),
        };
        const reactivationMetadata = {
          ...metadata,
          reactivation_stamps: [...reactStamps, nextEvent],
          last_lifecycle_event: nextEvent,
        };
        if (!dryRun) {
          // Guarded, id-scoped update: only fires when the row is still in
          // the exact observed state (inactive, deactivated by repair).
          const reactivatedRows = await db
            .update(creditPacksTable)
            .set({
              is_active: true,
              metadata: reactivationMetadata,
              updated_at: new Date(),
            })
            .where(
              and(
                eq(creditPacksTable.id, existingRow.id),
                eq(creditPacksTable.is_active, false),
                eq(creditPacksTable.metadata, existingRow.metadata),
              ),
            )
            .returning({ id: creditPacksTable.id });
          if (reactivatedRows.length === 0) {
            // Lost the race: a concurrent writer changed the row after our
            // read. Report the row as present but not reactivated here.
            plan.existing = {
              credits: existingRow.credits,
              price_cents: existingRow.price_cents,
              is_active: false,
            };
            kept.push(plan);
            if (!asJson) {
              console.log(
                `• ${plan.name}: row changed concurrently — reactivation skipped`,
              );
            }
            continue;
          }
        }
        reactivated.push(plan.stripe_price_id);
        plan.existing = {
          credits: existingRow.credits,
          price_cents: existingRow.price_cents,
          is_active: true,
        };
        kept.push(plan);
        if (!asJson) {
          console.log(
            `• ${plan.name}: reactivated (price ${plan.stripe_price_id} configured again; economics preserved)`,
          );
        }
        continue;
      }
    }
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
  const catalogueRows = await db
    .select({
      id: creditPacksTable.id,
      name: creditPacksTable.name,
      stripe_price_id: creditPacksTable.stripe_price_id,
      is_active: creditPacksTable.is_active,
      metadata: creditPacksTable.metadata,
    })
    .from(creditPacksTable);

  // Test-only interleave hook (#26599 CAS-race proof): pause with the
  // catalogue snapshot held, before any deactivation write, until the marker
  // disappears. Never active unless the env var is set by the test harness.
  if (process.env.ELIZA_TEST_CAS_PAUSE_DIR) {
    const { writeFile: mark, unlink: unmark } = await import(
      "node:fs/promises"
    );
    const marker = path.join(process.env.ELIZA_TEST_CAS_PAUSE_DIR, "paused");
    await mark(marker, String(Date.now()));
    for (let i = 0; i < 240; i++) {
      if (!existsSync(marker)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    await unmark(marker).catch(() => {});
  }

  for (const row of catalogueRows) {
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
      // matching stamp (#22963). Compare-and-set on the observed state so a
      // concurrent operator/reconciler change between read and write is never
      // overwritten by this stale-snapshot metadata (#26599 review).
      if (dryRun) {
        deprecated.push(row.id);
        continue;
      }
      const driftEvent = {
        kind: "deactivated",
        reason: "stripe_price_id_no_longer_configured",
        at: new Date().toISOString(),
      };
      const driftRows = await db
        .update(creditPacksTable)
        .set({
          is_active: false,
          metadata: {
            ...metadata,
            last_lifecycle_event: driftEvent,
          },
          updated_at: new Date(),
        })
        .where(
          and(
            eq(creditPacksTable.id, row.id),
            eq(creditPacksTable.is_active, row.is_active),
            eq(creditPacksTable.metadata, row.metadata),
          ),
        )
        .returning({ id: creditPacksTable.id });
      if (driftRows.length === 0) {
        // Lost the race: the row changed after our snapshot — a concurrent
        // operator change must survive, not be reverted as "deprecated".
        if (!asJson) {
          console.log(
            `• ${row.name}: row changed concurrently — deactivation skipped`,
          );
        }
        continue;
      }
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
    const deprecationEvent = {
      kind: "deactivated",
      reason: "stripe_price_id_no_longer_configured",
      at: new Date().toISOString(),
    };
    // Compare-and-set on the observed snapshot (activation + metadata), same
    // shape as the reactivation path: a concurrent operator/reconciler change
    // between the catalogue read and this update must survive — a zero-row
    // update is a lost race, not a successful repair (#26599 review).
    const deprecatedRows = await db
      .update(creditPacksTable)
      .set({
        is_active: false,
        metadata: {
          ...((row.metadata as Record<string, unknown> | null) ?? {}),
          deprecation_stamps: [
            ...stamps,
            {
              reason: "stripe_price_id_no_longer_configured",
              at: deprecationEvent.at,
            },
          ],
          last_lifecycle_event: deprecationEvent,
        },
        updated_at: new Date(),
      })
      .where(
        and(
          eq(creditPacksTable.id, row.id),
          eq(creditPacksTable.is_active, row.is_active),
          eq(creditPacksTable.metadata, row.metadata),
        ),
      )
      .returning({ id: creditPacksTable.id });
    if (deprecatedRows.length === 0) {
      // Lost the race: the row changed after our snapshot. Do not report the
      // row as deprecated — the concurrent writer owns the row now.
      if (!asJson) {
        console.log(
          `• ${row.name}: row changed concurrently — deactivation skipped`,
        );
      }
      continue;
    }
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
          reactivated,
        },
        null,
        2,
      ),
    );
  } else if (dryRun) {
    console.log("Dry run — no rows written.");
  } else {
    console.log(
      `✅ Credit pack seed complete: ${inserted.length} created, ${kept.length} already present, ${deprecated.length} deprecated, ${reactivated.length} reactivated.`,
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

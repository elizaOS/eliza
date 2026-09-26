/**
 * Seeds the cloud billing DB with the default credit-pack catalog
 * (Small/Medium/Large), wiring each pack to the Stripe price/product ids
 * provided via STRIPE_*_PACK_* env vars. One-off admin script run manually
 * with bun against the DATABASE_URL from .env/.env.local. Defaults to a dry-run;
 * writes require --apply --acknowledge-price-credit-ratios. Existing rows are never reactivated.
 */
import { loadEnvFiles } from "./local-dev-helpers";

loadEnvFiles([".env", { path: ".env.local", override: true }]);

const creditPacks = [
  {
    name: "Small Pack",
    description: "Perfect for testing and small projects",
    credits: 5.0, // $5.00 in credits
    price_cents: 4999, // $49.99 USD
    stripe_price_id: process.env.STRIPE_SMALL_PACK_PRICE_ID ?? "",
    stripe_product_id: process.env.STRIPE_SMALL_PACK_PRODUCT_ID ?? "",
    sort_order: 1,
  },
  {
    name: "Medium Pack",
    description: "Best value for regular usage",
    credits: 15.0, // $15.00 in credits
    price_cents: 12999, // $129.99 USD
    stripe_price_id: process.env.STRIPE_MEDIUM_PACK_PRICE_ID ?? "",
    stripe_product_id: process.env.STRIPE_MEDIUM_PACK_PRODUCT_ID ?? "",
    sort_order: 2,
  },
  {
    name: "Large Pack",
    description: "Maximum savings for power users",
    credits: 50.0, // $50.00 in credits
    price_cents: 39999, // $399.99 USD
    stripe_price_id: process.env.STRIPE_LARGE_PACK_PRICE_ID ?? "",
    stripe_product_id: process.env.STRIPE_LARGE_PACK_PRODUCT_ID ?? "",
    sort_order: 3,
  },
];

async function seedCreditPacks() {
  const apply = process.argv.includes("--apply");
  if (
    process.argv
      .slice(2)
      .some(
        (arg) =>
          ![
            "--apply",
            "--acknowledge-price-credit-ratios",
            "--dry-run",
          ].includes(arg),
      )
  )
    throw new Error("Unknown option");
  if (apply && process.argv.includes("--dry-run"))
    throw new Error("Choose either --apply or --dry-run");
  if (apply && !process.argv.includes("--acknowledge-price-credit-ratios")) {
    throw new Error(
      "Review the price/credit ratios in the dry-run, then explicitly pass --acknowledge-price-credit-ratios with --apply",
    );
  }
  for (const pack of creditPacks) {
    if (
      !/^price_[A-Za-z0-9]+$/.test(pack.stripe_price_id ?? "") ||
      !/^prod_[A-Za-z0-9]+$/.test(pack.stripe_product_id ?? "")
    ) {
      throw new Error(
        `Configure valid Stripe price and product IDs for ${pack.name}`,
      );
    }
  }
  if (
    new Set(creditPacks.map((pack) => pack.stripe_price_id)).size !==
    creditPacks.length
  )
    throw new Error("Each pack requires a distinct Stripe price");
  console.log(
    JSON.stringify(
      {
        apply,
        packs: creditPacks.map((pack) => ({
          ...pack,
          chargedUsd: pack.price_cents / 100,
          grantedCreditUsd: pack.credits,
        })),
      },
      null,
      2,
    ),
  );
  if (!apply) return;
  const [{ db }, { creditPacks: table }, { eq }] = await Promise.all([
    import("../../shared/src/db/client"),
    import("../../shared/src/db/schemas/credit-packs"),
    import("drizzle-orm"),
  ]);
  await db.transaction(async (tx) => {
    for (const pack of creditPacks) {
      await tx
        .insert(table)
        .values(pack)
        .onConflictDoNothing({ target: table.stripe_price_id });
      const [stored] = await tx
        .select()
        .from(table)
        .where(eq(table.stripe_price_id, pack.stripe_price_id));
      if (
        !stored ||
        stored.stripe_product_id !== pack.stripe_product_id ||
        Number(stored.credits) !== pack.credits ||
        stored.price_cents !== pack.price_cents
      ) {
        throw new Error(
          `Existing ${pack.name} differs from the reviewed configuration; no packs were changed`,
        );
      }
      // Existing rows retain activation and lifecycle metadata. Configuration
      // changes never authorize reactivating or deactivating a historical pack.
    }
  });
  console.log("Credit packs reconciled; existing activation states preserved.");
}

seedCreditPacks()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

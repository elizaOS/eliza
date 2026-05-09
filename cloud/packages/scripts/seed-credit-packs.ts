import { loadEnvFiles } from "./local-dev-helpers";

loadEnvFiles([".env", { path: ".env.local", override: true }]);

const creditPacks = [
  {
    name: "Small Pack",
    description: "Perfect for testing and small projects",
    credits: 5.0, // $5.00 in credits
    price_cents: 4999, // $49.99 USD
    stripe_price_id: process.env.STRIPE_SMALL_PACK_PRICE_ID!,
    stripe_product_id: process.env.STRIPE_SMALL_PACK_PRODUCT_ID!,
    sort_order: 1,
  },
  {
    name: "Medium Pack",
    description: "Best value for regular usage",
    credits: 15.0, // $15.00 in credits
    price_cents: 12999, // $129.99 USD
    stripe_price_id: process.env.STRIPE_MEDIUM_PACK_PRICE_ID!,
    stripe_product_id: process.env.STRIPE_MEDIUM_PACK_PRODUCT_ID!,
    sort_order: 2,
  },
  {
    name: "Large Pack",
    description: "Maximum savings for power users",
    credits: 50.0, // $50.00 in credits
    price_cents: 39999, // $399.99 USD
    stripe_price_id: process.env.STRIPE_LARGE_PACK_PRICE_ID!,
    stripe_product_id: process.env.STRIPE_LARGE_PACK_PRODUCT_ID!,
    sort_order: 3,
  },
];

async function seedCreditPacks() {
  const [{ db }, { creditPacks: creditPacksTable }] = await Promise.all([
    import("../db/client"),
    import("../db/schemas/credit-packs"),
  ]);

  console.log("🌱 Seeding credit packs...");

  for (const pack of creditPacks) {
    try {
      const [result] = await db.insert(creditPacksTable).values(pack).returning();
      console.log(`✓ Created: ${pack.name} (${result.id})`);
    } catch (error) {
      console.error(`✗ Failed to create ${pack.name}:`, error);
    }
  }

  console.log("✅ Credit packs seeded successfully!");
}

seedCreditPacks()
  .then(() => {
    console.log("🎉 Done!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("❌ Error seeding credit packs:", error);
    process.exit(1);
  });

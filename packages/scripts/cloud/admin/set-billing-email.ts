/**
 * Script to set billing email for an organization
 * This is a one-time setup script to ensure billing emails are sent
 *
 * Usage: tsx packages/scripts/set-billing-email.ts <org-id> <email>
 */

import { eq } from "drizzle-orm";
import { loadEnvFiles } from "./local-dev-helpers";

loadEnvFiles();

async function setBillingEmail(orgId: string, email: string) {
  const [{ db }, { organizations }] = await Promise.all([
    import("@/db/client"),
    import("@/db/schemas/organizations"),
  ]);

  try {
    console.log(`Setting billing email for organization ${orgId} to ${email}`);

    const [org] = await db
      .update(organizations)
      .set({
        billing_email: email,
        updated_at: new Date(),
      })
      .where(eq(organizations.id, orgId))
      .returning();

    if (org) {
      console.log("✅ Billing email updated successfully");
      console.log(`   Organization: ${org.name}`);
      console.log(`   Billing Email: ${org.billing_email}`);
    } else {
      console.error("❌ Organization not found");
      process.exit(1);
    }
  } catch (error) {
    console.error("❌ Error updating billing email:", error);
    process.exit(1);
  }
}

// Get command line arguments
const orgId = process.argv[2];
const email = process.argv[3];

if (!orgId || !email) {
  console.error("Usage: tsx packages/scripts/set-billing-email.ts <org-id> <email>");
  console.error("\nExample:");
  console.error(
    "  tsx packages/scripts/set-billing-email.ts 67e22ff7-257b-41a3-8773-513a4674d1bb user@example.com",
  );
  process.exit(1);
}

setBillingEmail(orgId, email).then(() => {
  console.log("\n✅ Done!");
  process.exit(0);
});

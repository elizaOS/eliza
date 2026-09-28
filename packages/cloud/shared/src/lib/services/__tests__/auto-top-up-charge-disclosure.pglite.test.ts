/**
 * Affiliate surcharge disclosure for card auto top-up (#23020) on PGlite: the
 * pre-save preview reads the real affiliate attribution and returns the
 * credited base, affiliate markup, platform fee and total as separate lines,
 * and the receipt breakdown parsed from the durable charge metadata matches.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";

const ambientDatabaseUrl = process.env.DATABASE_URL ?? "";
if (ambientDatabaseUrl && !ambientDatabaseUrl.startsWith("pglite")) {
  throw new Error(
    "auto-top-up-charge-disclosure.pglite.test requires an isolated PGlite DATABASE_URL",
  );
}
process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { affiliateCodes, userAffiliates } from "../../../db/schemas/affiliates";
import { organizations } from "../../../db/schemas/organizations";
import { users } from "../../../db/schemas/users";

const TEST_TIMEOUT = 300_000;

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests;

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
  const { apply } = await pushSchema(
    { organizations, users, affiliateCodes, userAffiliates } as never,
    dbWrite as never,
  );
  await apply();
}, TEST_TIMEOUT);

afterAll(async () => {
  await closeDb();
});

async function seedOrganization(markupPercent: string | null) {
  const [organization] = await dbWrite
    .insert(organizations)
    .values({ name: "Buyer", slug: unique("org") })
    .returning();
  const [buyer] = await dbWrite
    .insert(users)
    .values({ steward_user_id: unique("buyer"), organization_id: organization.id })
    .returning();
  if (markupPercent !== null) {
    const [affiliate] = await dbWrite
      .insert(users)
      .values({ steward_user_id: unique("affiliate") })
      .returning();
    const [code] = await dbWrite
      .insert(affiliateCodes)
      .values({ user_id: affiliate.id, code: unique("CODE"), markup_percent: markupPercent })
      .returning();
    await dbWrite.insert(userAffiliates).values({ user_id: buyer.id, affiliate_code_id: code.id });
  }
  return organization.id;
}

test(
  "an attributed organization sees the markup and platform fee as separate lines before saving",
  async () => {
    const { AutoTopUpService } = await import("../auto-top-up");
    const organizationId = await seedOrganization("10.00");
    const preview = await new AutoTopUpService().previewCharge(organizationId, 25);
    expect(preview).toEqual({
      attribution: "affiliate",
      breakdown: {
        creditedBaseUsd: "25.00",
        affiliateMarkupUsd: "2.50",
        platformFeeUsd: "5.00",
        totalChargeUsd: "32.50",
        surchargeApplies: true,
      },
    });
  },
  TEST_TIMEOUT,
);

test(
  "an unattributed organization is charged the credited amount only",
  async () => {
    const { AutoTopUpService } = await import("../auto-top-up");
    const organizationId = await seedOrganization(null);
    const preview = await new AutoTopUpService().previewCharge(organizationId, 25);
    expect(preview).toEqual({
      attribution: "none",
      breakdown: {
        creditedBaseUsd: "25.00",
        affiliateMarkupUsd: "0.00",
        platformFeeUsd: "0.00",
        totalChargeUsd: "25.00",
        surchargeApplies: false,
      },
    });
  },
  TEST_TIMEOUT,
);

test(
  "rounding at the maximum markup and the receipt breakdown agree with the charged total",
  async () => {
    const { AutoTopUpService } = await import("../auto-top-up");
    const { autoTopUpChargeBreakdownFromMetadata } = await import(
      "../auto-top-up-charge-breakdown"
    );
    const organizationId = await seedOrganization("1000.00");
    const preview = await new AutoTopUpService().previewCharge(organizationId, 10.01);
    expect(preview.breakdown).toEqual({
      creditedBaseUsd: "10.01",
      affiliateMarkupUsd: "100.10",
      platformFeeUsd: "2.00",
      totalChargeUsd: "112.11",
      surchargeApplies: true,
    });

    // The durable charge signs these fields into the PaymentIntent metadata
    // and copies them onto the credit transaction; the receipt reads them back.
    const receipt = autoTopUpChargeBreakdownFromMetadata({
      type: "auto_top_up",
      fees_included: "true",
      base_amount: "10.01",
      affiliate_fee_amount: "100.10",
      platform_fee_amount: "2.00",
      total_charged: "112.11",
    });
    expect(receipt).toEqual(preview.breakdown);

    // Lines that do not add up to the charged total are never shown.
    expect(
      autoTopUpChargeBreakdownFromMetadata({
        type: "auto_top_up",
        fees_included: "true",
        base_amount: "10.01",
        affiliate_fee_amount: "100.10",
        platform_fee_amount: "2.00",
        total_charged: "112.12",
      }),
    ).toBeNull();
  },
  TEST_TIMEOUT,
);

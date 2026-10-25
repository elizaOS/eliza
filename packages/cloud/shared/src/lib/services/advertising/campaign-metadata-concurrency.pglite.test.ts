/**
 * A campaign's metadata holds both the attribution token secret and the
 * dayparting schedule. Each writer changes only its own key, against the
 * stored object, so a concurrent writer's key survives. Real advertising
 * service and repository over PGlite; the second writer runs right after the
 * first one has read the campaign, before it writes.
 */
import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const { closeDatabaseConnectionsForTests, dbWrite } = await import("../../../db/client");
const { adCampaigns } = await import("../../../db/schemas/ad-campaigns");
const { adCampaignsRepository } = await import("../../../db/repositories/ad-campaigns");
const { advertisingService } = await import("./index");

const ORG = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN = "22222222-2222-4222-8222-222222222222";
const SCHEDULE = {
  timezone: "UTC",
  windows: [{ daysOfWeek: [1, 2, 3, 4, 5], startTime: "09:00", endTime: "17:00" }],
};

const verify = (token: string) =>
  (
    advertisingService as unknown as { verifyAttributionToken(t: string): Promise<unknown> }
  ).verifyAttributionToken(token);

/** Runs `other` once, right after the next campaign read. */
function afterNextRead(other: () => Promise<unknown>) {
  const original = adCampaignsRepository.findById.bind(adCampaignsRepository);
  let pending: (() => Promise<unknown>) | null = other;
  return spyOn(adCampaignsRepository, "findById").mockImplementation(async (id) => {
    const row = await original(id);
    const run = pending;
    pending = null;
    if (run) await run();
    return row;
  });
}

async function storedMetadata(): Promise<Record<string, unknown>> {
  const result = await dbWrite.execute(
    sql.raw(`SELECT metadata FROM ad_campaigns WHERE id = '${CAMPAIGN}'`),
  );
  return (result.rows[0] as { metadata: Record<string, unknown> }).metadata;
}

beforeAll(async () => {
  const config = getTableConfig(adCampaigns);
  await dbWrite.execute(
    sql.raw(
      `CREATE TABLE ${config.name} (${config.columns
        .map(
          (column) =>
            `"${column.name}" ${column.getSQLType()}${column.name === "id" ? " PRIMARY KEY" : ""}`,
        )
        .join(",")})`,
    ),
  );
});

beforeEach(async () => {
  await dbWrite.execute(sql.raw("TRUNCATE TABLE ad_campaigns"));
  await dbWrite.execute(
    sql.raw(`INSERT INTO ad_campaigns (id, organization_id, name, status, metadata)
      VALUES ('${CAMPAIGN}', '${ORG}', 'Launch', 'draft', '{}'::jsonb)`),
  );
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

test("a dayparting save during the first attribution request keeps the issued token valid", async () => {
  let issued = "";
  const spy = afterNextRead(async () => {
    issued = (await advertisingService.getAttributionToken(CAMPAIGN, ORG)).token;
  });
  try {
    await advertisingService.updateCampaign(CAMPAIGN, ORG, { dayparting: SCHEDULE });
  } finally {
    spy.mockRestore();
  }

  const metadata = await storedMetadata();
  expect(metadata.dayparting).toEqual(SCHEDULE);
  await expect(verify(issued)).resolves.toBeDefined();
});

test("two first attribution requests at once issue tokens that both verify", async () => {
  let second = "";
  const spy = afterNextRead(async () => {
    second = (await advertisingService.getAttributionToken(CAMPAIGN, ORG)).token;
  });
  let first = "";
  try {
    first = (await advertisingService.getAttributionToken(CAMPAIGN, ORG)).token;
  } finally {
    spy.mockRestore();
  }

  await expect(verify(first)).resolves.toBeDefined();
  await expect(verify(second)).resolves.toBeDefined();
});

test("minting the attribution secret does not revert a dayparting schedule saved meanwhile", async () => {
  const spy = afterNextRead(() =>
    advertisingService.updateCampaign(CAMPAIGN, ORG, { dayparting: SCHEDULE }),
  );
  let issued = "";
  try {
    issued = (await advertisingService.getAttributionToken(CAMPAIGN, ORG)).token;
  } finally {
    spy.mockRestore();
  }

  expect((await storedMetadata()).dayparting).toEqual(SCHEDULE);
  await expect(verify(issued)).resolves.toBeDefined();
});

test("clearing the schedule removes only the dayparting key", async () => {
  await advertisingService.updateCampaign(CAMPAIGN, ORG, { dayparting: SCHEDULE });
  const { token } = await advertisingService.getAttributionToken(CAMPAIGN, ORG);

  await advertisingService.updateCampaign(CAMPAIGN, ORG, { dayparting: null });

  expect((await storedMetadata()).dayparting).toBeUndefined();
  await expect(verify(token)).resolves.toBeDefined();
});

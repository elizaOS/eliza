/**
 * The domain health cron probes up to a batch of not-yet-live domains per
 * tick. A domain that keeps failing its probe must not keep newer domains
 * from ever being probed; otherwise their `is_live` never flips.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
process.env.ENVIRONMENT = "local";

const probed: string[] = [];
mock.module("../security/safe-fetch", () => ({
  async safeFetch(url: string) {
    const host = new URL(url).hostname;
    probed.push(host);
    return new Response("", { status: host.startsWith("broken") ? 503 : 200 });
  },
}));

const ORG = "75000000-0000-4000-8000-000000000001";
let client: typeof import("../../db/client");
let health: typeof import("./domain-health");

beforeAll(async () => {
  client = await import("../../db/client");
  const domains = await import("../../db/schemas/managed-domains");
  const pglite = client.getPgliteClientForTests();
  const empty = generateDrizzleJson({});
  for (const statement of await generateMigration(
    empty,
    generateDrizzleJson(
      {
        domainRegistrarEnum: domains.domainRegistrarEnum,
        domainNameserverModeEnum: domains.domainNameserverModeEnum,
        domainResourceTypeEnum: domains.domainResourceTypeEnum,
        domainModerationStatusEnum: domains.domainModerationStatusEnum,
        domainStatusEnum: domains.domainStatusEnum,
        managedDomains: domains.managedDomains,
      },
      empty.id,
    ),
  )) {
    if (/REFERENCES "/.test(statement)) continue;
    await pglite.exec(statement.replaceAll('"public".', ""));
  }
  health = await import("./domain-health");
  const insert = (domain: string, minutesAgo: number) =>
    pglite.query(
      `INSERT INTO managed_domains(organization_id, domain, registrar, status, verified, is_live, created_at, updated_at)
       VALUES ($1, $2, 'cloudflare', 'active', true, false, now() - ($3 || ' minutes')::interval, now() - ($3 || ' minutes')::interval)`,
      [ORG, domain, String(minutesAgo)],
    );
  // Two domains that never answer, then one that does.
  await insert("broken-a.example", 30);
  await insert("broken-b.example", 20);
  await insert("ready.example", 10);
}, 120_000);

afterAll(async () => {
  await client.closeDatabaseConnectionsForTests();
});

test("domains that keep failing do not keep a newer domain from being probed", async () => {
  for (let tick = 0; tick < 3; tick++) await health.probeDomainHealth(new Date(), 2);

  expect(probed).toContain("ready.example");
  const rows = await client
    .getPgliteClientForTests()
    .query<{ domain: string; is_live: boolean }>(
      "SELECT domain, is_live FROM managed_domains ORDER BY domain",
    );
  expect(rows.rows).toEqual([
    { domain: "broken-a.example", is_live: false },
    { domain: "broken-b.example", is_live: false },
    { domain: "ready.example", is_live: true },
  ]);
});

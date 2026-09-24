/** Runs the shared paid-renewal recovery contract against migrated in-memory PGlite and actual loopback Stripe transport. */
import { definePaidRenewalRecoveryContract } from "./test-support/subscription-paid-renewal-recovery-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
let client: typeof import("../client") | undefined;
definePaidRenewalRecoveryContract({
  async setup() {
    client = await import("../client");
  },
  async exec(sql) {
    if (!client) throw new Error("PGlite fixture not initialized");
    await client.getPgliteClientForTests().exec(sql);
  },
  async query<Row extends Record<string, unknown>>(sql: string, values?: unknown[]) {
    if (!client) throw new Error("PGlite fixture not initialized");
    return client.getPgliteClientForTests().query<Row>(sql, values);
  },
  async close() {
    if (client) await client.closeDatabaseConnectionsForTests();
  },
});

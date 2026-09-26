import { randomUUID } from "node:crypto";
import type { UUID } from "@elizaos/core";
import { expect, it } from "vitest";
import { PgDatabaseAdapter } from "../pg/adapter";
import { PostgresConnectionManager } from "../pg/manager";
import { createIsolatedTestDatabase } from "./test-helpers";

it("atomically claims cache values across SQL connections and agent scopes", async () => {
  // The opt-in URL must name a disposable database: the migration helper resets it.
  const postgresUrl = process.env.CACHE_CAS_TEST_POSTGRES_URL ?? null;
  if (postgresUrl && !new URL(postgresUrl).pathname.startsWith("/eliza_cas_test"))
    throw new Error("Use a disposable eliza_cas_test database");
  const fixture = await createIsolatedTestDatabase("cache-cas", [], { postgresUrl });
  const other = postgresUrl
    ? new PgDatabaseAdapter(fixture.testAgentId, new PostgresConnectionManager(postgresUrl))
    : fixture.adapter;
  try {
    const adapters = [fixture.adapter, other];
    const winners = await Promise.all(
      Array.from({ length: 12 }, (_, writer) =>
        adapters[writer % 2]!.compareAndSetCache("claim", undefined, { writer })
      )
    );
    expect(winners.filter(Boolean)).toHaveLength(1);
    const observed = await fixture.runtime.getCache("claim");
    const replacements = await Promise.all(
      adapters.map((adapter, writer) =>
        adapter.compareAndSetCache("claim", observed, { replacement: writer })
      )
    );
    expect(replacements.filter(Boolean)).toHaveLength(1);
    expect(await other.compareAndSetCache("absent", null, 1)).toBe(false);
    expect(await other.compareAndSetCache("null", undefined, null)).toBe(true);
    expect(await other.compareAndSetCache("null", null, { b: 2, a: 1 })).toBe(true);
    expect(await other.compareAndSetCache("null", { a: 1, b: 2 }, "done")).toBe(true);
    const isolatedId = randomUUID() as UUID;
    await fixture.adapter.createAgent({ id: isolatedId, name: "Other owner", bio: [] });
    await fixture.adapter.withAgentScope(isolatedId, async (scoped) => {
      expect(await scoped.compareAndSetCache("claim", undefined, "isolated")).toBe(true);
    });
    expect(await fixture.runtime.getCache("claim")).not.toBe("isolated");
    await expect(
      other.compareAndSetCache("bad", undefined, { x: undefined })
    ).rejects.toMatchObject({ code: "CACHE_CAS_INVALID_VALUE" });
  } finally {
    if (other !== fixture.adapter) await other.close();
    await fixture.cleanup();
  }
});

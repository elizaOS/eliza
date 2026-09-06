/** Exercises cloud identity persistence and deletion against the actual SQL migration in isolated PGlite. */
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { agentIdentities } from "../schemas/agent-identities";

test("identity migration permits API-shaped writes and preserves identity uniqueness and cascade ownership", async () => {
  const client = new PGlite();
  const database = drizzle(client);
  try {
    await client.exec(
      "CREATE TABLE organizations (id uuid PRIMARY KEY); CREATE TABLE agent_sandboxes (id uuid PRIMARY KEY)",
    );
    const org = randomUUID();
    const otherOrg = randomUUID();
    const agent = randomUUID();
    const otherAgent = randomUUID();
    await client.query("INSERT INTO organizations VALUES ($1), ($2)", [org, otherOrg]);
    await client.query("INSERT INTO agent_sandboxes VALUES ($1), ($2)", [agent, otherAgent]);
    await expect(database.select().from(agentIdentities).execute()).rejects.toMatchObject({
      cause: { code: "42P01" },
    });
    const migration = await readFile(
      new URL("./0366_agent_identities.sql", import.meta.url),
      "utf8",
    );
    await client.exec(migration);
    const record = {
      organization_id: org,
      sandbox_agent_id: agent,
      chain_id: 56,
      registry_address: "fixture-registry",
      token_id: "1",
      agent_uri: "https://example.invalid/identity",
      owner_wallet_address: "fixture-owner",
      tx_hash: "fixture-transaction",
    };
    const [inserted] = await database.insert(agentIdentities).values(record).returning();
    expect(
      (
        await database
          .select()
          .from(agentIdentities)
          .where(
            and(
              eq(agentIdentities.sandbox_agent_id, agent),
              eq(agentIdentities.organization_id, org),
            ),
          )
      )[0].agent_uri,
    ).toBe(record.agent_uri);
    expect(
      await database
        .select()
        .from(agentIdentities)
        .where(
          and(
            eq(agentIdentities.sandbox_agent_id, agent),
            eq(agentIdentities.organization_id, otherOrg),
          ),
        ),
    ).toEqual([]);
    await expect(
      database
        .insert(agentIdentities)
        .values({ ...record, token_id: "2" })
        .execute(),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
    await expect(
      database
        .insert(agentIdentities)
        .values({ ...record, sandbox_agent_id: otherAgent, organization_id: otherOrg })
        .execute(),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
    await database.insert(agentIdentities).values({
      ...record,
      sandbox_agent_id: otherAgent,
      organization_id: otherOrg,
      token_id: "2",
    });
    await client.exec(migration);
    await client.query("DELETE FROM agent_sandboxes WHERE id = $1", [agent]);
    expect(
      await database.select().from(agentIdentities).where(eq(agentIdentities.id, inserted.id)),
    ).toEqual([]);
    expect(
      (await database.select().from(agentIdentities)).map((row) => row.sandbox_agent_id),
    ).toEqual([otherAgent]);
    await client.query("DELETE FROM organizations WHERE id = $1", [otherOrg]);
    expect(await database.select().from(agentIdentities)).toEqual([]);
  } finally {
    await client.close();
  }
}, 60_000);

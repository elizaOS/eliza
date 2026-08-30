/** Replays the Dedicated authority migration against real PGlite and checks its provenance fences. */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

describe("personal Dedicated upgrade authority migration", () => {
  test("leaves legacy JSON unblessed and enforces exact version, cutover, source, and target authority", async () => {
    const database = new PGlite();
    try {
      await database.exec(`
        CREATE TABLE organizations (id uuid PRIMARY KEY);
        CREATE TABLE users (id uuid PRIMARY KEY);
        CREATE TABLE agent_sandboxes (
          id uuid PRIMARY KEY,
          agent_config jsonb
        );
        INSERT INTO organizations VALUES ('10000000-0000-4000-8000-000000000001');
        INSERT INTO users VALUES ('20000000-0000-4000-8000-000000000001');
        INSERT INTO agent_sandboxes VALUES (
          '30000000-0000-4000-8000-000000000001',
          '{"__agentUpgradedFrom":"personal:forged"}'::jsonb
        );
        INSERT INTO agent_sandboxes VALUES (
          '30000000-0000-4000-8000-000000000002',
          '{}'::jsonb
        );
      `);
      const migration = await readFile(
        new URL("./migrations/0319_personal_dedicated_upgrade_authorities.sql", import.meta.url),
        "utf8",
      );
      await database.exec(migration);

      const before = await database.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM personal_dedicated_upgrade_authorities",
      );
      expect(before.rows[0]?.count).toBe("0");
      const legacy = await database.query<{ marker: string }>(
        "SELECT agent_config ->> '__agentUpgradedFrom' AS marker FROM agent_sandboxes WHERE id = '30000000-0000-4000-8000-000000000001'",
      );
      expect(legacy.rows[0]?.marker).toBe("personal:forged");

      await database.exec(`
        INSERT INTO personal_dedicated_upgrade_authorities (
          organization_id, user_id, source_agent_id, dedicated_agent_id
        ) VALUES (
          '10000000-0000-4000-8000-000000000001',
          '20000000-0000-4000-8000-000000000001',
          'personal:verified',
          '30000000-0000-4000-8000-000000000001'
        )
      `);
      await expect(
        database.exec(`
          INSERT INTO personal_dedicated_upgrade_authorities (
            organization_id, user_id, source_agent_id, dedicated_agent_id, schema_version
          ) VALUES (
            '10000000-0000-4000-8000-000000000001',
            '20000000-0000-4000-8000-000000000001',
            'personal:version-drift',
            '30000000-0000-4000-8000-000000000002', 2
          )
        `),
      ).rejects.toThrow(/version_check/i);
      await expect(
        database.exec(`
          UPDATE personal_dedicated_upgrade_authorities
          SET cutover_token = 'incomplete'
          WHERE dedicated_agent_id = '30000000-0000-4000-8000-000000000001'
        `),
      ).rejects.toThrow(/cutover_check/i);
      await expect(
        database.exec(`
          INSERT INTO personal_dedicated_upgrade_authorities (
            organization_id, user_id, source_agent_id, dedicated_agent_id
          ) VALUES (
            '10000000-0000-4000-8000-000000000001',
            '20000000-0000-4000-8000-000000000001',
            'personal:verified',
            '30000000-0000-4000-8000-000000000002'
          )
        `),
      ).rejects.toThrow(/source_unique/i);
    } finally {
      await database.close();
    }

    const journal = JSON.parse(
      await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    const authorityMigration = journal.entries.find(
      ({ tag }) => tag === "0319_personal_dedicated_upgrade_authorities",
    );
    expect(authorityMigration).toMatchObject({
      idx: 302,
      tag: "0319_personal_dedicated_upgrade_authorities",
    });
  });
});

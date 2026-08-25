/** Proves the additive Personal Shared consent migration on real PGlite. */

import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

const bindingsMigration = await Bun.file(
  new URL("./0297_personal_shared_group_bindings.sql", import.meta.url),
).text();
const participantsMigration = await Bun.file(
  new URL("./0311_personal_shared_group_participants.sql", import.meta.url),
).text();
const consentMigration = await Bun.file(
  new URL("./0320_personal_shared_multi_principal_consent.sql", import.meta.url),
).text();

const databases: PGlite[] = [];
const ORG = "a1000000-0000-4000-8000-000000000001";
const OWNER = "a1000000-0000-4000-8000-000000000011";
const JOINER = "a1000000-0000-4000-8000-000000000012";
const BINDING = "a1000000-0000-4000-8000-000000000021";

async function legacyDatabase(): Promise<PGlite> {
  const db = new PGlite();
  databases.push(db);
  await db.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE users (id uuid PRIMARY KEY);
    INSERT INTO organizations (id) VALUES ('${ORG}');
    INSERT INTO users (id) VALUES ('${OWNER}'), ('${JOINER}');
  `);
  await db.exec(bindingsMigration);
  await db.exec(participantsMigration);
  await db.query(
    `INSERT INTO personal_shared_group_claims
       (code_hash, organization_id, owner_user_id, personal_agent_id, platform,
        project, connector_account_id, issued_to_platform_user_id, expires_at)
     VALUES ('legacy-claim', $1, $2, 'personal:parent-a', 'blooio', 'eliza-app',
       'synthetic-connector', 'synthetic-parent-a', now() + interval '1 hour')`,
    [ORG, OWNER],
  );
  await db.query(
    `INSERT INTO personal_shared_group_bindings
       (id, organization_id, owner_user_id, personal_agent_id, platform, project,
        connector_account_id, provider_chat_id, conversation_id,
        created_by_platform_user_id)
     VALUES ($1, $2, $3, 'personal:parent-a', 'blooio', 'eliza-app',
       'synthetic-connector', 'synthetic-family-group', 'group:synthetic-family',
       'synthetic-parent-a')`,
    [BINDING, ORG, OWNER],
  );
  await db.query(
    `INSERT INTO personal_shared_group_participants
       (binding_id, platform_user_id, ordinal)
     VALUES ($1, 'synthetic-parent-a', 1)`,
    [BINDING],
  );
  await db.exec(consentMigration);
  return db;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

describe("0320 Personal Shared multi-principal consent", () => {
  test("preserves legacy rows as single-owner with nullable participant consent", async () => {
    const db = await legacyDatabase();
    const claims = await db.query<{
      consent_mode: string;
      required_principal_count: number;
    }>("SELECT consent_mode, required_principal_count FROM personal_shared_group_claims");
    expect(claims.rows).toEqual([{ consent_mode: "single_owner", required_principal_count: 1 }]);
    const bindings = await db.query<{
      consent_mode: string;
      required_principal_count: number;
      consent_version: string;
    }>(
      "SELECT consent_mode, required_principal_count, consent_version::text AS consent_version FROM personal_shared_group_bindings",
    );
    expect(bindings.rows).toEqual([
      {
        consent_mode: "single_owner",
        required_principal_count: 1,
        consent_version: "1",
      },
    ]);
    const participants = await db.query<{
      linked_user_id: string | null;
      consented_at: Date | null;
      consent_provenance: string | null;
      revoked_at: Date | null;
    }>(
      "SELECT linked_user_id, consented_at, consent_provenance, revoked_at FROM personal_shared_group_participants",
    );
    expect(participants.rows).toEqual([
      {
        linked_user_id: null,
        consented_at: null,
        consent_provenance: null,
        revoked_at: null,
      },
    ]);
  });

  test("enforces consent configuration, complete participant links, and one account per binding", async () => {
    const db = await legacyDatabase();
    await expect(
      db.query(
        "UPDATE personal_shared_group_bindings SET consent_mode = 'all_adults' WHERE id = $1",
        [BINDING],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        "UPDATE personal_shared_group_participants SET linked_user_id = $1 WHERE binding_id = $2",
        [OWNER, BINDING],
      ),
    ).rejects.toThrow();

    await db.query(
      `UPDATE personal_shared_group_participants
          SET linked_user_id = $1, consented_at = now(), consent_provenance = 'owner_binding'
        WHERE binding_id = $2`,
      [OWNER, BINDING],
    );
    await expect(
      db.query(
        `INSERT INTO personal_shared_group_participants
           (binding_id, platform_user_id, ordinal, linked_user_id, consented_at,
            consent_provenance)
         VALUES ($1, 'synthetic-duplicate-owner', 2, $2, now(), 'authenticated_dm')`,
        [BINDING, OWNER],
      ),
    ).rejects.toThrow();
    await expect(db.query("DELETE FROM users WHERE id = $1", [OWNER])).rejects.toThrow();
    const retained = await db.query<{ linked_user_id: string }>(
      "SELECT linked_user_id FROM personal_shared_group_participants WHERE binding_id = $1",
      [BINDING],
    );
    expect(retained.rows).toEqual([{ linked_user_id: OWNER }]);
  });

  test("binds challenge stage to its linked-account shape and cascades authority rows", async () => {
    const db = await legacyDatabase();
    await expect(
      db.query(
        `INSERT INTO personal_shared_group_join_challenges
           (code_hash, stage, binding_id, consent_version, platform, project,
            connector_account_id, provider_chat_id, issued_to_platform_user_id,
            source_message_id, expires_at, superseded_at)
         VALUES ('bad-supersession-shape', 'authenticate', $1, 1, 'blooio', 'eliza-app',
           'synthetic-connector', 'synthetic-family-group', 'synthetic-parent-b',
           'bad-supersession-source', now() + interval '1 minute', now())`,
        [BINDING],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        `INSERT INTO personal_shared_group_join_challenges
           (code_hash, stage, binding_id, consent_version, platform, project,
            connector_account_id, provider_chat_id, issued_to_platform_user_id,
            source_message_id, linked_user_id, expires_at)
         VALUES ('bad-auth-shape', 'authenticate', $1, 1, 'blooio', 'eliza-app',
           'synthetic-connector', 'synthetic-family-group', 'synthetic-parent-b',
           'bad-auth-source', $2, now() + interval '1 minute')`,
        [BINDING, JOINER],
      ),
    ).rejects.toThrow();
    await db.query(
      `INSERT INTO personal_shared_group_join_challenges
          (code_hash, stage, binding_id, consent_version, platform, project,
           connector_account_id, provider_chat_id, issued_to_platform_user_id,
          source_message_id, linked_user_id, expires_at)
       VALUES ('confirm-shape', 'confirm', $1, 1, 'blooio', 'eliza-app',
         'synthetic-connector', 'synthetic-family-group', 'synthetic-parent-b',
         'confirm-source', $2, now() + interval '1 minute')`,
      [BINDING, JOINER],
    );
    await db.query("DELETE FROM users WHERE id = $1", [JOINER]);
    const remaining = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM personal_shared_group_join_challenges",
    );
    expect(remaining.rows[0]?.count).toBe("0");
    const linkedUserIndexes = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE indexname IN (
         'personal_shared_group_join_challenges_linked_user_idx',
         'personal_shared_group_join_challenges_source_uidx',
         'personal_shared_group_participants_linked_user_idx'
       )
       ORDER BY indexname`,
    );
    expect(linkedUserIndexes.rows).toEqual([
      { indexname: "personal_shared_group_join_challenges_linked_user_idx" },
      { indexname: "personal_shared_group_join_challenges_source_uidx" },
      { indexname: "personal_shared_group_participants_linked_user_idx" },
    ]);
  });
});

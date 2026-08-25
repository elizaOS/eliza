/** Applies the remote-host connection-mode CHECK migration to real PGlite and proves the backfill fails closed. */
import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migration = await readFile(
  new URL("./0313_remote_host_connection_mode_check.sql", import.meta.url),
  "utf8",
);

const databases: PGlite[] = [];

async function database(): Promise<PGlite> {
  const db = new PGlite();
  databases.push(db);
  await db.exec(`
    CREATE TABLE remote_hosts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      user_id uuid NOT NULL,
      device_id text NOT NULL,
      display_name text NOT NULL,
      platform text NOT NULL,
      connection_mode text NOT NULL,
      runtime_key_id text NOT NULL,
      signing_public_jwk jsonb NOT NULL,
      encryption_public_jwk jsonb NOT NULL,
      host_token_hash text NOT NULL,
      status text DEFAULT 'active' NOT NULL,
      last_seen_at timestamp,
      created_at timestamp DEFAULT now() NOT NULL,
      updated_at timestamp DEFAULT now() NOT NULL,
      revoked_at timestamp,
      CONSTRAINT remote_hosts_status_check CHECK (
        (status = 'active' AND revoked_at IS NULL)
        OR (status = 'revoked' AND revoked_at IS NOT NULL)
      )
    )
  `);
  return db;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

describe("0313 remote host connection-mode check", () => {
  test("revokes non-relay legacy rows, preserves relay rows and their status", async () => {
    const db = await database();
    await db.exec(`
      INSERT INTO remote_hosts
        (organization_id, user_id, device_id, display_name, platform, connection_mode,
         runtime_key_id, signing_public_jwk, encryption_public_jwk, host_token_hash, status, revoked_at)
      VALUES
        ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
         'relay-host', 'Relay Host', 'linux', 'relay', 'key-r', '{}', '{}', 'hash-r', 'active', NULL),
        ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
         'legacy-ssh', 'Legacy SSH', 'linux', 'ssh', 'key-s', '{}', '{}', 'hash-s', 'active', NULL),
        ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
         'relay-revoked', 'Already Revoked', 'linux', 'relay', 'key-x', '{}', '{}',
         'hash-x', 'revoked', '2026-01-01T00:00:00Z')
    `);

    await db.exec(migration);

    const result = await db.query<{
      device_id: string;
      connection_mode: string;
      status: string;
      revoked_at: string | null;
    }>(`
      SELECT device_id, connection_mode, status, revoked_at
      FROM remote_hosts
      ORDER BY device_id
    `);

    const rows = result.rows;
    expect(rows).toHaveLength(3);
    const relayHost = rows.find((row) => row.device_id === "relay-host");
    expect(relayHost?.status).toBe("active");
    expect(relayHost?.revoked_at).toBeNull();
    const legacySsh = rows.find((row) => row.device_id === "legacy-ssh");
    expect(legacySsh?.status).toBe("revoked");
    expect(legacySsh?.revoked_at).not.toBeNull();
    const relayRevoked = rows.find((row) => row.device_id === "relay-revoked");
    expect(relayRevoked?.status).toBe("revoked");
    expect(relayRevoked?.revoked_at).not.toBeNull();
    // The already-revoked row keeps its original revoked_at (COALESCE preserved it).
    expect(relayRevoked?.revoked_at === legacySsh?.revoked_at).toBe(false);
  });

  test("enforces the CHECK constraint against new and updated rows", async () => {
    const db = await database();
    await db.exec(migration);

    await db.exec(`
      INSERT INTO remote_hosts
        (organization_id, user_id, device_id, display_name, platform, connection_mode,
         runtime_key_id, signing_public_jwk, encryption_public_jwk, host_token_hash)
      VALUES
        ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
         'relay-ok', 'Relay OK', 'linux', 'relay', 'key-r', '{}', '{}', 'hash-r')
    `);
    await db.exec("UPDATE remote_hosts SET connection_mode = 'relay' WHERE device_id = 'relay-ok'");

    let insertRejected = false;
    try {
      await db.exec(`
        INSERT INTO remote_hosts
          (organization_id, user_id, device_id, display_name, platform, connection_mode,
           runtime_key_id, signing_public_jwk, encryption_public_jwk, host_token_hash)
        VALUES
          ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
           'bad-mode', 'Bad Mode', 'linux', 'ssh', 'key-b', '{}', '{}', 'hash-b')
      `);
    } catch {
      insertRejected = true;
    }
    expect(insertRejected).toBe(true);

    let updateRejected = false;
    try {
      await db.exec(
        "UPDATE remote_hosts SET connection_mode = 'tunnel' WHERE device_id = 'relay-ok'",
      );
    } catch {
      updateRejected = true;
    }
    expect(updateRejected).toBe(true);

    const result = await db.query<{ connection_mode: string }>(
      "SELECT connection_mode FROM remote_hosts WHERE device_id = 'relay-ok'",
    );
    expect(result.rows[0]?.connection_mode).toBe("relay");
  });

  test("is idempotent: re-applying preserves the constraint and existing rows", async () => {
    const db = await database();
    await db.exec(`
      INSERT INTO remote_hosts
        (organization_id, user_id, device_id, display_name, platform, connection_mode,
         runtime_key_id, signing_public_jwk, encryption_public_jwk, host_token_hash)
      VALUES
        ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
         'legacy-ssh', 'Legacy SSH', 'linux', 'ssh', 'key-s', '{}', '{}', 'hash-s')
    `);
    await db.exec(migration);
    await db.exec(migration);

    const result = await db.query<{ status: string; revoked_at: string | null }>(
      "SELECT status, revoked_at FROM remote_hosts WHERE device_id = 'legacy-ssh'",
    );
    expect(result.rows[0]?.status).toBe("revoked");
    expect(result.rows[0]?.revoked_at).not.toBeNull();

    let rejected = false;
    try {
      await db.exec(
        "UPDATE remote_hosts SET connection_mode = 'headscale' WHERE device_id = 'legacy-ssh'",
      );
    } catch {
      rejected = true;
    }
    // The legacy row is revoked, so retaining 'ssh' is allowed (audit history).
    expect(rejected).toBe(false);
    // But flipping an active row's mode away from relay is rejected.
    await db.exec(`
      INSERT INTO remote_hosts
        (organization_id, user_id, device_id, display_name, platform, connection_mode,
         runtime_key_id, signing_public_jwk, encryption_public_jwk, host_token_hash)
      VALUES
        ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
         'relay-live', 'Relay Live', 'linux', 'relay', 'key-l', '{}', '{}', 'hash-l')
    `);
    let activeRejected = false;
    try {
      await db.exec(
        "UPDATE remote_hosts SET connection_mode = 'headscale' WHERE device_id = 'relay-live'",
      );
    } catch {
      activeRejected = true;
    }
    expect(activeRejected).toBe(true);

    // The only path where a brand-new non-relay value can legally enter the
    // table: an INSERT that is already revoked (audit-style), per the CHECK's
    // (relay OR revoked) carve-out.
    await db.exec(`
      INSERT INTO remote_hosts
        (organization_id, user_id, device_id, display_name, platform, connection_mode,
         runtime_key_id, signing_public_jwk, encryption_public_jwk, host_token_hash,
         status, revoked_at)
      VALUES
        ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
         'legacy-audit', 'Legacy Audit', 'linux', 'ssh', 'key-a', '{}', '{}', 'hash-a',
         'revoked', '2026-01-01T00:00:00Z')
    `);
    const auditRow = await db.query<{ status: string; connection_mode: string }>(
      "SELECT status, connection_mode FROM remote_hosts WHERE device_id = 'legacy-audit'",
    );
    expect(auditRow.rows[0]?.status).toBe("revoked");
    expect(auditRow.rows[0]?.connection_mode).toBe("ssh");
  });
});

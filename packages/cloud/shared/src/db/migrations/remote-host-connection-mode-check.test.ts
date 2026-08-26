/** Applies the relay-only remote-host migration to PGlite and verifies its fail-closed backfill. */

import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migration = await readFile(
  new URL("./0324_remote_host_connection_mode_check.sql", import.meta.url),
  "utf8",
);
const databases: PGlite[] = [];

async function createDatabase(): Promise<PGlite> {
  const database = new PGlite();
  databases.push(database);
  await database.exec(`
    CREATE TABLE remote_hosts (
      id text UNIQUE NOT NULL,
      device_id text PRIMARY KEY,
      connection_mode text NOT NULL,
      status text NOT NULL,
      revoked_at timestamp,
      updated_at timestamp DEFAULT now() NOT NULL,
      CONSTRAINT remote_hosts_status_check CHECK (
        (status IN ('pending', 'active') AND revoked_at IS NULL)
        OR (status = 'revoked' AND revoked_at IS NOT NULL)
      )
    );
    CREATE TABLE remote_sessions (
      id text PRIMARY KEY,
      host_id text NOT NULL,
      status text NOT NULL,
      pairing_token_hash text,
      ended_at timestamp,
      updated_at timestamp DEFAULT now() NOT NULL
    );
    CREATE TABLE remote_command_envelopes (
      id text PRIMARY KEY,
      host_id text NOT NULL,
      status text NOT NULL,
      claim_token text,
      claim_expires_at timestamp,
      start_receipt jsonb,
      started_at timestamp,
      terminal_at timestamp,
      updated_at timestamp DEFAULT now() NOT NULL,
      CONSTRAINT command_lifecycle_check CHECK (
        (status = 'pending' AND claim_token IS NULL AND claim_expires_at IS NULL
          AND start_receipt IS NULL AND started_at IS NULL)
        OR (status = 'claimed' AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL
          AND start_receipt IS NULL AND started_at IS NULL)
        OR (status IN ('started', 'execution_ambiguous') AND claim_token IS NOT NULL
          AND claim_expires_at IS NULL AND start_receipt IS NOT NULL AND started_at IS NOT NULL)
        OR status = 'completed'
        OR (status = 'cancelled' AND claim_token IS NULL AND claim_expires_at IS NULL
          AND start_receipt IS NULL AND started_at IS NULL)
      )
    )
  `);
  return database;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("0324 remote host connection-mode check", () => {
  test("revokes unsupported live rows and preserves relay enrollment states", async () => {
    const database = await createDatabase();
    await database.exec(`
      INSERT INTO remote_hosts (id, device_id, connection_mode, status) VALUES
        ('active-relay', 'active-relay', 'relay', 'active'),
        ('pending-relay', 'pending-relay', 'relay', 'pending'),
        ('legacy-ssh', 'legacy-ssh', 'ssh', 'active')
    `);

    await database.exec(migration);
    const result = await database.query<{
      device_id: string;
      status: string;
      revoked_at: string | null;
    }>("SELECT device_id, status, revoked_at FROM remote_hosts ORDER BY device_id");

    expect(result.rows).toMatchObject([
      { device_id: "active-relay", status: "active", revoked_at: null },
      { device_id: "legacy-ssh", status: "revoked" },
      { device_id: "pending-relay", status: "pending", revoked_at: null },
    ]);
    expect(result.rows[1]?.revoked_at).not.toBeNull();
  });

  test("terminalizes every live session and command owned by a revoked host", async () => {
    const database = await createDatabase();
    await database.exec(`
      INSERT INTO remote_hosts (id, device_id, connection_mode, status) VALUES
        ('unsupported', 'unsupported', 'ssh', 'active'),
        ('supported', 'supported', 'relay', 'active');
      INSERT INTO remote_sessions
        (id, host_id, status, pairing_token_hash)
      VALUES
        ('session-pending', 'unsupported', 'pending', 'pairing-a'),
        ('session-claimed', 'unsupported', 'claimed', NULL),
        ('session-active', 'unsupported', 'active', NULL),
        ('session-relay', 'supported', 'active', NULL),
        ('session-ended', 'unsupported', 'expired', NULL);
      INSERT INTO remote_command_envelopes
        (id, host_id, status, claim_token, claim_expires_at, start_receipt, started_at)
      VALUES
        ('command-pending', 'unsupported', 'pending', NULL, NULL, NULL, NULL),
        ('command-claimed', 'unsupported', 'claimed', 'claim-a', now() + interval '1 minute', NULL, NULL),
        ('command-started', 'unsupported', 'started', 'claim-b', NULL, '{"accepted":true}', now()),
        ('command-completed', 'unsupported', 'completed', 'claim-c', NULL, '{"accepted":true}', now()),
        ('command-relay', 'supported', 'pending', NULL, NULL, NULL, NULL);
    `);

    await database.exec(migration);

    const sessions = await database.query<{
      id: string;
      status: string;
      pairing_token_hash: string | null;
      ended_at: string | null;
    }>("SELECT id, status, pairing_token_hash, ended_at FROM remote_sessions ORDER BY id");
    expect(sessions.rows).toMatchObject([
      { id: "session-active", status: "revoked", ended_at: expect.anything() },
      { id: "session-claimed", status: "revoked", ended_at: expect.anything() },
      { id: "session-ended", status: "expired", ended_at: null },
      { id: "session-pending", status: "revoked", pairing_token_hash: null },
      { id: "session-relay", status: "active", ended_at: null },
    ]);

    const commands = await database.query<{
      id: string;
      status: string;
      claim_token: string | null;
      claim_expires_at: string | null;
      terminal_at: string | null;
    }>(
      "SELECT id, status, claim_token, claim_expires_at, terminal_at FROM remote_command_envelopes ORDER BY id",
    );
    expect(commands.rows).toMatchObject([
      { id: "command-claimed", status: "cancelled", claim_token: null, claim_expires_at: null },
      { id: "command-completed", status: "completed", terminal_at: null },
      { id: "command-pending", status: "cancelled", terminal_at: expect.anything() },
      { id: "command-relay", status: "pending", terminal_at: null },
      { id: "command-started", status: "execution_ambiguous", claim_token: "claim-b" },
    ]);
  });

  test("rejects unsupported active or pending rows but retains revoked audit rows", async () => {
    const database = await createDatabase();
    await database.exec(migration);

    for (const status of ["active", "pending"]) {
      await expect(
        database.exec(
          `INSERT INTO remote_hosts (id, device_id, connection_mode, status) VALUES ('${status}', '${status}', 'direct', '${status}')`,
        ),
      ).rejects.toThrow();
    }
    await database.exec(`
      INSERT INTO remote_hosts
        (id, device_id, connection_mode, status, revoked_at)
      VALUES ('legacy-audit', 'legacy-audit', 'ssh', 'revoked', now())
    `);
    const result = await database.query<{ connection_mode: string }>(
      "SELECT connection_mode FROM remote_hosts WHERE device_id = 'legacy-audit'",
    );
    expect(result.rows[0]?.connection_mode).toBe("ssh");
  });
});

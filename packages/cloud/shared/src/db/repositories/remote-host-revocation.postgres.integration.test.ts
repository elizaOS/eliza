/** Real row-lock scheduling for bounded remote-host revocation cleanup. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import type { Database } from "../client";
import { generateRemoteHostToken, hashRemoteHostToken } from "../crypto/remote-host-token";
import { RemoteHostsRepository } from "./remote-hosts";
import { RemoteSessionsRepository } from "./remote-sessions-store";

const url = process.env.INFERENCE_POLICY_TEST_POSTGRES_URL;
const schema = `remote_host_revocation_${randomUUID().replaceAll("-", "_")}`;
const organizationId = randomUUID();
const userId = randomUUID();
const hostId = randomUUID();
const sessionId = randomUUID();
const hostToken = generateRemoteHostToken();
const jwk: JsonWebKey = {
  kty: "EC",
  crv: "P-256",
  x: "k6rgke6fNq62RpJc23PzYnmd9702xegeg3Ian-dsmqk",
  y: "LWE89OONX0oDV-cNpPQaAVu456yXJ70K8E9Iq2LQHvM",
};

(url ? describe : describe.skip)("remote host revocation on real PostgreSQL", () => {
  let setup: Client;
  let locker: Client;
  let pool: Pool;
  let hosts: RemoteHostsRepository;
  let sessions: RemoteSessionsRepository;

  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
      !parsed.username.startsWith("qa_")
    ) {
      throw new Error("Remote revocation requires an isolated loopback PostgreSQL qa_* role");
    }
    setup = new Client({ connectionString: url });
    await setup.connect();
    await setup.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema},pg_catalog`);
    await setup.query(`
      CREATE TABLE organizations (id uuid PRIMARY KEY);
      CREATE TABLE users (id uuid PRIMARY KEY);
      CREATE TABLE eliza_sandboxes (id uuid PRIMARY KEY);
    `);
    for (const migration of [
      "0068_add_remote_sessions",
      "0275_remote_sessions_first_class_expiry",
      "0305_secure_remote_hosts",
      "0306_secure_remote_command_relay",
      "0330_remote_session_two_phase_activation",
      "0331_remote_host_managed_network",
      "0332_remote_target_initiated_pairing",
    ]) {
      const source = await readFile(
        new URL(`../migrations/${migration}.sql`, import.meta.url),
        "utf8",
      );
      for (const statement of source.split("--> statement-breakpoint")) {
        if (statement.trim()) await setup.query(statement);
      }
    }
    await setup.query("INSERT INTO organizations VALUES($1)", [organizationId]);
    await setup.query("INSERT INTO users VALUES($1)", [userId]);
    parsed.searchParams.set("options", `-c search_path=${schema},pg_catalog`);
    pool = new Pool({ connectionString: parsed.toString() });
    locker = new Client({ connectionString: parsed.toString() });
    await locker.connect();
    const database = drizzle(pool) as unknown as Database;
    hosts = new RemoteHostsRepository(database);
    sessions = new RemoteSessionsRepository(database);
  }, 60_000);

  afterAll(async () => {
    if (locker) await locker.end();
    if (pool) await pool.end();
    if (setup) {
      await setup.query(`DROP SCHEMA ${schema} CASCADE`);
      await setup.end();
    }
  });

  test("reports a locked claimed pairing and drains it on the next revocation", async () => {
    await hosts.createOwned({
      id: hostId,
      organization_id: organizationId,
      user_id: userId,
      device_id: "revocation-test-target",
      display_name: "Target",
      platform: "linux",
      connection_mode: "relay",
      runtime_key_id: "target-key",
      signing_public_jwk: jwk,
      encryption_public_jwk: jwk,
      host_token_hash: await hashRemoteHostToken(hostToken),
      status: "active",
    });
    await sessions.createPendingForAuthenticatedHost({
      id: sessionId,
      hostId,
      hostToken,
      grantId: randomUUID(),
      grantRevision: 1,
      code: "123456",
      pairingSecret: "remote-revocation-test-secret-at-least-32-bytes",
      expiresAt: new Date(Date.now() + 300_000),
      grantExpiresAt: new Date(Date.now() + 3_600_000),
    });
    expect(
      await sessions.claimPendingHostForOwner({
        organizationId,
        userId,
        sessionId,
        code: "123456",
        pairingSecret: "remote-revocation-test-secret-at-least-32-bytes",
        controllerDeviceId: "controller",
        controllerKeyId: "controller-key",
        controllerDisplayName: "Controller",
        controllerPlatform: "linux",
        controllerSigningPublicJwk: jwk,
        controllerEncryptionPublicJwk: jwk,
      }),
    ).toMatchObject({ kind: "claimed" });
    await locker.query("BEGIN");
    try {
      await locker.query("SELECT id FROM remote_sessions WHERE id=$1 FOR UPDATE", [sessionId]);
      expect(await hosts.revoke(hostId, organizationId, userId)).toMatchObject({
        alreadyRevoked: false,
        cleanup: { sessions: 0, commands: 0, more: true },
      });
      expect(await hosts.authenticate(hostId, hostToken)).toBeUndefined();
    } finally {
      await locker.query("COMMIT");
    }
    expect(await hosts.revoke(hostId, organizationId, userId)).toMatchObject({
      alreadyRevoked: true,
      cleanup: { sessions: 1, commands: 0, more: false },
    });
    const remaining = await setup.query("SELECT status FROM remote_sessions WHERE id=$1", [
      sessionId,
    ]);
    expect(remaining.rows).toEqual([{ status: "revoked" }]);
  }, 30_000);
});

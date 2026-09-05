/**
 * Proves one enrollment-to-subsequent-authentication path over the real
 * remote-host store. The mint/hash helpers are already pinned by
 * `remote-host-token.test.ts`; this suite is the store boundary: the
 * enrollment route returns the plaintext `rhost_v1_` token once, only the
 * canonical `sha256:` digest is persisted as `host_token_hash`, and later
 * host/session/command lookups authenticate by hashing the presented bearer
 * and comparing it to that row — the same `authenticate` / token-hash
 * equality production uses.
 *
 * Drives the production repositories against real PGlite, matching the
 * existing `remote-command-envelopes.pglite.test.ts` harness. No mocked
 * crypto, no in-memory fake store.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
  type EncryptedRemoteCommandEnvelope,
  REMOTE_CONTROL_ENVELOPE_ALGORITHM,
  REMOTE_CONTROL_PROTOCOL_VERSION,
} from "@elizaos/shared/contracts/remote-control";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../client";
import { generateRemoteHostToken, hashRemoteHostToken } from "../crypto/remote-host-token";
import { deriveRemotePairingCodeVerifier } from "../crypto/remote-pairing-code";
import { remoteCommandEnvelopes } from "../schemas/remote-command-envelopes";
import { remoteHosts } from "../schemas/remote-hosts";
import { remoteSessions } from "../schemas/remote-sessions";
import { RemoteCommandEnvelopesRepository } from "./remote-command-envelopes";
import { RemoteHostsRepository } from "./remote-hosts";
import { RemoteSessionsRepository } from "./remote-sessions-store";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TOKEN_PATTERN = /^rhost_v1_[A-Za-z0-9_-]{43}$/;

const organizationId = "10000000-0000-4000-8000-000000000001";
const ownerId = "20000000-0000-4000-8000-000000000001";
const hostId = "40000000-0000-4000-8000-000000000001";
const sessionId = "50000000-0000-4000-8000-000000000001";
const grantId = "60000000-0000-4000-8000-000000000001";
const controllerDeviceId = "controller-linux-one";
const controllerKeyId = "controller-key-one";
const targetKeyId = "target-key-one";
const pairingSecret = "remote-relay-pglite-pairing-secret-at-least-32-bytes";
const ecPublicJwk: JsonWebKey = {
  kty: "EC",
  crv: "P-256",
  x: "k6rgke6fNq62RpJc23PzYnmd9702xegeg3Ian-dsmqk",
  y: "LWE89OONX0oDV-cNpPQaAVu456yXJ70K8E9Iq2LQHvM",
};

let pglite: PGlite;
let database: Database;
let hosts: RemoteHostsRepository;
let sessions: RemoteSessionsRepository;
let commands: RemoteCommandEnvelopesRepository;

async function applyMigration(name: string): Promise<void> {
  const source = await Bun.file(new URL(`../migrations/${name}.sql`, import.meta.url)).text();
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim()) await pglite.exec(statement);
  }
}

/**
 * Mirrors `POST /api/v1/remote/hosts`: mint plaintext, persist only the
 * digest via `createOwned`, keep the token in the caller's hand (the 201
 * `hostToken` field).
 */
async function enrollHost(): Promise<{ plaintext: string; digest: string }> {
  const plaintext = generateRemoteHostToken();
  const digest = await hashRemoteHostToken(plaintext);
  expect(
    await hosts.createOwned({
      id: hostId,
      organization_id: organizationId,
      user_id: ownerId,
      device_id: "linux-one",
      display_name: "Linux One",
      platform: "linux",
      connection_mode: "relay",
      runtime_key_id: targetKeyId,
      signing_public_jwk: ecPublicJwk,
      encryption_public_jwk: ecPublicJwk,
      host_token_hash: digest,
      status: "active",
    }),
  ).toMatchObject({ kind: "created" });
  return { plaintext, digest };
}

async function pairOwnedHost(hostToken: string): Promise<void> {
  const pairingExpiry = new Date(Date.now() + 5 * 60_000);
  const grantExpiry = new Date(Date.now() + 60 * 60_000);
  const verifier = await deriveRemotePairingCodeVerifier(
    pairingSecret,
    { organizationId, userId: ownerId, hostId, sessionId },
    "123456",
    pairingExpiry,
  );
  expect(
    await sessions.createPendingForOwnedHost({
      id: sessionId,
      organization_id: organizationId,
      user_id: ownerId,
      host_id: hostId,
      grant_id: grantId,
      grant_revision: 1,
      status: "pending",
      requester_identity: ownerId,
      pairing_token_hash: verifier,
      controller_device_id: controllerDeviceId,
      controller_key_id: controllerKeyId,
      controller_display_name: "Controller",
      controller_platform: "linux",
      controller_signing_public_jwk: ecPublicJwk,
      controller_encryption_public_jwk: ecPublicJwk,
      target_key_id: targetKeyId,
      expires_at: pairingExpiry,
      grant_expires_at: grantExpiry,
    }),
  ).toMatchObject({ status: "pending" });
  expect(
    await sessions.activatePendingHost({
      sessionId,
      hostId,
      hostToken,
      code: "123456",
      pairingSecret,
    }),
  ).toMatchObject({ kind: "activated", session: { status: "activating" } });
  expect(await sessions.commitHostActivation({ sessionId, hostId, hostToken })).toMatchObject({
    kind: "committed",
    session: { status: "active" },
  });
}

function commandEnvelope(): EncryptedRemoteCommandEnvelope {
  return {
    version: REMOTE_CONTROL_PROTOCOL_VERSION,
    ownerId,
    grantId,
    grantRevision: 1,
    sessionId,
    controllerDeviceId,
    controllerKeyId,
    targetRuntimeId: hostId,
    targetKeyId,
    commandId: "command-one",
    algorithm: REMOTE_CONTROL_ENVELOPE_ALGORITHM,
    senderKeyId: controllerKeyId,
    recipientKeyId: targetKeyId,
    messageDigest: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ephemeralPublicKeyJwk: ecPublicJwk,
    salt: "A".repeat(43),
    iv: "B".repeat(16),
    ciphertext: "C".repeat(23),
    messageKind: "command",
    sequence: 1,
    nonce: "nonce-one",
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
}

beforeAll(async () => {
  pglite = new PGlite();
  database = drizzle({
    client: pglite,
    schema: { remoteHosts, remoteSessions, remoteCommandEnvelopes },
  }) as unknown as Database;
  hosts = new RemoteHostsRepository(database);
  sessions = new RemoteSessionsRepository(database);
  commands = new RemoteCommandEnvelopesRepository(database);

  await pglite.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE users (id uuid PRIMARY KEY);
    CREATE TABLE eliza_sandboxes (id uuid PRIMARY KEY);
    INSERT INTO organizations VALUES ('${organizationId}');
    INSERT INTO users VALUES ('${ownerId}');
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
    await applyMigration(migration);
  }
});

beforeEach(async () => {
  await database.delete(remoteCommandEnvelopes);
  await database.delete(remoteSessions);
  await database.delete(remoteHosts);
});

afterAll(async () => {
  await pglite.close();
});

describe("remote host token store boundary", () => {
  it("returns plaintext once, persists the sha256 digest, and authenticates later lookups", async () => {
    const { plaintext, digest } = await enrollHost();

    expect(TOKEN_PATTERN.test(plaintext)).toBe(true);
    expect(DIGEST_PATTERN.test(digest)).toBe(true);
    expect(digest).toBe(await hashRemoteHostToken(plaintext));

    const [stored] = await database.select().from(remoteHosts).where(eq(remoteHosts.id, hostId));
    expect(stored?.host_token_hash).toBe(digest);
    expect(stored?.host_token_hash).toMatch(DIGEST_PATTERN);
    expect(stored?.host_token_hash.slice("sha256:".length)).toBe(
      stored?.host_token_hash.slice("sha256:".length).toLowerCase(),
    );
    // The enrollment row is the persistence boundary: plaintext is the 201
    // response analogue and must not round-trip into any stored column.
    expect(JSON.stringify(stored)).not.toContain(plaintext);
    expect(stored).not.toHaveProperty("hostToken");

    expect(await hosts.authenticate(hostId, plaintext)).toMatchObject({
      id: hostId,
      status: "active",
      host_token_hash: digest,
    });

    await pairOwnedHost(plaintext);
    expect(
      await sessions.readAuthenticatedHostPairing({
        sessionId,
        hostId,
        hostToken: plaintext,
      }),
    ).toMatchObject({ kind: "found", session: { status: "active" } });

    await commands.enqueue({
      organizationId,
      ownerId,
      envelope: commandEnvelope(),
    });
    const claim = await commands.claimNext({ sessionId, hostId, hostToken: plaintext });
    expect(claim.kind).toBe("claimed");
  });

  it("fails closed on a wrong token and a mutated stored digest", async () => {
    const { plaintext, digest } = await enrollHost();
    const otherToken = generateRemoteHostToken();
    expect(otherToken).not.toBe(plaintext);

    expect(await hosts.authenticate(hostId, otherToken)).toBeUndefined();
    expect(
      await sessions.createPendingForAuthenticatedHost({
        id: sessionId,
        hostId,
        hostToken: otherToken,
        grantId,
        grantRevision: 1,
        code: "123456",
        pairingSecret,
        expiresAt: new Date(Date.now() + 5 * 60_000),
        grantExpiresAt: new Date(Date.now() + 60 * 60_000),
      }),
    ).toBeUndefined();
    expect((await commands.claimNext({ sessionId, hostId, hostToken: otherToken })).kind).toBe(
      "not_found",
    );

    const mutatedDigest = `${digest.slice(0, -1)}${digest.endsWith("a") ? "b" : "a"}`;
    expect(mutatedDigest).toMatch(DIGEST_PATTERN);
    expect(mutatedDigest).not.toBe(digest);
    await database
      .update(remoteHosts)
      .set({ host_token_hash: mutatedDigest })
      .where(eq(remoteHosts.id, hostId));

    expect(await hosts.authenticate(hostId, plaintext)).toBeUndefined();
    expect((await commands.claimNext({ sessionId, hostId, hostToken: plaintext })).kind).toBe(
      "not_found",
    );
  });
});

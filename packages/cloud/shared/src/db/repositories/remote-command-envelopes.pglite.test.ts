/** Real persistence tests for relay sequence, claim lease, and completion. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import type { EncryptedRemoteCommand } from "@elizaos/shared";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../client";
import { remoteCommandEnvelopes } from "../schemas/remote-command-envelopes";
import { remoteHosts } from "../schemas/remote-hosts";
import { remoteSessions } from "../schemas/remote-sessions";
import { RemoteCommandEnvelopesRepository } from "./remote-command-envelopes";

const orgId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const hostId = "33333333-3333-4333-8333-333333333333";
const sessionId = "44444444-4444-4444-8444-444444444444";
const commandId = "55555555-5555-4555-8555-555555555555";
const key = { kty: "EC", crv: "P-256", x: "x", y: "y" };
const envelope: EncryptedRemoteCommand = {
  version: 1,
  algorithm: "ECDH-P256-HKDF-SHA256+A256GCM",
  senderKeyId: "phone-key",
  recipientKeyId: "host-key",
  ephemeralPublicKeyJwk: key,
  salt: "salt",
  iv: "iv",
  ciphertext: "ciphertext",
};

let pglite: PGlite;
let db: Database;
let repository: RemoteCommandEnvelopesRepository;

beforeAll(async () => {
  pglite = new PGlite();
  db = drizzle({
    client: pglite,
    schema: { remoteHosts, remoteSessions, remoteCommandEnvelopes },
  }) as unknown as Database;
  repository = new RemoteCommandEnvelopesRepository(db);
  await db.execute(sql`
    CREATE TABLE remote_hosts (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL, user_id uuid NOT NULL,
      display_name text NOT NULL, platform text NOT NULL, connection_mode text NOT NULL,
      headscale_hostname text, runtime_key_id text NOT NULL, signing_public_jwk jsonb NOT NULL,
      encryption_public_jwk jsonb NOT NULL, host_token_hash text NOT NULL, status text NOT NULL,
      last_seen_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
    )
  `);
  await db.execute(sql`
    CREATE TABLE remote_sessions (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL, user_id uuid NOT NULL,
      agent_id uuid, host_id uuid, status text NOT NULL, requester_identity text NOT NULL,
      pairing_token_hash text, controller_device_id text, controller_key_id text,
      controller_display_name text, controller_platform text,
      controller_signing_public_jwk jsonb, controller_encryption_public_jwk jsonb,
      last_sequence bigint NOT NULL DEFAULT 0, last_seen_at timestamptz,
      ingress_url text, ingress_reason text, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz
    )
  `);
  await db.execute(sql`
    CREATE TABLE remote_command_envelopes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL,
      organization_id uuid NOT NULL, user_id uuid NOT NULL, command_id text NOT NULL,
      sequence bigint NOT NULL, envelope jsonb NOT NULL, status text NOT NULL DEFAULT 'pending',
      attempts integer NOT NULL DEFAULT 0, expires_at timestamptz NOT NULL,
      claim_expires_at timestamptz, result_envelope jsonb, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
      UNIQUE(session_id, command_id), UNIQUE(session_id, sequence)
    )
  `);
  await db.insert(remoteHosts).values({
    id: hostId,
    organization_id: orgId,
    user_id: userId,
    display_name: "Mac",
    platform: "macos",
    connection_mode: "managed_headscale",
    runtime_key_id: "host-key",
    signing_public_jwk: key,
    encryption_public_jwk: key,
    host_token_hash: "hash",
    status: "online",
  });
  await db.insert(remoteSessions).values({
    id: sessionId,
    organization_id: orgId,
    user_id: userId,
    host_id: hostId,
    status: "active",
    requester_identity: userId,
    controller_device_id: "phone",
    controller_key_id: "phone-key",
    controller_signing_public_jwk: key,
    controller_encryption_public_jwk: key,
  });
});

afterAll(async () => pglite.close());

describe("remote command relay persistence", () => {
  test("enforces sequence, leases one command, and completes for the controller key", async () => {
    const queued = await repository.enqueue({
      sessionId,
      organizationId: orgId,
      userId,
      commandId,
      sequence: 1,
      expiresAt: new Date(Date.now() + 60_000),
      envelope,
    });
    expect(queued.kind).toBe("queued");
    await expect(
      repository.enqueue({
        sessionId,
        organizationId: orgId,
        userId,
        commandId: crypto.randomUUID(),
        sequence: 1,
        expiresAt: new Date(Date.now() + 60_000),
        envelope,
      }),
    ).resolves.toEqual({ kind: "replay" });

    const claimed = await repository.claimNext(sessionId, hostId);
    expect(claimed?.command.command_id).toBe(commandId);
    expect(claimed?.session.controller_key_id).toBe("phone-key");
    await expect(repository.claimNext(sessionId, hostId)).resolves.toBeNull();

    await expect(
      repository.complete({
        sessionId,
        commandId,
        hostId,
        resultEnvelope: {
          ...envelope,
          senderKeyId: "attacker-key",
          recipientKeyId: "phone-key",
        },
      }),
    ).resolves.toBeUndefined();

    const resultEnvelope = {
      ...envelope,
      senderKeyId: "host-key",
      recipientKeyId: "phone-key",
    };
    const completed = await repository.complete({
      sessionId,
      commandId,
      hostId,
      resultEnvelope,
    });
    expect(completed?.status).toBe("completed");
    const read = await repository.readOwnedResult(sessionId, commandId, orgId, userId);
    expect(read?.result_envelope).toEqual(resultEnvelope);
  });

  test("rejects a relay envelope retargeted to a different host key", async () => {
    await expect(
      repository.enqueue({
        sessionId,
        organizationId: orgId,
        userId,
        commandId: crypto.randomUUID(),
        sequence: 2,
        expiresAt: new Date(Date.now() + 60_000),
        envelope: { ...envelope, recipientKeyId: "attacker-key" },
      }),
    ).resolves.toEqual({ kind: "wrong_keys" });
  });
});

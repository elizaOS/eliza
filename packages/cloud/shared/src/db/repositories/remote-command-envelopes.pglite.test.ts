/**
 * Exercises the production remote host/session/command repositories against
 * real PGlite transactions, including one-use pairing, replay fencing,
 * pre-start lease recovery, post-start ambiguity, and revocation cleanup.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
  type EncryptedRemoteCommandEnvelope,
  type EncryptedRemoteCommandResultEnvelope,
  type EncryptedRemoteCommandStartReceiptEnvelope,
  type EncryptedRemoteControlEnvelope,
  REMOTE_CONTROL_ENVELOPE_ALGORITHM,
  REMOTE_CONTROL_PROTOCOL_VERSION,
} from "@elizaos/shared/contracts/remote-control";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../client";
import { generateRemoteHostToken, hashRemoteHostToken } from "../crypto/remote-host-token";
import { deriveRemotePairingCodeVerifier } from "../crypto/remote-pairing-code";
import { remoteCommandEnvelopes } from "../schemas/remote-command-envelopes";
import { remoteHosts } from "../schemas/remote-hosts";
import { remoteSessions } from "../schemas/remote-sessions";
import {
  RemoteCommandEnvelopesRepository,
  type RemoteRelayScope,
} from "./remote-command-envelopes";
import { RemoteHostsRepository } from "./remote-hosts";
import { RemoteSessionsRepository } from "./remote-sessions-store";

const organizationId = "10000000-0000-4000-8000-000000000001";
const ownerId = "20000000-0000-4000-8000-000000000001";
const otherOwnerId = "20000000-0000-4000-8000-000000000002";
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
let hostToken: string;

const scope: RemoteRelayScope = {
  ownerId,
  grantId,
  grantRevision: 1,
  sessionId,
  controllerDeviceId,
  controllerKeyId,
  targetRuntimeId: hostId,
  targetKeyId,
  commandId: "command-one",
};

function envelope(
  messageKind: "command",
  overrides?: Record<string, unknown>,
): EncryptedRemoteCommandEnvelope;
function envelope(
  messageKind: "start_receipt",
  overrides?: Record<string, unknown>,
): EncryptedRemoteCommandStartReceiptEnvelope;
function envelope(
  messageKind: "result",
  overrides?: Record<string, unknown>,
): EncryptedRemoteCommandResultEnvelope;
function envelope(
  messageKind: "command" | "start_receipt" | "result",
  overrides: Record<string, unknown> = {},
): EncryptedRemoteControlEnvelope {
  const targetOriginated = messageKind !== "command";
  const common = {
    version: REMOTE_CONTROL_PROTOCOL_VERSION,
    ...scope,
    algorithm: REMOTE_CONTROL_ENVELOPE_ALGORITHM,
    senderKeyId: targetOriginated ? targetKeyId : controllerKeyId,
    recipientKeyId: targetOriginated ? controllerKeyId : targetKeyId,
    messageDigest: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ephemeralPublicKeyJwk: ecPublicJwk,
    salt: "A".repeat(43),
    iv: "B".repeat(16),
    ciphertext: "C".repeat(23),
  };
  if (messageKind === "command") {
    return {
      ...common,
      messageKind,
      sequence: 1,
      nonce: "nonce-one",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      ...overrides,
    } as EncryptedRemoteControlEnvelope;
  }
  return { ...common, messageKind, ...overrides } as EncryptedRemoteControlEnvelope;
}

async function applyMigration(name: string): Promise<void> {
  const source = await Bun.file(new URL(`../migrations/${name}.sql`, import.meta.url)).text();
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim()) await pglite.exec(statement);
  }
}

async function enrollAndPair(activate = true): Promise<void> {
  hostToken = generateRemoteHostToken();
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
      host_token_hash: await hashRemoteHostToken(hostToken),
      status: "active",
    }),
  ).toMatchObject({ kind: "created" });

  const code = "123456";
  const pairingExpiry = new Date(Date.now() + 5 * 60_000);
  const grantExpiry = new Date(Date.now() + 60 * 60_000);
  const verifier = await deriveRemotePairingCodeVerifier(
    pairingSecret,
    { organizationId, userId: ownerId, hostId, sessionId },
    code,
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
  if (activate) {
    expect(
      await sessions.activatePendingHost({
        sessionId,
        hostId,
        hostToken,
        code,
        pairingSecret,
      }),
    ).toMatchObject({ kind: "activated", session: { status: "active" } });
  }
}

async function enqueue(commandEnvelope = envelope("command")) {
  return commands.enqueue({
    organizationId,
    ownerId,
    envelope: commandEnvelope,
  });
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
    CREATE TABLE conversations (
      id uuid PRIMARY KEY,
      settings jsonb NOT NULL DEFAULT
        '{"temperature":0.7,"maxTokens":2000,"topP":1,"frequencyPenalty":0,"presencePenalty":0,"systemPrompt":"You are a helpful AI assistant."}'::jsonb
    );
    INSERT INTO organizations VALUES ('${organizationId}');
    INSERT INTO users VALUES ('${ownerId}');
  `);
  for (const migration of [
    "0068_add_remote_sessions",
    "0275_remote_sessions_first_class_expiry",
    "0305_secure_remote_hosts",
    "0306_secure_remote_command_relay",
    "0307_twilio_outbound_call_audit",
    "0308_remove_conversation_token_default",
    "0312_remote_host_managed_network",
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

describe("secure remote relay repositories", () => {
  it("keeps managed enrollment non-authoritative until durable activation and cleanup", async () => {
    hostToken = generateRemoteHostToken();
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
        host_token_hash: await hashRemoteHostToken(hostToken),
        status: "pending",
      }),
    ).toMatchObject({ kind: "created", host: { status: "pending" } });
    expect(await hosts.authenticate(hostId, hostToken)).toBeUndefined();
    const pairingExpiry = new Date(Date.now() + 5 * 60_000);
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
        pairing_token_hash: await deriveRemotePairingCodeVerifier(
          pairingSecret,
          { organizationId, userId: ownerId, hostId, sessionId },
          "123456",
          pairingExpiry,
        ),
        controller_device_id: controllerDeviceId,
        controller_key_id: controllerKeyId,
        controller_display_name: "Controller",
        controller_platform: "linux",
        controller_signing_public_jwk: ecPublicJwk,
        controller_encryption_public_jwk: ecPublicJwk,
        target_key_id: targetKeyId,
        expires_at: pairingExpiry,
        grant_expires_at: new Date(Date.now() + 60 * 60_000),
      }),
    ).toBeUndefined();
    await hosts.recordManagedEnrollment({
      hostId,
      organizationId,
      userId: ownerId,
      hostname: "eliza-host-test",
      preAuthKeyId: "123",
    });
    let [host] = await database.select().from(remoteHosts);
    expect(host).toMatchObject({
      headscale_hostname: "eliza-host-test",
      headscale_preauth_key_id: "123",
      headscale_cleanup_pending: true,
      status: "pending",
    });
    expect(JSON.stringify(host)).not.toContain("hskey-");
    expect(
      await hosts.listManagedCleanupCandidates({
        pendingUpdatedBefore: new Date("2100-01-01T00:00:00.000Z"),
        limit: 10,
      }),
    ).toHaveLength(1);
    expect(await hosts.authenticateManagedEnrollment(hostId, hostToken)).toMatchObject({
      id: hostId,
      status: "pending",
    });

    const active = await hosts.activateManagedEnrollment({
      hostId,
      organizationId,
      userId: ownerId,
      hostname: "eliza-host-test-cnpx9uop",
    });
    expect(active.status).toBe("active");
    expect(active.headscale_hostname).toBe("eliza-host-test-cnpx9uop");
    expect(await hosts.authenticate(hostId, hostToken)).toMatchObject({
      id: hostId,
      status: "active",
    });
    expect(
      await hosts.listManagedCleanupCandidates({
        pendingUpdatedBefore: new Date("2100-01-01T00:00:00.000Z"),
        limit: 10,
      }),
    ).toHaveLength(0);

    await hosts.completeManagedCleanup({
      hostId,
      organizationId,
      userId: ownerId,
    });
    [host] = await database.select().from(remoteHosts);
    expect(host).toMatchObject({
      headscale_hostname: null,
      headscale_preauth_key_id: null,
      headscale_cleanup_pending: false,
      headscale_cleanup_error: null,
    });
  });

  it("revokes a pending managed host without ever granting bearer authority", async () => {
    hostToken = generateRemoteHostToken();
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
      host_token_hash: await hashRemoteHostToken(hostToken),
      status: "pending",
    });

    expect(await hosts.authenticate(hostId, hostToken)).toBeUndefined();
    expect(await hosts.revoke(hostId, organizationId, ownerId)).toMatchObject({
      host: { status: "revoked" },
      alreadyRevoked: false,
    });
    expect(await hosts.authenticate(hostId, hostToken)).toBeUndefined();
  });

  it("records a host heartbeat even when its active session has no command", async () => {
    await enrollAndPair();
    expect((await commands.claimNext({ sessionId, hostId, hostToken })).kind).toBe("empty");
    const [host] = await database
      .select({ lastSeenAt: remoteHosts.last_seen_at })
      .from(remoteHosts)
      .where(eq(remoteHosts.id, hostId));
    expect(host?.lastSeenAt).toBeInstanceOf(Date);
  });

  it("recovers a lost host token only for the exact active public identity", async () => {
    await enrollAndPair(false);
    const oldToken = hostToken;
    const replacement = generateRemoteHostToken();
    const recovery = await hosts.recoverCredential({
      hostId,
      organizationId,
      userId: ownerId,
      deviceId: "linux-one",
      displayName: "Linux One",
      platform: "linux",
      connectionMode: "relay",
      runtimeKeyId: targetKeyId,
      signingPublicJwk: ecPublicJwk,
      encryptionPublicJwk: ecPublicJwk,
      hostTokenHash: await hashRemoteHostToken(replacement),
    });
    expect(recovery).toMatchObject({ kind: "recovered", host: { id: hostId } });
    expect(await hosts.authenticate(hostId, oldToken)).toBeUndefined();
    expect(await hosts.authenticate(hostId, replacement)).toMatchObject({ id: hostId });

    expect(
      await hosts.recoverCredential({
        hostId,
        organizationId,
        userId: ownerId,
        deviceId: "different-device",
        displayName: "Linux One",
        platform: "linux",
        connectionMode: "relay",
        runtimeKeyId: targetKeyId,
        signingPublicJwk: ecPublicJwk,
        encryptionPublicJwk: ecPublicJwk,
        hostTokenHash: await hashRemoteHostToken(generateRemoteHostToken()),
      }),
    ).toEqual({ kind: "mismatch" });
  });

  it("consumes a host-bound pairing verifier only once", async () => {
    await enrollAndPair(false);
    const attempts = await Promise.all([
      sessions.activatePendingHost({
        sessionId,
        hostId,
        hostToken,
        code: "123456",
        pairingSecret,
      }),
      sessions.activatePendingHost({
        sessionId,
        hostId,
        hostToken,
        code: "123456",
        pairingSecret,
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.kind === "activated")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.kind === "invalid_pairing")).toHaveLength(1);
    const [stored] = await database.select().from(remoteSessions);
    expect(stored?.pairing_token_hash).toBeNull();
    expect(stored?.pairing_consumed_at).not.toBeNull();
    expect(
      await sessions.activatePendingHost({
        sessionId,
        hostId,
        hostToken,
        code: "123456",
        pairingSecret,
      }),
    ).toEqual({ kind: "invalid_pairing" });
  });

  it("serializes sequence, nonce, and idempotency under the session lock", async () => {
    await enrollAndPair();
    const commandEnvelope = envelope("command");
    const first = await enqueue(commandEnvelope);
    expect(first.kind).toBe("queued");
    expect((await enqueue(commandEnvelope)).kind).toBe("duplicate");
    expect(
      (
        await commands.enqueue({
          organizationId,
          ownerId,
          envelope: envelope("command", {
            commandId: "command-gap",
            sequence: 3,
            nonce: "nonce-gap",
          }),
        })
      ).kind,
    ).toBe("sequence_gap");
    expect(
      (
        await commands.enqueue({
          organizationId,
          ownerId,
          envelope: envelope("command", { commandId: "command-two", sequence: 2 }),
        })
      ).kind,
    ).toBe("replay");
  });

  it("rejects an envelope that is not bound to the authenticated owner", async () => {
    await enrollAndPair();

    expect(
      await commands.enqueue({
        organizationId,
        ownerId: otherOwnerId,
        envelope: envelope("command"),
      }),
    ).toEqual({ kind: "not_found" });
    expect(await database.select().from(remoteCommandEnvelopes)).toHaveLength(0);
  });

  it("retries only an expired pre-start claim and fences its stale attempt", async () => {
    await enrollAndPair();
    expect((await enqueue()).kind).toBe("queued");
    const first = await commands.claimNext({ sessionId, hostId, hostToken, leaseMs: 1_000 });
    expect(first.kind).toBe("claimed");
    if (first.kind !== "claimed") throw new Error("expected first claim");
    await database.execute(sql`
      UPDATE remote_command_envelopes
      SET claim_expires_at = now() - interval '1 second'
      WHERE id = ${first.command.id}
    `);
    const second = await commands.claimNext({ sessionId, hostId, hostToken, leaseMs: 1_000 });
    expect(second.kind).toBe("claimed");
    if (second.kind !== "claimed") throw new Error("expected second claim");
    expect(second.command.attempts).toBe(2);
    expect(second.command.claim_token).not.toBe(first.command.claim_token);
    expect(
      (
        await commands.recordStart({
          sessionId,
          commandId: scope.commandId,
          hostId,
          hostToken,
          claimAttempt: first.command.attempts,
          claimToken: first.command.claim_token!,
          startReceipt: envelope("start_receipt"),
        })
      ).kind,
    ).toBe("claim_lost");
  });

  it("persists start evidence and never requeues post-start uncertainty", async () => {
    await enrollAndPair();
    expect((await enqueue()).kind).toBe("queued");
    const claim = await commands.claimNext({ sessionId, hostId, hostToken });
    if (claim.kind !== "claimed") throw new Error("expected claim");
    const startInput = {
      sessionId,
      commandId: scope.commandId,
      hostId,
      hostToken,
      claimAttempt: claim.command.attempts,
      claimToken: claim.command.claim_token!,
      startReceipt: envelope("start_receipt"),
    };
    expect((await commands.recordStart(startInput)).kind).toBe("started");
    expect((await commands.recordStart(startInput)).kind).toBe("duplicate");
    await database.execute(sql`
      UPDATE remote_command_envelopes
      SET expires_at = now() - interval '1 second'
      WHERE id = ${claim.command.id}
    `);
    expect((await commands.claimNext({ sessionId, hostId, hostToken })).kind).toBe("empty");
    const [stored] = await database
      .select()
      .from(remoteCommandEnvelopes)
      .where(eq(remoteCommandEnvelopes.id, claim.command.id));
    expect(stored?.status).toBe("execution_ambiguous");
    expect(stored?.start_receipt).not.toBeNull();
  });

  it("expires bounded pre-start work and marks started work ambiguous with its grant", async () => {
    await enrollAndPair();
    await enqueue();
    await commands.enqueue({
      organizationId,
      ownerId,
      envelope: envelope("command", {
        commandId: "command-two",
        sequence: 2,
        nonce: "nonce-two",
      }),
    });
    const claim = await commands.claimNext({ sessionId, hostId, hostToken });
    if (claim.kind !== "claimed") throw new Error("expected claim");
    await commands.recordStart({
      sessionId,
      commandId: scope.commandId,
      hostId,
      hostToken,
      claimAttempt: claim.command.attempts,
      claimToken: claim.command.claim_token!,
      startReceipt: envelope("start_receipt"),
    });
    await database.execute(sql`
      UPDATE remote_sessions
      SET grant_expires_at = now() - interval '1 second'
      WHERE id = ${sessionId}
    `);

    expect((await commands.claimNext({ sessionId, hostId, hostToken })).kind).toBe("not_found");
    const stored = await database
      .select({
        commandId: remoteCommandEnvelopes.command_id,
        status: remoteCommandEnvelopes.status,
      })
      .from(remoteCommandEnvelopes);
    expect(stored).toContainEqual({
      commandId: scope.commandId,
      status: "execution_ambiguous",
    });
    expect(stored).toContainEqual({ commandId: "command-two", status: "expired" });
  });

  it("binds completion to the exact claim attempt and durable start receipt", async () => {
    await enrollAndPair();
    await enqueue();
    const claim = await commands.claimNext({ sessionId, hostId, hostToken });
    if (claim.kind !== "claimed") throw new Error("expected claim");
    expect(
      (
        await commands.complete({
          sessionId,
          commandId: scope.commandId,
          hostId,
          hostToken,
          claimAttempt: claim.command.attempts,
          claimToken: claim.command.claim_token!,
          resultEnvelope: envelope("result"),
        })
      ).kind,
    ).toBe("claim_lost");
    await commands.recordStart({
      sessionId,
      commandId: scope.commandId,
      hostId,
      hostToken,
      claimAttempt: claim.command.attempts,
      claimToken: claim.command.claim_token!,
      startReceipt: envelope("start_receipt"),
    });
    const completion = {
      sessionId,
      commandId: scope.commandId,
      hostId,
      hostToken,
      claimAttempt: claim.command.attempts,
      claimToken: claim.command.claim_token!,
      resultEnvelope: envelope("result"),
    };
    expect((await commands.complete(completion)).kind).toBe("completed");
    expect((await commands.complete(completion)).kind).toBe("duplicate");
    expect(
      await commands.readOwnedResult({
        organizationId,
        ownerId,
        sessionId,
        commandId: scope.commandId,
      }),
    ).toMatchObject({ status: "completed", attempts: 1 });
  });

  it("turns started work ambiguous and pre-start work cancelled on revocation", async () => {
    await enrollAndPair();
    await enqueue();
    const claim = await commands.claimNext({ sessionId, hostId, hostToken });
    if (claim.kind !== "claimed") throw new Error("expected claim");
    await commands.recordStart({
      sessionId,
      commandId: scope.commandId,
      hostId,
      hostToken,
      claimAttempt: claim.command.attempts,
      claimToken: claim.command.claim_token!,
      startReceipt: envelope("start_receipt"),
    });
    const revoked = await sessions.revoke(sessionId, organizationId, ownerId);
    expect(revoked).toMatchObject({
      alreadyEnded: false,
      session: { status: "revoked" },
      cleanup: { commands: 1, more: false },
    });
    const [stored] = await database.select().from(remoteCommandEnvelopes);
    expect(stored?.status).toBe("execution_ambiguous");
    expect((await commands.claimNext({ sessionId, hostId, hostToken })).kind).toBe("not_found");
  });

  it("lets the exact host bearer revoke and continue its own bounded cleanup", async () => {
    await enrollAndPair();
    await expect(
      hosts.revokeAuthenticated(hostId, `rhost_v1_${"B".repeat(43)}`),
    ).resolves.toBeUndefined();
    await expect(hosts.authenticate(hostId, hostToken)).resolves.toMatchObject({
      status: "active",
    });

    await expect(hosts.revokeAuthenticated(hostId, hostToken)).resolves.toMatchObject({
      alreadyRevoked: false,
      host: { id: hostId, status: "revoked" },
      cleanup: { sessions: 1, more: false },
    });
    await expect(hosts.revokeAuthenticated(hostId, hostToken)).resolves.toMatchObject({
      alreadyRevoked: true,
      host: { id: hostId, status: "revoked" },
      cleanup: { sessions: 0, commands: 0, more: false },
    });
  });

  it("serializes revoke against enqueue and leaves no executable command", async () => {
    await enrollAndPair();
    const [enqueueResult, revokeResult] = await Promise.all([
      enqueue(),
      sessions.revoke(sessionId, organizationId, ownerId),
    ]);
    expect(["queued", "not_found"]).toContain(enqueueResult.kind);
    expect(revokeResult).toMatchObject({ session: { status: "revoked" } });
    const stored = await database.select().from(remoteCommandEnvelopes);
    expect(stored.every((command) => command.status === "cancelled")).toBe(true);
    expect((await commands.claimNext({ sessionId, hostId, hostToken })).kind).toBe("not_found");
  });
});

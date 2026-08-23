/**
 * Joins the native remote-target public lifecycle across an injected
 * PlatformSecureStore contract, the real JSON journal, protocol cryptography,
 * and a real loopback HTTP server. The OS Secret Service and Cloud relay are
 * deliberately replaced with deterministic test doubles; this is same-host
 * integration proof, not packaged, deployed-Cloud, or physical-device proof.
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  REMOTE_CONTROL_PROTOCOL_VERSION,
  type RemoteControllerPublicIdentity,
  type RemoteTargetPublicIdentity,
} from "@elizaos/shared/contracts/remote-control";
import { afterEach, describe, expect, it } from "vitest";
import type {
  PlatformSecureStore,
  SecureStoreDeleteResult,
  SecureStoreGetResult,
  SecureStoreSecretKind,
  SecureStoreSetResult,
} from "../../../src/security/platform-secure-store";
import {
  digestRemotePayload,
  openRemoteControlMessage,
  sealRemoteControlMessage,
  signRemoteCommand,
  verifyRemoteCommandResult,
  verifyRemoteCommandStartReceipt,
} from "../../../src/security/remote-control-crypto";
import { RemoteTargetDesktopService } from "./remote-target-rpc";
import { JsonFileRemoteTargetStateStore } from "./remote-target-store";
import type {
  RemoteTargetActivationResponse,
  RemoteTargetClaim,
  RemoteTargetEnrollmentRequest,
  RemoteTargetEnrollmentResponse,
  RemoteTargetHostRevocationPage,
  RemoteTargetRelayTransport,
} from "./remote-target-transport";
import { RemoteTargetVault } from "./remote-target-vault";

const NOW = 2_000_000_000_000;
const OWNER_ID = "owner-1";
const HOST_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const GRANT_ID = "33333333-3333-4333-8333-333333333333";
const VAULT_ID = "same-host-remote-target-integration";
const API_TOKEN = "test-loopback-token-never-a-real-credential";
const OWNER_TOKEN = "test-owner-token-never-a-real-credential";
const PAIRING_CODE = "123456";
const HOST_TOKEN = `rhost_v1_${"A".repeat(43)}`;

const tempRoots: string[] = [];
const servers: Server[] = [];
const services: RemoteTargetDesktopService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

function privateKey(): JsonWebKey {
  return generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  }).privateKey.export({ format: "jwk" });
}

function publicKey(privateJwk: JsonWebKey): JsonWebKey {
  const { d: _privateScalar, ...publicJwk } = privateJwk;
  return publicJwk;
}

/**
 * Faithful process-shared slot semantics for the production secure-store
 * interface. It intentionally does not claim OS-backed protection.
 */
class InjectedSecureStore implements PlatformSecureStore {
  readonly backend = "none" as const;
  readonly values = new Map<string, string>();

  private slot(vaultId: string, kind: SecureStoreSecretKind): string {
    return `${vaultId}\0${kind}`;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async get(
    vaultId: string,
    kind: SecureStoreSecretKind,
  ): Promise<SecureStoreGetResult> {
    const value = this.values.get(this.slot(vaultId, kind));
    return value === undefined
      ? { ok: false, reason: "not_found" }
      : { ok: true, value };
  }

  async set(
    vaultId: string,
    kind: SecureStoreSecretKind,
    value: string,
  ): Promise<SecureStoreSetResult> {
    this.values.set(this.slot(vaultId, kind), value);
    return { ok: true };
  }

  async delete(
    vaultId: string,
    kind: SecureStoreSecretKind,
  ): Promise<SecureStoreDeleteResult> {
    return {
      ok: true,
      deleted: this.values.delete(this.slot(vaultId, kind)),
    };
  }
}

interface LoopbackCall {
  authorization: string | undefined;
  executionId: string | undefined;
  method: string | undefined;
  url: string | undefined;
}

async function startLoopbackHealthServer(): Promise<{
  apiBase: string;
  calls: LoopbackCall[];
}> {
  const calls: LoopbackCall[] = [];
  const server = createServer((request, response) => {
    calls.push({
      authorization: request.headers.authorization,
      executionId: request.headers["x-eliza-remote-execution-id"] as
        | string
        | undefined,
      method: request.method,
      url: request.url,
    });
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end('{"ready":true,"runtime":"linux"}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a loopback TCP address.");
  }
  return {
    apiBase: `http://127.0.0.1:${address.port}`,
    calls,
  };
}

class DeterministicRelay implements RemoteTargetRelayTransport {
  readonly controllerSigningPrivate = privateKey();
  readonly controllerEncryptionPrivate = privateKey();
  readonly controller: RemoteControllerPublicIdentity = {
    version: REMOTE_CONTROL_PROTOCOL_VERSION,
    role: "controller",
    ownerId: OWNER_ID,
    deviceId: "controller-device-1",
    keyId: "controller-key-1",
    displayName: "Same-host controller",
    platform: "linux",
    signingPublicKeyJwk: publicKey(this.controllerSigningPrivate),
    encryptionPublicKeyJwk: publicKey(this.controllerEncryptionPrivate),
    createdAt: NOW - 8_000,
  };
  enrollmentRequest: RemoteTargetEnrollmentRequest | null = null;
  claimRequests = 0;
  revokeRequests = 0;
  readonly claims: RemoteTargetClaim[] = [];
  readonly starts: Array<
    Parameters<RemoteTargetRelayTransport["recordStart"]>[0]
  > = [];
  readonly completions: Array<
    Parameters<RemoteTargetRelayTransport["complete"]>[0]
  > = [];

  async enroll(
    input: RemoteTargetEnrollmentRequest,
  ): Promise<RemoteTargetEnrollmentResponse> {
    this.enrollmentRequest = input;
    return {
      hostId: HOST_ID,
      hostToken: HOST_TOKEN,
      runtimeKeyId: input.runtimeKeyId,
      status: "active",
      createdAt: NOW - 9_000,
      recovered: false,
    };
  }

  async activate(input: {
    enrollment: Parameters<
      RemoteTargetRelayTransport["activate"]
    >[0]["enrollment"];
    sessionId?: string;
    code: string;
  }): Promise<RemoteTargetActivationResponse> {
    expect(input.code).toBe(PAIRING_CODE);
    expect(input.sessionId).toBe(SESSION_ID);
    expect(input.enrollment.hostToken).toBe(HOST_TOKEN);
    return {
      sessionId: SESSION_ID,
      grantId: GRANT_ID,
      grantRevision: 1,
      ownerId: OWNER_ID,
      controller: this.controller,
      targetRuntimeId: HOST_ID,
      targetKeyId: input.enrollment.identity.keyId,
      grantExpiresAt: NOW + 3_600_000,
      status: "activating",
    };
  }

  async compensateActivation(
    input: Parameters<RemoteTargetRelayTransport["compensateActivation"]>[0],
  ): Promise<
    Awaited<ReturnType<RemoteTargetRelayTransport["compensateActivation"]>>
  > {
    return {
      sessionId: input.sessionId,
      status: "revoked",
      alreadyCompensated: false,
    };
  }

  async commitActivation(
    input: Parameters<RemoteTargetRelayTransport["commitActivation"]>[0],
  ): Promise<
    Awaited<ReturnType<RemoteTargetRelayTransport["commitActivation"]>>
  > {
    return {
      sessionId: input.sessionId,
      status: "active",
      alreadyCommitted: false,
    };
  }

  async claimNext(): Promise<RemoteTargetClaim | null> {
    this.claimRequests += 1;
    return this.claims.shift() ?? null;
  }

  async recordStart(
    input: Parameters<RemoteTargetRelayTransport["recordStart"]>[0],
  ): Promise<void> {
    this.starts.push(input);
  }

  async complete(
    input: Parameters<RemoteTargetRelayTransport["complete"]>[0],
  ): Promise<void> {
    this.completions.push(input);
  }

  async revokeHost(
    input: Parameters<RemoteTargetRelayTransport["revokeHost"]>[0],
  ): Promise<RemoteTargetHostRevocationPage> {
    expect(input.enrollment.identity.runtimeId).toBe(HOST_ID);
    this.revokeRequests += 1;
    return {
      hostId: HOST_ID,
      status: "revoked",
      alreadyRevoked: this.revokeRequests > 1,
      cleanup: {
        sessions: this.revokeRequests === 1 ? 1 : 0,
        commands: this.revokeRequests === 1 ? 1 : 0,
        more: false,
      },
    };
  }
}

function createStatusClaim(input: {
  relay: DeterministicRelay;
  target: RemoteTargetPublicIdentity;
}): {
  claim: RemoteTargetClaim;
  command: ReturnType<typeof signRemoteCommand>;
} {
  const commandId = randomUUID();
  const body = {
    version: REMOTE_CONTROL_PROTOCOL_VERSION,
    ownerId: OWNER_ID,
    grantId: GRANT_ID,
    grantRevision: 1,
    sessionId: SESSION_ID,
    controllerDeviceId: input.relay.controller.deviceId,
    controllerKeyId: input.relay.controller.keyId,
    targetRuntimeId: HOST_ID,
    targetKeyId: input.target.keyId,
    commandId,
    sequence: 1,
    nonce: randomUUID(),
    issuedAt: NOW - 1_000,
    expiresAt: NOW + 30_000,
    action: "agent.status" as const,
    payload: {},
    payloadDigest: digestRemotePayload({}),
  };
  const command = signRemoteCommand(body, input.relay.controllerSigningPrivate);
  const envelope = sealRemoteControlMessage(
    command,
    {
      ...body,
      messageKind: "command",
      senderKeyId: input.relay.controller.keyId,
      recipientKeyId: input.target.keyId,
    },
    input.target.encryptionPublicKeyJwk,
  );
  return {
    command,
    claim: {
      commandId,
      sequence: 1,
      envelope,
      claimAttempt: 1,
      claimToken: randomUUID(),
      claimExpiresAt: NOW + 20_000,
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the joined remote-target flow.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("same-host remote target integration with injected secret-store and relay boundaries", () => {
  it("persists authority across recreation, executes loopback status once under retry, and cannot resurrect after revoke", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-remote-target-integration-"),
    );
    tempRoots.push(root);
    const journalPath = path.join(root, "remote-target", "journal-v1.json");
    const secureStore = new InjectedSecureStore();
    const relay = new DeterministicRelay();
    const loopback = await startLoopbackHealthServer();

    const enrollmentService = new RemoteTargetDesktopService(
      new RemoteTargetVault(secureStore, VAULT_ID),
      new JsonFileRemoteTargetStateStore(journalPath),
      relay,
      () => NOW,
    );
    services.push(enrollmentService);
    const enrolled = await enrollmentService.enroll({
      apiBaseUrl: "https://relay.example.test",
      ownerId: OWNER_ID,
      ownerAccessToken: OWNER_TOKEN,
      displayName: "Same-host Linux target",
    });
    expect(enrolled).toMatchObject({ hostId: HOST_ID, status: "active" });
    expect(relay.enrollmentRequest).toMatchObject({
      ownerId: OWNER_ID,
      ownerAccessToken: OWNER_TOKEN,
      runtimeKeyId: enrolled.identity.keyId,
    });
    const secureSlot = secureStore.values.get(
      `${VAULT_ID}\0runtime.agent_profiles`,
    );
    expect(secureSlot).toContain('"status":"enrolled"');
    expect(secureSlot).toContain(HOST_TOKEN);
    expect(secureSlot).not.toContain(OWNER_TOKEN);

    // Recreate the native service before activation to prove enrollment comes
    // from the injected platform boundary rather than retained object state.
    const activationService = new RemoteTargetDesktopService(
      new RemoteTargetVault(secureStore, VAULT_ID),
      new JsonFileRemoteTargetStateStore(journalPath),
      relay,
      () => NOW,
    );
    services.push(activationService);
    await activationService.configureLoopback({
      apiBase: loopback.apiBase,
      apiToken: API_TOKEN,
      pollIntervalMs: 250,
    });
    await expect(
      activationService.activate({
        sessionId: SESSION_ID,
        code: PAIRING_CODE,
      }),
    ).resolves.toMatchObject({ sessionId: SESSION_ID, status: "active" });
    const activeState = await new JsonFileRemoteTargetStateStore(
      journalPath,
    ).read();
    expect(activeState.sessions[SESSION_ID]?.grant).toMatchObject({
      ownerId: OWNER_ID,
      targetRuntimeIds: [HOST_ID],
      revokedAt: null,
    });
    const journalBytes = await fs.readFile(journalPath, "utf8");
    expect(journalBytes).not.toContain(OWNER_TOKEN);
    expect(journalBytes).not.toContain(HOST_TOKEN);
    expect(journalBytes).not.toContain(API_TOKEN);
    expect((await fs.stat(journalPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(journalPath))).mode & 0o777).toBe(0o700);

    const { claim, command } = createStatusClaim({
      relay,
      target: enrolled.identity,
    });
    relay.claims.push(claim, claim);

    // Recreate both vault and journal adapters again. Resume must join the two
    // durable halves of authority and execute through the real loopback HTTP
    // boundary without any retained runner state.
    const resumedService = new RemoteTargetDesktopService(
      new RemoteTargetVault(secureStore, VAULT_ID),
      new JsonFileRemoteTargetStateStore(journalPath),
      relay,
      () => NOW,
    );
    services.push(resumedService);
    await expect(
      resumedService.resumeEligibleLoopback({
        apiBase: loopback.apiBase,
        apiToken: API_TOKEN,
        pollIntervalMs: 250,
      }),
    ).resolves.toEqual({ resumed: true, reason: "active_authority" });
    await waitFor(() => relay.claimRequests >= 2);
    await resumedService.stop();

    expect(loopback.calls).toEqual([
      {
        authorization: `Bearer ${API_TOKEN}`,
        executionId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
        method: "GET",
        url: "/api/health",
      },
    ]);
    expect(relay.starts).toHaveLength(1);
    expect(relay.completions).toHaveLength(1);
    expect(relay.starts[0]?.commandId).toBe(claim.commandId);
    expect(relay.completions[0]?.commandId).toBe(claim.commandId);

    const startEnvelope = relay.starts[0]?.envelope;
    const resultEnvelope = relay.completions[0]?.envelope;
    if (!startEnvelope || !resultEnvelope) {
      throw new Error("Expected encrypted start and result envelopes.");
    }
    const start = openRemoteControlMessage(
      startEnvelope,
      relay.controllerEncryptionPrivate,
      {
        ...claim.envelope,
        messageKind: "start_receipt",
        senderKeyId: enrolled.identity.keyId,
        recipientKeyId: relay.controller.keyId,
      },
    );
    const result = openRemoteControlMessage(
      resultEnvelope,
      relay.controllerEncryptionPrivate,
      {
        ...claim.envelope,
        messageKind: "result",
        senderKeyId: enrolled.identity.keyId,
        recipientKeyId: relay.controller.keyId,
      },
    );
    expect(
      verifyRemoteCommandStartReceipt(
        start as never,
        enrolled.identity,
        command,
      ),
    ).toBe(true);
    expect(
      verifyRemoteCommandResult(result as never, enrolled.identity, command),
    ).toBe(true);
    expect("result" in result.body ? result.body.result : undefined).toEqual({
      status: 200,
      body: '{"ready":true,"runtime":"linux"}',
      headers: { "content-type": "application/json" },
    });

    const completedState = await new JsonFileRemoteTargetStateStore(
      journalPath,
    ).read();
    expect(completedState.commands[claim.commandId]).toMatchObject({
      status: "completed",
      resultDelivered: true,
      claimAttempt: null,
      claimToken: null,
    });

    await resumedService.revoke({ sessionId: SESSION_ID });
    await resumedService.revoke({ sessionId: SESSION_ID });
    const revokedState = await new JsonFileRemoteTargetStateStore(
      journalPath,
    ).read();
    expect(revokedState.sessions[SESSION_ID]?.grant).toMatchObject({
      revision: 2,
      revokedAt: NOW,
    });
    await resumedService.finalizeHostRevoke({
      hostId: HOST_ID,
      cloudRevoked: true,
    });
    await resumedService.finalizeHostRevoke({
      hostId: HOST_ID,
      cloudRevoked: true,
    });
    expect(relay.revokeRequests).toBe(1);

    expect(secureStore.values.size).toBe(0);
    const afterRevoke = new RemoteTargetDesktopService(
      new RemoteTargetVault(secureStore, VAULT_ID),
      new JsonFileRemoteTargetStateStore(journalPath),
      relay,
      () => NOW,
    );
    services.push(afterRevoke);
    await expect(
      afterRevoke.resumeEligibleLoopback({
        apiBase: loopback.apiBase,
        apiToken: API_TOKEN,
        pollIntervalMs: 250,
      }),
    ).resolves.toEqual({ resumed: false, reason: "not_enrolled" });
    await expect(afterRevoke.getIdentity()).resolves.toEqual({
      enrolled: false,
    });
    await expect(
      new JsonFileRemoteTargetStateStore(journalPath).read(),
    ).resolves.toMatchObject({ sessions: {}, commands: {} });
    expect(loopback.calls).toHaveLength(1);
  });
});

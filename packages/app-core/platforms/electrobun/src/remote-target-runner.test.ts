/**
 * Exercises the native target runner with real protocol cryptography and a
 * deterministic in-memory relay/state harness. The tests recreate runner
 * instances to prove crash boundaries without touching Cloud or OS services.
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  REMOTE_CONTROL_PROTOCOL_VERSION,
  type RemoteControllerPublicIdentity,
  type RemoteTargetPublicIdentity,
} from "@elizaos/shared/contracts/remote-control";
import { describe, expect, it } from "vitest";
import type {
  PlatformSecureStore,
  SecureStoreDeleteResult,
  SecureStoreGetResult,
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
import {
  RemoteTargetRunner,
  type RemoteTargetRunnerHooks,
} from "./remote-target-runner";
import {
  MemoryRemoteTargetStateStore,
  remoteTargetStoreInternals,
} from "./remote-target-store";
import {
  type RemoteTargetActivationResponse,
  type RemoteTargetClaim,
  type RemoteTargetEnrollmentRequest,
  type RemoteTargetEnrollmentResponse,
  type RemoteTargetRelayTransport,
  RemoteTargetTransportError,
} from "./remote-target-transport";
import { RemoteTargetVault } from "./remote-target-vault";

const NOW = 2_000_000_000_000;
const HOST_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const GRANT_ID = "33333333-3333-4333-8333-333333333333";

class MemorySecureStore implements PlatformSecureStore {
  readonly backend = "none" as const;
  readonly values = new Map<string, string>();

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async get(vaultId: string): Promise<SecureStoreGetResult> {
    const value = this.values.get(vaultId);
    return value === undefined
      ? { ok: false, reason: "not_found" }
      : { ok: true, value };
  }

  async set(
    vaultId: string,
    _kind: unknown,
    value: string,
  ): Promise<SecureStoreSetResult> {
    this.values.set(vaultId, value);
    return { ok: true };
  }

  async delete(vaultId: string): Promise<SecureStoreDeleteResult> {
    return { ok: true, deleted: this.values.delete(vaultId) };
  }
}

class FakeRelay implements RemoteTargetRelayTransport {
  readonly claims: RemoteTargetClaim[] = [];
  readonly starts: {
    commandId: string;
    envelope: RemoteTargetClaim["envelope"];
  }[] = [];
  readonly completions: {
    commandId: string;
    envelope: RemoteTargetClaim["envelope"];
  }[] = [];
  startFailure: Error | null = null;
  completionFailure: Error | null = null;

  async enroll(
    _input: RemoteTargetEnrollmentRequest,
  ): Promise<RemoteTargetEnrollmentResponse> {
    throw new Error("unused");
  }

  async activate(): Promise<RemoteTargetActivationResponse> {
    throw new Error("unused");
  }

  async claimNext(
    _input: Parameters<RemoteTargetRelayTransport["claimNext"]>[0],
  ): Promise<RemoteTargetClaim | null> {
    return this.claims.shift() ?? null;
  }

  async recordStart(input: {
    commandId: string;
    envelope: RemoteTargetClaim["envelope"];
  }): Promise<void> {
    if (this.startFailure) {
      const error = this.startFailure;
      this.startFailure = null;
      throw error;
    }
    this.starts.push(input);
  }

  async complete(input: {
    commandId: string;
    envelope: RemoteTargetClaim["envelope"];
  }): Promise<void> {
    if (this.completionFailure) {
      const error = this.completionFailure;
      this.completionFailure = null;
      throw error;
    }
    this.completions.push(input);
  }
}

class SessionAwareRelay extends FakeRelay {
  constructor(private readonly deadSessionId: string) {
    super();
  }

  override async claimNext(
    input: Parameters<RemoteTargetRelayTransport["claimNext"]>[0],
  ): Promise<RemoteTargetClaim | null> {
    if (input.sessionId === this.deadSessionId) {
      throw new RemoteTargetTransportError("HTTP_404", 404);
    }
    return super.claimNext(input);
  }
}

class DeferredClaimRelay extends FakeRelay {
  readonly claimRequested: Promise<void>;
  private markClaimRequested: () => void = () => undefined;
  private releaseClaim: (claim: RemoteTargetClaim | null) => void = () =>
    undefined;
  private readonly deferredClaim: Promise<RemoteTargetClaim | null>;
  private claimDeferred = true;

  constructor() {
    super();
    this.claimRequested = new Promise((resolve) => {
      this.markClaimRequested = resolve;
    });
    this.deferredClaim = new Promise((resolve) => {
      this.releaseClaim = resolve;
    });
  }

  override async claimNext(
    _input: Parameters<RemoteTargetRelayTransport["claimNext"]>[0],
  ): Promise<RemoteTargetClaim | null> {
    if (!this.claimDeferred) return null;
    this.claimDeferred = false;
    this.markClaimRequested();
    return this.deferredClaim;
  }

  resolveClaim(claim: RemoteTargetClaim | null): void {
    this.releaseClaim(claim);
  }
}

function privateKey(): JsonWebKey {
  return generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  }).privateKey.export({ format: "jwk" });
}

function publicKey(privateJwk: JsonWebKey): JsonWebKey {
  const { d: _privateScalar, ...publicJwk } = privateJwk;
  return publicJwk;
}

interface Harness {
  vault: RemoteTargetVault;
  state: MemoryRemoteTargetStateStore;
  relay: FakeRelay;
  target: RemoteTargetPublicIdentity;
  controller: RemoteControllerPublicIdentity;
  controllerSigningPrivate: JsonWebKey;
  controllerEncryptionPrivate: JsonWebKey;
  activation: RemoteTargetActivationResponse;
}

async function createHarness(): Promise<Harness> {
  const vault = new RemoteTargetVault(new MemorySecureStore(), "test-target");
  const pending = await vault.prepare({
    ownerId: "owner-1",
    displayName: "Linux target",
    now: NOW - 10_000,
  });
  if (pending.status !== "pending") throw new Error("expected pending target");
  const enrolled = await vault.commitEnrollment({
    apiBaseUrl: "https://api.example.test",
    hostId: HOST_ID,
    hostToken: `rhost_v1_${"A".repeat(43)}`,
    runtimeKeyId: pending.keyId,
    createdAt: NOW - 9_000,
  });
  const controllerSigningPrivate = privateKey();
  const controllerEncryptionPrivate = privateKey();
  const controller: RemoteControllerPublicIdentity = {
    version: REMOTE_CONTROL_PROTOCOL_VERSION,
    role: "controller",
    ownerId: "owner-1",
    deviceId: "controller-device-1",
    keyId: "controller-key-1",
    displayName: "Controller",
    platform: "linux",
    signingPublicKeyJwk: publicKey(controllerSigningPrivate),
    encryptionPublicKeyJwk: publicKey(controllerEncryptionPrivate),
    createdAt: NOW - 8_000,
  };
  const activation: RemoteTargetActivationResponse = {
    sessionId: SESSION_ID,
    grantId: GRANT_ID,
    grantRevision: 1,
    ownerId: "owner-1",
    controller,
    targetRuntimeId: HOST_ID,
    targetKeyId: enrolled.identity.keyId,
    grantExpiresAt: NOW + 3_600_000,
    status: "active",
  };
  return {
    vault,
    state: new MemoryRemoteTargetStateStore(),
    relay: new FakeRelay(),
    target: enrolled.identity,
    controller,
    controllerSigningPrivate,
    controllerEncryptionPrivate,
    activation,
  };
}

function claimFor(harness: Harness, sequence = 1): RemoteTargetClaim {
  const commandId = randomUUID();
  const body = {
    version: REMOTE_CONTROL_PROTOCOL_VERSION,
    ownerId: "owner-1",
    grantId: GRANT_ID,
    grantRevision: 1,
    sessionId: SESSION_ID,
    controllerDeviceId: harness.controller.deviceId,
    controllerKeyId: harness.controller.keyId,
    targetRuntimeId: HOST_ID,
    targetKeyId: harness.target.keyId,
    commandId,
    sequence,
    nonce: randomUUID(),
    issuedAt: NOW - 1_000,
    expiresAt: NOW + 30_000,
    action: "agent.status" as const,
    payload: {},
    payloadDigest: digestRemotePayload({}),
  };
  const command = signRemoteCommand(body, harness.controllerSigningPrivate);
  const envelope = sealRemoteControlMessage(
    command,
    {
      ...body,
      messageKind: "command",
      senderKeyId: harness.controller.keyId,
      recipientKeyId: harness.target.keyId,
    },
    harness.target.encryptionPublicKeyJwk,
  );
  return {
    commandId,
    sequence,
    envelope,
    claimAttempt: 1,
    claimToken: randomUUID(),
    claimExpiresAt: NOW + 20_000,
  };
}

async function createRunner(
  harness: Harness,
  execute: () => Promise<void> | void,
  hooks: RemoteTargetRunnerHooks = {},
): Promise<RemoteTargetRunner> {
  const runner = new RemoteTargetRunner(
    harness.vault,
    harness.state,
    harness.relay,
    {
      execute: async () => {
        await execute();
        return {
          status: "completed",
          result: {
            status: 200,
            body: '{"ready":true}',
            headers: { "content-type": "application/json" },
          },
        };
      },
    },
    { now: () => NOW, hooks },
  );
  await runner.installActivation(harness.activation);
  return runner;
}

describe("remote target durable runner", () => {
  it("executes and delivers one real encrypted status command exactly once", async () => {
    const harness = await createHarness();
    let executions = 0;
    const runner = await createRunner(harness, () => {
      executions += 1;
    });
    const claim = claimFor(harness);
    harness.relay.claims.push(claim, claim);

    expect(await runner.pollOnce()).toBe("completed");
    expect(await runner.pollOnce()).toBe("duplicate");
    expect(executions).toBe(1);
    expect(harness.relay.starts.map((item) => item.commandId)).toEqual([
      claim.commandId,
    ]);
    expect(harness.relay.completions.map((item) => item.commandId)).toEqual([
      claim.commandId,
    ]);
    const command = openRemoteControlMessage(
      claim.envelope,
      ((await harness.vault.load()) as { encryptionPrivateKeyJwk: JsonWebKey })
        .encryptionPrivateKeyJwk,
      {
        ...claim.envelope,
        messageKind: "command",
        senderKeyId: harness.controller.keyId,
        recipientKeyId: harness.target.keyId,
      },
    );
    if (
      !("signature" in command) ||
      command.body.commandId !== claim.commandId
    ) {
      throw new Error("expected signed command");
    }
    const startEnvelope = harness.relay.starts[0]?.envelope;
    const completedEnvelope = harness.relay.completions[0]?.envelope;
    if (!startEnvelope || !completedEnvelope)
      throw new Error("missing envelopes");
    const start = openRemoteControlMessage(
      startEnvelope,
      harness.controllerEncryptionPrivate,
      {
        ...claim.envelope,
        messageKind: "start_receipt",
        senderKeyId: harness.target.keyId,
        recipientKeyId: harness.controller.keyId,
      },
    );
    const completed = openRemoteControlMessage(
      completedEnvelope,
      harness.controllerEncryptionPrivate,
      {
        ...claim.envelope,
        messageKind: "result",
        senderKeyId: harness.target.keyId,
        recipientKeyId: harness.controller.keyId,
      },
    );
    expect(
      verifyRemoteCommandStartReceipt(
        start as never,
        harness.target,
        command as never,
      ),
    ).toBe(true);
    expect(
      verifyRemoteCommandResult(
        completed as never,
        harness.target,
        command as never,
      ),
    ).toBe(true);
    expect(
      "result" in completed.body ? completed.body.result : undefined,
    ).toEqual({
      status: 200,
      body: '{"ready":true}',
      headers: { "content-type": "application/json" },
    });
    const state = await harness.state.read();
    expect(state.commands[claim.commandId]?.status).toBe("completed");
    expect(state.commands[claim.commandId]?.resultDelivered).toBe(true);
    expect(state.commands[claim.commandId]?.claimToken).toBeNull();
  });

  it("retries a crash before durable start and runs the effect once", async () => {
    const harness = await createHarness();
    const claim = claimFor(harness);
    let executions = 0;
    const crashing = await createRunner(
      harness,
      () => {
        executions += 1;
      },
      {
        afterReserve: () => {
          throw new Error("crash-before-start");
        },
      },
    );
    harness.relay.claims.push(claim);
    await expect(crashing.pollOnce()).rejects.toThrow("crash-before-start");
    expect((await harness.state.read()).commands[claim.commandId]?.status).toBe(
      "reserved",
    );

    const restarted = await createRunner(harness, () => {
      executions += 1;
    });
    harness.relay.claims.push({
      ...claim,
      claimAttempt: 2,
      claimToken: randomUUID(),
    });
    expect(await restarted.pollOnce()).toBe("completed");
    expect(executions).toBe(1);
  });

  it("rejects state-store failures instead of reporting a false offline state", async () => {
    const harness = await createHarness();
    harness.state.read = async () => {
      throw new Error("journal-read-failed");
    };
    const runner = await createRunner(harness, () => undefined);

    await expect(runner.pollOnce()).rejects.toThrow("journal-read-failed");
  });

  it("resends an unacknowledged start after restart before dispatching", async () => {
    const harness = await createHarness();
    const claim = claimFor(harness);
    let executions = 0;
    const first = await createRunner(harness, () => {
      executions += 1;
    });
    harness.relay.startFailure = new RemoteTargetTransportError(
      "NETWORK_UNAVAILABLE",
      0,
    );
    harness.relay.claims.push(claim);
    expect(await first.pollOnce()).toBe("offline");
    const interrupted = (await harness.state.read()).commands[claim.commandId];
    expect(interrupted?.startDelivered).toBe(false);
    expect(interrupted?.effectDispatched).toBe(false);

    const restarted = await createRunner(harness, () => {
      executions += 1;
    });
    expect(await restarted.recoverInterrupted()).toBe(1);
    expect(executions).toBe(1);
    expect(harness.relay.starts.map((item) => item.commandId)).toEqual([
      claim.commandId,
    ]);
  });

  it("reports ambiguity and never repeats an effect dispatched before crash", async () => {
    const harness = await createHarness();
    const claim = claimFor(harness);
    let executions = 0;
    const first = await createRunner(
      harness,
      () => {
        executions += 1;
      },
      {
        afterEffect: () => {
          throw new Error("crash-after-effect");
        },
      },
    );
    harness.relay.claims.push(claim);
    await expect(first.pollOnce()).rejects.toThrow("crash-after-effect");
    expect(executions).toBe(1);

    const restarted = await createRunner(harness, () => {
      executions += 1;
    });
    expect(await restarted.recoverInterrupted()).toBe(1);
    expect(executions).toBe(1);
    expect((await harness.state.read()).commands[claim.commandId]?.status).toBe(
      "execution_ambiguous",
    );
  });

  it("retries terminal delivery after an offline completion without re-execution", async () => {
    const harness = await createHarness();
    const claim = claimFor(harness);
    let executions = 0;
    const runner = await createRunner(harness, () => {
      executions += 1;
    });
    harness.relay.completionFailure = new RemoteTargetTransportError(
      "NETWORK_UNAVAILABLE",
      0,
    );
    harness.relay.claims.push(claim);
    expect(await runner.pollOnce()).toBe("offline");
    expect(executions).toBe(1);
    expect(
      (await harness.state.read()).commands[claim.commandId]?.resultDelivered,
    ).toBe(false);

    expect(await runner.pollOnce()).toBe("empty");
    expect(executions).toBe(1);
    expect(harness.relay.completions.map((item) => item.commandId)).toEqual([
      claim.commandId,
    ]);
  });

  it("terminalizes an expired relay claim and continues polling", async () => {
    const harness = await createHarness();
    const claim = claimFor(harness);
    let executions = 0;
    const runner = await createRunner(harness, () => {
      executions += 1;
    });
    harness.relay.completionFailure = new RemoteTargetTransportError(
      "EXECUTION_AMBIGUOUS",
      409,
    );
    harness.relay.claims.push(claim);
    expect(await runner.pollOnce()).toBe("completed");
    expect(await runner.pollOnce()).toBe("empty");
    expect(executions).toBe(1);
    const stored = (await harness.state.read()).commands[claim.commandId];
    expect(stored?.resultDelivered).toBe(true);
    expect(stored?.status).toBe("execution_ambiguous");
  });

  it("rejects an expired claim before crossing the durable start boundary", async () => {
    const harness = await createHarness();
    let executions = 0;
    const runner = await createRunner(harness, () => {
      executions += 1;
    });
    harness.relay.claims.push({
      ...claimFor(harness),
      claimExpiresAt: NOW - 1,
    });
    await expect(runner.pollOnce()).rejects.toThrow("expired before");
    expect(executions).toBe(0);
    expect(harness.relay.starts).toHaveLength(0);
  });

  it("rejects tampered owner routing and a sequence gap without durable admission", async () => {
    const harness = await createHarness();
    let executions = 0;
    const runner = await createRunner(harness, () => {
      executions += 1;
    });
    const tampered = claimFor(harness);
    tampered.envelope = { ...tampered.envelope, ownerId: "other-owner" };
    harness.relay.claims.push(tampered, claimFor(harness, 2));
    await expect(runner.pollOnce()).rejects.toThrow();
    await expect(runner.pollOnce()).rejects.toThrow();
    expect(executions).toBe(0);
    expect(Object.keys((await harness.state.read()).commands)).toHaveLength(0);
  });

  it("revokes a session idempotently and clears its replay state", async () => {
    const harness = await createHarness();
    const runner = await createRunner(harness, () => undefined);
    await runner.revokeSession(SESSION_ID);
    await runner.revokeSession(SESSION_ID);
    const session = (await harness.state.read()).sessions[SESSION_ID];
    expect(session?.grant.revokedAt).toBe(NOW);
    expect(session?.grant.revision).toBe(2);
    expect(session?.nonces).toEqual({});
    expect(session?.stoppedAt).toBe(NOW);
  });

  it("fails closed on oversized replay maps and inconsistent delivery state", async () => {
    const harness = await createHarness();
    const runner = await createRunner(harness, () => undefined);
    const state = await harness.state.read();
    const session = state.sessions[SESSION_ID];
    if (!session) throw new Error("missing session");
    for (let index = 0; index < 4_097; index += 1) {
      session.nonces[`nonce-${index}`] = NOW + 1_000;
    }
    expect(() => remoteTargetStoreInternals.assertState(state)).toThrow(
      "corrupt",
    );

    const cleanHarness = await createHarness();
    const cleanRunner = await createRunner(cleanHarness, () => undefined);
    const claim = claimFor(cleanHarness);
    cleanHarness.relay.claims.push(claim);
    await cleanRunner.pollOnce();
    const inconsistent = await cleanHarness.state.read();
    const command = inconsistent.commands[claim.commandId];
    if (!command) throw new Error("missing command");
    command.resultEnvelope = null;
    expect(() => remoteTargetStoreInternals.assertState(inconsistent)).toThrow(
      "inconsistent",
    );
    await runner.stop();
  });

  it("fences a missing session without starving another active session", async () => {
    const harness = await createHarness();
    const deadSessionId = "11111111-2222-4111-8111-111111111111";
    harness.relay = new SessionAwareRelay(deadSessionId);
    let executions = 0;
    const runner = await createRunner(harness, () => {
      executions += 1;
    });
    await runner.installActivation({
      ...harness.activation,
      sessionId: deadSessionId,
      grantId: "11111111-3333-4111-8111-111111111111",
    });
    const claim = claimFor(harness);
    harness.relay.claims.push(claim);
    expect(await runner.pollOnce()).toBe("completed");
    expect(executions).toBe(1);
    expect(
      (await harness.state.read()).sessions[deadSessionId]?.stoppedAt,
    ).toBe(NOW);
  });

  it("stops across an in-flight claim boundary without admitting an effect", async () => {
    const harness = await createHarness();
    const relay = new DeferredClaimRelay();
    harness.relay = relay;
    let executions = 0;
    const runner = await createRunner(harness, () => {
      executions += 1;
    });
    const claim = claimFor(harness);

    const starting = runner.start();
    await relay.claimRequested;
    const stopping = runner.stop();
    relay.resolveClaim(claim);
    await Promise.all([starting, stopping]);

    expect(executions).toBe(0);
    expect(Object.keys((await harness.state.read()).commands)).toHaveLength(0);
    expect((await runner.status()).running).toBe(false);
  });

  it("does not finish stopping while startup recovery is executing an effect", async () => {
    const harness = await createHarness();
    const claim = claimFor(harness);
    const interrupted = await createRunner(harness, () => undefined);
    harness.relay.startFailure = new RemoteTargetTransportError(
      "NETWORK_UNAVAILABLE",
      0,
    );
    harness.relay.claims.push(claim);
    expect(await interrupted.pollOnce()).toBe("offline");

    let enterEffect: () => void = () => undefined;
    const effectEntered = new Promise<void>((resolve) => {
      enterEffect = resolve;
    });
    let releaseEffect: () => void = () => undefined;
    const effectReleased = new Promise<void>((resolve) => {
      releaseEffect = resolve;
    });
    const recovering = await createRunner(harness, async () => {
      enterEffect();
      await effectReleased;
    });
    const starting = recovering.start();
    await effectEntered;
    let stopFinished = false;
    const stopping = recovering.stop().then(() => {
      stopFinished = true;
    });
    await Promise.resolve();
    expect(stopFinished).toBe(false);
    releaseEffect();
    await Promise.all([starting, stopping]);
    expect(stopFinished).toBe(true);
    expect((await recovering.status()).running).toBe(false);
  });

  it("keeps repeated start and stop calls idempotent", async () => {
    const harness = await createHarness();
    const runner = await createRunner(harness, () => undefined);

    await runner.start();
    await runner.start();
    expect((await runner.status()).running).toBe(true);
    await runner.stop();
    await runner.stop();
    expect((await runner.status()).running).toBe(false);
  });

  it("serializes reconfiguration across an old in-flight poll", async () => {
    const harness = await createHarness();
    const relay = new DeferredClaimRelay();
    harness.relay = relay;
    await createRunner(harness, () => undefined);
    const service = new RemoteTargetDesktopService(
      harness.vault,
      harness.state,
      relay,
      () => NOW,
    );
    const firstConfiguration = {
      apiBase: "http://127.0.0.1:31337",
      apiToken: "first-local-token-123456789",
    };
    const secondConfiguration = {
      apiBase: "http://127.0.0.1:31338",
      apiToken: "second-local-token-123456789",
    };
    await service.configureLoopback(firstConfiguration);
    const startingOldRunner = service.start();
    await relay.claimRequested;
    const reconfiguring = service.configureLoopback(secondConfiguration);
    relay.resolveClaim(claimFor(harness));
    await Promise.all([startingOldRunner, reconfiguring]);

    expect(Object.keys((await harness.state.read()).commands)).toHaveLength(0);
    expect((await service.status()).running).toBe(false);
    await service.start();
    expect((await service.status()).running).toBe(true);
    await expect(
      service.configureLoopback({
        apiBase: "http://127.0.0.1:31339",
        apiToken: "short",
      }),
    ).rejects.toThrow("authentication is unavailable");
    expect((await service.status()).running).toBe(true);
    await service.configureLoopback(secondConfiguration);
    expect((await service.status()).running).toBe(true);
    await service.stop();
  });
});

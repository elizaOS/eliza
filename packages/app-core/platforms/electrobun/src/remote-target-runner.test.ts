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
import { describe, expect, it, vi } from "vitest";
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
  type RemoteTargetDurableState,
  type RemoteTargetStateStore,
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

class DeferredReadStateStore implements RemoteTargetStateStore {
  private deferredRead: Promise<void> | null = null;
  private releaseDeferredRead: (() => void) | null = null;
  private signalReadStarted: (() => void) | null = null;

  constructor(private readonly delegate: RemoteTargetStateStore) {}

  deferNextRead(): { started: Promise<void>; release: () => void } {
    this.deferredRead = new Promise<void>((resolve) => {
      this.releaseDeferredRead = resolve;
    });
    const started = new Promise<void>((resolve) => {
      this.signalReadStarted = resolve;
    });
    return {
      started,
      release: () => this.releaseDeferredRead?.(),
    };
  }

  async read(): Promise<RemoteTargetDurableState> {
    const snapshot = await this.delegate.read();
    const deferred = this.deferredRead;
    if (deferred) {
      this.deferredRead = null;
      this.signalReadStarted?.();
      await deferred;
      this.releaseDeferredRead = null;
      this.signalReadStarted = null;
    }
    return snapshot;
  }

  clear(): Promise<void> {
    return this.delegate.clear();
  }

  transact<T>(
    operation: (state: RemoteTargetDurableState) => T | Promise<T>,
  ): Promise<T> {
    return this.delegate.transact(operation);
  }
}

class FailingTransactionStateStore implements RemoteTargetStateStore {
  private readonly delegate = new MemoryRemoteTargetStateStore();
  private transactionCount = 0;

  constructor(private readonly failTransactionNumber = 1) {}

  read(): Promise<RemoteTargetDurableState> {
    return this.delegate.read();
  }

  clear(): Promise<void> {
    return this.delegate.clear();
  }

  transact<T>(
    operation: (state: RemoteTargetDurableState) => T | Promise<T>,
  ): Promise<T> {
    this.transactionCount += 1;
    if (this.transactionCount === this.failTransactionNumber) {
      return Promise.reject(new Error("local-journal-write-failed"));
    }
    return this.delegate.transact(operation);
  }
}

class FakeRelay implements RemoteTargetRelayTransport {
  claimRequests = 0;
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
  compensationFailure: Error | null = null;
  readonly compensations: string[] = [];
  commitFailure: Error | null = null;
  readonly commits: string[] = [];
  readonly revocations: Array<{
    hostId: string;
    status: "revoked";
    alreadyRevoked: boolean;
    cleanup: { sessions: number; commands: number; more: boolean };
  }> = [];

  async enroll(
    _input: RemoteTargetEnrollmentRequest,
  ): Promise<RemoteTargetEnrollmentResponse> {
    throw new Error("unused");
  }

  async activateManagedNetwork(): Promise<{ hostname: string }> {
    throw new Error("unused");
  }

  async activate(): Promise<RemoteTargetActivationResponse> {
    throw new Error("unused");
  }

  async compensateActivation(
    input: Parameters<RemoteTargetRelayTransport["compensateActivation"]>[0],
  ): Promise<
    Awaited<ReturnType<RemoteTargetRelayTransport["compensateActivation"]>>
  > {
    this.compensations.push(input.sessionId);
    if (this.compensationFailure) throw this.compensationFailure;
    return {
      sessionId: input.sessionId,
      status: "revoked",
      alreadyCompensated: this.compensations.length > 1,
    };
  }

  async commitActivation(
    input: Parameters<RemoteTargetRelayTransport["commitActivation"]>[0],
  ): Promise<
    Awaited<ReturnType<RemoteTargetRelayTransport["commitActivation"]>>
  > {
    this.commits.push(input.sessionId);
    if (this.commitFailure) throw this.commitFailure;
    return {
      sessionId: input.sessionId,
      status: "active",
      alreadyCommitted: this.commits.length > 1,
    };
  }

  async claimNext(
    _input: Parameters<RemoteTargetRelayTransport["claimNext"]>[0],
  ): Promise<RemoteTargetClaim | null> {
    this.claimRequests += 1;
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

  async revokeHost(): Promise<{
    hostId: string;
    status: "revoked";
    alreadyRevoked: boolean;
    cleanup: { sessions: number; commands: number; more: boolean };
  }> {
    const page = this.revocations.shift();
    if (!page) throw new Error("authoritative revocation unavailable");
    return page;
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

class BackgroundFailureRelay extends FakeRelay {
  override async claimNext(
    input: Parameters<RemoteTargetRelayTransport["claimNext"]>[0],
  ): Promise<RemoteTargetClaim | null> {
    if (this.claimRequests > 0) throw new Error("journal-integrity-failed");
    return super.claimNext(input);
  }
}

class DeferredActivationRelay extends FakeRelay {
  readonly activationRequested: Promise<void>;
  private markActivationRequested: () => void = () => undefined;
  private releaseActivation: (
    activation: RemoteTargetActivationResponse,
  ) => void = () => undefined;
  private readonly deferredActivation: Promise<RemoteTargetActivationResponse>;

  constructor() {
    super();
    this.activationRequested = new Promise((resolve) => {
      this.markActivationRequested = resolve;
    });
    this.deferredActivation = new Promise((resolve) => {
      this.releaseActivation = resolve;
    });
  }

  override async activate(): Promise<RemoteTargetActivationResponse> {
    this.markActivationRequested();
    return this.deferredActivation;
  }

  resolveActivation(activation: RemoteTargetActivationResponse): void {
    this.releaseActivation(activation);
  }
}

class ImmediateActivationRelay extends FakeRelay {
  constructor(private readonly activation: RemoteTargetActivationResponse) {
    super();
  }

  override async activate(): Promise<RemoteTargetActivationResponse> {
    return this.activation;
  }
}

class DeferredCompensationRelay extends ImmediateActivationRelay {
  readonly compensationRequested: Promise<void>;
  private markCompensationRequested: () => void = () => undefined;
  private releaseCompensation: () => void = () => undefined;
  private readonly deferredCompensation: Promise<void>;

  constructor(activation: RemoteTargetActivationResponse) {
    super(activation);
    this.compensationRequested = new Promise((resolve) => {
      this.markCompensationRequested = resolve;
    });
    this.deferredCompensation = new Promise((resolve) => {
      this.releaseCompensation = resolve;
    });
  }

  override async compensateActivation(
    input: Parameters<RemoteTargetRelayTransport["compensateActivation"]>[0],
  ): Promise<
    Awaited<ReturnType<RemoteTargetRelayTransport["compensateActivation"]>>
  > {
    this.markCompensationRequested();
    await this.deferredCompensation;
    return super.compensateActivation(input);
  }

  resolveCompensation(): void {
    this.releaseCompensation();
  }
}

class ManagedEnrollmentRelay extends FakeRelay {
  activateManagedCalls = 0;
  activateManagedFailure: Error | null = null;

  override async enroll(
    input: RemoteTargetEnrollmentRequest,
  ): Promise<RemoteTargetEnrollmentResponse> {
    return {
      hostId: HOST_ID,
      hostToken: `rhost_v1_${"A".repeat(43)}`,
      runtimeKeyId: input.runtimeKeyId,
      status: "pending",
      createdAt: NOW - 1_000,
      recovered: false,
      managedNetworkEnrollment: {
        loginServer: "https://headscale.example.test",
        authKey: "hskey-auth-one-use-secret",
        hostname: "eliza-host-one",
        expiresAt: NOW + 30_000,
      },
    };
  }

  override async activateManagedNetwork(): Promise<{ hostname: string }> {
    this.activateManagedCalls += 1;
    if (this.activateManagedFailure) throw this.activateManagedFailure;
    return { hostname: "eliza-host-one-cnpx9uop" };
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
    status: "activating",
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
  pollIntervalMs?: number,
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
    { now: () => NOW, hooks, pollIntervalMs },
  );
  await runner.installActivation(harness.activation);
  await runner.commitLocalActivation(harness.activation.sessionId);
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
    await runner.commitLocalActivation(deadSessionId);
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

  it("observes a rejected background poll and stops reporting the loop as running", async () => {
    vi.useFakeTimers();
    try {
      const harness = await createHarness();
      harness.relay = new BackgroundFailureRelay();
      const runner = await createRunner(harness, () => undefined, {}, 250);

      await runner.start();
      expect(await runner.status()).toMatchObject({
        running: true,
        lastErrorCode: null,
      });

      await vi.advanceTimersByTimeAsync(250);

      expect(await runner.status()).toMatchObject({
        running: false,
        lastErrorCode: "REMOTE_TARGET_LOOP_FAILED",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-resumes one runner from durable enrollment and active authority", async () => {
    const harness = await createHarness();
    await createRunner(harness, () => undefined);
    const restarted = new RemoteTargetDesktopService(
      harness.vault,
      harness.state,
      harness.relay,
      () => NOW,
    );
    const input = {
      apiBase: "http://127.0.0.1:31337",
      apiToken: "restart-local-token-123456789",
      pollIntervalMs: 60_000,
    };

    const [first, duplicate] = await Promise.all([
      restarted.resumeEligibleLoopback(input),
      restarted.resumeEligibleLoopback(input),
    ]);

    expect(first).toEqual({ resumed: true, reason: "active_authority" });
    expect(duplicate).toEqual({ resumed: true, reason: "active_authority" });
    expect((await restarted.status()).running).toBe(true);
    expect(harness.relay.claimRequests).toBe(1);
    await restarted.stop();
  });

  it("auto-resume preserves the journal fence after a dispatched effect", async () => {
    const harness = await createHarness();
    let executions = 0;
    const interrupted = await createRunner(
      harness,
      () => {
        executions += 1;
      },
      {
        afterEffect: () => {
          throw new Error("desktop-process-exited");
        },
      },
    );
    const claim = claimFor(harness);
    harness.relay.claims.push(claim);
    await expect(interrupted.pollOnce()).rejects.toThrow(
      "desktop-process-exited",
    );
    expect(executions).toBe(1);

    const restarted = new RemoteTargetDesktopService(
      harness.vault,
      harness.state,
      harness.relay,
      () => NOW,
    );
    await restarted.resumeEligibleLoopback({
      apiBase: "http://127.0.0.1:31337",
      apiToken: "restart-local-token-123456789",
      pollIntervalMs: 60_000,
    });

    expect(executions).toBe(1);
    expect(
      (await harness.state.read()).commands[claim.commandId],
    ).toMatchObject({
      status: "execution_ambiguous",
      errorCode: "REMOTE_EXECUTION_INTERRUPTED",
      resultDelivered: true,
    });
    await restarted.stop();
  });

  it("never rehydrates a revoked remote authority", async () => {
    const harness = await createHarness();
    const authority = await createRunner(harness, () => undefined);
    await authority.revokeSession(SESSION_ID);
    const restarted = new RemoteTargetDesktopService(
      harness.vault,
      harness.state,
      harness.relay,
      () => NOW,
    );

    await expect(
      restarted.resumeEligibleLoopback({
        apiBase: "http://127.0.0.1:31337",
        apiToken: "restart-local-token-123456789",
      }),
    ).resolves.toEqual({ resumed: false, reason: "no_active_authority" });
    expect((await restarted.status()).running).toBe(false);
    expect(harness.relay.claimRequests).toBe(0);
  });

  it("never rehydrates a host removed after authoritative cloud revocation", async () => {
    const harness = await createHarness();
    await createRunner(harness, () => undefined);
    harness.relay.revocations.push({
      hostId: HOST_ID,
      status: "revoked",
      alreadyRevoked: true,
      cleanup: { sessions: 0, commands: 0, more: false },
    });
    const priorProcess = new RemoteTargetDesktopService(
      harness.vault,
      harness.state,
      harness.relay,
      () => NOW,
    );
    await priorProcess.finalizeHostRevoke({ hostId: HOST_ID });
    const restarted = new RemoteTargetDesktopService(
      harness.vault,
      harness.state,
      harness.relay,
      () => NOW,
    );

    await expect(
      restarted.resumeEligibleLoopback({
        apiBase: "http://127.0.0.1:31337",
        apiToken: "restart-local-token-123456789",
      }),
    ).resolves.toEqual({ resumed: false, reason: "not_enrolled" });
    expect(await harness.state.read()).toEqual({
      version: 1,
      sessions: {},
      commands: {},
    });
    expect(harness.relay.claimRequests).toBe(0);
  });

  it("serializes host finalization behind an in-flight startup resume", async () => {
    const harness = await createHarness();
    await createRunner(harness, () => undefined);
    harness.relay.revocations.push({
      hostId: HOST_ID,
      status: "revoked",
      alreadyRevoked: true,
      cleanup: { sessions: 0, commands: 0, more: false },
    });
    const deferredState = new DeferredReadStateStore(harness.state);
    const deferredRead = deferredState.deferNextRead();
    const service = new RemoteTargetDesktopService(
      harness.vault,
      deferredState,
      harness.relay,
      () => NOW,
    );

    const resuming = service.resumeEligibleLoopback({
      apiBase: "http://127.0.0.1:31337",
      apiToken: "restart-local-token-123456789",
      pollIntervalMs: 60_000,
    });
    await deferredRead.started;
    let finalized = false;
    const finalizing = service
      .finalizeHostRevoke({ hostId: HOST_ID })
      .then((result) => {
        finalized = true;
        return result;
      });
    await Promise.resolve();

    expect(finalized).toBe(false);
    expect((await harness.vault.load())?.status).toBe("enrolled");
    expect((await harness.state.read()).sessions[SESSION_ID]).toBeDefined();

    deferredRead.release();
    await expect(resuming).resolves.toEqual({
      resumed: true,
      reason: "active_authority",
    });
    await expect(finalizing).resolves.toEqual({ cleaned: true });
    await expect(service.status()).resolves.toMatchObject({
      running: false,
      enrolled: false,
      activeSessions: 0,
    });
    expect(await harness.state.read()).toEqual({
      version: 1,
      sessions: {},
      commands: {},
    });
  });

  it("fails closed when durable authority outlives its secure enrollment", async () => {
    const harness = await createHarness();
    await createRunner(harness, () => undefined);
    await harness.vault.delete();
    const restarted = new RemoteTargetDesktopService(
      harness.vault,
      harness.state,
      harness.relay,
      () => NOW,
    );

    await expect(
      restarted.resumeEligibleLoopback({
        apiBase: "http://127.0.0.1:31337",
        apiToken: "restart-local-token-123456789",
      }),
    ).rejects.toThrow("credentials are unavailable");
    expect((await restarted.status()).running).toBe(false);
    expect(harness.relay.claimRequests).toBe(0);
  });

  it("rejects missing loopback authentication before replacing a live runner", async () => {
    const harness = await createHarness();
    await createRunner(harness, () => undefined);
    const restarted = new RemoteTargetDesktopService(
      harness.vault,
      harness.state,
      harness.relay,
      () => NOW,
    );
    await restarted.resumeEligibleLoopback({
      apiBase: "http://127.0.0.1:31337",
      apiToken: "restart-local-token-123456789",
      pollIntervalMs: 60_000,
    });

    await expect(
      restarted.resumeEligibleLoopback({
        apiBase: "http://127.0.0.1:31338",
        apiToken: "missing",
      }),
    ).rejects.toThrow("authentication is unavailable");
    expect((await restarted.status()).running).toBe(true);
    await restarted.stop();
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

  it("serializes activation before authoritative host finalization", async () => {
    const harness = await createHarness();
    const relay = new DeferredActivationRelay();
    relay.revocations.push({
      hostId: HOST_ID,
      status: "revoked",
      alreadyRevoked: false,
      cleanup: { sessions: 1, commands: 0, more: false },
    });
    const service = new RemoteTargetDesktopService(
      harness.vault,
      harness.state,
      relay,
      () => NOW,
    );

    const activating = service.activate({ code: "123456" });
    await relay.activationRequested;
    let finalized = false;
    const finalizing = service
      .finalizeHostRevoke({ hostId: HOST_ID })
      .then((result) => {
        finalized = true;
        return result;
      });
    await Promise.resolve();
    expect(finalized).toBe(false);

    relay.resolveActivation(harness.activation);
    await expect(activating).resolves.toMatchObject({
      sessionId: SESSION_ID,
      status: "active",
    });
    await expect(finalizing).resolves.toEqual({ cleaned: true });
    await expect(harness.vault.load()).resolves.toBeNull();
    await expect(harness.state.read()).resolves.toEqual({
      version: 1,
      sessions: {},
      commands: {},
    });
  });

  it("compensates Cloud when local activation installation fails", async () => {
    const harness = await createHarness();
    const relay = new ImmediateActivationRelay(harness.activation);
    const state = new FailingTransactionStateStore();
    const service = new RemoteTargetDesktopService(
      harness.vault,
      state,
      relay,
      () => NOW,
    );

    await expect(service.activate({ code: "123456" })).rejects.toMatchObject({
      code: "REMOTE_ACTIVATION_LOCAL_INSTALL_FAILED",
      context: { sessionId: SESSION_ID },
    });
    expect(relay.compensations).toEqual([SESSION_ID]);
    expect((await state.read()).sessions).toEqual({});
  });

  it("exposes failed compensation for exact-session retry without authority", async () => {
    const harness = await createHarness();
    const relay = new ImmediateActivationRelay(harness.activation);
    relay.compensationFailure = new Error("cloud-compensation-unavailable");
    const state = new FailingTransactionStateStore();
    const service = new RemoteTargetDesktopService(
      harness.vault,
      state,
      relay,
      () => NOW,
    );

    await expect(service.activate({ code: "123456" })).resolves.toEqual({
      sessionId: SESSION_ID,
      status: "compensation_required",
      errorCode: "REMOTE_ACTIVATION_COMPENSATION_REQUIRED",
      retryRpc: "remoteTargetCompensateActivation",
    });
    expect((await state.read()).sessions).toEqual({});

    relay.compensationFailure = null;
    await expect(
      service.compensateActivation({ sessionId: SESSION_ID }),
    ).resolves.toEqual({
      sessionId: SESSION_ID,
      status: "revoked",
      alreadyCompensated: true,
    });
  });

  it("keeps a staged grant non-authoritative until exact-session commit retry succeeds", async () => {
    const harness = await createHarness();
    const relay = new ImmediateActivationRelay(harness.activation);
    relay.commitFailure = new RemoteTargetTransportError(
      "NETWORK_UNAVAILABLE",
      0,
    );
    const service = new RemoteTargetDesktopService(
      harness.vault,
      harness.state,
      relay,
      () => NOW,
    );

    await expect(service.activate({ code: "123456" })).resolves.toEqual({
      sessionId: SESSION_ID,
      status: "commit_required",
      errorCode: "REMOTE_ACTIVATION_COMMIT_REQUIRED",
      retryRpc: "remoteTargetCommitActivation",
    });
    expect(
      (await harness.state.read()).sessions[SESSION_ID]?.activationState,
    ).toBe("staged");
    expect((await service.status()).activeSessions).toBe(0);

    relay.commitFailure = null;
    await expect(
      service.commitActivation({ sessionId: SESSION_ID }),
    ).resolves.toMatchObject({
      sessionId: SESSION_ID,
      status: "active",
    });
    expect(
      (await harness.state.read()).sessions[SESSION_ID]?.activationState,
    ).toBe("active");
    expect(relay.commits).toEqual([SESSION_ID, SESSION_ID]);
  });

  it("recovers a process exit after durable staging but before Cloud commit", async () => {
    const harness = await createHarness();
    const relay = new ImmediateActivationRelay(harness.activation);
    relay.commitFailure = new RemoteTargetTransportError(
      "NETWORK_UNAVAILABLE",
      0,
    );
    const interrupted = new RemoteTargetDesktopService(
      harness.vault,
      harness.state,
      relay,
      () => NOW,
    );
    await expect(
      interrupted.activate({ code: "123456" }),
    ).resolves.toMatchObject({
      status: "commit_required",
    });

    relay.commitFailure = null;
    const restarted = new RemoteTargetDesktopService(
      harness.vault,
      harness.state,
      relay,
      () => NOW,
    );
    await expect(
      restarted.resumeEligibleLoopback({
        apiBase: "http://127.0.0.1:31337",
        apiToken: "restart-local-token-123456789",
        pollIntervalMs: 60_000,
      }),
    ).resolves.toEqual({ resumed: true, reason: "active_authority" });
    expect(
      (await harness.state.read()).sessions[SESSION_ID]?.activationState,
    ).toBe("active");
    expect(relay.commits).toEqual([SESSION_ID, SESSION_ID]);
    await restarted.stop();
  });

  it("recovers a process exit after Cloud commit but before the local active mark", async () => {
    const harness = await createHarness();
    const relay = new ImmediateActivationRelay(harness.activation);
    const state = new FailingTransactionStateStore(2);
    const interrupted = new RemoteTargetDesktopService(
      harness.vault,
      state,
      relay,
      () => NOW,
    );
    await expect(
      interrupted.activate({ code: "123456" }),
    ).resolves.toMatchObject({
      status: "commit_required",
    });
    expect((await state.read()).sessions[SESSION_ID]?.activationState).toBe(
      "staged",
    );

    const restarted = new RemoteTargetDesktopService(
      harness.vault,
      state,
      relay,
      () => NOW,
    );
    await expect(
      restarted.resumeEligibleLoopback({
        apiBase: "http://127.0.0.1:31337",
        apiToken: "restart-local-token-123456789",
        pollIntervalMs: 60_000,
      }),
    ).resolves.toEqual({ resumed: true, reason: "active_authority" });
    expect((await state.read()).sessions[SESSION_ID]?.activationState).toBe(
      "active",
    );
    expect(relay.commits).toEqual([SESSION_ID, SESSION_ID]);
    await restarted.stop();
  });

  it("keeps active work running and retries an offline staged commit on the poll lifecycle", async () => {
    vi.useFakeTimers();
    try {
      const harness = await createHarness();
      const relay = new ImmediateActivationRelay(harness.activation);
      const activeRunner = await createRunner(harness, () => undefined);
      await activeRunner.installActivation({
        ...harness.activation,
        sessionId: "11111111-2222-4111-8111-111111111111",
        grantId: "11111111-3333-4111-8111-111111111111",
      });
      await activeRunner.stop();
      relay.commitFailure = new RemoteTargetTransportError(
        "NETWORK_UNAVAILABLE",
        0,
      );
      const restarted = new RemoteTargetDesktopService(
        harness.vault,
        harness.state,
        relay,
        () => NOW,
      );

      await expect(
        restarted.resumeEligibleLoopback({
          apiBase: "http://127.0.0.1:31337",
          apiToken: "restart-local-token-123456789",
          pollIntervalMs: 250,
        }),
      ).resolves.toEqual({ resumed: true, reason: "active_authority" });
      expect(await restarted.status()).toMatchObject({
        running: true,
        activeSessions: 1,
        lastErrorCode: "NETWORK_UNAVAILABLE",
      });

      relay.commitFailure = null;
      await vi.advanceTimersByTimeAsync(250);
      expect(await restarted.status()).toMatchObject({
        running: true,
        activeSessions: 2,
        lastErrorCode: null,
      });
      await restarted.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a terminal staged activation without wedging an active session", async () => {
    const harness = await createHarness();
    const runner = await createRunner(harness, () => undefined);
    const stagedSessionId = "11111111-2222-4111-8111-111111111111";
    await runner.installActivation({
      ...harness.activation,
      sessionId: stagedSessionId,
      grantId: "11111111-3333-4111-8111-111111111111",
    });
    harness.relay.commitFailure = new RemoteTargetTransportError(
      "HTTP_410",
      410,
    );

    await expect(runner.pollOnce()).resolves.toBe("empty");
    const state = await harness.state.read();
    expect(state.sessions[stagedSessionId]).toBeUndefined();
    expect(state.sessions[SESSION_ID]?.activationState).toBe("active");
    expect(harness.relay.claimRequests).toBe(1);
  });

  it("keeps finalization queued through local-failure compensation", async () => {
    const harness = await createHarness();
    const relay = new DeferredCompensationRelay(harness.activation);
    relay.revocations.push({
      hostId: HOST_ID,
      status: "revoked",
      alreadyRevoked: false,
      cleanup: { sessions: 0, commands: 0, more: false },
    });
    const state = new FailingTransactionStateStore();
    const service = new RemoteTargetDesktopService(
      harness.vault,
      state,
      relay,
      () => NOW,
    );

    const activating = service.activate({ code: "123456" });
    await relay.compensationRequested;
    let finalized = false;
    const finalizing = service
      .finalizeHostRevoke({ hostId: HOST_ID })
      .then((result) => {
        finalized = true;
        return result;
      });
    await Promise.resolve();
    expect(finalized).toBe(false);

    relay.resolveCompensation();
    await expect(activating).rejects.toMatchObject({
      code: "REMOTE_ACTIVATION_LOCAL_INSTALL_FAILED",
    });
    await expect(finalizing).resolves.toEqual({ cleaned: true });
  });

  it("requires authoritative host revocation before deleting native credentials", async () => {
    const harness = await createHarness();
    const service = new RemoteTargetDesktopService(
      harness.vault,
      harness.state,
      harness.relay,
      () => NOW,
    );

    await expect(
      service.finalizeHostRevoke({ hostId: HOST_ID, cloudRevoked: true }),
    ).rejects.toThrow("authoritative revocation unavailable");
    await expect(harness.vault.load()).resolves.toMatchObject({
      status: "enrolled",
    });
  });

  it("drains authoritative revoke pages before clearing the journal and vault", async () => {
    const harness = await createHarness();
    await createRunner(harness, () => undefined);
    harness.relay.revocations.push(
      {
        hostId: HOST_ID,
        status: "revoked",
        alreadyRevoked: false,
        cleanup: { sessions: 100, commands: 500, more: true },
      },
      {
        hostId: HOST_ID,
        status: "revoked",
        alreadyRevoked: true,
        cleanup: { sessions: 1, commands: 0, more: false },
      },
    );
    const service = new RemoteTargetDesktopService(
      harness.vault,
      harness.state,
      harness.relay,
      () => NOW,
    );

    await expect(
      service.finalizeHostRevoke({ hostId: HOST_ID }),
    ).resolves.toEqual({ cleaned: true });
    await expect(harness.vault.load()).resolves.toBeNull();
    await expect(harness.state.read()).resolves.toEqual({
      version: 1,
      sessions: {},
      commands: {},
    });
    expect(harness.relay.revocations).toHaveLength(0);
  });

  it("rejects non-progressing revoke continuation without local cleanup", async () => {
    const harness = await createHarness();
    harness.relay.revocations.push({
      hostId: HOST_ID,
      status: "revoked",
      alreadyRevoked: true,
      cleanup: { sessions: 0, commands: 0, more: true },
    });
    const service = new RemoteTargetDesktopService(
      harness.vault,
      harness.state,
      harness.relay,
      () => NOW,
    );

    await expect(
      service.finalizeHostRevoke({ hostId: HOST_ID }),
    ).rejects.toMatchObject({
      code: "REMOTE_HOST_CLEANUP_PROGRESS_INVALID",
    });
    await expect(harness.vault.load()).resolves.toMatchObject({
      status: "enrolled",
    });
  });

  it("activates managed authority only after the native join succeeds", async () => {
    const vault = new RemoteTargetVault(
      new MemorySecureStore(),
      "managed-success-target",
    );
    const relay = new ManagedEnrollmentRelay();
    let joined = false;
    let left = false;
    const service = new RemoteTargetDesktopService(
      vault,
      new MemoryRemoteTargetStateStore(),
      relay,
      () => NOW,
      {
        join: async () => {
          joined = true;
        },
        leave: async () => {
          left = true;
        },
      },
    );
    await expect(
      service.enroll({
        apiBaseUrl: "https://api.example.test",
        ownerId: "owner-1",
        ownerAccessToken: "owner-token-123456789",
        displayName: "Linux target",
        platform: "linux",
        managedNetwork: true,
      }),
    ).resolves.toMatchObject({ hostId: HOST_ID, status: "active" });
    expect(joined).toBe(true);
    expect(relay.activateManagedCalls).toBe(1);
    await expect(vault.load()).resolves.toMatchObject({
      status: "enrolled",
      managedNetwork: {
        hostname: "eliza-host-one",
        loginServer: "https://headscale.example.test",
      },
    });
    relay.revocations.push({
      hostId: HOST_ID,
      status: "revoked",
      alreadyRevoked: false,
      cleanup: { sessions: 0, commands: 0, more: false },
    });
    await expect(
      service.finalizeHostRevoke({ hostId: HOST_ID }),
    ).resolves.toEqual({ cleaned: true });
    expect(left).toBe(true);
  });

  it("revokes pending Cloud authority and deletes local credentials after a native join failure", async () => {
    const vault = new RemoteTargetVault(
      new MemorySecureStore(),
      "managed-failure-target",
    );
    const relay = new ManagedEnrollmentRelay();
    relay.revocations.push({
      hostId: HOST_ID,
      status: "revoked",
      alreadyRevoked: false,
      cleanup: { sessions: 0, commands: 0, more: false },
    });
    const service = new RemoteTargetDesktopService(
      vault,
      new MemoryRemoteTargetStateStore(),
      relay,
      () => NOW,
      {
        join: async () => {
          throw new Error("Tailscale unavailable");
        },
        leave: async () => undefined,
      },
    );
    await expect(
      service.enroll({
        apiBaseUrl: "https://api.example.test",
        ownerId: "owner-1",
        ownerAccessToken: "owner-token-123456789",
        displayName: "Linux target",
        platform: "linux",
        managedNetwork: true,
      }),
    ).rejects.toThrow("Tailscale unavailable");
    expect(relay.activateManagedCalls).toBe(0);
    await expect(vault.load()).resolves.toBeNull();
  });

  it("leaves the managed membership when Cloud activation fails", async () => {
    const vault = new RemoteTargetVault(
      new MemorySecureStore(),
      "managed-activation-failure-target",
    );
    const relay = new ManagedEnrollmentRelay();
    relay.activateManagedFailure = new Error("Headscale node unavailable");
    relay.revocations.push({
      hostId: HOST_ID,
      status: "revoked",
      alreadyRevoked: false,
      cleanup: { sessions: 0, commands: 0, more: false },
    });
    let leaveCalls = 0;
    const service = new RemoteTargetDesktopService(
      vault,
      new MemoryRemoteTargetStateStore(),
      relay,
      () => NOW,
      {
        join: async () => undefined,
        leave: async ({ hostname, loginServer }) => {
          expect(hostname).toBe("eliza-host-one");
          expect(loginServer).toBe("https://headscale.example.test");
          leaveCalls += 1;
        },
      },
    );

    await expect(
      service.enroll({
        apiBaseUrl: "https://api.example.test",
        ownerId: "owner-1",
        ownerAccessToken: "owner-token-123456789",
        displayName: "Linux target",
        managedNetwork: true,
      }),
    ).rejects.toThrow("Headscale node unavailable");
    expect(leaveCalls).toBe(1);
    await expect(vault.load()).resolves.toBeNull();
  });
});

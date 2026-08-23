/**
 * Runs the Linux side of the encrypted remote-control protocol. It admits one
 * host-bound command through a durable replay journal, publishes the durable
 * start receipt before invoking an allowlisted local effect, and persists the
 * signed terminal envelope before attempting relay delivery.
 */
import { randomUUID } from "node:crypto";
import {
  copyRemoteCommandBinding,
  type EncryptedRemoteControlEnvelope,
  isSignedRemoteCommand,
  REMOTE_CONTROL_MAX_REPLAY_ENTRIES_PER_SESSION,
  REMOTE_CONTROL_PROTOCOL_VERSION,
  type RemoteCommandAction,
  type RemoteCommandResultStatus,
  type RemoteControllerGrant,
  type RemoteJsonValue,
  type SignedRemoteCommand,
} from "@elizaos/shared/contracts/remote-control";
import {
  digestRemoteResultValue,
  openRemoteControlMessage,
  sealRemoteControlMessage,
  signRemoteCommandResult,
  signRemoteCommandStartReceipt,
  verifyRemoteCommandAuthenticity,
} from "../../../src/security/remote-control-crypto";
import type {
  RemoteTargetStateStore,
  RemoteTargetStoredCommand,
} from "./remote-target-store";
import type {
  RemoteTargetActivationResponse,
  RemoteTargetClaim,
  RemoteTargetRelayTransport,
} from "./remote-target-transport";
import { RemoteTargetTransportError } from "./remote-target-transport";
import type {
  EnrolledRemoteTargetVaultRecord,
  RemoteTargetVault,
} from "./remote-target-vault";

export interface RemoteTargetEffectResult {
  status: Exclude<RemoteCommandResultStatus, "execution_ambiguous">;
  result?: RemoteJsonValue;
  errorCode?: string;
}

export interface RemoteTargetCommandExecutor {
  execute(input: {
    action: RemoteCommandAction;
    payload: RemoteJsonValue;
    executionId: string;
  }): Promise<RemoteTargetEffectResult>;
}

export interface RemoteTargetRunnerHooks {
  afterReserve?(commandId: string): Promise<void> | void;
  afterStartPersisted?(commandId: string): Promise<void> | void;
  afterEffect?(commandId: string): Promise<void> | void;
}

export interface RemoteTargetRunnerStatus {
  running: boolean;
  enrolled: boolean;
  activeSessions: number;
  pendingResults: number;
  lastPollAt: number | null;
  lastErrorCode: string | null;
}

type PollDisposition =
  | "empty"
  | "completed"
  | "duplicate"
  | "delivery_pending"
  | "offline";

function errorCode(error: unknown): string {
  if (
    error instanceof RemoteTargetTransportError &&
    error.code === "REQUEST_TIMEOUT"
  ) {
    return "REMOTE_TARGET_TIMEOUT";
  }
  return "REMOTE_TARGET_UNAVAILABLE";
}

function resultEnvelope(
  command: SignedRemoteCommand,
  stored: RemoteTargetStoredCommand,
  enrollment: EnrolledRemoteTargetVaultRecord,
  controllerEncryptionPublicKeyJwk: JsonWebKey,
): EncryptedRemoteControlEnvelope {
  const body = {
    ...copyRemoteCommandBinding(command.body),
    commandDigest: stored.commandDigest,
    status: stored.status as RemoteCommandResultStatus,
    executionId: stored.executionId,
    startedAt: stored.startedAt,
    completedAt: stored.completedAt ?? Date.now(),
    ...(stored.resultPresent ? { result: stored.result } : {}),
    ...(stored.errorCode ? { errorCode: stored.errorCode } : {}),
    resultDigest: digestRemoteResultValue(
      stored.resultPresent ? stored.result : undefined,
      stored.errorCode ?? undefined,
    ),
  };
  const signed = signRemoteCommandResult(body, enrollment.signingPrivateKeyJwk);
  return sealRemoteControlMessage(
    signed,
    {
      ...copyRemoteCommandBinding(command.body),
      messageKind: "result",
      senderKeyId: command.body.targetKeyId,
      recipientKeyId: command.body.controllerKeyId,
    },
    controllerEncryptionPublicKeyJwk,
  );
}

function startEnvelope(
  command: SignedRemoteCommand,
  stored: RemoteTargetStoredCommand,
  enrollment: EnrolledRemoteTargetVaultRecord,
  controllerEncryptionPublicKeyJwk: JsonWebKey,
): EncryptedRemoteControlEnvelope {
  if (!stored.executionId || !stored.startedAt) {
    throw new Error("Remote command durable start is incomplete.");
  }
  const signed = signRemoteCommandStartReceipt(
    {
      ...copyRemoteCommandBinding(command.body),
      status: "started",
      commandDigest: stored.commandDigest,
      executionId: stored.executionId,
      startedAt: stored.startedAt,
    },
    enrollment.signingPrivateKeyJwk,
  );
  return sealRemoteControlMessage(
    signed,
    {
      ...copyRemoteCommandBinding(command.body),
      messageKind: "start_receipt",
      senderKeyId: command.body.targetKeyId,
      recipientKeyId: command.body.controllerKeyId,
    },
    controllerEncryptionPublicKeyJwk,
  );
}

export class RemoteTargetRunner {
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPollAt: number | null = null;
  private lastErrorCode: string | null = null;
  private pollTail: Promise<void> = Promise.resolve();
  private loopGeneration = 0;

  private stopFailedLoop(generation: number): void {
    if (generation !== this.loopGeneration) return;
    this.running = false;
    this.pollTimer = null;
    this.lastErrorCode = "REMOTE_TARGET_LOOP_FAILED";
  }

  constructor(
    private readonly vault: RemoteTargetVault,
    private readonly stateStore: RemoteTargetStateStore,
    private readonly transport: RemoteTargetRelayTransport,
    private readonly executor: RemoteTargetCommandExecutor,
    private readonly options: {
      now?: () => number;
      pollIntervalMs?: number;
      hooks?: RemoteTargetRunnerHooks;
    } = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  async installActivation(
    activation: RemoteTargetActivationResponse,
  ): Promise<void> {
    const enrollment = await this.requireEnrollment();
    if (
      activation.ownerId !== enrollment.identity.ownerId ||
      activation.targetRuntimeId !== enrollment.identity.runtimeId ||
      activation.targetKeyId !== enrollment.identity.keyId ||
      activation.controller.ownerId !== activation.ownerId
    ) {
      throw new Error("Remote activation binding does not match this target.");
    }
    const grant: RemoteControllerGrant = {
      version: REMOTE_CONTROL_PROTOCOL_VERSION,
      grantId: activation.grantId,
      revision: activation.grantRevision,
      ownerId: activation.ownerId,
      controllerDeviceId: activation.controller.deviceId,
      controllerKeyId: activation.controller.keyId,
      targetRuntimeIds: [activation.targetRuntimeId],
      sessionId: activation.sessionId,
      createdAt: this.now(),
      expiresAt: activation.grantExpiresAt,
      revokedAt: null,
    };
    await this.stateStore.transact((state) => {
      const current = state.sessions[activation.sessionId];
      if (!current && Object.keys(state.sessions).length >= 256) {
        for (const [sessionId, candidate] of Object.entries(state.sessions)) {
          if (candidate.stoppedAt !== null) delete state.sessions[sessionId];
        }
        if (Object.keys(state.sessions).length >= 256) {
          throw new Error("Remote target session capacity is exhausted.");
        }
      }
      if (current && current.grant.revision > grant.revision) {
        throw new Error("Remote grant revision cannot move backward.");
      }
      if (
        current &&
        current.grant.revision === grant.revision &&
        JSON.stringify(current.grant) !== JSON.stringify(grant)
      ) {
        throw new Error("Remote grant revision conflicts with durable state.");
      }
      state.sessions[activation.sessionId] = {
        grant,
        controller: activation.controller,
        lastSequence: current?.lastSequence ?? 0,
        nonces: current?.nonces ?? {},
        stoppedAt: null,
      };
    });
  }

  async pollOnce(expectedGeneration?: number): Promise<PollDisposition> {
    let disposition: PollDisposition = "offline";
    const run = this.pollTail.then(async () => {
      disposition = await this.pollOnceSerialized(expectedGeneration);
    });
    this.pollTail = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
    return disposition;
  }

  private async pollOnceSerialized(
    expectedGeneration?: number,
  ): Promise<PollDisposition> {
    const enrollment = await this.requireEnrollment();
    this.lastPollAt = this.now();
    try {
      await this.flushPending(enrollment);
      const state = await this.stateStore.read();
      const sessions = Object.values(state.sessions)
        .filter(
          (session) =>
            session.stoppedAt === null &&
            session.grant.revokedAt === null &&
            (session.grant.expiresAt === null ||
              session.grant.expiresAt >= this.now()),
        )
        .sort((a, b) => a.grant.sessionId.localeCompare(b.grant.sessionId));
      for (const session of sessions) {
        let claim: RemoteTargetClaim | null;
        try {
          claim = await this.transport.claimNext({
            enrollment,
            sessionId: session.grant.sessionId,
          });
        } catch (error) {
          // error-policy:J4 a terminal relay absence fences the local session;
          // all other failures remain failures for the outer poll boundary.
          if (
            error instanceof RemoteTargetTransportError &&
            (error.status === 404 || error.status === 410)
          ) {
            await this.fenceSession(session.grant.sessionId);
            continue;
          }
          throw error;
        }
        if (!claim) continue;
        if (
          expectedGeneration !== undefined &&
          (!this.running || expectedGeneration !== this.loopGeneration)
        ) {
          return "empty";
        }
        const disposition = await this.processClaim(
          enrollment,
          claim,
          expectedGeneration,
        );
        this.lastErrorCode = null;
        return disposition;
      }
      this.lastErrorCode = null;
      return "empty";
    } catch (error) {
      if (error instanceof RemoteTargetTransportError) {
        // error-policy:J4 expected transport failures expose a distinct
        // offline diagnostic state while durable/crypto defects fail fast.
        this.lastErrorCode = errorCode(error);
        return "offline";
      }
      throw error;
    }
  }

  private async processClaim(
    enrollment: EnrolledRemoteTargetVaultRecord,
    claim: RemoteTargetClaim,
    expectedGeneration?: number,
  ): Promise<PollDisposition> {
    if (!this.canProcessGeneration(expectedGeneration)) return "empty";
    const snapshot = await this.stateStore.read();
    const session = snapshot.sessions[claim.envelope.sessionId];
    if (!session) throw new Error("Remote command session is unknown.");
    if (claim.claimExpiresAt <= this.now()) {
      throw new Error("Remote command claim expired before local admission.");
    }
    const expected = {
      ...copyRemoteCommandBinding(claim.envelope),
      messageKind: "command" as const,
      senderKeyId: claim.envelope.controllerKeyId,
      recipientKeyId: enrollment.identity.keyId,
    };
    const opened = openRemoteControlMessage(
      claim.envelope,
      enrollment.encryptionPrivateKeyJwk,
      expected,
    );
    if (!isSignedRemoteCommand(opened)) {
      throw new Error("Remote relay command plaintext is invalid.");
    }
    const authenticity = verifyRemoteCommandAuthenticity({
      command: opened,
      identity: session.controller,
      targetIdentity: enrollment.identity,
      grant: session.grant,
      expectedOwnerId: enrollment.identity.ownerId,
      expectedSessionId: session.grant.sessionId,
      expectedTargetRuntimeId: enrollment.identity.runtimeId,
      now: this.now(),
    });
    if (!authenticity.ok) {
      throw new Error(
        `Remote command authentication failed: ${authenticity.reason}.`,
      );
    }
    if (
      claim.commandId !== opened.body.commandId ||
      claim.sequence !== opened.body.sequence
    ) {
      throw new Error("Remote claim routing fields do not match the command.");
    }
    if (!this.canProcessGeneration(expectedGeneration)) return "empty";

    const admission = await this.stateStore.transact((state) => {
      const authority = state.sessions[opened.body.sessionId];
      if (
        !authority ||
        authority.stoppedAt !== null ||
        authority.grant.revokedAt !== null ||
        authority.grant.revision !== opened.body.grantRevision ||
        authority.grant.ownerId !== opened.body.ownerId ||
        authority.grant.controllerDeviceId !== opened.body.controllerDeviceId ||
        authority.grant.controllerKeyId !== opened.body.controllerKeyId ||
        !authority.grant.targetRuntimeIds.includes(
          opened.body.targetRuntimeId,
        ) ||
        (authority.grant.expiresAt !== null &&
          authority.grant.expiresAt < this.now())
      ) {
        throw new Error("Remote command authority is no longer active.");
      }
      const existing = state.commands[opened.body.commandId];
      if (existing) {
        if (existing.commandDigest !== authenticity.commandDigest) {
          throw new Error(
            "Remote command identifier conflicts with durable state.",
          );
        }
        return { duplicate: true, command: existing };
      }
      for (const [nonce, expiresAt] of Object.entries(authority.nonces)) {
        if (expiresAt < this.now()) delete authority.nonces[nonce];
      }
      if (
        opened.body.sequence !== authority.lastSequence + 1 ||
        authority.nonces[opened.body.nonce] !== undefined
      ) {
        throw new Error("Remote command replay or sequence gap was rejected.");
      }
      if (
        Object.keys(authority.nonces).length >=
        REMOTE_CONTROL_MAX_REPLAY_ENTRIES_PER_SESSION
      ) {
        throw new Error("Remote command replay capacity is exhausted.");
      }
      if (Object.keys(state.commands).length >= 16_384) {
        const pruneBefore = this.now() - 24 * 60 * 60 * 1_000;
        for (const [commandId, candidate] of Object.entries(state.commands)) {
          if (
            candidate.resultDelivered &&
            candidate.completedAt !== null &&
            candidate.completedAt < pruneBefore
          ) {
            delete state.commands[commandId];
          }
        }
        if (Object.keys(state.commands).length >= 16_384) {
          throw new Error("Remote target command capacity is exhausted.");
        }
      }
      const command: RemoteTargetStoredCommand = {
        command: opened,
        commandDigest: authenticity.commandDigest,
        status: "reserved",
        reservedAt: this.now(),
        executionId: null,
        startedAt: null,
        completedAt: null,
        resultPresent: false,
        result: null,
        errorCode: null,
        claimAttempt: null,
        claimToken: null,
        startEnvelope: null,
        startDelivered: false,
        effectDispatched: false,
        resultEnvelope: null,
        resultDelivered: false,
      };
      authority.lastSequence = opened.body.sequence;
      authority.nonces[opened.body.nonce] = opened.body.expiresAt;
      state.commands[opened.body.commandId] = command;
      return { duplicate: false, command };
    });
    await this.options.hooks?.afterReserve?.(opened.body.commandId);
    if (!this.canProcessGeneration(expectedGeneration)) {
      return "delivery_pending";
    }
    if (admission.command.status === "started") {
      await this.stateStore.transact((state) => {
        const record = state.commands[opened.body.commandId];
        if (record?.status !== "started") return;
        record.claimAttempt = claim.claimAttempt;
        record.claimToken = claim.claimToken;
      });
      return this.resumeStartedCommand(enrollment, opened.body.commandId);
    }
    if (admission.command.status !== "reserved") {
      return admission.command.resultDelivered
        ? "duplicate"
        : "delivery_pending";
    }

    const started = await this.stateStore.transact((state) => {
      const record = state.commands[opened.body.commandId];
      if (!record) throw new Error("Reserved remote command disappeared.");
      if (record.status !== "reserved") return { began: false, record };
      record.status = "started";
      record.executionId = randomUUID();
      record.startedAt = this.now();
      record.claimAttempt = claim.claimAttempt;
      record.claimToken = claim.claimToken;
      record.startEnvelope = startEnvelope(
        opened,
        record,
        enrollment,
        session.controller.encryptionPublicKeyJwk,
      );
      return { began: true, record };
    });
    if (!started.began) return "duplicate";
    await this.options.hooks?.afterStartPersisted?.(opened.body.commandId);
    return this.resumeStartedCommand(enrollment, opened.body.commandId);
  }

  private async resumeStartedCommand(
    enrollment: EnrolledRemoteTargetVaultRecord,
    commandId: string,
  ): Promise<PollDisposition> {
    const snapshot = await this.stateStore.read();
    let record = snapshot.commands[commandId];
    if (record?.status !== "started") {
      return record?.resultDelivered ? "duplicate" : "delivery_pending";
    }
    if (
      !record.startEnvelope ||
      record.claimAttempt === null ||
      record.claimToken === null
    ) {
      throw new Error("Remote start delivery state is incomplete.");
    }
    if (!record.startDelivered) {
      try {
        await this.transport.recordStart({
          enrollment,
          sessionId: record.command.body.sessionId,
          commandId,
          claimAttempt: record.claimAttempt,
          claimToken: record.claimToken,
          envelope: record.startEnvelope,
        });
      } catch (error) {
        // error-policy:J4 losing authority after durable start becomes an
        // explicit execution-ambiguous result, never a retry.
        if (
          error instanceof RemoteTargetTransportError &&
          (error.code === "CLAIM_LOST" ||
            error.status === 404 ||
            error.status === 410)
        ) {
          await this.stateStore.transact((state) => {
            const current = state.commands[commandId];
            const session = current
              ? state.sessions[current.command.body.sessionId]
              : undefined;
            if (current?.status !== "started") return;
            current.status = "execution_ambiguous";
            current.completedAt = this.now();
            current.resultPresent = false;
            current.errorCode = "REMOTE_START_CLAIM_LOST";
            if (!session) throw new Error("Remote command session is missing.");
            current.resultEnvelope = resultEnvelope(
              current.command,
              current,
              enrollment,
              session.controller.encryptionPublicKeyJwk,
            );
            current.resultDelivered = true;
            current.claimToken = null;
            current.claimAttempt = null;
          });
          return "delivery_pending";
        }
        throw error;
      }
      await this.stateStore.transact((state) => {
        const current = state.commands[commandId];
        if (
          current?.startEnvelope?.messageDigest ===
          record?.startEnvelope?.messageDigest
        ) {
          current.startDelivered = true;
        }
      });
    }

    const dispatch = await this.stateStore.transact((state) => {
      const current = state.commands[commandId];
      const session = current
        ? state.sessions[current.command.body.sessionId]
        : undefined;
      if (!current || !session || current.status !== "started") {
        throw new Error("Remote execution state changed unexpectedly.");
      }
      if (current.effectDispatched) {
        current.status = "execution_ambiguous";
        current.completedAt = this.now();
        current.resultPresent = false;
        current.result = null;
        current.errorCode = "REMOTE_EXECUTION_INTERRUPTED";
        current.resultEnvelope = resultEnvelope(
          current.command,
          current,
          enrollment,
          session.controller.encryptionPublicKeyJwk,
        );
        return { execute: false, record: current };
      }
      current.effectDispatched = true;
      return { execute: true, record: current };
    });
    if (!dispatch.execute) {
      await this.deliverResult(enrollment, dispatch.record);
      return "delivery_pending";
    }

    record = dispatch.record;
    let effect:
      | RemoteTargetEffectResult
      | {
          status: "execution_ambiguous";
          errorCode: "REMOTE_EFFECT_OUTCOME_UNKNOWN";
        };
    try {
      effect = await this.executor.execute({
        action: record.command.body.action,
        payload: record.command.body.payload,
        executionId: record.executionId as string,
      });
    } catch {
      // error-policy:J1 an effect exception after durable start has unknown outcome.
      effect = {
        status: "execution_ambiguous",
        errorCode: "REMOTE_EFFECT_OUTCOME_UNKNOWN",
      };
    }
    await this.options.hooks?.afterEffect?.(commandId);
    const terminal = await this.stateStore.transact((state) => {
      const current = state.commands[commandId];
      const activeSession = current
        ? state.sessions[current.command.body.sessionId]
        : undefined;
      if (!current || !activeSession || current.status !== "started") {
        throw new Error("Remote execution state changed unexpectedly.");
      }
      current.status = effect.status;
      current.completedAt = this.now();
      current.resultPresent = "result" in effect;
      current.result = "result" in effect ? (effect.result ?? null) : null;
      current.errorCode = effect.errorCode ?? null;
      current.resultEnvelope = resultEnvelope(
        current.command,
        current,
        enrollment,
        activeSession.controller.encryptionPublicKeyJwk,
      );
      return current;
    });
    if (!terminal.resultEnvelope) {
      throw new Error("Remote result envelope was not persisted.");
    }
    await this.deliverResult(enrollment, terminal);
    return "completed";
  }

  async recoverInterrupted(): Promise<number> {
    const enrollment = await this.requireEnrollment();
    const state = await this.stateStore.read();
    const recovered = Object.values(state.commands)
      .filter((record) => record.status === "started")
      .map((record) => record.command.body.commandId);
    for (const commandId of recovered) {
      await this.resumeStartedCommand(enrollment, commandId);
    }
    await this.flushPending(enrollment);
    return recovered.length;
  }

  private canProcessGeneration(
    expectedGeneration: number | undefined,
  ): boolean {
    return (
      expectedGeneration === undefined ||
      (this.running && expectedGeneration === this.loopGeneration)
    );
  }

  private async flushPending(
    enrollment: EnrolledRemoteTargetVaultRecord,
  ): Promise<void> {
    const state = await this.stateStore.read();
    const pending = Object.values(state.commands).filter(
      (record) =>
        record.status !== "reserved" &&
        record.status !== "started" &&
        !record.resultDelivered &&
        record.resultEnvelope !== null,
    );
    for (const record of pending) await this.deliverResult(enrollment, record);
  }

  private async deliverResult(
    enrollment: EnrolledRemoteTargetVaultRecord,
    record: RemoteTargetStoredCommand,
  ): Promise<void> {
    if (
      !record.resultEnvelope ||
      record.claimAttempt === null ||
      record.claimToken === null
    ) {
      throw new Error("Remote result delivery state is incomplete.");
    }
    if (!record.startDelivered) {
      if (!record.startEnvelope) {
        throw new Error("Remote start delivery state is incomplete.");
      }
      await this.transport.recordStart({
        enrollment,
        sessionId: record.command.body.sessionId,
        commandId: record.command.body.commandId,
        claimAttempt: record.claimAttempt,
        claimToken: record.claimToken,
        envelope: record.startEnvelope,
      });
      await this.stateStore.transact((state) => {
        const current = state.commands[record.command.body.commandId];
        if (
          current?.startEnvelope?.messageDigest ===
          record.startEnvelope?.messageDigest
        ) {
          current.startDelivered = true;
        }
      });
    }
    try {
      await this.transport.complete({
        enrollment,
        sessionId: record.command.body.sessionId,
        commandId: record.command.body.commandId,
        claimAttempt: record.claimAttempt,
        claimToken: record.claimToken,
        envelope: record.resultEnvelope,
      });
    } catch (error) {
      // error-policy:J4 terminal relay authority loss is persisted as a
      // delivered or explicitly ambiguous outcome.
      if (
        error instanceof RemoteTargetTransportError &&
        (error.code === "CLAIM_LOST" ||
          error.code === "EXECUTION_AMBIGUOUS" ||
          error.status === 404 ||
          error.status === 410)
      ) {
        await this.stateStore.transact((state) => {
          const current = state.commands[record.command.body.commandId];
          if (!current) return;
          current.resultDelivered = true;
          current.claimToken = null;
          current.claimAttempt = null;
          if (error.code === "EXECUTION_AMBIGUOUS") {
            current.status = "execution_ambiguous";
            current.errorCode = "REMOTE_RELAY_EXECUTION_AMBIGUOUS";
            const session = state.sessions[current.command.body.sessionId];
            if (!session) throw new Error("Remote command session is missing.");
            current.resultEnvelope = resultEnvelope(
              current.command,
              current,
              enrollment,
              session.controller.encryptionPublicKeyJwk,
            );
          }
        });
        return;
      }
      throw error;
    }
    await this.stateStore.transact((state) => {
      const current = state.commands[record.command.body.commandId];
      if (
        current &&
        current.resultEnvelope?.messageDigest ===
          record.resultEnvelope?.messageDigest
      ) {
        current.resultDelivered = true;
        current.claimToken = null;
        current.claimAttempt = null;
      }
    });
  }

  async revokeSession(sessionId: string): Promise<void> {
    const enrollment = await this.requireEnrollment();
    await this.stateStore.transact((state) => {
      const session = state.sessions[sessionId];
      if (!session) return;
      const revokedAt = this.now();
      session.grant = {
        ...session.grant,
        revision: session.grant.revision + (session.grant.revokedAt ? 0 : 1),
        revokedAt: session.grant.revokedAt ?? revokedAt,
      };
      session.stoppedAt ??= revokedAt;
      session.nonces = {};
      for (const record of Object.values(state.commands)) {
        if (record.command.body.sessionId !== sessionId) continue;
        if (record.status === "reserved") {
          record.status = "rejected";
          record.completedAt = revokedAt;
          record.resultPresent = false;
          record.errorCode = "REMOTE_SESSION_REVOKED";
          record.resultEnvelope = resultEnvelope(
            record.command,
            record,
            enrollment,
            session.controller.encryptionPublicKeyJwk,
          );
          record.resultDelivered = true;
        } else if (record.status === "started") {
          record.status = "execution_ambiguous";
          record.completedAt = revokedAt;
          record.resultPresent = false;
          record.errorCode = "REMOTE_SESSION_REVOKED_AFTER_START";
        } else {
          continue;
        }
        if (!record.resultDelivered) {
          record.resultEnvelope = resultEnvelope(
            record.command,
            record,
            enrollment,
            session.controller.encryptionPublicKeyJwk,
          );
        }
      }
    });
    await this.flushPending(enrollment);
  }

  private async fenceSession(sessionId: string): Promise<void> {
    await this.stateStore.transact((state) => {
      const session = state.sessions[sessionId];
      if (!session) return;
      const stoppedAt = this.now();
      session.stoppedAt ??= stoppedAt;
      session.grant = {
        ...session.grant,
        revision: session.grant.revision + (session.grant.revokedAt ? 0 : 1),
        revokedAt: session.grant.revokedAt ?? stoppedAt,
      };
      session.nonces = {};
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    const generation = ++this.loopGeneration;
    this.running = true;
    const startup = this.pollTail.then(async () => {
      if (!this.running || generation !== this.loopGeneration) return;
      await this.recoverInterrupted();
    });
    this.pollTail = startup.then(
      () => undefined,
      () => undefined,
    );
    await startup;
    if (!this.running || generation !== this.loopGeneration) return;
    const loop = async (): Promise<void> => {
      if (!this.running || generation !== this.loopGeneration) return;
      await this.pollOnce(generation);
      if (!this.running || generation !== this.loopGeneration) return;
      this.pollTimer = setTimeout(
        () => {
          this.pollTimer = null;
          void loop().catch(() => {
            // error-policy:J4 a background integrity failure becomes a
            // distinct stopped/error status instead of an unhandled promise.
            this.stopFailedLoop(generation);
          });
        },
        Math.max(250, this.options.pollIntervalMs ?? 1_000),
      );
    };
    try {
      await loop();
    } catch (error) {
      this.stopFailedLoop(generation);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.loopGeneration += 1;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    await this.pollTail;
  }

  async status(): Promise<RemoteTargetRunnerStatus> {
    const [enrollment, state] = await Promise.all([
      this.vault.load(),
      this.stateStore.read(),
    ]);
    return {
      running: this.running,
      enrolled: enrollment?.status === "enrolled",
      activeSessions: Object.values(state.sessions).filter(
        (session) =>
          session.stoppedAt === null && session.grant.revokedAt === null,
      ).length,
      pendingResults: Object.values(state.commands).filter(
        (record) => record.resultEnvelope && !record.resultDelivered,
      ).length,
      lastPollAt: this.lastPollAt,
      lastErrorCode: this.lastErrorCode,
    };
  }

  private async requireEnrollment(): Promise<EnrolledRemoteTargetVaultRecord> {
    const enrollment = await this.vault.load();
    if (enrollment?.status !== "enrolled") {
      throw new Error("Remote target is not enrolled.");
    }
    return enrollment;
  }
}

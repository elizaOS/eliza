/**
 * Persists the Linux remote target's non-secret grant, replay, and execution
 * journal under one serialized atomic-write boundary. The host bearer and
 * private key material deliberately live in the operating-system secret store
 * instead of this journal.
 */
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "@elizaos/core/atomic-json";
import {
  canonicalizeRemoteControlValue,
  type EncryptedRemoteControlEnvelope,
  isEncryptedRemoteControlEnvelope,
  isRemoteControlIdentifier,
  isRemoteControllerGrant,
  isRemoteControllerPublicIdentity,
  isSignedRemoteCommand,
  REMOTE_CONTROL_MAX_REPLAY_ENTRIES_PER_SESSION,
  type RemoteControllerGrant,
  type RemoteControllerPublicIdentity,
  type RemoteJsonValue,
  type SignedRemoteCommand,
} from "@elizaos/shared/contracts/remote-control";
import { resolveStateDir } from "./native/auth-bridge";

export type RemoteTargetCommandStatus =
  | "reserved"
  | "started"
  | "completed"
  | "rejected"
  | "cancelled"
  | "execution_ambiguous";

export interface RemoteTargetStoredSession {
  grant: RemoteControllerGrant;
  controller: RemoteControllerPublicIdentity;
  lastSequence: number;
  nonces: Record<string, number>;
  stoppedAt: number | null;
  /** Absent legacy rows are committed; new two-phase rows stage explicitly. */
  activationState?: "staged" | "active";
}

export interface RemoteTargetStoredCommand {
  command: SignedRemoteCommand;
  commandDigest: string;
  status: RemoteTargetCommandStatus;
  reservedAt: number;
  executionId: string | null;
  startedAt: number | null;
  completedAt: number | null;
  resultPresent: boolean;
  result: RemoteJsonValue | null;
  errorCode: string | null;
  claimAttempt: number | null;
  claimToken: string | null;
  startEnvelope: EncryptedRemoteControlEnvelope | null;
  startDelivered: boolean;
  effectDispatched: boolean;
  resultEnvelope: EncryptedRemoteControlEnvelope | null;
  resultDelivered: boolean;
}

export interface RemoteTargetDurableState {
  version: 1;
  sessions: Record<string, RemoteTargetStoredSession>;
  commands: Record<string, RemoteTargetStoredCommand>;
}

export interface RemoteTargetStateStore {
  read(): Promise<RemoteTargetDurableState>;
  clear(): Promise<void>;
  transact<T>(
    operation: (state: RemoteTargetDurableState) => T | Promise<T>,
  ): Promise<T>;
}

function emptyState(): RemoteTargetDurableState {
  return { version: 1, sessions: {}, commands: {} };
}

function cloneState(state: RemoteTargetDurableState): RemoteTargetDurableState {
  return structuredClone(state);
}

function assertState(
  value: unknown,
): asserts value is RemoteTargetDurableState {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Reflect.get(value, "version") !== 1 ||
    typeof Reflect.get(value, "sessions") !== "object" ||
    Reflect.get(value, "sessions") === null ||
    Array.isArray(Reflect.get(value, "sessions")) ||
    typeof Reflect.get(value, "commands") !== "object" ||
    Reflect.get(value, "commands") === null ||
    Array.isArray(Reflect.get(value, "commands"))
  ) {
    throw new Error("Remote target journal is corrupt.");
  }
  const state = value as Record<string, unknown>;
  const sessions = state.sessions as Record<string, unknown>;
  if (Object.keys(sessions).length > 256) {
    throw new Error("Remote target journal exceeds session capacity.");
  }
  for (const [sessionId, candidate] of Object.entries(sessions)) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      throw new Error("Remote target journal is corrupt.");
    }
    const session = candidate as Record<string, unknown>;
    const grant = session.grant;
    const controller = session.controller;
    const nonces = session.nonces;
    if (
      !isRemoteControllerGrant(grant) ||
      grant.sessionId !== sessionId ||
      !isRemoteControllerPublicIdentity(controller) ||
      controller.ownerId !== grant.ownerId ||
      controller.deviceId !== grant.controllerDeviceId ||
      controller.keyId !== grant.controllerKeyId ||
      !Number.isSafeInteger(session.lastSequence) ||
      (session.lastSequence as number) < 0 ||
      typeof nonces !== "object" ||
      nonces === null ||
      Array.isArray(nonces) ||
      Object.keys(nonces).length >
        REMOTE_CONTROL_MAX_REPLAY_ENTRIES_PER_SESSION ||
      Object.keys(nonces).some((nonce) => !isRemoteControlIdentifier(nonce)) ||
      Object.values(nonces).some(
        (expiry) => !Number.isSafeInteger(expiry) || (expiry as number) <= 0,
      ) ||
      (session.stoppedAt !== null &&
        (!Number.isSafeInteger(session.stoppedAt) ||
          (session.stoppedAt as number) <= 0)) ||
      (session.activationState !== undefined &&
        session.activationState !== "staged" &&
        session.activationState !== "active")
    ) {
      throw new Error("Remote target journal is corrupt.");
    }
  }
  const commands = state.commands as Record<string, unknown>;
  if (Object.keys(commands).length > 16_384) {
    throw new Error("Remote target journal exceeds command capacity.");
  }
  const statuses = new Set<RemoteTargetCommandStatus>([
    "reserved",
    "started",
    "completed",
    "rejected",
    "cancelled",
    "execution_ambiguous",
  ]);
  for (const [commandId, candidate] of Object.entries(commands)) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      throw new Error("Remote target journal is corrupt.");
    }
    const command = candidate as Record<string, unknown>;
    const signed = command.command;
    const start = command.startEnvelope;
    const result = command.resultEnvelope;
    if (
      !isSignedRemoteCommand(signed) ||
      signed.body.commandId !== commandId ||
      !statuses.has(command.status as RemoteTargetCommandStatus) ||
      typeof command.commandDigest !== "string" ||
      !Number.isSafeInteger(command.reservedAt) ||
      typeof command.resultPresent !== "boolean" ||
      typeof command.startDelivered !== "boolean" ||
      typeof command.effectDispatched !== "boolean" ||
      typeof command.resultDelivered !== "boolean" ||
      (command.executionId !== null &&
        (typeof command.executionId !== "string" ||
          !/^[0-9a-f-]{36}$/i.test(command.executionId))) ||
      (command.claimAttempt !== null &&
        (!Number.isSafeInteger(command.claimAttempt) ||
          (command.claimAttempt as number) < 1)) ||
      (command.claimToken !== null &&
        (typeof command.claimToken !== "string" ||
          !/^[0-9a-f-]{36}$/i.test(command.claimToken))) ||
      (start !== null &&
        (!isEncryptedRemoteControlEnvelope(start) ||
          start.messageKind !== "start_receipt" ||
          start.commandId !== commandId ||
          start.sessionId !== signed.body.sessionId)) ||
      (result !== null &&
        (!isEncryptedRemoteControlEnvelope(result) ||
          result.messageKind !== "result" ||
          result.commandId !== commandId ||
          result.sessionId !== signed.body.sessionId))
    ) {
      throw new Error("Remote target journal is corrupt.");
    }
    const status = command.status as RemoteTargetCommandStatus;
    const reserved = status === "reserved";
    const started = status === "started";
    const terminal = !reserved && !started;
    const hasExecution =
      typeof command.executionId === "string" &&
      Number.isSafeInteger(command.startedAt);
    if (
      (command.claimAttempt === null) !== (command.claimToken === null) ||
      (reserved &&
        (command.executionId !== null ||
          command.startedAt !== null ||
          start !== null ||
          command.startDelivered !== false ||
          command.effectDispatched !== false ||
          command.completedAt !== null ||
          result !== null)) ||
      (started &&
        (!hasExecution ||
          start === null ||
          command.claimAttempt === null ||
          command.claimToken === null ||
          command.completedAt !== null ||
          result !== null)) ||
      (terminal &&
        (!Number.isSafeInteger(command.completedAt) || result === null)) ||
      (command.startDelivered === true && start === null) ||
      (command.effectDispatched === true && command.startDelivered !== true) ||
      (command.resultDelivered === true && (!terminal || result === null))
    ) {
      throw new Error("Remote target journal state is inconsistent.");
    }
    try {
      if (command.resultPresent) canonicalizeRemoteControlValue(command.result);
    } catch {
      // error-policy:J3 persisted journal bytes are untrusted input.
      throw new Error("Remote target journal is corrupt.");
    }
  }
}

export function resolveRemoteTargetJournalPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveStateDir(env), "remote-target", "journal-v1.json");
}

export class JsonFileRemoteTargetStateStore implements RemoteTargetStateStore {
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = resolveRemoteTargetJournalPath()) {}

  private async load(): Promise<RemoteTargetDurableState> {
    const value = await readJsonFile<unknown>(this.filePath);
    if (value === null) return emptyState();
    assertState(value);
    return value;
  }

  async read(): Promise<RemoteTargetDurableState> {
    await this.transactionTail;
    return cloneState(await this.load());
  }

  async clear(): Promise<void> {
    await this.transact((state) => {
      state.sessions = {};
      state.commands = {};
    });
  }

  async transact<T>(
    operation: (state: RemoteTargetDurableState) => T | Promise<T>,
  ): Promise<T> {
    const predecessor = this.transactionTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.transactionTail = predecessor
      // error-policy:J5 the failed transaction's caller observes this rejection;
      // the tail remains usable so later durable transactions are not poisoned.
      .catch(() => undefined)
      .then(() => current);
    // error-policy:J5 the originating transaction caller observes the same
    // predecessor rejection; this waiter only preserves queue ordering.
    await predecessor.catch(() => undefined);
    try {
      const state = await this.load();
      const result = await operation(state);
      assertState(state);
      await writeJsonAtomic(this.filePath, state, {
        mode: 0o600,
        dirMode: 0o700,
      });
      return result;
    } finally {
      release();
    }
  }
}

/** Deterministic durable-state double whose backing survives runner recreation. */
export class MemoryRemoteTargetStateStore implements RemoteTargetStateStore {
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(private state: RemoteTargetDurableState = emptyState()) {}

  async read(): Promise<RemoteTargetDurableState> {
    await this.transactionTail;
    return cloneState(this.state);
  }

  async clear(): Promise<void> {
    await this.transact((state) => {
      state.sessions = {};
      state.commands = {};
    });
  }

  async transact<T>(
    operation: (state: RemoteTargetDurableState) => T | Promise<T>,
  ): Promise<T> {
    const predecessor = this.transactionTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.transactionTail = predecessor
      // error-policy:J5 the failed transaction's caller observes this rejection;
      // the in-memory test queue must retain production serialization semantics.
      .catch(() => undefined)
      .then(() => current);
    // error-policy:J5 the originating transaction caller observes the same
    // predecessor rejection; this waiter only preserves queue ordering.
    await predecessor.catch(() => undefined);
    try {
      const candidate = cloneState(this.state);
      const result = await operation(candidate);
      assertState(candidate);
      this.state = cloneState(candidate);
      return result;
    } finally {
      release();
    }
  }
}

export const remoteTargetStoreInternals = { assertState };

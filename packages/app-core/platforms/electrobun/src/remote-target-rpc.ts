/**
 * Exposes the native-only Linux target lifecycle to the typed Electrobun RPC
 * composition layer. Renderer callers receive public identity and health data;
 * the host bearer and private JWKs never cross this boundary.
 */
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import type { RemoteTargetPublicIdentity } from "@elizaos/shared/contracts/remote-control";
import { logger } from "./logger";
import {
  LoopbackRemoteTargetExecutor,
  normalizeRemoteTargetLoopbackBase,
} from "./remote-target-executor";
import {
  type RemoteTargetManagedNetworkJoiner,
  TailscaleCliManagedNetworkJoiner,
} from "./remote-target-managed-network";
import {
  RemoteTargetRunner,
  type RemoteTargetRunnerStatus,
} from "./remote-target-runner";
import {
  JsonFileRemoteTargetStateStore,
  type RemoteTargetStateStore,
} from "./remote-target-store";
import {
  HttpRemoteTargetRelayTransport,
  normalizeRemoteTargetApiBase,
  type RemoteTargetRelayTransport,
  RemoteTargetTransportError,
} from "./remote-target-transport";
import {
  RemoteTargetVault,
  remoteTargetVaultInternals,
} from "./remote-target-vault";

export interface DesktopRemoteTargetEnrollmentResult {
  hostId: string;
  status: "active";
  identity: RemoteTargetPublicIdentity;
}

export interface DesktopRemoteTargetIdentityResult {
  enrolled: boolean;
  identity?: RemoteTargetPublicIdentity;
}

export type DesktopRemoteTargetActivationResult =
  | {
      sessionId: string;
      status: "active";
      controllerDisplayName: string;
      grantExpiresAt: number;
    }
  | {
      sessionId: string;
      status: "compensation_required";
      errorCode: "REMOTE_ACTIVATION_COMPENSATION_REQUIRED";
      retryRpc: "remoteTargetCompensateActivation";
    }
  | {
      sessionId: string;
      status: "commit_required";
      errorCode: "REMOTE_ACTIVATION_COMMIT_REQUIRED";
      retryRpc: "remoteTargetCommitActivation";
    };

export interface DesktopRemoteTargetResumeResult {
  resumed: boolean;
  reason:
    | "active_authority"
    | "activation_recovery"
    | "not_enrolled"
    | "no_active_authority";
}

interface RemoteTargetLoopbackConfiguration {
  apiBase: string;
  apiToken: string;
  pollIntervalMs?: number;
}

interface PreparedRemoteTargetLoopbackConfiguration {
  executor: LoopbackRemoteTargetExecutor;
  key: string;
  pollIntervalMs?: number;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Remote target parameters are required.");
  }
  return value as Record<string, unknown>;
}

function requireString(
  value: unknown,
  field: string,
  maxBytes: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw new Error(`Remote target ${field} is invalid.`);
  }
  return value.trim();
}

export class RemoteTargetDesktopService {
  private runner: RemoteTargetRunner | null = null;
  private loopbackConfigurationKey: string | null = null;
  private configurationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly vault: RemoteTargetVault = new RemoteTargetVault(),
    private readonly stateStore: RemoteTargetStateStore = new JsonFileRemoteTargetStateStore(),
    private readonly transport: RemoteTargetRelayTransport = new HttpRemoteTargetRelayTransport(),
    private readonly now: () => number = Date.now,
    private readonly managedNetworkJoiner: RemoteTargetManagedNetworkJoiner = new TailscaleCliManagedNetworkJoiner(),
  ) {}

  private prepareLoopbackConfiguration(
    input: RemoteTargetLoopbackConfiguration,
  ): PreparedRemoteTargetLoopbackConfiguration {
    const apiBase = normalizeRemoteTargetLoopbackBase(input.apiBase);
    return {
      executor: new LoopbackRemoteTargetExecutor({
        apiBase,
        apiToken: input.apiToken,
      }),
      key: createHash("sha256")
        .update(apiBase)
        .update("\0")
        .update(input.apiToken)
        .update("\0")
        .update(String(input.pollIntervalMs ?? 1_000))
        .digest("base64url"),
      ...(input.pollIntervalMs === undefined
        ? {}
        : { pollIntervalMs: input.pollIntervalMs }),
    };
  }

  private enqueueConfiguration<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.configurationTail.then(operation);
    this.configurationTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private async installLoopbackConfiguration(
    prepared: PreparedRemoteTargetLoopbackConfiguration,
  ): Promise<RemoteTargetRunner> {
    if (this.runner && this.loopbackConfigurationKey === prepared.key) {
      return this.runner;
    }
    const replacement = new RemoteTargetRunner(
      this.vault,
      this.stateStore,
      this.transport,
      prepared.executor,
      { now: this.now, pollIntervalMs: prepared.pollIntervalMs },
    );
    await this.runner?.stop();
    this.runner = replacement;
    this.loopbackConfigurationKey = prepared.key;
    return replacement;
  }

  async configureLoopback(
    input: RemoteTargetLoopbackConfiguration,
  ): Promise<void> {
    const prepared = this.prepareLoopbackConfiguration(input);
    await this.enqueueConfiguration(async () => {
      await this.installLoopbackConfiguration(prepared);
    });
  }

  /**
   * Rebuild the ephemeral runner after a desktop-process restart, but only
   * when both halves of its durable authority still exist: an enrolled host
   * identity in the OS credential store and at least one live controller
   * grant in the exactly-once journal. Missing/corrupt credential or journal
   * state never degrades into a fresh enrollment or an unpinned runner.
   */
  async resumeEligibleLoopback(
    input: RemoteTargetLoopbackConfiguration,
  ): Promise<DesktopRemoteTargetResumeResult> {
    const prepared = this.prepareLoopbackConfiguration(input);
    return this.enqueueConfiguration(async () => {
      const runner = await this.installLoopbackConfiguration(prepared);
      const enrollmentBeforeRecovery = await this.vault.load();
      if (enrollmentBeforeRecovery?.status === "enrolled") {
        await runner.recoverStagedActivations();
      }
      const [enrollment, state] = await Promise.all([
        this.vault.load(),
        this.stateStore.read(),
      ]);
      const activeSessions = Object.values(state.sessions).filter(
        (session) =>
          session.activationState !== "staged" &&
          session.stoppedAt === null &&
          session.grant.revokedAt === null &&
          (session.grant.expiresAt === null ||
            session.grant.expiresAt >= this.now()),
      );
      const stagedSessions = Object.values(state.sessions).filter(
        (session) =>
          session.activationState === "staged" &&
          session.stoppedAt === null &&
          session.grant.revokedAt === null,
      );
      if (enrollment?.status !== "enrolled") {
        if (activeSessions.length > 0) {
          throw new Error(
            "Remote target credentials are unavailable for the durable active session.",
          );
        }
        return {
          resumed: false,
          reason: "not_enrolled" as const,
        };
      }
      if (activeSessions.length === 0) {
        if (stagedSessions.length > 0) {
          await runner.start();
          return { resumed: true, reason: "activation_recovery" as const };
        }
        return {
          resumed: false,
          reason: "no_active_authority" as const,
        };
      }
      await runner.start();
      return { resumed: true, reason: "active_authority" as const };
    });
  }

  async enroll(params: unknown): Promise<DesktopRemoteTargetEnrollmentResult> {
    const value = requireObject(params);
    const apiBaseUrl = normalizeRemoteTargetApiBase(
      requireString(value.apiBaseUrl, "API URL", 2_048),
    );
    const ownerId = requireString(value.ownerId, "owner", 256);
    const ownerAccessToken = requireString(
      value.ownerAccessToken,
      "owner authentication",
      16_384,
    );
    const displayName = requireString(value.displayName, "display name", 128);
    const managedNetworkValue = value.managedNetwork;
    if (
      managedNetworkValue !== undefined &&
      typeof managedNetworkValue !== "boolean"
    ) {
      throw new Error("Managed network selection is invalid.");
    }
    const managedNetwork = managedNetworkValue === true;
    const prepared = await this.vault.prepare({
      ownerId,
      displayName,
      now: this.now(),
    });
    if (prepared.status === "enrolled") {
      if (prepared.apiBaseUrl !== apiBaseUrl) {
        throw new Error("Remote target is enrolled against a different API.");
      }
      return {
        hostId: prepared.identity.runtimeId,
        status: "active",
        identity: prepared.identity,
      };
    }
    let response: Awaited<ReturnType<RemoteTargetRelayTransport["enroll"]>>;
    try {
      response = await this.transport.enroll({
        apiBaseUrl,
        ownerAccessToken,
        ownerId,
        deviceId: prepared.deviceId,
        displayName: prepared.displayName,
        runtimeKeyId: prepared.keyId,
        signingPublicKeyJwk: remoteTargetVaultInternals.publicJwk(
          prepared.signingPrivateKeyJwk,
        ),
        encryptionPublicKeyJwk: remoteTargetVaultInternals.publicJwk(
          prepared.encryptionPrivateKeyJwk,
        ),
        managedNetwork,
      });
    } catch (error) {
      if (
        error instanceof RemoteTargetTransportError &&
        error.code === "REMOTE_HOST_REVOKED"
      ) {
        if (!(await this.vault.delete())) {
          throw new Error(
            "Stale remote target identity could not be cleared.",
            {
              cause: error,
            },
          );
        }
        throw new Error(
          "The revoked enrollment was cleared locally. Retry to create a fresh host identity.",
          { cause: error },
        );
      }
      if (
        error instanceof RemoteTargetTransportError &&
        error.code === "MANAGED_ENROLLMENT_PENDING"
      ) {
        throw new Error(
          "A prior managed enrollment is still pending. Revoke its host card, then retry.",
          { cause: error },
        );
      }
      throw error;
    }
    const managedEnrollment = managedNetwork
      ? response.managedNetworkEnrollment
      : undefined;
    if (
      managedNetwork &&
      (!managedEnrollment || response.status !== "pending")
    ) {
      throw new Error("Cloud did not return pending managed enrollment.");
    }
    if (!managedNetwork && response.status !== "active") {
      throw new Error("Cloud did not activate remote host enrollment.");
    }
    const enrolled = await this.vault.commitEnrollment({
      apiBaseUrl,
      hostId: response.hostId,
      hostToken: response.hostToken,
      runtimeKeyId: response.runtimeKeyId,
      createdAt: response.createdAt,
    });
    if (managedNetwork) {
      let joinedManagedNetwork = false;
      try {
        // The response was validated before committing credentials, so this
        // assertion only narrows the discriminated managed path for TypeScript.
        if (!managedEnrollment)
          throw new Error("Managed enrollment is missing.");
        await this.managedNetworkJoiner.join(managedEnrollment);
        joinedManagedNetwork = true;
        await this.vault.recordManagedNetwork({
          hostId: enrolled.identity.runtimeId,
          hostname: managedEnrollment.hostname,
          loginServer: managedEnrollment.loginServer,
        });
        await this.transport.activateManagedNetwork({
          enrollment: enrolled,
          expectedHostname: managedEnrollment.hostname,
        });
      } catch (cause) {
        const cleanupFailures: unknown[] = [];
        if (joinedManagedNetwork && managedEnrollment) {
          try {
            await this.managedNetworkJoiner.leave({
              hostname: managedEnrollment.hostname,
              loginServer: managedEnrollment.loginServer,
            });
          } catch (cleanupCause) {
            // error-policy:J6 Cloud cleanup must still run if native
            // membership teardown fails after a partial activation.
            cleanupFailures.push(cleanupCause);
          }
        }
        try {
          let cloudCleanupComplete = false;
          for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
            const page = await this.transport.revokeHost({
              enrollment: enrolled,
            });
            if (!page.cleanup.more) {
              if (
                cleanupFailures.length === 0 &&
                !(await this.vault.delete())
              ) {
                throw new Error(
                  "Managed enrollment was revoked, but local credentials could not be removed.",
                );
              }
              cloudCleanupComplete = true;
              break;
            }
            if (page.cleanup.sessions === 0 && page.cleanup.commands === 0) {
              throw new Error("Managed enrollment cleanup made no progress.");
            }
          }
          if (!cloudCleanupComplete) {
            throw new Error(
              "Managed enrollment cleanup exceeded its retry bound.",
            );
          }
        } catch (cleanupCause) {
          // error-policy:J6 native and Cloud cleanup failures are retained
          // together without suppressing the primary activation failure.
          cleanupFailures.push(cleanupCause);
        }
        if (cleanupFailures.length > 0) {
          throw new AggregateError(
            [cause, ...cleanupFailures],
            "Managed enrollment failed and cleanup must be retried from Devices & Runtimes.",
            { cause },
          );
        }
        throw cause;
      }
    }
    return {
      hostId: enrolled.identity.runtimeId,
      status: "active",
      identity: enrolled.identity,
    };
  }

  async getIdentity(): Promise<DesktopRemoteTargetIdentityResult> {
    const record = await this.vault.load();
    return record?.status === "enrolled"
      ? { enrolled: true, identity: record.identity }
      : { enrolled: false };
  }

  async activate(
    params: unknown,
  ): Promise<DesktopRemoteTargetActivationResult> {
    const value = requireObject(params);
    const sessionId =
      value.sessionId === undefined
        ? undefined
        : requireString(value.sessionId, "session id", 256);
    const code = requireString(value.code, "pairing code", 6);
    if (!/^\d{6}$/.test(code)) {
      throw new Error("Pairing code must contain exactly six digits.");
    }
    return this.enqueueConfiguration(async () => {
      const enrollment = await this.vault.load();
      if (enrollment?.status !== "enrolled") {
        throw new Error("Remote target is not enrolled.");
      }
      const activation = await this.transport.activate({
        enrollment,
        ...(sessionId ? { sessionId } : {}),
        code,
      });
      const installer =
        this.runner ??
        new RemoteTargetRunner(
          this.vault,
          this.stateStore,
          this.transport,
          {
            execute: async () => ({
              status: "rejected",
              errorCode: "REMOTE_TARGET_NOT_STARTED",
            }),
          },
          { now: this.now },
        );
      this.runner ??= installer;
      try {
        await installer.installActivation(activation);
      } catch (installError) {
        try {
          await this.transport.compensateActivation({
            enrollment,
            sessionId: activation.sessionId,
          });
        } catch (compensationError) {
          // error-policy:J2 preserve both failures and expose the exact,
          // idempotently retryable session without claiming local authority.
          const failure = new ElizaError(
            "Remote activation failed locally and Cloud compensation is required",
            {
              code: "REMOTE_ACTIVATION_COMPENSATION_REQUIRED",
              context: { sessionId: activation.sessionId },
              cause: new AggregateError([installError, compensationError]),
            },
          );
          logger.error(
            "[RemoteTargetDesktopService] Activation compensation requires retry",
            failure,
          );
          // The typed non-authoritative response preserves the exact session
          // required by the idempotent retry RPC. The local journal remains
          // empty, so this is never presented as active authority.
          return {
            sessionId: activation.sessionId,
            status: "compensation_required" as const,
            errorCode: "REMOTE_ACTIVATION_COMPENSATION_REQUIRED" as const,
            retryRpc: "remoteTargetCompensateActivation" as const,
          };
        }
        throw new ElizaError(
          "Remote activation failed locally and was rolled back in Cloud",
          {
            code: "REMOTE_ACTIVATION_LOCAL_INSTALL_FAILED",
            context: { sessionId: activation.sessionId },
            cause: installError,
          },
        );
      }
      try {
        await this.transport.commitActivation({
          enrollment,
          sessionId: activation.sessionId,
        });
        await installer.commitLocalActivation(activation.sessionId);
      } catch (commitError) {
        // error-policy:J4 the durable local staged grant remains
        // non-executable while exact-session commit is retried idempotently.
        logger.warn(
          "[RemoteTargetDesktopService] Activation commit requires retry",
          { sessionId: activation.sessionId, error: commitError },
        );
        return {
          sessionId: activation.sessionId,
          status: "commit_required" as const,
          errorCode: "REMOTE_ACTIVATION_COMMIT_REQUIRED" as const,
          retryRpc: "remoteTargetCommitActivation" as const,
        };
      }
      return {
        sessionId: activation.sessionId,
        status: "active" as const,
        controllerDisplayName: activation.controller.displayName,
        grantExpiresAt: activation.grantExpiresAt,
      };
    });
  }

  async compensateActivation(params: unknown): Promise<{
    sessionId: string;
    status: "denied" | "revoked";
    alreadyCompensated: boolean;
  }> {
    const value = requireObject(params);
    const sessionId = requireString(value.sessionId, "session id", 256);
    return this.enqueueConfiguration(async () => {
      const enrollment = await this.vault.load();
      if (enrollment?.status !== "enrolled") {
        throw new ElizaError("Remote host enrollment is unavailable", {
          code: "REMOTE_HOST_ENROLLMENT_UNAVAILABLE",
          context: { sessionId },
        });
      }
      return this.transport.compensateActivation({ enrollment, sessionId });
    });
  }

  async commitActivation(params: unknown): Promise<{
    sessionId: string;
    status: "active";
    alreadyCommitted: boolean;
  }> {
    const value = requireObject(params);
    const sessionId = requireString(value.sessionId, "session id", 256);
    return this.enqueueConfiguration(async () => {
      const enrollment = await this.vault.load();
      if (enrollment?.status !== "enrolled") {
        throw new ElizaError("Remote host enrollment is unavailable", {
          code: "REMOTE_HOST_ENROLLMENT_UNAVAILABLE",
          context: { sessionId },
        });
      }
      const response = await this.transport.commitActivation({
        enrollment,
        sessionId,
      });
      const runner = this.requireRunner();
      await runner.commitLocalActivation(sessionId);
      return response;
    });
  }

  async start(): Promise<{ running: true }> {
    await this.requireRunner().start();
    return { running: true };
  }

  async stop(): Promise<{ running: false }> {
    await this.runner?.stop();
    return { running: false };
  }

  async status(): Promise<RemoteTargetRunnerStatus> {
    if (this.runner) return this.runner.status();
    const [identity, state] = await Promise.all([
      this.getIdentity(),
      this.stateStore.read(),
    ]);
    return {
      running: false,
      enrolled: identity.enrolled,
      activeSessions: Object.values(state.sessions).filter(
        (session) =>
          session.activationState !== "staged" &&
          session.stoppedAt === null &&
          session.grant.revokedAt === null,
      ).length,
      pendingResults: Object.values(state.commands).filter(
        (command) => command.resultEnvelope && !command.resultDelivered,
      ).length,
      lastPollAt: null,
      lastErrorCode: null,
    };
  }

  async revoke(params: unknown): Promise<{ revoked: true }> {
    const value = requireObject(params);
    const sessionId = requireString(value.sessionId, "session id", 256);
    await this.requireRunner().revokeSession(sessionId);
    return { revoked: true };
  }

  async finalizeHostRevoke(params: unknown): Promise<{ cleaned: true }> {
    const value = requireObject(params);
    const hostId = requireString(value.hostId, "host id", 256);
    return await this.enqueueConfiguration(async () => {
      const enrollment = await this.vault.load();
      if (enrollment?.status !== "enrolled") {
        const state = await this.stateStore.read();
        if (
          Object.keys(state.sessions).length === 0 &&
          Object.keys(state.commands).length === 0
        ) {
          return { cleaned: true };
        }
        throw new ElizaError("Remote host enrollment is unavailable", {
          code: "REMOTE_HOST_ENROLLMENT_UNAVAILABLE",
          context: { hostId },
        });
      }
      if (enrollment.identity.runtimeId !== hostId) {
        throw new ElizaError(
          "Remote host cleanup target does not match this device",
          {
            code: "REMOTE_HOST_CLEANUP_TARGET_MISMATCH",
            context: { hostId, enrolledHostId: enrollment.identity.runtimeId },
          },
        );
      }
      while (true) {
        const page = await this.transport.revokeHost({ enrollment });
        if (!page.cleanup.more) break;
        if (page.cleanup.sessions === 0 && page.cleanup.commands === 0) {
          throw new ElizaError(
            "Remote host revocation made no cleanup progress",
            {
              code: "REMOTE_HOST_CLEANUP_PROGRESS_INVALID",
              context: { hostId, reason: "non_progressing_page" },
            },
          );
        }
      }
      if (enrollment.managedNetwork) {
        await this.managedNetworkJoiner.leave({
          hostname: enrollment.managedNetwork.hostname,
          loginServer: enrollment.managedNetwork.loginServer,
        });
      }
      await this.runner?.stop();
      this.runner = null;
      this.loopbackConfigurationKey = null;
      await this.stateStore.clear();
      if (!(await this.vault.delete())) {
        throw new ElizaError("Remote host credentials could not be deleted", {
          code: "REMOTE_HOST_CREDENTIAL_DELETE_FAILED",
          context: { hostId },
        });
      }
      return { cleaned: true };
    });
  }

  private requireRunner(): RemoteTargetRunner {
    if (!this.runner) {
      throw new Error("Remote target loopback runtime is not configured.");
    }
    return this.runner;
  }
}

const desktopRemoteTargetService = new RemoteTargetDesktopService();

export function configureDesktopRemoteTarget(input: {
  apiBase: string;
  apiToken: string;
  pollIntervalMs?: number;
}): Promise<void> {
  return desktopRemoteTargetService.configureLoopback(input);
}

export function resumeDesktopRemoteTarget(input: {
  apiBase: string;
  apiToken: string;
  pollIntervalMs?: number;
}): Promise<DesktopRemoteTargetResumeResult> {
  return desktopRemoteTargetService.resumeEligibleLoopback(input);
}

export function desktopRemoteTargetEnroll(
  params: unknown,
): Promise<DesktopRemoteTargetEnrollmentResult> {
  return desktopRemoteTargetService.enroll(params);
}

export function desktopRemoteTargetGetIdentity(): Promise<DesktopRemoteTargetIdentityResult> {
  return desktopRemoteTargetService.getIdentity();
}

export function desktopRemoteTargetActivate(
  params: unknown,
): Promise<DesktopRemoteTargetActivationResult> {
  return desktopRemoteTargetService.activate(params);
}

export function desktopRemoteTargetCompensateActivation(
  params: unknown,
): Promise<{
  sessionId: string;
  status: "denied" | "revoked";
  alreadyCompensated: boolean;
}> {
  return desktopRemoteTargetService.compensateActivation(params);
}

export function desktopRemoteTargetCommitActivation(params: unknown): Promise<{
  sessionId: string;
  status: "active";
  alreadyCommitted: boolean;
}> {
  return desktopRemoteTargetService.commitActivation(params);
}

export function desktopRemoteTargetStart(): Promise<{ running: true }> {
  return desktopRemoteTargetService.start();
}

export function desktopRemoteTargetStop(): Promise<{ running: false }> {
  return desktopRemoteTargetService.stop();
}

export function desktopRemoteTargetStatus(): Promise<RemoteTargetRunnerStatus> {
  return desktopRemoteTargetService.status();
}

export function desktopRemoteTargetRevoke(
  params: unknown,
): Promise<{ revoked: true }> {
  return desktopRemoteTargetService.revoke(params);
}

export function desktopRemoteTargetFinalizeHostRevoke(
  params: unknown,
): Promise<{ cleaned: true }> {
  return desktopRemoteTargetService.finalizeHostRevoke(params);
}

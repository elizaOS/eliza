/**
 * Exposes the native-only Linux target lifecycle to the typed Electrobun RPC
 * composition layer. Renderer callers receive public identity and health data;
 * the host bearer and private JWKs never cross this boundary.
 */
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import type { RemoteTargetPublicIdentity } from "@elizaos/shared/contracts/remote-control";
import {
  LoopbackRemoteTargetExecutor,
  normalizeRemoteTargetLoopbackBase,
} from "./remote-target-executor";
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

export interface DesktopRemoteTargetActivationResult {
  sessionId: string;
  status: "active";
  controllerDisplayName: string;
  grantExpiresAt: number;
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
  ) {}

  async configureLoopback(input: {
    apiBase: string;
    apiToken: string;
    pollIntervalMs?: number;
  }): Promise<void> {
    const apiBase = normalizeRemoteTargetLoopbackBase(input.apiBase);
    const configurationKey = createHash("sha256")
      .update(apiBase)
      .update("\0")
      .update(input.apiToken)
      .update("\0")
      .update(String(input.pollIntervalMs ?? 1_000))
      .digest("base64url");
    const configure = this.configurationTail.then(async () => {
      if (this.runner && this.loopbackConfigurationKey === configurationKey) {
        return;
      }
      const replacement = new RemoteTargetRunner(
        this.vault,
        this.stateStore,
        this.transport,
        new LoopbackRemoteTargetExecutor({
          apiBase,
          apiToken: input.apiToken,
        }),
        { now: this.now, pollIntervalMs: input.pollIntervalMs },
      );
      await this.runner?.stop();
      this.runner = replacement;
      this.loopbackConfigurationKey = configurationKey;
    });
    // error-policy:J5 the current configure caller receives `configure`; this
    // tail suppression only keeps a later replacement from inheriting failure.
    this.configurationTail = configure.catch(() => undefined);
    return configure;
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
    const response = await this.transport.enroll({
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
    });
    const enrolled = await this.vault.commitEnrollment({
      apiBaseUrl,
      hostId: response.hostId,
      hostToken: response.hostToken,
      runtimeKeyId: response.runtimeKeyId,
      createdAt: response.createdAt,
    });
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
    const sessionId = requireString(value.sessionId, "session id", 256);
    const code = requireString(value.code, "pairing code", 6);
    if (!/^\d{6}$/.test(code)) {
      throw new Error("Pairing code must contain exactly six digits.");
    }
    const enrollment = await this.vault.load();
    if (enrollment?.status !== "enrolled") {
      throw new Error("Remote target is not enrolled.");
    }
    const activation = await this.transport.activate({
      enrollment,
      sessionId,
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
    await installer.installActivation(activation);
    return {
      sessionId: activation.sessionId,
      status: "active",
      controllerDisplayName: activation.controller.displayName,
      grantExpiresAt: activation.grantExpiresAt,
    };
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
          session.stoppedAt === null && session.grant.revokedAt === null,
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
    const enrollment = await this.vault.load();
    if (enrollment?.status !== "enrolled") {
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
    await this.stop();
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

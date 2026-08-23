/** Canonical renderer-side executor for Devices & Runtimes UI and agent actions. */

import type {
  RuntimeManagementRequest,
  RuntimeManagementResult,
} from "@elizaos/shared/contracts";
import {
  createDefaultRemoteControlCloudClient,
  getDefaultRemoteControlCloudConnection,
} from "../api/remote-control-cloud-default";
import { isElectrobunRuntime } from "../bridge/electrobun-runtime";
import {
  addAgentProfile,
  loadAgentProfileRegistry,
  removeAgentProfile,
} from "../state";
import { isTrustedRestoreApiBaseUrl } from "../state/runtime-url-trust";
import {
  clearRemoteControllerSessionState,
  getOrCreateRemoteControllerIdentity,
} from "./remote-controller";
import {
  activateRemoteTarget,
  enrollRemoteTarget,
  finalizeRemoteTargetHostRevoke,
  getRemoteTargetIdentity,
  getRemoteTargetStatus,
  startRemoteTarget,
  stopRemoteTarget,
} from "./remote-target";
import {
  deleteRuntimeCredentialRecord,
  storeRuntimeCredential,
} from "./runtime-credential-store";
import { inspectSshHost, startSshRuntime, stopSshRuntime } from "./ssh-runtime";
import {
  removeSshRuntime,
  resumePendingSshRuntimeCleanups,
  retrySshRuntimeCleanup,
  type SshRuntimeCleanupResult,
  type SshRuntimeLifecycleDependencies,
  setupSshRuntime,
} from "./ssh-runtime-lifecycle";

/** Secret-bearing fields exist only inside the renderer and never cross agent HTTP/WS. */
export interface LocalRuntimeManagementRequest
  extends RuntimeManagementRequest {
  accessToken?: string;
}

const SSH_DEPENDENCIES: SshRuntimeLifecycleDependencies = {
  startTunnel: startSshRuntime,
  stopTunnel: stopSshRuntime,
  storeCredential: storeRuntimeCredential,
  deleteCredentialRecord: deleteRuntimeCredentialRecord,
  addProfile: addAgentProfile,
  removeProfile: removeAgentProfile,
  loadRegistry: loadAgentProfileRegistry,
};

function requiredString(value: string | undefined, field: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized;
}

function requiredPort(value: number | undefined, field: string): number {
  if (
    !Number.isSafeInteger(value) ||
    value === undefined ||
    value < 1 ||
    value > 65535
  ) {
    throw new Error(`${field} must be a valid TCP port.`);
  }
  return value;
}

function requireCompleteCleanup(results: SshRuntimeCleanupResult[]): void {
  if (results.some((result) => !result.complete)) {
    throw new Error(
      "SSH cleanup is incomplete. Retry cleanup before continuing.",
    );
  }
}

function localDesktopPlatform(): "macos" | "windows" | "linux" {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("win")) return "windows";
  if (platform.includes("linux")) return "linux";
  return "macos";
}

function publicRuntimeList(): Record<string, unknown>[] {
  const registry = loadAgentProfileRegistry();
  return registry.profiles.map((profile) => ({
    id: profile.id,
    label: profile.label,
    kind: profile.kind,
    connectionMode: profile.connectionMode ?? "direct",
    active: profile.id === registry.activeProfileId,
    ...(profile.connectionMode === "ssh"
      ? { target: profile.ssh?.target ?? null }
      : {}),
    ...(profile.connectionMode === "relay"
      ? { targetRuntimeId: profile.remoteRelay?.targetRuntimeId ?? null }
      : {}),
  }));
}

async function removeRuntime(profileId: string): Promise<void> {
  const profile = loadAgentProfileRegistry().profiles.find(
    (candidate) => candidate.id === profileId,
  );
  if (!profile) throw new Error("That runtime profile was not found.");
  if (profile.connectionMode === "relay" && profile.remoteRelay) {
    const cloud = createDefaultRemoteControlCloudClient();
    await cloud.revokeSession(profile.remoteRelay.sessionId);
    await clearRemoteControllerSessionState({
      ownerId: profile.remoteRelay.ownerId,
      controllerDeviceId: profile.remoteRelay.controllerDeviceId,
      sessionId: profile.remoteRelay.sessionId,
    });
  }
  if (profile.connectionMode === "ssh") {
    await removeSshRuntime(profile, SSH_DEPENDENCIES);
    return;
  }
  removeAgentProfile(profile.id);
}

async function revokeRuntime(targetId: string): Promise<void> {
  const cloud = createDefaultRemoteControlCloudClient();
  const registry = loadAgentProfileRegistry();
  const profile = registry.profiles.find(
    (candidate) => candidate.id === targetId,
  );
  if (profile?.remoteRelay) {
    await cloud.revokeSession(profile.remoteRelay.sessionId);
    await clearRemoteControllerSessionState({
      ownerId: profile.remoteRelay.ownerId,
      controllerDeviceId: profile.remoteRelay.controllerDeviceId,
      sessionId: profile.remoteRelay.sessionId,
    });
    removeAgentProfile(profile.id);
    return;
  }

  const directory = await cloud.listHosts();
  const controller = await getOrCreateRemoteControllerIdentity({
    ownerId: directory.ownerId,
  });
  const hostId = targetId.replace(/^host:/, "");
  const host = directory.hosts.find((candidate) => candidate.id === hostId);
  if (host?.status === "pending") {
    await cloud.revokeHost(hostId);
    return;
  }
  const sessions = await cloud.listSessions(hostId, directory.ownerId);
  const session = sessions.find(
    (candidate) =>
      candidate.status === "active" &&
      candidate.controllerDeviceId === controller.deviceId &&
      candidate.controllerKeyId === controller.keyId,
  );
  if (!session)
    throw new Error("No active pairing was found for this controller.");
  await cloud.revokeSession(session.id);
}

async function execute(
  request: LocalRuntimeManagementRequest,
): Promise<Record<string, unknown>> {
  if (request.op === "list") {
    const data: Record<string, unknown> = { runtimes: publicRuntimeList() };
    if (isElectrobunRuntime()) data.host = await getRemoteTargetStatus();
    return data;
  }

  if (request.op === "pair") {
    const targetId = requiredString(request.targetId, "targetId");
    const hostId = targetId.replace(/^host:/, "");
    const cloud = createDefaultRemoteControlCloudClient();
    const directory = await cloud.listHosts();
    const host = directory.hosts.find((candidate) => candidate.id === hostId);
    if (!host) throw new Error("Refresh Devices & Runtimes before pairing.");
    const controller = await getOrCreateRemoteControllerIdentity({
      ownerId: directory.ownerId,
    });
    const receipt = await cloud.createPairing({ hostId, controller });
    return {
      hostId,
      hostLabel: host.displayName,
      receipt,
    };
  }

  if (request.op === "revoke") {
    await revokeRuntime(requiredString(request.targetId, "targetId"));
    return {};
  }

  if (request.op === "remove") {
    await removeRuntime(requiredString(request.runtimeId, "runtimeId"));
    return {};
  }

  if (request.op === "retry") {
    const runtimeId = requiredString(request.runtimeId, "runtimeId");
    const profile = loadAgentProfileRegistry().profiles.find(
      (candidate) => candidate.id === runtimeId,
    );
    if (!profile?.ssh) throw new Error("That SSH runtime was not found.");
    if (await retrySshRuntimeCleanup(runtimeId, SSH_DEPENDENCIES)) return {};
    await startSshRuntime({
      runtimeId,
      target: profile.ssh.target,
      sshPort: profile.ssh.sshPort,
      remoteApiPort: profile.ssh.remoteApiPort,
      expectedFingerprint: profile.ssh.hostFingerprint,
      identityFile: profile.ssh.identityFile,
      credentialRef: profile.credentialRef,
    });
    return {};
  }

  if (request.op === "inspect_ssh") {
    return {
      inspection: await inspectSshHost({
        runtimeId: requiredString(request.runtimeId, "runtimeId"),
        target: requiredString(request.target, "target"),
        sshPort: requiredPort(request.sshPort, "sshPort"),
      }),
    };
  }

  if (request.op === "connect_ssh") {
    const runtimeId = requiredString(request.runtimeId, "runtimeId");
    requireCompleteCleanup(
      await resumePendingSshRuntimeCleanups(SSH_DEPENDENCIES),
    );
    const profile = await setupSshRuntime(
      {
        runtimeId,
        label: requiredString(request.label, "label"),
        target: requiredString(request.target, "target"),
        sshPort: requiredPort(request.sshPort, "sshPort"),
        remoteApiPort: requiredPort(request.remoteApiPort, "remoteApiPort"),
        expectedFingerprint: requiredString(
          request.expectedFingerprint,
          "expectedFingerprint",
        ),
        ...(request.identityFile?.trim()
          ? { identityFile: request.identityFile.trim() }
          : {}),
        credentialRef: runtimeId,
        ...(request.accessToken?.trim()
          ? { accessToken: request.accessToken.trim() }
          : {}),
      },
      SSH_DEPENDENCIES,
    );
    return { runtimeId: profile.id, label: profile.label };
  }

  if (request.op === "add_direct") {
    const apiBase = requiredString(request.apiBase, "apiBase");
    if (!isTrustedRestoreApiBaseUrl(apiBase)) {
      throw new Error("Use a private, local, or Tailscale runtime URL.");
    }
    const profile = addAgentProfile(
      {
        kind: "remote",
        label: requiredString(request.label, "label"),
        apiBase,
        ...(request.accessToken?.trim()
          ? { accessToken: request.accessToken.trim() }
          : {}),
      },
      { activate: false },
    );
    return { runtimeId: profile.id, label: profile.label };
  }

  if (request.op === "enroll_host") {
    if (!isElectrobunRuntime())
      throw new Error("Host enrollment requires the desktop app.");
    const cloud = createDefaultRemoteControlCloudClient();
    const directory = await cloud.listHosts();
    const connection = getDefaultRemoteControlCloudConnection();
    const platform = localDesktopPlatform();
    const enrollment = await enrollRemoteTarget({
      apiBaseUrl: connection.baseUrl,
      ownerId: directory.ownerId,
      ownerAccessToken: connection.authToken,
      displayName:
        platform === "macos"
          ? "My Mac"
          : platform === "windows"
            ? "My Windows PC"
            : "My Linux computer",
      platform,
      managedNetwork: request.managedNetwork === true,
    });
    return { hostId: enrollment.hostId };
  }

  if (request.op === "approve_pairing") {
    const result = await activateRemoteTarget({
      sessionId: requiredString(request.sessionId, "sessionId"),
      code: requiredString(request.code, "code"),
    });
    await startRemoteTarget();
    return { controllerDisplayName: result.controllerDisplayName };
  }

  if (request.op === "start_host") {
    if (!(await startRemoteTarget()))
      throw new Error("The desktop relay did not start.");
    return {};
  }

  if (request.op === "stop_host") {
    if (!(await stopRemoteTarget()))
      throw new Error("The desktop relay did not stop.");
    return {};
  }

  const identity = await getRemoteTargetIdentity();
  const hostId = identity.identity?.runtimeId;
  if (!hostId) throw new Error("This computer's host identity is unavailable.");
  const cloud = createDefaultRemoteControlCloudClient();
  await cloud.revokeHost(hostId);
  if (!(await finalizeRemoteTargetHostRevoke(hostId))) {
    throw new Error(
      "Cloud revoked the host, but local cleanup needs to be retried.",
    );
  }
  return { hostId };
}

export async function executeRuntimeManagementCommand(
  request: LocalRuntimeManagementRequest,
): Promise<RuntimeManagementResult> {
  try {
    return { ok: true, op: request.op, data: await execute(request) };
  } catch (cause) {
    // error-policy:J1 the renderer command boundary returns an explicit failure
    // to the waiting agent route; it never reports a failed mutation as success.
    return {
      ok: false,
      op: request.op,
      error:
        cause instanceof Error && cause.message.trim()
          ? cause.message
          : "The runtime operation failed.",
    };
  }
}

export const runtimeManagementInternals = {
  publicRuntimeList,
  requiredPort,
  requiredString,
};

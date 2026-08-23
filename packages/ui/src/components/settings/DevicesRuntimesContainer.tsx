/** Live state and secure enrollment flows for Devices & Runtimes settings. */

import type { RemoteControllerPublicIdentity } from "@elizaos/shared/contracts/remote-control";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  RemoteHostDirectory,
  RemoteHostSummary,
  RemotePairingReceipt,
  RemoteSessionSummary,
} from "../../api/remote-control-cloud-client";
import {
  RemoteCloudRequestError,
  RemoteControlAuthenticationRequiredError,
} from "../../api/remote-control-cloud-client";
import { createDefaultRemoteControlCloudClient } from "../../api/remote-control-cloud-default";
import { isElectrobunRuntime } from "../../bridge/electrobun-runtime";
import { isStoreBuild } from "../../build-variant";
import { isAndroidCloudBuild } from "../../platform/android-runtime";
import { getOrCreateRemoteControllerIdentity } from "../../platform/remote-controller";
import {
  getRemoteTargetIdentity,
  getRemoteTargetStatus,
} from "../../platform/remote-target";
import {
  deleteRuntimeCredentialRecord,
  storeRuntimeCredential,
} from "../../platform/runtime-credential-store";
import { executeRuntimeManagementCommand } from "../../platform/runtime-management";
import {
  getSshRuntimeStatus,
  type SshHostInspection,
  startSshRuntime,
  stopSshRuntime,
} from "../../platform/ssh-runtime";
import {
  resumePendingSshRuntimeCleanups,
  type SshRuntimeCleanupResult,
  type SshRuntimeLifecycleDependencies,
} from "../../platform/ssh-runtime-lifecycle";
import {
  type AgentProfile,
  addAgentProfile,
  loadAgentProfileRegistry,
  removeAgentProfile,
  switchRuntimeNonDestructive,
} from "../../state";
import {
  type DesktopRemoteTargetView,
  type DevicePairingView,
  type DeviceRuntimeTarget,
  DevicesRuntimesSection,
  type DirectRuntimeInput,
  type SshConnectInput,
} from "./DevicesRuntimesSection";

function messageFor(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  return "The device request failed. Check the connection and try again.";
}

function isCloudAuthenticationRequired(cause: unknown): boolean {
  return (
    cause instanceof RemoteControlAuthenticationRequiredError ||
    (cause instanceof RemoteCloudRequestError && cause.status === 401)
  );
}

const SSH_RUNTIME_LIFECYCLE_DEPENDENCIES: SshRuntimeLifecycleDependencies = {
  startTunnel: startSshRuntime,
  stopTunnel: stopSshRuntime,
  storeCredential: storeRuntimeCredential,
  deleteCredentialRecord: deleteRuntimeCredentialRecord,
  addProfile: addAgentProfile,
  removeProfile: removeAgentProfile,
  loadRegistry: loadAgentProfileRegistry,
};

function requireCompleteSshCleanup(results: SshRuntimeCleanupResult[]): void {
  if (results.some((result) => !result.complete)) {
    throw new Error(
      "SSH cleanup is incomplete. Refresh to retry before adding another server.",
    );
  }
}

function platformName(platform: RemoteHostSummary["platform"]): string {
  if (platform === "macos") return "Mac";
  if (platform === "windows") return "Windows PC";
  if (platform === "linux") return "Linux computer";
  if (platform === "ios") return "iPhone or iPad";
  if (platform === "android") return "Android device";
  return "Web runtime";
}

function localDesktopPlatform(): "macos" | "windows" | "linux" {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("win")) return "windows";
  if (platform.includes("linux")) return "linux";
  return "macos";
}

function requireHostCreatedAt(value: string): number {
  const createdAt = Date.parse(value);
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) {
    throw new Error("Cloud returned invalid remote-host creation metadata.");
  }
  return createdAt;
}

function profileTarget(
  profile: AgentProfile,
  activeId: string | null,
  sshRunning: ReadonlyMap<string, boolean>,
  directory: RemoteHostDirectory | null,
  sessions: ReadonlyMap<string, RemoteSessionSummary[]>,
): DeviceRuntimeTarget {
  const selected = profile.id === activeId;
  if (profile.connectionMode === "ssh") {
    const running = sshRunning.get(profile.id) ?? false;
    return {
      id: profile.id,
      label: profile.label,
      detail: `VPS over SSH · ${profile.ssh?.target ?? "Unknown target"}`,
      kind: "ssh",
      status: running ? "connected" : "offline",
      selected,
      activity: running ? "Tunnel active" : "Tunnel stopped",
      canRemove: true,
    };
  }
  if (profile.connectionMode === "relay" && profile.remoteRelay) {
    const relay = profile.remoteRelay;
    const host = directory?.hosts.find(
      (item) => item.id === relay.targetRuntimeId,
    );
    const session = (sessions.get(relay.targetRuntimeId) ?? []).find(
      (item) => item.id === relay.sessionId,
    );
    const invalid = Boolean(
      !Number.isSafeInteger(relay.targetCreatedAt) ||
        relay.targetCreatedAt <= 0 ||
        (directory &&
          (!host ||
            host.status === "revoked" ||
            session?.status !== "active" ||
            (relay.expiresAt && Date.parse(relay.expiresAt) <= Date.now()))),
    );
    const offline =
      !invalid && Boolean(directory && host?.status === "offline");
    return {
      id: profile.id,
      label: profile.label,
      detail: `${platformName(profile.remoteRelay.targetPlatform)} · encrypted Cloud relay · health/status only`,
      kind: "relay",
      status: invalid
        ? "error"
        : offline || !directory
          ? "offline"
          : "connected",
      selected,
      activity: invalid
        ? "Grant expired or revoked"
        : offline
          ? "Host is offline"
          : directory
            ? "Health/status checks available"
            : "Cloud status unavailable",
      error: invalid
        ? "This pairing is no longer active. Remove it and pair again."
        : undefined,
      canRevoke: true,
      canRemove: true,
    };
  }
  return {
    id: profile.id,
    label: profile.label,
    detail:
      profile.kind === "local"
        ? "This device · private local runtime"
        : profile.kind === "cloud"
          ? "Eliza Cloud runtime"
          : `VPS / direct · ${profile.apiBase ?? "No address"}`,
    kind:
      profile.kind === "local"
        ? "local"
        : profile.kind === "cloud"
          ? "cloud"
          : "vps",
    status: "connected",
    selected,
    activity: selected ? "Currently in use" : "Ready",
    canRemove: profile.kind === "remote",
  };
}

function hostTarget(
  host: RemoteHostSummary,
  sessions: ReadonlyMap<string, RemoteSessionSummary[]>,
  controller: RemoteControllerPublicIdentity | null,
): DeviceRuntimeTarget {
  const active = (sessions.get(host.id) ?? []).find(
    (session) => session.status === "active",
  );
  const activeHere = (sessions.get(host.id) ?? []).find(
    (session) =>
      session.status === "active" &&
      session.controllerDeviceId === controller?.deviceId &&
      session.controllerKeyId === controller.keyId,
  );
  const revoked = host.status === "revoked";
  return {
    id: `host:${host.id}`,
    label: host.displayName,
    detail: `${platformName(host.platform)} · encrypted relay · health/status only`,
    kind: host.platform === "web" ? "cloud" : "relay",
    status: revoked
      ? "error"
      : host.status === "offline"
        ? "offline"
        : activeHere
          ? "connected"
          : "pairing",
    selected: false,
    activity: revoked
      ? "Access revoked"
      : activeHere
        ? "Paired securely"
        : active
          ? "Paired on another controller"
          : host.lastSeenAt
            ? `Last seen ${new Date(host.lastSeenAt).toLocaleString()}`
            : "Awaiting first connection",
    error: revoked
      ? "This host was revoked and cannot accept new sessions."
      : undefined,
    canPair: !revoked && !activeHere,
    canRevoke: !revoked && Boolean(activeHere),
    canSelect: false,
  };
}

interface RuntimeRemovalDependencies {
  revokeSession: (sessionId: string) => Promise<void>;
  clearSession: (input: {
    ownerId: string;
    controllerDeviceId: string;
    sessionId: string;
  }) => Promise<unknown>;
  removeSsh: (profile: AgentProfile) => Promise<void>;
  removeProfile: (profileId: string) => void;
}

async function removeRuntimeWithAuthority(
  profile: AgentProfile,
  dependencies: RuntimeRemovalDependencies,
): Promise<void> {
  if (profile.connectionMode === "relay" && profile.remoteRelay) {
    await dependencies.revokeSession(profile.remoteRelay.sessionId);
    await dependencies.clearSession({
      ownerId: profile.remoteRelay.ownerId,
      controllerDeviceId: profile.remoteRelay.controllerDeviceId,
      sessionId: profile.remoteRelay.sessionId,
    });
  }
  if (profile.connectionMode === "ssh") {
    await dependencies.removeSsh(profile);
    return;
  }
  dependencies.removeProfile(profile.id);
}

async function revokeDesktopHostCloudFirst(
  hostId: string,
  dependencies: {
    revokeHost: (hostId: string) => Promise<void>;
    finalizeLocal: (hostId: string) => Promise<boolean>;
  },
): Promise<void> {
  await dependencies.revokeHost(hostId);
  if (!(await dependencies.finalizeLocal(hostId))) {
    throw new Error(
      "Cloud revoked this computer, but local credential cleanup needs to be retried.",
    );
  }
}

function visibleProfilesForBuild(
  profiles: readonly AgentProfile[],
  activeProfileId: string | null,
  localRuntimeUnavailable: boolean,
): AgentProfile[] {
  if (!localRuntimeUnavailable) return [...profiles];
  return profiles.filter(
    (profile) => profile.kind !== "local" || profile.id === activeProfileId,
  );
}

function canSelectProfileForBuild(
  profile: AgentProfile | undefined,
  localRuntimeUnavailable: boolean,
): boolean {
  return (
    Boolean(profile) && !(localRuntimeUnavailable && profile?.kind === "local")
  );
}

export function DevicesRuntimesContainer({
  className,
}: {
  className?: string;
}) {
  const [registry, setRegistry] = useState(() => loadAgentProfileRegistry());
  const [directory, setDirectory] = useState<RemoteHostDirectory | null>(null);
  const [controller, setController] =
    useState<RemoteControllerPublicIdentity | null>(null);
  const [sessions, setSessions] = useState<Map<string, RemoteSessionSummary[]>>(
    () => new Map(),
  );
  const [sshRunning, setSshRunning] = useState<Map<string, boolean>>(
    () => new Map(),
  );
  const [desktopTarget, setDesktopTarget] =
    useState<DesktopRemoteTargetView | null>(null);
  const [pairing, setPairing] = useState<{
    hostId: string;
    receipt: RemotePairingReceipt;
  } | null>(null);
  const [sshInspection, setSshInspection] = useState<SshHostInspection | null>(
    null,
  );
  const pendingSshId = useRef(crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cloudState, setCloudState] = useState<
    "loading" | "available" | "signed-out" | "error"
  >("loading");
  const localRuntimeUnavailable = isAndroidCloudBuild() || isStoreBuild();

  const refresh = useCallback(async () => {
    setError(null);
    setCloudState("loading");
    const nextRegistry = loadAgentProfileRegistry();
    setRegistry(nextRegistry);

    const sshProfiles = nextRegistry.profiles.filter(
      (profile) => profile.connectionMode === "ssh",
    );
    const statuses = await Promise.all(
      sshProfiles.map(
        async (profile) =>
          [
            profile.id,
            (await getSshRuntimeStatus(profile.id)).running,
          ] as const,
      ),
    );
    setSshRunning(new Map(statuses));
    if (isElectrobunRuntime()) {
      const [status, identity] = await Promise.all([
        getRemoteTargetStatus(),
        getRemoteTargetIdentity(),
      ]);
      setDesktopTarget({
        ...status,
        platform: localDesktopPlatform(),
        hostId: identity.identity?.runtimeId ?? null,
      });
    } else {
      setDesktopTarget(null);
    }

    try {
      const cloud = createDefaultRemoteControlCloudClient();
      const nextDirectory = await cloud.listHosts();
      const nextController = await getOrCreateRemoteControllerIdentity({
        ownerId: nextDirectory.ownerId,
      });
      const nextSessions = new Map<string, RemoteSessionSummary[]>();
      await Promise.all(
        nextDirectory.hosts.map(async (host) => {
          nextSessions.set(
            host.id,
            await cloud.listSessions(host.id, nextDirectory.ownerId),
          );
        }),
      );
      setDirectory(nextDirectory);
      setCloudState("available");
      setController(nextController);
      setSessions(nextSessions);

      for (const host of nextDirectory.hosts) {
        for (const session of nextSessions.get(host.id) ?? []) {
          if (session.status !== "active") continue;
          if (
            session.controllerDeviceId !== nextController.deviceId ||
            session.controllerKeyId !== nextController.keyId
          ) {
            continue;
          }
          const existing = nextRegistry.profiles.some(
            (profile) => profile.remoteRelay?.sessionId === session.id,
          );
          if (existing) continue;
          addAgentProfile(
            {
              kind: "remote",
              label: host.displayName,
              apiBase: `eliza-remote://session/${session.id}`,
              connectionMode: "relay",
              remoteRelay: {
                ownerId: session.ownerId,
                controllerDeviceId: nextController.deviceId,
                controllerKeyId: nextController.keyId,
                grantId: session.grantId,
                grantRevision: session.grantRevision,
                sessionId: session.id,
                targetRuntimeId: session.targetRuntimeId,
                targetKeyId: session.targetKeyId,
                targetDisplayName: host.displayName,
                targetCreatedAt: requireHostCreatedAt(host.createdAt),
                targetPlatform: host.platform,
                targetSigningPublicKeyJwk: host.signingPublicKeyJwk,
                targetEncryptionPublicKeyJwk: host.encryptionPublicKeyJwk,
                expiresAt: session.grantExpiresAt,
              },
            },
            { activate: false },
          );
        }
      }
      setRegistry(loadAgentProfileRegistry());
    } catch (cause) {
      // error-policy:J4 authentication absence and refresh failures become
      // distinct signed-out or visible error states.
      setDirectory(null);
      setController(null);
      setSessions(new Map());
      if (isCloudAuthenticationRequired(cause)) {
        setCloudState("signed-out");
      } else {
        setCloudState("error");
        setError(messageFor(cause));
      }
    }
  }, []);

  useEffect(() => {
    void resumePendingSshRuntimeCleanups(SSH_RUNTIME_LIFECYCLE_DEPENDENCIES)
      .then((results) => {
        requireCompleteSshCleanup(results);
        return refresh();
      })
      .catch((cause) => setError(messageFor(cause)));
  }, [refresh]);

  const run = useCallback(async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      // error-policy:J4 settings operations surface a visible error state.
      setError(messageFor(cause));
    } finally {
      setRegistry(loadAgentProfileRegistry());
      setBusy(false);
    }
  }, []);

  const targets = useMemo(() => {
    const profiles = visibleProfilesForBuild(
      registry.profiles,
      registry.activeProfileId,
      localRuntimeUnavailable,
    ).map((profile) =>
      profileTarget(
        profile,
        registry.activeProfileId,
        sshRunning,
        directory,
        sessions,
      ),
    );
    const hosts = (directory?.hosts ?? []).map((host) =>
      hostTarget(host, sessions, controller),
    );
    return [...profiles, ...hosts];
  }, [
    controller,
    directory,
    localRuntimeUnavailable,
    registry,
    sessions,
    sshRunning,
  ]);

  const pairingView: DevicePairingView | null = useMemo(() => {
    if (!pairing) return null;
    const host = directory?.hosts.find((item) => item.id === pairing.hostId);
    return {
      hostId: pairing.hostId,
      hostLabel: host?.displayName ?? "remote device",
      sessionId: pairing.receipt.sessionId,
      code: pairing.receipt.code,
      expiresAt: pairing.receipt.expiresAt,
      qrPayload: `elizaos://remote/pair?session=${encodeURIComponent(pairing.receipt.sessionId)}&code=${pairing.receipt.code}`,
    };
  }, [directory, pairing]);

  const onSelect = (id: string) =>
    run(async () => {
      const profile = loadAgentProfileRegistry().profiles.find(
        (item) => item.id === id,
      );
      if (!canSelectProfileForBuild(profile, localRuntimeUnavailable)) {
        throw new Error(
          "Local runtime is unavailable on this build. Choose Cloud or a verified remote runtime.",
        );
      }
      const result = switchRuntimeNonDestructive(id);
      if (!result.ok)
        throw new Error(
          "That runtime could not be selected. Check its connection and try again.",
        );
    });

  const onAddDirectRuntime = (input: DirectRuntimeInput) =>
    run(async () => {
      const outcome = await executeRuntimeManagementCommand({
        op: "add_direct",
        label: input.label,
        apiBase: input.apiBase,
        accessToken: input.accessToken,
      });
      if (!outcome.ok) throw new Error(outcome.error);
      const runtimeId = String(outcome.data?.runtimeId ?? "");
      const result = switchRuntimeNonDestructive(runtimeId);
      if (!result.ok) {
        throw new Error(
          "The private runtime was saved but could not be selected. Check its address and retry.",
        );
      }
    });

  const onPair = (targetId: string) =>
    run(async () => {
      const outcome = await executeRuntimeManagementCommand({
        op: "pair",
        targetId,
      });
      if (!outcome.ok) throw new Error(outcome.error);
      const hostId = String(outcome.data?.hostId ?? "");
      setPairing({
        hostId,
        receipt: outcome.data?.receipt as RemotePairingReceipt,
      });
    });

  const onRevoke = (targetId: string) =>
    run(async () => {
      const outcome = await executeRuntimeManagementCommand({
        op: "revoke",
        targetId,
      });
      if (!outcome.ok) throw new Error(outcome.error);
      await refresh();
    });

  const onRemove = (id: string) =>
    run(async () => {
      const outcome = await executeRuntimeManagementCommand({
        op: "remove",
        runtimeId: id,
      });
      if (!outcome.ok) throw new Error(outcome.error);
    });

  const onRetry = (id: string) =>
    run(async () => {
      const outcome = await executeRuntimeManagementCommand({
        op: "retry",
        runtimeId: id,
      });
      if (!outcome.ok) throw new Error(outcome.error);
      await refresh();
    });

  const onInspectSsh = (input: { target: string; sshPort: number }) =>
    run(async () => {
      const outcome = await executeRuntimeManagementCommand({
        op: "inspect_ssh",
        runtimeId: pendingSshId.current,
        ...input,
      });
      if (!outcome.ok) throw new Error(outcome.error);
      setSshInspection(outcome.data?.inspection as SshHostInspection);
    });

  const onConnectSsh = (input: SshConnectInput) =>
    run(async () => {
      const runtimeId = pendingSshId.current;
      const outcome = await executeRuntimeManagementCommand({
        op: "connect_ssh",
        runtimeId,
        ...input,
      });
      if (!outcome.ok) throw new Error(outcome.error);
      pendingSshId.current = crypto.randomUUID();
      setSshInspection(null);
      await refresh();
    });

  const onEnrollDesktopTarget = () =>
    run(async () => {
      const outcome = await executeRuntimeManagementCommand({
        op: "enroll_host",
      });
      if (!outcome.ok) throw new Error(outcome.error);
      await refresh();
    });

  const onActivateDesktopTarget = (input: {
    sessionId: string;
    code: string;
  }) =>
    run(async () => {
      const outcome = await executeRuntimeManagementCommand({
        op: "approve_pairing",
        ...input,
      });
      if (!outcome.ok) throw new Error(outcome.error);
      setPairing(null);
      await refresh();
    });

  const onSetDesktopTargetRunning = (running: boolean) =>
    run(async () => {
      const outcome = await executeRuntimeManagementCommand({
        op: running ? "start_host" : "stop_host",
      });
      if (!outcome.ok) throw new Error(outcome.error);
      await refresh();
    });

  const onRevokeDesktopTarget = () =>
    run(async () => {
      const outcome = await executeRuntimeManagementCommand({
        op: "revoke_host",
      });
      if (!outcome.ok) throw new Error(outcome.error);
      const hostId = String(
        outcome.data?.hostId ?? desktopTarget?.hostId ?? "",
      );
      setPairing((current) => (current?.hostId === hostId ? null : current));
      await refresh();
    });

  return (
    <DevicesRuntimesSection
      className={className}
      targets={targets}
      pairing={pairingView}
      sshInspection={sshInspection}
      desktopTarget={desktopTarget}
      busy={busy}
      error={error}
      cloudState={cloudState}
      onRefresh={() =>
        run(async () => {
          requireCompleteSshCleanup(
            await resumePendingSshRuntimeCleanups(
              SSH_RUNTIME_LIFECYCLE_DEPENDENCIES,
            ),
          );
          await refresh();
        })
      }
      onSelect={onSelect}
      onRetry={onRetry}
      onPair={onPair}
      onRevoke={onRevoke}
      onRemove={onRemove}
      onInspectSsh={onInspectSsh}
      onConnectSsh={onConnectSsh}
      onAddDirectRuntime={onAddDirectRuntime}
      onEnrollDesktopTarget={onEnrollDesktopTarget}
      onActivateDesktopTarget={onActivateDesktopTarget}
      onSetDesktopTargetRunning={onSetDesktopTargetRunning}
      onRevokeDesktopTarget={onRevokeDesktopTarget}
    />
  );
}

export const devicesRuntimesInternals = {
  canSelectProfileForBuild,
  hostTarget,
  profileTarget,
  removeRuntimeWithAuthority,
  revokeDesktopHostCloudFirst,
  requireCompleteSshCleanup,
  visibleProfilesForBuild,
};

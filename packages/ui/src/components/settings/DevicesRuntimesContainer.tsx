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
import {
  createDefaultRemoteControlCloudClient,
  getDefaultRemoteControlCloudConnection,
} from "../../api/remote-control-cloud-default";
import { isElectrobunRuntime } from "../../bridge/electrobun-runtime";
import {
  clearRemoteControllerSessionState,
  getOrCreateRemoteControllerIdentity,
} from "../../platform/remote-controller";
import {
  activateRemoteTarget,
  enrollRemoteTarget,
  finalizeRemoteTargetHostRevoke,
  getRemoteTargetIdentity,
  getRemoteTargetStatus,
  startRemoteTarget,
  stopRemoteTarget,
} from "../../platform/remote-target";
import {
  deleteRuntimeCredentialRecord,
  storeRuntimeCredential,
} from "../../platform/runtime-credential-store";
import {
  getSshRuntimeStatus,
  inspectSshHost,
  type SshHostInspection,
  startSshRuntime,
  stopSshRuntime,
} from "../../platform/ssh-runtime";
import {
  type AgentProfile,
  addAgentProfile,
  loadAgentProfileRegistry,
  removeAgentProfile,
  switchRuntimeNonDestructive,
} from "../../state";
import {
  type DevicePairingView,
  type DeviceRuntimeTarget,
  DevicesRuntimesSection,
  type LinuxRemoteTargetView,
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

async function startSshWithCredentialCleanup(
  runtimeId: string,
  input: SshConnectInput,
  dependencies: {
    start: typeof startSshRuntime;
    deleteCredential: typeof deleteRuntimeCredentialRecord;
  } = {
    start: startSshRuntime,
    deleteCredential: deleteRuntimeCredentialRecord,
  },
): Promise<void> {
  try {
    await dependencies.start({
      runtimeId,
      target: input.target,
      sshPort: input.sshPort,
      remoteApiPort: input.remoteApiPort,
      expectedFingerprint: input.expectedFingerprint,
      identityFile: input.identityFile,
      credentialRef: runtimeId,
    });
  } catch (cause) {
    if (input.accessToken) {
      try {
        await dependencies.deleteCredential(runtimeId);
      } catch (cleanupCause) {
        // error-policy:J2 preserve both the primary tunnel failure and the
        // security-relevant credential cleanup failure.
        throw new AggregateError(
          [cause, cleanupCause],
          "SSH connection failed and its stored credential could not be removed.",
          { cause },
        );
      }
    }
    // error-policy:J2 the primary start failure crosses unchanged after
    // successful cleanup.
    throw cause;
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
  };
}

interface RuntimeRemovalDependencies {
  revokeSession: (sessionId: string) => Promise<void>;
  clearSession: (input: {
    ownerId: string;
    controllerDeviceId: string;
    sessionId: string;
  }) => Promise<unknown>;
  stopSsh: (runtimeId: string) => Promise<unknown>;
  deleteCredential: (runtimeId: string) => Promise<unknown>;
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
    await dependencies.stopSsh(profile.id);
    await dependencies.deleteCredential(profile.credentialRef ?? profile.id);
  }
  dependencies.removeProfile(profile.id);
}

async function revokeLinuxHostCloudFirst(
  hostId: string,
  dependencies: {
    revokeHost: (hostId: string) => Promise<void>;
    finalizeLocal: (hostId: string) => Promise<boolean>;
  },
): Promise<void> {
  await dependencies.revokeHost(hostId);
  if (!(await dependencies.finalizeLocal(hostId))) {
    throw new Error(
      "Cloud revoked the Linux host, but local credential cleanup needs to be retried.",
    );
  }
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
  const [linuxTarget, setLinuxTarget] = useState<LinuxRemoteTargetView | null>(
    null,
  );
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
    if (
      isElectrobunRuntime() &&
      navigator.platform.toLowerCase().includes("linux")
    ) {
      const [status, identity] = await Promise.all([
        getRemoteTargetStatus(),
        getRemoteTargetIdentity(),
      ]);
      setLinuxTarget({
        ...status,
        hostId: identity.identity?.runtimeId ?? null,
      });
    } else {
      setLinuxTarget(null);
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
    void refresh();
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
    const profiles = registry.profiles.map((profile) =>
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
  }, [controller, directory, registry, sessions, sshRunning]);

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
      const result = switchRuntimeNonDestructive(id);
      if (!result.ok)
        throw new Error(
          "That runtime could not be selected. Check its connection and try again.",
        );
    });

  const onPair = (targetId: string) =>
    run(async () => {
      const hostId = targetId.replace(/^host:/, "");
      const host = directory?.hosts.find((item) => item.id === hostId);
      if (!host || !directory)
        throw new Error("Refresh devices before pairing.");
      const currentController =
        controller ??
        (await getOrCreateRemoteControllerIdentity({
          ownerId: directory.ownerId,
        }));
      const receipt =
        await createDefaultRemoteControlCloudClient().createPairing({
          hostId,
          controller: currentController,
        });
      setPairing({ hostId, receipt });
    });

  const onRevoke = (targetId: string) =>
    run(async () => {
      const hostId = targetId.replace(/^host:/, "");
      const profile = registry.profiles.find((item) => item.id === targetId);
      const sessionId =
        profile?.remoteRelay?.sessionId ??
        (sessions.get(hostId) ?? []).find(
          (item) =>
            item.status === "active" &&
            item.controllerDeviceId === controller?.deviceId &&
            item.controllerKeyId === controller.keyId,
        )?.id;
      if (!sessionId) throw new Error("No active pairing was found.");
      await createDefaultRemoteControlCloudClient().revokeSession(sessionId);
      if (profile?.remoteRelay) {
        await clearRemoteControllerSessionState({
          ownerId: profile.remoteRelay.ownerId,
          controllerDeviceId: profile.remoteRelay.controllerDeviceId,
          sessionId,
        });
        removeAgentProfile(profile.id);
      }
      await refresh();
    });

  const onRemove = (id: string) =>
    run(async () => {
      const profile = registry.profiles.find((item) => item.id === id);
      if (!profile) return;
      const cloud = createDefaultRemoteControlCloudClient();
      await removeRuntimeWithAuthority(profile, {
        revokeSession: (sessionId) => cloud.revokeSession(sessionId),
        clearSession: clearRemoteControllerSessionState,
        stopSsh: stopSshRuntime,
        deleteCredential: deleteRuntimeCredentialRecord,
        removeProfile: removeAgentProfile,
      });
    });

  const onRetry = (id: string) =>
    run(async () => {
      const profile = registry.profiles.find((item) => item.id === id);
      if (profile?.connectionMode === "ssh" && profile.ssh) {
        await startSshRuntime({
          runtimeId: profile.id,
          target: profile.ssh.target,
          sshPort: profile.ssh.sshPort,
          remoteApiPort: profile.ssh.remoteApiPort,
          expectedFingerprint: profile.ssh.hostFingerprint,
          identityFile: profile.ssh.identityFile,
          credentialRef: profile.credentialRef,
        });
      }
      await refresh();
    });

  const onInspectSsh = (input: { target: string; sshPort: number }) =>
    run(async () => {
      const inspection = await inspectSshHost({
        runtimeId: pendingSshId.current,
        ...input,
      });
      setSshInspection(inspection);
    });

  const onConnectSsh = (input: SshConnectInput) =>
    run(async () => {
      const runtimeId = pendingSshId.current;
      if (input.accessToken)
        await storeRuntimeCredential(runtimeId, input.accessToken);
      await startSshWithCredentialCleanup(runtimeId, input);
      addAgentProfile(
        {
          kind: "remote",
          label: input.label,
          apiBase: `eliza-ssh://runtime/${runtimeId}`,
          credentialRef: runtimeId,
          connectionMode: "ssh",
          ssh: {
            target: input.target,
            sshPort: input.sshPort,
            remoteApiPort: input.remoteApiPort,
            hostFingerprint: input.expectedFingerprint,
            identityFile: input.identityFile,
          },
        },
        { activate: false, id: runtimeId },
      );
      pendingSshId.current = crypto.randomUUID();
      setSshInspection(null);
      await refresh();
    });

  const onEnrollLinuxTarget = () =>
    run(async () => {
      const cloud = createDefaultRemoteControlCloudClient();
      const currentDirectory = directory ?? (await cloud.listHosts());
      const connection = getDefaultRemoteControlCloudConnection();
      await enrollRemoteTarget({
        apiBaseUrl: connection.baseUrl,
        ownerId: currentDirectory.ownerId,
        ownerAccessToken: connection.authToken,
        displayName: "My Linux computer",
      });
      await refresh();
    });

  const onActivateLinuxTarget = (input: { sessionId: string; code: string }) =>
    run(async () => {
      await activateRemoteTarget(input);
      await startRemoteTarget();
      setPairing(null);
      await refresh();
    });

  const onSetLinuxTargetRunning = (running: boolean) =>
    run(async () => {
      if (running) await startRemoteTarget();
      else await stopRemoteTarget();
      await refresh();
    });

  const onRevokeLinuxTarget = () =>
    run(async () => {
      const hostId = linuxTarget?.hostId;
      if (!hostId) throw new Error("This Linux host identity is unavailable.");
      const cloud = createDefaultRemoteControlCloudClient();
      await revokeLinuxHostCloudFirst(hostId, {
        revokeHost: (id) => cloud.revokeHost(id),
        finalizeLocal: finalizeRemoteTargetHostRevoke,
      });
      setPairing((current) => (current?.hostId === hostId ? null : current));
      await refresh();
    });

  return (
    <DevicesRuntimesSection
      className={className}
      targets={targets}
      pairing={pairingView}
      sshInspection={sshInspection}
      linuxTarget={linuxTarget}
      busy={busy}
      error={error}
      cloudState={cloudState}
      onRefresh={() => run(refresh)}
      onSelect={onSelect}
      onRetry={onRetry}
      onPair={onPair}
      onRevoke={onRevoke}
      onRemove={onRemove}
      onInspectSsh={onInspectSsh}
      onConnectSsh={onConnectSsh}
      onEnrollLinuxTarget={onEnrollLinuxTarget}
      onActivateLinuxTarget={onActivateLinuxTarget}
      onSetLinuxTargetRunning={onSetLinuxTargetRunning}
      onRevokeLinuxTarget={onRevokeLinuxTarget}
    />
  );
}

export const devicesRuntimesInternals = {
  hostTarget,
  profileTarget,
  removeRuntimeWithAuthority,
  revokeLinuxHostCloudFirst,
  startSshWithCredentialCleanup,
};

/** Live state and secure enrollment flows for Devices & Runtimes settings. */

import type { RemoteControllerPublicIdentity } from "@elizaos/shared/contracts/remote-control";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { client } from "../../api";
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
import { subscribeRemoteTargetPairingIntents } from "../../platform/remote-target-pairing-intent";
import {
  deleteRuntimeCredentialRecord,
  storeRuntimeCredential,
} from "../../platform/runtime-credential-store";
import {
  getSshRuntimeStatus,
  inspectSshHost,
  type SshHostInspection,
  type SshRuntimeStatus,
  startSshRuntime,
  stopSshRuntime,
} from "../../platform/ssh-runtime";
import {
  type AgentProfile,
  type AgentProfileRegistry,
  addAgentProfile,
  clearPersistedActiveServer,
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

function restoredRelayProfile(
  host: RemoteHostSummary,
  session: RemoteSessionSummary,
  controller: RemoteControllerPublicIdentity,
): Omit<AgentProfile, "id" | "createdAt"> {
  if (session.targetKeyId !== host.runtimeKeyId) {
    throw new Error(
      "Cloud session target key does not match the enrolled remote host.",
    );
  }
  return {
    kind: "remote",
    label: host.displayName,
    apiBase: `eliza-remote://session/${session.id}`,
    connectionMode: "relay",
    remoteRelay: {
      ownerId: session.ownerId,
      controllerDeviceId: controller.deviceId,
      controllerKeyId: controller.keyId,
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
  };
}

function profileTarget(
  profile: AgentProfile,
  activeId: string | null,
  sshStatuses: ReadonlyMap<string, SshRuntimeStatus>,
  directory: RemoteHostDirectory | null,
  sessions: ReadonlyMap<string, RemoteSessionSummary[]>,
): DeviceRuntimeTarget {
  const selected = profile.id === activeId;
  if (profile.connectionMode === "ssh") {
    const sshStatus = sshStatuses.get(profile.id);
    const running = sshStatus?.running ?? false;
    const blocked = sshStatus?.reconnectState === "blocked";
    return {
      id: profile.id,
      label: profile.label,
      detail: `VPS over SSH · ${profile.ssh?.target ?? "Unknown target"}`,
      kind: "ssh",
      status: blocked ? "error" : running ? "connected" : "offline",
      selected,
      activity: blocked
        ? "Reconnect blocked"
        : running
          ? "Tunnel active"
          : "Tunnel stopped",
      error: blocked
        ? (sshStatus.lastError ??
          "The SSH tunnel could not be restored. Inspect the host and reconnect manually.")
        : undefined,
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

interface RelayRevocationAuthority {
  sessionId: string;
  ownerId: string;
  controllerDeviceId: string;
  profile: AgentProfile | null;
}

function relayAuthorityFromProfile(
  profile: AgentProfile,
): RelayRevocationAuthority | null {
  const relay = profile.remoteRelay;
  if (profile.connectionMode !== "relay" || !relay) return null;
  return {
    sessionId: relay.sessionId,
    ownerId: relay.ownerId,
    controllerDeviceId: relay.controllerDeviceId,
    profile,
  };
}

function resolveRelayRevocationAuthority(
  targetId: string,
  profiles: readonly AgentProfile[],
  sessions: ReadonlyMap<string, RemoteSessionSummary[]>,
  controller: RemoteControllerPublicIdentity | null,
): RelayRevocationAuthority | null {
  const directProfile = profiles.find((profile) => profile.id === targetId);
  if (directProfile) return relayAuthorityFromProfile(directProfile);
  if (!targetId.startsWith("host:") || !controller) return null;

  const hostId = targetId.slice("host:".length);
  const session = (sessions.get(hostId) ?? []).find(
    (candidate) =>
      candidate.status === "active" &&
      candidate.controllerDeviceId === controller.deviceId &&
      candidate.controllerKeyId === controller.keyId,
  );
  if (!session) return null;
  const profile =
    profiles.find(
      (candidate) => candidate.remoteRelay?.sessionId === session.id,
    ) ?? null;
  return {
    sessionId: session.id,
    ownerId: session.ownerId,
    controllerDeviceId: session.controllerDeviceId,
    profile,
  };
}

function buildRuntimeTargets(
  registry: AgentProfileRegistry,
  sshStatuses: ReadonlyMap<string, SshRuntimeStatus>,
  directory: RemoteHostDirectory | null,
  sessions: ReadonlyMap<string, RemoteSessionSummary[]>,
  controller: RemoteControllerPublicIdentity | null,
): DeviceRuntimeTarget[] {
  const profiles = registry.profiles.map((profile) =>
    profileTarget(
      profile,
      registry.activeProfileId,
      sshStatuses,
      directory,
      sessions,
    ),
  );
  const representedHostIds = new Set(
    registry.profiles.flatMap((profile) =>
      profile.remoteRelay ? [profile.remoteRelay.targetRuntimeId] : [],
    ),
  );
  const hosts = (directory?.hosts ?? [])
    .filter((host) => !representedHostIds.has(host.id))
    .map((host) => hostTarget(host, sessions, controller));
  return [...profiles, ...hosts];
}

function removeProfileWithoutStaleSelection(
  profileId: string,
  dependencies: {
    loadRegistry: () => AgentProfileRegistry;
    switchRuntime: (profileId: string) => { ok: boolean };
    clearRuntimeSelection: () => void;
    removeProfile: (profileId: string) => void;
  },
): void {
  const registry = dependencies.loadRegistry();
  if (registry.activeProfileId === profileId) {
    const fallback =
      registry.profiles.find(
        (profile) => profile.id !== profileId && profile.kind === "local",
      ) ?? registry.profiles.find((profile) => profile.id !== profileId);
    if (!fallback) {
      dependencies.clearRuntimeSelection();
    } else if (!dependencies.switchRuntime(fallback.id).ok) {
      throw new Error(
        "The revoked runtime could not be removed because the fallback runtime was not saved. Try again.",
      );
    }
  }
  dependencies.removeProfile(profileId);
}

async function revokeRelayAuthorityWithCleanup(
  authority: RelayRevocationAuthority,
  dependencies: {
    revokeSession: (sessionId: string) => Promise<void>;
    clearSession: (input: {
      ownerId: string;
      controllerDeviceId: string;
      sessionId: string;
    }) => Promise<unknown>;
    removeProfile: (profileId: string) => void;
  },
): Promise<void> {
  await dependencies.revokeSession(authority.sessionId);
  await dependencies.clearSession({
    ownerId: authority.ownerId,
    controllerDeviceId: authority.controllerDeviceId,
    sessionId: authority.sessionId,
  });
  if (authority.profile) dependencies.removeProfile(authority.profile.id);
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
  const relayAuthority = relayAuthorityFromProfile(profile);
  if (relayAuthority) {
    await revokeRelayAuthorityWithCleanup(relayAuthority, dependencies);
    return;
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
  const [sshStatuses, setSshStatuses] = useState<Map<string, SshRuntimeStatus>>(
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
          [profile.id, await getSshRuntimeStatus(profile.id)] as const,
      ),
    );
    setSshStatuses(new Map(statuses));
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
          addAgentProfile(restoredRelayProfile(host, session, nextController), {
            activate: false,
          });
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
    return buildRuntimeTargets(
      registry,
      sshStatuses,
      directory,
      sessions,
      controller,
    );
  }, [controller, directory, registry, sessions, sshStatuses]);

  const removeProfileAfterCleanup = useCallback((profileId: string) => {
    removeProfileWithoutStaleSelection(profileId, {
      loadRegistry: loadAgentProfileRegistry,
      switchRuntime: switchRuntimeNonDestructive,
      clearRuntimeSelection: () => {
        clearPersistedActiveServer();
        client.setToken(null);
        client.setBaseUrl(null);
      },
      removeProfile: removeAgentProfile,
    });
  }, []);

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
      const authority = resolveRelayRevocationAuthority(
        targetId,
        registry.profiles,
        sessions,
        controller,
      );
      if (!authority) throw new Error("No active pairing was found.");
      const cloud = createDefaultRemoteControlCloudClient();
      await revokeRelayAuthorityWithCleanup(authority, {
        revokeSession: (sessionId) => cloud.revokeSession(sessionId),
        clearSession: clearRemoteControllerSessionState,
        removeProfile: removeProfileAfterCleanup,
      });
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
        removeProfile: removeProfileAfterCleanup,
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
          credentialRef: profile.credentialRef ?? profile.id,
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

  const onActivateLinuxTarget = useCallback(
    (input: { sessionId?: string; code: string }) =>
      run(async () => {
        await activateRemoteTarget(input);
        await startRemoteTarget();
        setPairing(null);
        await refresh();
      }),
    [refresh, run],
  );

  useEffect(
    () =>
      subscribeRemoteTargetPairingIntents((intent) =>
        onActivateLinuxTarget({
          sessionId: intent.sessionId,
          code: intent.code,
        }),
      ),
    [onActivateLinuxTarget],
  );

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
  buildRuntimeTargets,
  hostTarget,
  profileTarget,
  removeProfileWithoutStaleSelection,
  removeRuntimeWithAuthority,
  resolveRelayRevocationAuthority,
  revokeRelayAuthorityWithCleanup,
  revokeLinuxHostCloudFirst,
  startSshWithCredentialCleanup,
  restoredRelayProfile,
};

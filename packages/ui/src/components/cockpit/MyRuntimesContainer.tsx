/**
 * Connects the runtime switcher to the persisted agent-profile registry and
 * enforces trust gates before adding or activating remote runtimes.
 */
import { useCallback, useEffect, useState } from "react";

import { client } from "../../api";
import { isStoreBuild } from "../../build-variant";
import { isAndroidCloudBuild } from "../../platform/android-runtime";
import { getOrCreateControllerPublicIdentity } from "../../platform/remote-controller-identity";
import {
  REMOTE_PAIRING_DEEP_LINK_EVENT,
  takePendingRemotePairingCode,
} from "../../platform/remote-pairing-deep-link";
import {
  deleteRuntimeCredential,
  loadRuntimeCredential,
  storeRuntimeCredential,
} from "../../platform/runtime-credential-store";
import { startSshRuntime, stopSshRuntime } from "../../platform/ssh-runtime";
import {
  addAgentProfile,
  loadAgentProfileRegistry,
  removeAgentProfile,
  switchRuntimeNonDestructive,
  updateAgentProfile,
} from "../../state";
import { isTrustedRestoreApiBaseUrl } from "../../state/runtime-url-trust";
import { shellLocalStorage } from "../../surface-realm-channel";
import { SettingsStack } from "../settings/settings-layout";
import type { LinkedElizaDevice } from "./MyRuntimesSection";
import { MyRuntimesSection } from "./MyRuntimesSection";

const CLOUD_HOST_ID_KEY = "eliza.remote-host.id.v1";

function activeSshProfile(
  registry: ReturnType<typeof loadAgentProfileRegistry>,
) {
  const active = registry.profiles.find(
    (profile) => profile.id === registry.activeProfileId,
  );
  return active?.sshGateway ? active : null;
}

export function pairingTargetHostId(
  registry: ReturnType<typeof loadAgentProfileRegistry>,
  localHostId: string | null,
): string | null {
  return activeSshProfile(registry)?.sshGateway?.hostId ?? localHostId;
}

function localHostPlatform(): "macos" | "linux" | "windows" {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("win")) return "windows";
  if (platform.includes("linux")) return "linux";
  return "macos";
}

export interface MyRuntimesContainerProps {
  className?: string;
}

function switchFailureMessage(reason: string | undefined): string {
  if (reason === "untrusted-remote") {
    return "That remote isn't trusted — use a tailscale (100.x / *.ts.net) or local address.";
  }
  if (reason === "untrusted-cloud") {
    return "That Cloud agent address isn't valid. Open the agent again from Eliza Cloud.";
  }
  if (reason === "persistence-failed") {
    return "The runtime couldn't be saved. Check browser storage and try again.";
  }
  return "That runtime is no longer available.";
}

/**
 * Live container for {@link MyRuntimesSection}: reads the agent-profile registry,
 * switches the active runtime in place via {@link switchRuntimeNonDestructive}
 * (with the public-URL trust gate), and adds a VPS/remote runtime via
 * `addAgentProfile`. Mount this in Settings (or the cockpit) to manage
 * local / cloud-dedicated / VPS-remote runtimes from one place.
 */
export function MyRuntimesContainer({ className }: MyRuntimesContainerProps) {
  const [registry, setRegistry] = useState(() => loadAgentProfileRegistry());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<LinkedElizaDevice[]>([]);

  // On a store / android-cloud build the on-device local runtime isn't a real
  // option (no local code execution) — hide it and refuse switching to it, so
  // phone users only ever drive a cloud/remote runtime.
  const hideLocal = isAndroidCloudBuild() || isStoreBuild();
  const visibleProfiles = hideLocal
    ? // Hide local runtimes — but keep the one that's CURRENTLY active visible,
      // otherwise the Active badge vanishes on a store build whose persisted
      // active profile is local (onSwitch still refuses switching TO a local).
      registry.profiles.filter(
        (p) => p.kind !== "local" || p.id === registry.activeProfileId,
      )
    : registry.profiles;

  const refresh = useCallback(() => {
    setRegistry(loadAgentProfileRegistry());
  }, []);

  const onSwitch = useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        if (hideLocal) {
          const target = loadAgentProfileRegistry().profiles.find(
            (p) => p.id === id,
          );
          if (target?.kind === "local") {
            setError(
              "Local runtime isn't available on this build — use a cloud or remote runtime.",
            );
            return;
          }
        }
        let target = loadAgentProfileRegistry().profiles.find(
          (profile) => profile.id === id,
        );
        if (target?.sshGateway) {
          const tunnel = await startSshRuntime(target.sshGateway);
          if (target.apiBase !== tunnel.apiBase) {
            updateAgentProfile(target.id, { apiBase: tunnel.apiBase });
            target = { ...target, apiBase: tunnel.apiBase };
          }
        }
        const credential = target?.credentialRef
          ? await loadRuntimeCredential(target.credentialRef)
          : null;
        const res = credential
          ? switchRuntimeNonDestructive(id, credential)
          : switchRuntimeNonDestructive(id);
        if (!res.ok) {
          setError(switchFailureMessage(res.reason));
        }
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "That runtime could not be started.",
        );
      } finally {
        refresh();
        setBusy(false);
      }
    },
    [refresh, hideLocal],
  );

  const onAddRemote = useCallback(
    async (entry: { label: string; apiBase: string; accessToken?: string }) => {
      setBusy(true);
      setError(null);
      try {
        // Trust-gate at ADD time: a public URL would be added + auto-activated
        // by addAgentProfile but then rejected by the switch gate, leaving the
        // Active badge lying and the client un-repointed. Reject it up front.
        if (!isTrustedRestoreApiBaseUrl(entry.apiBase)) {
          setError(
            "That remote isn't trusted — use a tailscale (100.x / *.ts.net) or local address.",
          );
          return;
        }
        const profile = addAgentProfile(
          {
            kind: "remote",
            label: entry.label,
            apiBase: entry.apiBase,
          },
          { activate: false },
        );
        if (entry.accessToken) {
          await storeRuntimeCredential(profile.id, entry.accessToken);
          updateAgentProfile(profile.id, { credentialRef: profile.id });
        }
        const result = entry.accessToken
          ? switchRuntimeNonDestructive(profile.id, entry.accessToken)
          : switchRuntimeNonDestructive(profile.id);
        if (!result.ok) setError(switchFailureMessage(result.reason));
      } finally {
        refresh();
        setBusy(false);
      }
    },
    [refresh],
  );

  const refreshLinkedDevices = useCallback(async (hostId: string) => {
    const sessions = await client.listCloudRemoteSessions({ hostId });
    setDevices(
      sessions
        .filter(
          (
            session,
          ): session is typeof session & {
            controllerDeviceId: string;
          } => Boolean(session.controllerDeviceId),
        )
        .map((session) => ({
          id: session.id,
          name: session.controllerDisplayName ?? "Linked device",
          platform:
            session.controllerPlatform === "ios"
              ? "iphone"
              : session.controllerPlatform === "macos"
                ? "mac"
                : session.controllerPlatform === "windows"
                  ? "windows"
                  : session.controllerPlatform === "linux"
                    ? "linux"
                    : "other",
          role: "controller" as const,
          status: session.status === "active" ? "online" : "pending",
          lastSeenLabel: session.lastSeenAt
            ? `Last active ${new Date(session.lastSeenAt).toLocaleString()}`
            : undefined,
        })),
    );
  }, []);

  useEffect(() => {
    const hostId = pairingTargetHostId(
      registry,
      globalThis.localStorage?.getItem(CLOUD_HOST_ID_KEY)?.trim() ?? null,
    );
    if (hostId) void refreshLinkedDevices(hostId).catch(() => {});
    else setDevices([]);
  }, [refreshLinkedDevices, registry]);

  const onCreatePairing = useCallback(async () => {
    const currentRegistry = loadAgentProfileRegistry();
    const sshProfile = activeSshProfile(currentRegistry);
    let hostId =
      sshProfile?.sshGateway?.hostId ??
      globalThis.localStorage?.getItem(CLOUD_HOST_ID_KEY)?.trim();
    const hosts = await client.listCloudRemoteHosts();
    if (!hostId || !hosts.some((host) => host.id === hostId)) {
      const platform = sshProfile ? "linux" : localHostPlatform();
      const hostIdentity = await getOrCreateControllerPublicIdentity();
      const enrolled = await client.enrollCloudRemoteHost({
        displayName: sshProfile
          ? sshProfile.label
          : platform === "macos"
            ? "My Mac"
            : platform === "windows"
              ? "My Windows PC"
              : "My Linux computer",
        platform,
        hostIdentity: {
          keyId: hostIdentity.keyId,
          signingPublicKeyJwk: hostIdentity.signingPublicKeyJwk,
          encryptionPublicKeyJwk: hostIdentity.encryptionPublicKeyJwk,
        },
      });
      hostId = enrolled.host.id;
      await storeRuntimeCredential(
        `managed-host:${hostId}`,
        JSON.stringify(enrolled.enrollment),
      );
      if (sshProfile?.sshGateway) {
        updateAgentProfile(sshProfile.id, {
          sshGateway: { ...sshProfile.sshGateway, hostId },
        });
      } else {
        shellLocalStorage.setItem(CLOUD_HOST_ID_KEY, hostId);
      }
    }
    const pairing = await client.createCloudRemotePairing({ hostId });
    const payload = new URL("elizaos://pair");
    payload.searchParams.set("session", pairing.sessionId);
    payload.searchParams.set("code", pairing.code);
    void refreshLinkedDevices(hostId).catch(() => {});
    return {
      code: pairing.code,
      qrPayload: payload.toString(),
      expiresAt: pairing.expiresAt,
      targetLabel: sshProfile?.label ?? "this computer",
    };
  }, [refreshLinkedDevices]);

  const onRedeemPairing = useCallback(
    async (code: string) => {
      const identity = await getOrCreateControllerPublicIdentity();
      const result = await client.consumeCloudRemotePairing(code, identity);
      if (result.hostId && result.targetIdentity) {
        addAgentProfile(
          {
            kind: "remote",
            label: result.targetDisplayName ?? "Linked Mac",
            apiBase: `eliza-remote://session/${encodeURIComponent(result.sessionId)}`,
            remoteRelay: {
              ownerId: result.ownerId,
              sessionId: result.sessionId,
              targetRuntimeId: result.hostId,
              targetKeyId: result.targetIdentity.keyId,
              targetSigningPublicKeyJwk:
                result.targetIdentity.signingPublicKeyJwk,
              targetEncryptionPublicKeyJwk:
                result.targetIdentity.encryptionPublicKeyJwk,
            },
          },
          { activate: false },
        );
      } else if (result.ingressUrl) {
        addAgentProfile(
          {
            kind: "remote",
            label: "Linked runtime",
            apiBase: result.ingressUrl,
          },
          { activate: false },
        );
      }
      refresh();
    },
    [refresh],
  );

  useEffect(() => {
    let redeeming = false;
    const redeemPending = () => {
      const code = takePendingRemotePairingCode();
      if (!code || redeeming) return;
      redeeming = true;
      setBusy(true);
      setError(null);
      void onRedeemPairing(code)
        .catch((cause: unknown) => {
          setError(
            cause instanceof Error
              ? cause.message
              : "The pairing code could not be redeemed.",
          );
        })
        .finally(() => {
          redeeming = false;
          setBusy(false);
        });
    };
    globalThis.addEventListener?.(
      REMOTE_PAIRING_DEEP_LINK_EVENT,
      redeemPending,
    );
    redeemPending();
    return () =>
      globalThis.removeEventListener?.(
        REMOTE_PAIRING_DEEP_LINK_EVENT,
        redeemPending,
      );
  }, [onRedeemPairing]);

  const onRevokeDevice = useCallback(
    async (sessionId: string) => {
      await client.revokeCloudRemoteSession(sessionId);
      const hostId = globalThis.localStorage
        ?.getItem(CLOUD_HOST_ID_KEY)
        ?.trim();
      if (hostId) await refreshLinkedDevices(hostId);
    },
    [refreshLinkedDevices],
  );

  const onRemoveRuntime = useCallback(
    async (profileId: string) => {
      const profile = loadAgentProfileRegistry().profiles.find(
        (candidate) => candidate.id === profileId,
      );
      if (!profile || profile.id === registry.activeProfileId) {
        throw new Error("Switch to another runtime before removing this one.");
      }
      setBusy(true);
      setError(null);
      try {
        if (profile.sshGateway) {
          await client.revokeCloudRemoteHost(profile.sshGateway.hostId);
          await stopSshRuntime(profile.sshGateway.runtimeId);
          await deleteRuntimeCredential(
            `managed-host:${profile.sshGateway.hostId}`,
          );
        } else if (profile.remoteRelay) {
          await client.revokeCloudRemoteSession(profile.remoteRelay.sessionId);
        }
        if (profile.credentialRef) {
          await deleteRuntimeCredential(profile.credentialRef);
        }
        removeAgentProfile(profile.id);
        refresh();
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "The runtime could not be removed.",
        );
        throw cause;
      } finally {
        setBusy(false);
      }
    },
    [refresh, registry.activeProfileId],
  );

  const onAddSshHost = useCallback(
    async (entry: {
      label: string;
      target: string;
      sshPort: number;
      remoteApiPort: number;
      identityFile?: string;
      accessToken?: string;
    }) => {
      setBusy(true);
      setError(null);
      const runtimeId = crypto.randomUUID();
      let tunnelStarted = false;
      try {
        const sshGateway = {
          runtimeId,
          target: entry.target,
          sshPort: entry.sshPort,
          remoteApiPort: entry.remoteApiPort,
          ...(entry.identityFile ? { identityFile: entry.identityFile } : {}),
        };
        const tunnel = await startSshRuntime(sshGateway);
        tunnelStarted = true;
        const hostIdentity = await getOrCreateControllerPublicIdentity();
        const enrolled = await client.enrollCloudRemoteHost({
          displayName: entry.label,
          platform: "linux",
          hostIdentity: {
            keyId: hostIdentity.keyId,
            signingPublicKeyJwk: hostIdentity.signingPublicKeyJwk,
            encryptionPublicKeyJwk: hostIdentity.encryptionPublicKeyJwk,
          },
        });
        await storeRuntimeCredential(
          `managed-host:${enrolled.host.id}`,
          JSON.stringify(enrolled.enrollment),
        );
        if (entry.accessToken) {
          await storeRuntimeCredential(runtimeId, entry.accessToken);
        }
        const profile = addAgentProfile(
          {
            kind: "remote",
            label: entry.label,
            apiBase: tunnel.apiBase,
            ...(entry.accessToken ? { credentialRef: runtimeId } : {}),
            sshGateway: { ...sshGateway, hostId: enrolled.host.id },
          },
          { activate: false },
        );
        const switched = entry.accessToken
          ? switchRuntimeNonDestructive(profile.id, entry.accessToken)
          : switchRuntimeNonDestructive(profile.id);
        if (!switched.ok)
          throw new Error(switchFailureMessage(switched.reason));
        await refreshLinkedDevices(enrolled.host.id).catch(() => {});
        refresh();
      } catch (cause) {
        if (tunnelStarted) await stopSshRuntime(runtimeId).catch(() => {});
        throw cause;
      } finally {
        setBusy(false);
      }
    },
    [refresh, refreshLinkedDevices],
  );

  return (
    <SettingsStack className={className}>
      {error ? (
        <div
          role="alert"
          data-testid="my-runtimes-error"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </div>
      ) : null}
      <MyRuntimesSection
        runtimes={visibleProfiles}
        activeId={registry.activeProfileId}
        devices={devices}
        onSwitch={onSwitch}
        onRemoveRuntime={onRemoveRuntime}
        onCreatePairing={hideLocal ? undefined : onCreatePairing}
        onRedeemPairing={onRedeemPairing}
        onRevokeDevice={onRevokeDevice}
        onAddSshHost={hideLocal ? undefined : onAddSshHost}
        onAddRemote={onAddRemote}
        busy={busy}
      />
    </SettingsStack>
  );
}

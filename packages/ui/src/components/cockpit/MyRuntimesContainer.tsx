/**
 * Connects the runtime switcher to the persisted agent-profile registry and
 * enforces trust gates before adding or activating remote runtimes.
 */
import { useCallback, useState } from "react";

import { client } from "../../api";
import { isStoreBuild } from "../../build-variant";
import { isAndroidCloudBuild } from "../../platform/android-runtime";
import {
  addAgentProfile,
  loadAgentProfileRegistry,
  switchRuntimeNonDestructive,
} from "../../state";
import { isTrustedRestoreApiBaseUrl } from "../../state/runtime-url-trust";
import { SettingsStack } from "../settings/settings-layout";
import { MyRuntimesSection } from "./MyRuntimesSection";

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
    (id: string) => {
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
        const res = switchRuntimeNonDestructive(id);
        if (!res.ok) {
          setError(switchFailureMessage(res.reason));
        }
      } finally {
        refresh();
        setBusy(false);
      }
    },
    [refresh, hideLocal],
  );

  const onAddRemote = useCallback(
    (entry: { label: string; apiBase: string; accessToken?: string }) => {
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
            accessToken: entry.accessToken,
          },
          { activate: false },
        );
        const result = switchRuntimeNonDestructive(profile.id);
        if (!result.ok) setError(switchFailureMessage(result.reason));
      } finally {
        refresh();
        setBusy(false);
      }
    },
    [refresh],
  );

  const onCreatePairing = useCallback(async () => {
    const pairing = await client.getPairCode();
    const apiBase = client.getBaseUrl().trim();
    if (!apiBase) {
      throw new Error("Start the local agent before linking another device.");
    }
    const payload = new URL("elizaos://pair");
    payload.searchParams.set("base", apiBase);
    payload.searchParams.set("code", pairing.code);
    return {
      code: pairing.code,
      qrPayload: payload.toString(),
      expiresAt: new Date(pairing.expiresAt).toISOString(),
    };
  }, []);

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
        onSwitch={onSwitch}
        onCreatePairing={onCreatePairing}
        onAddRemote={onAddRemote}
        busy={busy}
      />
    </SettingsStack>
  );
}

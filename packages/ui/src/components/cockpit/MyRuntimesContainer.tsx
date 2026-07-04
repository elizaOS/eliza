/**
 * Connects the runtime switcher to the persisted agent-profile registry and
 * enforces trust gates before adding or activating remote runtimes.
 */
import { useCallback, useState } from "react";

import { isStoreBuild } from "../../build-variant";
import { cn } from "../../lib/utils";
import { isAndroidCloudBuild } from "../../platform/android-runtime";
import {
  addAgentProfile,
  loadAgentProfileRegistry,
  switchRuntimeNonDestructive,
} from "../../state";
import { isTrustedRestoreApiBaseUrl } from "../../state/startup-phase-restore";
import { MyRuntimesSection } from "./MyRuntimesSection";

export interface MyRuntimesContainerProps {
  className?: string;
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
          setError(
            res.reason === "untrusted-remote"
              ? "That remote isn't trusted — use a tailscale (100.x / *.ts.net) or local address."
              : "That runtime is no longer available.",
          );
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
        const profile = addAgentProfile({
          kind: "remote",
          label: entry.label,
          apiBase: entry.apiBase,
          accessToken: entry.accessToken,
        });
        // addAgentProfile activates it in the registry but does NOT repoint the
        // live client; switch to it so the base/token swap + persisted-active all
        // run and the Active badge matches the runtime actually serving.
        switchRuntimeNonDestructive(profile.id);
      } finally {
        refresh();
        setBusy(false);
      }
    },
    [refresh],
  );

  return (
    <div className={cn("flex flex-col gap-2", className)}>
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
        onAddRemote={onAddRemote}
        busy={busy}
      />
    </div>
  );
}

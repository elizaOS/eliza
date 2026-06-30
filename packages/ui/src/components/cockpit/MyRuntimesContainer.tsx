import { useCallback, useState } from "react";

import { cn } from "../../lib/utils";
import {
  addAgentProfile,
  loadAgentProfileRegistry,
  switchRuntimeNonDestructive,
} from "../../state";
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

  const refresh = useCallback(() => {
    setRegistry(loadAgentProfileRegistry());
  }, []);

  const onSwitch = useCallback(
    (id: string) => {
      setBusy(true);
      setError(null);
      try {
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
    [refresh],
  );

  const onAddRemote = useCallback(
    (entry: { label: string; apiBase: string; accessToken?: string }) => {
      setBusy(true);
      setError(null);
      try {
        addAgentProfile({
          kind: "remote",
          label: entry.label,
          apiBase: entry.apiBase,
          accessToken: entry.accessToken,
        });
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
        runtimes={registry.profiles}
        activeId={registry.activeProfileId}
        onSwitch={onSwitch}
        onAddRemote={onAddRemote}
        busy={busy}
      />
    </div>
  );
}

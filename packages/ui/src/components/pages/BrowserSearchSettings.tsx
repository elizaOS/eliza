/** Selects an exact connected browser profile for this agent's searches. */
import { useCallback, useEffect, useState } from "react";
import { client } from "../../api";
import { isDesktopLocalApiBaseUrl } from "../../api/desktop-local-api-base";
import { isMobileLocalAgentUrl } from "../../first-run/mobile-runtime-mode";
import {
  getActiveAgentAuthority,
  useActiveAgentAuthority,
} from "../../hooks/useActiveAgentAuthority";
import { loadAgentProfileRegistry } from "../../state/agent-profiles";
import { Button } from "../ui/button";
import { RemoteBrowserSearchSettings } from "./RemoteBrowserSearchSettings";

type Profile = { targetId: string; profileId: string };
type ProfileSettings = { connected: Profile | null; selected: Profile | null };

export function BrowserSearchSettings(): React.JSX.Element {
  const authority = useActiveAgentAuthority();
  const registry = loadAgentProfileRegistry();
  const active = registry.profiles.find(
    (profile) => profile.id === registry.activeProfileId,
  );
  const base = client.getBaseUrl?.() ?? "";
  const remote =
    (active !== undefined && active.kind !== "local") ||
    Boolean(
      base && !isMobileLocalAgentUrl(base) && !isDesktopLocalApiBaseUrl(base),
    );
  return remote ? (
    <RemoteBrowserSearchSettings key={authority} authority={authority} />
  ) : (
    <LocalBrowserSearchSettings key={authority} />
  );
}

function LocalBrowserSearchSettings(): React.JSX.Element {
  const authority = useActiveAgentAuthority();
  const [settings, setSettings] = useState<ProfileSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setError(null);
    try {
      const result = await client.fetch<ProfileSettings>(
        "/api/browser-device/profile",
      );
      if (getActiveAgentAuthority() === authority) setSettings(result);
    } catch {
      // error-policy:J4 A missing or remote device cannot grant a local profile.
      if (getActiveAgentAuthority() === authority)
        setError(
          "Browser connection unavailable. Open Chromium with the Eliza extension, then refresh.",
        );
    }
  }, [authority]);
  useEffect(() => {
    setSettings(null);
    setBusy(false);
    void refresh();
  }, [refresh]);
  async function select(selected: Profile | null) {
    if (getActiveAgentAuthority() !== authority) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.fetch<ProfileSettings>(
        "/api/browser-device/profile",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ selected }),
        },
      );
      if (getActiveAgentAuthority() === authority) setSettings(result);
    } catch {
      // error-policy:J4 Persisted selection is not inferred from a failed save.
      if (getActiveAgentAuthority() === authority)
        setError(
          "Could not save the browser selection. Refresh the connection and try again.",
        );
    } finally {
      if (getActiveAgentAuthority() === authority) setBusy(false);
    }
  }
  const connected = settings?.connected;
  const selected = settings?.selected;
  const current = Boolean(
    connected &&
      selected &&
      connected.targetId === selected.targetId &&
      connected.profileId === selected.profileId,
  );
  return (
    <section
      aria-label="Browser search settings"
      className="rounded-lg border border-border p-4 text-sm"
    >
      <h2 className="font-semibold text-txt">Agent web search</h2>
      <p className="mt-2 text-muted">
        Use your connected Chromium profile for this agent’s searches. Searches
        open background tabs and use that profile’s website sign-ins.
      </p>
      <p role="status" className="mt-2 break-all text-muted">
        {current
          ? `Using connected profile ${selected?.profileId}.`
          : selected
            ? `Selected profile ${selected.profileId} is disconnected.`
            : connected
              ? `Connected profile: ${connected.profileId}`
              : "No connected browser profile."}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="accentDarkHover"
          disabled={busy || !connected || current}
          onClick={() => connected && void select(connected)}
        >
          Use this browser
        </Button>
        {selected && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void select(null)}
          >
            Stop using this browser
          </Button>
        )}
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void refresh()}
        >
          Refresh connection
        </Button>
      </div>
      <p className="mt-3 text-xs text-muted">
        Without an available selected profile, search uses public search
        providers. After a browser search starts, errors stay with that tab.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

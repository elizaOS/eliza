/**
 * State for the app-shell surface: owner name, favorite/recent apps, and the
 * apps sub-tab. Reconciles localStorage favorites with the server list when the
 * shell supports full app-shell routes.
 */
import { useCallback, useEffect, useState } from "react";
import { client } from "../api";
import { supportsFullAppShellRoutes } from "../api/app-shell-capabilities";
import { AGENT_READY_EVENT } from "../events";
import {
  fetchServerFavoriteApps,
  loadFavoriteApps,
  loadRecentApps,
  replaceServerFavoriteApps,
  saveFavoriteApps,
  saveRecentApps,
} from "./persistence";

export interface AppShellState {
  ownerName: string | null;
  appsSubTab: "browse" | "running" | "games";
  agentSubTab: "character" | "inventory" | "documents";
  pluginsSubTab: "features" | "connectors" | "plugins";
  databaseSubTab: "tables" | "media" | "vectors";
  favoriteApps: string[];
  recentApps: string[];
  configRaw: Record<string, unknown>;
  configText: string;
}

interface UseAppShellStateOptions {
  syncServerFavorites?: boolean;
}

export function useAppShellState({
  syncServerFavorites = true,
}: UseAppShellStateOptions = {}) {
  const [ownerName, setOwnerNameState] = useState<string | null>(null);
  const [appsSubTab, setAppsSubTabRaw] = useState<
    "browse" | "running" | "games"
  >(() => {
    try {
      const stored = sessionStorage.getItem("eliza:appsSubTab");
      if (stored === "browse" || stored === "running" || stored === "games") {
        return stored;
      }
    } catch {
      /* ignore */
    }
    return "browse";
  });
  const [agentSubTab, setAgentSubTab] = useState<
    "character" | "inventory" | "documents"
  >("character");
  const [pluginsSubTab, setPluginsSubTab] = useState<
    "features" | "connectors" | "plugins"
  >("features");
  const [databaseSubTab, setDatabaseSubTab] = useState<
    "tables" | "media" | "vectors"
  >("tables");
  const [favoriteApps, setFavoriteAppsRaw] = useState<string[]>(() =>
    loadFavoriteApps(),
  );
  const [recentApps, setRecentAppsRaw] = useState<string[]>(() =>
    loadRecentApps(),
  );
  const [configRaw, setConfigRaw] = useState<Record<string, unknown>>({});
  const [configText, setConfigText] = useState("");

  const setAppsSubTab = useCallback((value: "browse" | "running" | "games") => {
    setAppsSubTabRaw(value);
    try {
      sessionStorage.setItem("eliza:appsSubTab", value);
    } catch {
      /* ignore */
    }
  }, []);

  const setFavoriteApps = useCallback((apps: string[]) => {
    setFavoriteAppsRaw(apps);
    saveFavoriteApps(apps);
    if (supportsFullAppShellRoutes(client.getBaseUrl())) {
      void replaceServerFavoriteApps(apps);
    }
  }, []);

  useEffect(() => {
    if (!syncServerFavorites) return;
    if (!supportsFullAppShellRoutes(client.getBaseUrl())) return;
    let cancelled = false;
    let hydrated = false;
    const applyServerApps = (serverApps: string[] | null): void => {
      if (cancelled || serverApps == null) return;
      hydrated = true;
      setFavoriteAppsRaw((current) => {
        if (
          current.length === serverApps.length &&
          current.every((entry, idx) => entry === serverApps[idx])
        ) {
          return current;
        }
        return serverApps;
      });
    };
    // Single retry-after-ready: on iOS the first fetch can fail while the
    // native transport is still mode-gated during boot (persistence logs that
    // at debug level). Once the native agent reports ready the transport is
    // settled, so re-fetch exactly once if the first attempt did not hydrate.
    const onAgentReady = (): void => {
      document.removeEventListener(AGENT_READY_EVENT, onAgentReady);
      if (cancelled || hydrated) return;
      void fetchServerFavoriteApps().then(applyServerApps);
    };
    document.addEventListener(AGENT_READY_EVENT, onAgentReady);
    void fetchServerFavoriteApps().then((serverApps) => {
      applyServerApps(serverApps);
      if (hydrated) {
        document.removeEventListener(AGENT_READY_EVENT, onAgentReady);
      }
    });
    return () => {
      cancelled = true;
      document.removeEventListener(AGENT_READY_EVENT, onAgentReady);
    };
  }, [syncServerFavorites]);

  const setRecentApps = useCallback((apps: string[]) => {
    setRecentAppsRaw(apps);
    saveRecentApps(apps);
  }, []);

  return {
    state: {
      ownerName,
      appsSubTab,
      agentSubTab,
      pluginsSubTab,
      databaseSubTab,
      favoriteApps,
      recentApps,
      configRaw,
      configText,
    } satisfies AppShellState,
    setOwnerNameState,
    setAppsSubTab,
    setAgentSubTab,
    setPluginsSubTab,
    setDatabaseSubTab,
    setFavoriteApps,
    setRecentApps,
    setConfigRaw,
    setConfigText,
  };
}

import { useCallback, useEffect, useState } from "react";
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

export function useAppShellState() {
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
    void replaceServerFavoriteApps(apps);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchServerFavoriteApps().then((serverApps) => {
      if (cancelled || serverApps == null) return;
      setFavoriteAppsRaw((current) => {
        if (
          current.length === serverApps.length &&
          current.every((entry, idx) => entry === serverApps[idx])
        ) {
          return current;
        }
        return serverApps;
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

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

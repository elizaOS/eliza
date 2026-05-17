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
export declare function useAppShellState(): {
  state: {
    ownerName: string | null;
    appsSubTab: "running" | "browse" | "games";
    agentSubTab: "inventory" | "documents" | "character";
    pluginsSubTab: "connectors" | "plugins" | "features";
    databaseSubTab: "media" | "tables" | "vectors";
    favoriteApps: string[];
    recentApps: string[];
    configRaw: Record<string, unknown>;
    configText: string;
  };
  setOwnerNameState: import("react").Dispatch<
    import("react").SetStateAction<string | null>
  >;
  setAppsSubTab: (value: "browse" | "running" | "games") => void;
  setAgentSubTab: import("react").Dispatch<
    import("react").SetStateAction<"inventory" | "documents" | "character">
  >;
  setPluginsSubTab: import("react").Dispatch<
    import("react").SetStateAction<"connectors" | "plugins" | "features">
  >;
  setDatabaseSubTab: import("react").Dispatch<
    import("react").SetStateAction<"media" | "tables" | "vectors">
  >;
  setFavoriteApps: (apps: string[]) => void;
  setRecentApps: (apps: string[]) => void;
  setConfigRaw: import("react").Dispatch<
    import("react").SetStateAction<Record<string, unknown>>
  >;
  setConfigText: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
};
//# sourceMappingURL=useAppShellState.d.ts.map

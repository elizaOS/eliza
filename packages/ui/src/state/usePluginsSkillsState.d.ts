/**
 * Plugins / Skills / Store / Catalog state — extracted from AppContext.
 *
 * Manages plugin list and config, skill list and create/delete/review/marketplace
 * flows, the store (registry plugins), and the catalog (marketplace skills).
 *
 * Accepts `{ setActionNotice }` for cross-domain notifications.
 */
import { type CatalogSkill, type PluginInfo, type RegistryPlugin, type SkillInfo, type SkillMarketplaceResult, type SkillScanReportSummary } from "../api";
/**
 * Pick the primary sensitive credential parameter from a plugin's
 * declared parameter list. Walks the priority list in order and returns
 * the first sensitive param whose key matches. Falls back to the first
 * sensitive parameter if none match (explicit contract: documented and
 * tested).
 */
export declare function pickPrimaryCredentialParam<P extends {
    key: string;
    sensitive: boolean;
}>(params: readonly P[]): P | undefined;
interface PluginsSkillsStateParams {
    setActionNotice: (text: string, tone?: "info" | "success" | "error", ttlMs?: number, once?: boolean, busy?: boolean) => void;
    setPendingRestart: (value: boolean | ((prev: boolean) => boolean)) => void;
    setPendingRestartReasons: (value: string[] | ((prev: string[]) => string[])) => void;
    showRestartBanner: () => void;
    triggerRestart: () => Promise<void>;
}
export declare function usePluginsSkillsState({ setActionNotice, setPendingRestart, setPendingRestartReasons, showRestartBanner, triggerRestart, }: PluginsSkillsStateParams): {
    plugins: PluginInfo[];
    setPlugins: import("react").Dispatch<import("react").SetStateAction<PluginInfo[]>>;
    pluginFilter: "connector" | "all" | "ai-provider" | "feature" | "streaming";
    setPluginFilter: import("react").Dispatch<import("react").SetStateAction<"connector" | "all" | "ai-provider" | "feature" | "streaming">>;
    pluginStatusFilter: "all" | "enabled" | "disabled";
    setPluginStatusFilter: import("react").Dispatch<import("react").SetStateAction<"all" | "enabled" | "disabled">>;
    pluginSearch: string;
    setPluginSearch: import("react").Dispatch<import("react").SetStateAction<string>>;
    pluginSettingsOpen: Set<string>;
    setPluginSettingsOpen: import("react").Dispatch<import("react").SetStateAction<Set<string>>>;
    pluginAdvancedOpen: Set<string>;
    setPluginAdvancedOpen: import("react").Dispatch<import("react").SetStateAction<Set<string>>>;
    pluginSaving: Set<string>;
    setPluginSaving: import("react").Dispatch<import("react").SetStateAction<Set<string>>>;
    pluginSaveSuccess: Set<string>;
    setPluginSaveSuccess: import("react").Dispatch<import("react").SetStateAction<Set<string>>>;
    loadPlugins: (_options?: {
        silent?: boolean;
    }) => Promise<void>;
    ensurePluginsLoaded: (options?: {
        refresh?: boolean;
    }) => Promise<void>;
    handlePluginToggle: (pluginId: string, enabled: boolean) => Promise<void>;
    handlePluginConfigSave: (pluginId: string, config: Record<string, string>) => Promise<void>;
    skills: SkillInfo[];
    setSkills: import("react").Dispatch<import("react").SetStateAction<SkillInfo[]>>;
    skillsSubTab: "browse" | "my";
    setSkillsSubTab: import("react").Dispatch<import("react").SetStateAction<"browse" | "my">>;
    skillCreateFormOpen: boolean;
    setSkillCreateFormOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
    skillCreateName: string;
    setSkillCreateName: import("react").Dispatch<import("react").SetStateAction<string>>;
    skillCreateDescription: string;
    setSkillCreateDescription: import("react").Dispatch<import("react").SetStateAction<string>>;
    skillCreating: boolean;
    setSkillCreating: import("react").Dispatch<import("react").SetStateAction<boolean>>;
    skillReviewReport: SkillScanReportSummary | null;
    setSkillReviewReport: import("react").Dispatch<import("react").SetStateAction<SkillScanReportSummary | null>>;
    skillReviewId: string;
    setSkillReviewId: import("react").Dispatch<import("react").SetStateAction<string>>;
    skillReviewLoading: boolean;
    setSkillReviewLoading: import("react").Dispatch<import("react").SetStateAction<boolean>>;
    skillToggleAction: string;
    setSkillToggleAction: import("react").Dispatch<import("react").SetStateAction<string>>;
    skillsMarketplaceQuery: string;
    setSkillsMarketplaceQuery: import("react").Dispatch<import("react").SetStateAction<string>>;
    skillsMarketplaceResults: SkillMarketplaceResult[];
    setSkillsMarketplaceResults: import("react").Dispatch<import("react").SetStateAction<SkillMarketplaceResult[]>>;
    skillsMarketplaceError: string;
    setSkillsMarketplaceError: import("react").Dispatch<import("react").SetStateAction<string>>;
    skillsMarketplaceLoading: boolean;
    setSkillsMarketplaceLoading: import("react").Dispatch<import("react").SetStateAction<boolean>>;
    skillsMarketplaceAction: string;
    setSkillsMarketplaceAction: import("react").Dispatch<import("react").SetStateAction<string>>;
    skillsMarketplaceManualGithubUrl: string;
    setSkillsMarketplaceManualGithubUrl: import("react").Dispatch<import("react").SetStateAction<string>>;
    loadSkills: () => Promise<void>;
    refreshSkills: () => Promise<void>;
    handleSkillToggle: (skillId: string, enabled: boolean) => Promise<void>;
    handleCreateSkill: () => Promise<void>;
    handleOpenSkill: (skillId: string) => Promise<void>;
    handleDeleteSkill: (skillId: string, skillName: string) => Promise<void>;
    handleReviewSkill: (skillId: string) => Promise<void>;
    handleAcknowledgeSkill: (skillId: string) => Promise<void>;
    searchSkillsMarketplace: () => Promise<void>;
    installSkillFromMarketplace: (item: SkillMarketplaceResult) => Promise<void>;
    installSkillFromGithubUrl: () => Promise<void>;
    uninstallMarketplaceSkill: (skillId: string, name: string) => Promise<void>;
    enableMarketplaceSkill: (skillId: string, name: string) => Promise<void>;
    disableMarketplaceSkill: (skillId: string, name: string) => Promise<void>;
    copyMarketplaceSkillSource: (skillId: string, name: string) => Promise<void>;
    storePlugins: RegistryPlugin[];
    setStorePlugins: import("react").Dispatch<import("react").SetStateAction<RegistryPlugin[]>>;
    storeSearch: string;
    setStoreSearch: import("react").Dispatch<import("react").SetStateAction<string>>;
    storeFilter: "connector" | "all" | "installed" | "ai-provider" | "feature";
    setStoreFilter: import("react").Dispatch<import("react").SetStateAction<"connector" | "all" | "installed" | "ai-provider" | "feature">>;
    storeLoading: boolean;
    setStoreLoading: import("react").Dispatch<import("react").SetStateAction<boolean>>;
    storeInstalling: Set<string>;
    setStoreInstalling: import("react").Dispatch<import("react").SetStateAction<Set<string>>>;
    storeUninstalling: Set<string>;
    setStoreUninstalling: import("react").Dispatch<import("react").SetStateAction<Set<string>>>;
    storeError: string | null;
    setStoreError: import("react").Dispatch<import("react").SetStateAction<string | null>>;
    storeDetailPlugin: RegistryPlugin | null;
    setStoreDetailPlugin: import("react").Dispatch<import("react").SetStateAction<RegistryPlugin | null>>;
    storeSubTab: "plugins" | "skills";
    setStoreSubTab: import("react").Dispatch<import("react").SetStateAction<"plugins" | "skills">>;
    catalogSkills: CatalogSkill[];
    setCatalogSkills: import("react").Dispatch<import("react").SetStateAction<CatalogSkill[]>>;
    catalogTotal: number;
    setCatalogTotal: import("react").Dispatch<import("react").SetStateAction<number>>;
    catalogPage: number;
    setCatalogPage: import("react").Dispatch<import("react").SetStateAction<number>>;
    catalogTotalPages: number;
    setCatalogTotalPages: import("react").Dispatch<import("react").SetStateAction<number>>;
    catalogSort: "name" | "downloads" | "stars" | "updated";
    setCatalogSort: import("react").Dispatch<import("react").SetStateAction<"name" | "downloads" | "stars" | "updated">>;
    catalogSearch: string;
    setCatalogSearch: import("react").Dispatch<import("react").SetStateAction<string>>;
    catalogLoading: boolean;
    setCatalogLoading: import("react").Dispatch<import("react").SetStateAction<boolean>>;
    catalogError: string | null;
    setCatalogError: import("react").Dispatch<import("react").SetStateAction<string | null>>;
    catalogDetailSkill: CatalogSkill | null;
    setCatalogDetailSkill: import("react").Dispatch<import("react").SetStateAction<CatalogSkill | null>>;
    catalogInstalling: Set<string>;
    setCatalogInstalling: import("react").Dispatch<import("react").SetStateAction<Set<string>>>;
    catalogUninstalling: Set<string>;
    setCatalogUninstalling: import("react").Dispatch<import("react").SetStateAction<Set<string>>>;
};
export {};
//# sourceMappingURL=usePluginsSkillsState.d.ts.map
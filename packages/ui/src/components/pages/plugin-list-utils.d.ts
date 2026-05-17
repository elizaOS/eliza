/**
 * Plugin list utilities — pure functions, constants, and type aliases
 * shared across the plugin management UI.
 */
import type { LucideIcon } from "lucide-react";
import type { PluginInfo, PluginParamDef } from "../../api";
import type { JsonSchemaObject } from "../../config/config-catalog";
import type { TranslateFn as AppTranslateFn, ConfigUiHint } from "../../types";
/**
 * Plugin IDs hidden from Features/Connectors views.
 * Core plugins are visible in Admin > Plugins instead.
 */
export declare const ALWAYS_ON_PLUGIN_IDS: Set<string>;
/** Keys to hide when Telegram "Allow all chats" mode is active. */
export declare const TELEGRAM_ALLOW_ALL_HIDDEN: Set<string>;
/** Detect advanced / debug parameters that should be collapsed by default. */
export declare function isAdvancedParam(param: PluginParamDef): boolean;
/** Convert PluginParamDef[] to a JSON Schema + ConfigUiHints for ConfigRenderer. */
export declare function paramsToSchema(
  params: PluginParamDef[],
  pluginId: string,
): {
  schema: JsonSchemaObject;
  hints: Record<string, ConfigUiHint>;
};
/** Resolve display icon. Order: explicit URL/emoji on PluginInfo.icon →
 *  registry-provided Lucide name (PluginInfo.iconName) → null. */
export declare function resolveIcon(p: PluginInfo): LucideIcon | string | null;
export declare function iconImageSource(icon: string): string | null;
export type TranslateFn = AppTranslateFn;
export declare function buildDiscordInviteUrl(applicationId: string): string;
export declare function getPluginResourceLinks(
  plugin: Pick<
    PluginInfo,
    "id" | "homepage" | "parameters" | "repository" | "setupGuideUrl"
  >,
  options?: {
    draftConfig?: Record<string, string>;
  },
): Array<{
  key: string;
  url: string;
}>;
export declare function pluginResourceLinkLabel(
  t: TranslateFn,
  key: string,
): string;
export declare const SUBGROUP_DISPLAY_ORDER: readonly [
  "ai-provider",
  "connector",
  "streaming",
  "voice",
  "blockchain",
  "devtools",
  "documents",
  "agents",
  "media",
  "automation",
  "storage",
  "gaming",
  "feature-other",
  "showcase",
];
export declare const SUBGROUP_LABELS: Record<string, string>;
export declare const SUBGROUP_NAV_ICONS: Record<string, LucideIcon>;
export declare function subgroupForPlugin(plugin: PluginInfo): string;
export type StatusFilter = "all" | "enabled" | "disabled";
export type PluginsViewMode =
  | "all"
  | "all-social"
  | "connectors"
  | "streaming"
  | "social";
export type SubgroupTag = {
  id: string;
  label: string;
  count: number;
};
export declare function isPluginReady(plugin: PluginInfo): boolean;
export declare function comparePlugins(
  left: PluginInfo,
  right: PluginInfo,
): number;
export declare function matchesPluginFilters(
  plugin: PluginInfo,
  searchLower: string,
  statusFilter: StatusFilter,
): boolean;
export declare function sortPlugins(
  filteredPlugins: PluginInfo[],
  pluginOrder: string[],
  allowCustomOrder: boolean,
): PluginInfo[];
export declare function buildPluginListState(options: {
  allowCustomOrder: boolean;
  effectiveSearch: string;
  effectiveStatusFilter: StatusFilter;
  isConnectorLikeMode: boolean;
  mode: PluginsViewMode;
  pluginOrder: string[];
  plugins: PluginInfo[];
  showSubgroupFilters: boolean;
  subgroupFilter: string;
}): {
  nonDbPlugins: PluginInfo[];
  sorted: PluginInfo[];
  subgroupTags: SubgroupTag[];
  visiblePlugins: PluginInfo[];
};
//# sourceMappingURL=plugin-list-utils.d.ts.map

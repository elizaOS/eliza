import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectValue,
  SettingsControls,
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarPanel,
  SidebarScrollRegion,
} from "@elizaos/ui";
import { ChevronRight } from "lucide-react";
import type { ReactNode, RefCallback } from "react";
import type { PluginInfo } from "../../api";
import type {
  PluginsViewMode,
  SubgroupTag,
  TranslateFn,
} from "./plugin-list-utils";

type RenderResolvedIconOptions = {
  className?: string;
  emojiClassName?: string;
};

interface ConnectorDesktopSidebarProps {
  collapseLabel: string;
  connectorExpandedIds: Set<string>;
  connectorSelectedId: string | null;
  desktopConnectorLayout: boolean;
  expandLabel: string;
  hasPluginToggleInFlight: boolean;
  mode: PluginsViewMode;
  pluginDescriptionFallback: string;
  pluginSearch: string;
  registerConnectorRailItem: (pluginId: string) => RefCallback<HTMLElement>;
  registerConnectorSidebarItem: (pluginId: string) => RefCallback<HTMLElement>;
  registerConnectorSidebarViewport: RefCallback<HTMLElement>;
  renderResolvedIcon: (
    plugin: PluginInfo,
    options?: RenderResolvedIconOptions,
  ) => ReactNode;
  resultLabel: string;
  subgroupFilter: string;
  subgroupTags: SubgroupTag[];
  t: TranslateFn;
  togglingPlugins: Set<string>;
  visiblePlugins: PluginInfo[];
  onConnectorSelect: (pluginId: string) => void;
  onConnectorSectionToggle: (pluginId: string) => void;
  onSearchChange: (value: string) => void;
  onSearchClear: () => void;
  onSubgroupFilterChange: (value: string) => void;
  onTogglePlugin: (pluginId: string, enabled: boolean) => Promise<void>;
}

export function ConnectorSidebar({
  collapseLabel,
  connectorExpandedIds,
  connectorSelectedId,
  desktopConnectorLayout,
  expandLabel,
  hasPluginToggleInFlight,
  mode,
  pluginDescriptionFallback,
  pluginSearch,
  registerConnectorRailItem,
  registerConnectorSidebarItem,
  registerConnectorSidebarViewport,
  renderResolvedIcon,
  resultLabel,
  subgroupFilter,
  subgroupTags,
  t,
  togglingPlugins,
  visiblePlugins,
  onConnectorSelect,
  onConnectorSectionToggle,
  onSearchChange,
  onSearchClear,
  onSubgroupFilterChange,
  onTogglePlugin,
}: ConnectorDesktopSidebarProps) {
  if (!desktopConnectorLayout) return null;

  const sidebarSearchLabel =
    mode === "social" ? "Search connectors" : "Search plugins";
  const filterSelectLabel =
    subgroupTags.find((tag) => tag.id === subgroupFilter)?.label ?? "All";
  const hasActivePluginFilters =
    pluginSearch.trim().length > 0 || subgroupFilter !== "all";

  return (
    <Sidebar
      ref={registerConnectorSidebarViewport}
      testId="connectors-settings-sidebar"
      collapsible
      contentIdentity={mode === "social" ? "connectors" : "plugins"}
      header={
        <SidebarHeader
          search={{
            value: pluginSearch,
            onChange: (event) => onSearchChange(event.target.value),
            onClear: onSearchClear,
            placeholder: sidebarSearchLabel,
            "aria-label": sidebarSearchLabel,
          }}
        />
      }
      collapsedRailItems={visiblePlugins.map((plugin) => {
        const isSelected = connectorSelectedId === plugin.id;
        return (
          <SidebarContent.RailItem
            key={plugin.id}
            ref={registerConnectorRailItem(plugin.id)}
            aria-label={plugin.name}
            title={plugin.name}
            active={isSelected}
            indicatorTone={plugin.enabled ? "accent" : undefined}
            onClick={() => onConnectorSelect(plugin.id)}
          >
            <SidebarContent.RailMedia>
              {renderResolvedIcon(plugin)}
            </SidebarContent.RailMedia>
          </SidebarContent.RailItem>
        );
      })}
    >
      <SidebarScrollRegion>
        <SidebarPanel>
          <div className="mb-3">
            <Select
              value={subgroupFilter}
              onValueChange={onSubgroupFilterChange}
            >
              <SettingsControls.SelectTrigger
                aria-label={
                  mode === "social"
                    ? "Filter connector category"
                    : "Filter plugin category"
                }
                variant="filter"
                className="w-full"
              >
                <SelectValue>{filterSelectLabel}</SelectValue>
              </SettingsControls.SelectTrigger>
              <SelectContent>
                {subgroupTags.map((tag) => (
                  <SelectItem key={tag.id} value={tag.id}>
                    {tag.label} ({tag.count})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {visiblePlugins.length === 0 ? (
            <SidebarContent.EmptyState className="px-4 py-6">
              {hasActivePluginFilters
                ? `No ${resultLabel} match the current filters.`
                : `No ${resultLabel} available.`}
            </SidebarContent.EmptyState>
          ) : (
            visiblePlugins.map((plugin) => {
              const isSelected = connectorSelectedId === plugin.id;
              const isExpanded = connectorExpandedIds.has(plugin.id);
              const isToggleBusy = togglingPlugins.has(plugin.id);
              const toggleDisabled =
                isToggleBusy || (hasPluginToggleInFlight && !isToggleBusy);

              return (
                <SidebarContent.Item
                  key={plugin.id}
                  as="div"
                  active={isSelected}
                  className="items-center gap-1.5 px-2.5 py-2 scroll-mt-3"
                  ref={registerConnectorSidebarItem(plugin.id)}
                >
                  <SidebarContent.ItemButton
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => onConnectorSelect(plugin.id)}
                    aria-current={isSelected ? "page" : undefined}
                    className="items-center gap-2"
                  >
                    <SidebarContent.ItemIcon
                      active={isSelected}
                      className="mt-0 h-8 w-8 shrink-0 p-1.5"
                    >
                      {renderResolvedIcon(plugin, {
                        className:
                          "h-4 w-4 shrink-0 rounded-[var(--radius-sm)] object-contain",
                        emojiClassName: "text-sm",
                      })}
                    </SidebarContent.ItemIcon>
                    <SidebarContent.ItemBody>
                      <span className="block truncate text-sm font-semibold leading-5 text-txt">
                        {plugin.name}
                      </span>
                    </SidebarContent.ItemBody>
                  </SidebarContent.ItemButton>
                  <div className="flex shrink-0 flex-row items-center gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      className={`h-7 min-h-0 min-w-[3.5rem] shrink-0 rounded-[var(--radius-sm)] border px-2.5 py-0 text-2xs font-bold leading-none tracking-[0.16em] transition-colors ${
                        plugin.enabled
                          ? "border-accent bg-accent text-accent-fg"
                          : "border-border bg-transparent text-muted hover:border-accent/40 hover:text-txt"
                      } ${
                        toggleDisabled
                          ? "cursor-not-allowed opacity-60"
                          : "cursor-pointer"
                      }`}
                      onClick={(event) => {
                        event.stopPropagation();
                        void onTogglePlugin(plugin.id, !plugin.enabled);
                      }}
                      disabled={toggleDisabled}
                    >
                      {isToggleBusy
                        ? "..."
                        : plugin.enabled
                          ? t("common.on")
                          : t("common.off")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0 rounded-[var(--radius-sm)] text-muted hover:text-txt"
                      aria-label={`${isExpanded ? collapseLabel : expandLabel} ${plugin.name} in sidebar`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onConnectorSectionToggle(plugin.id);
                      }}
                    >
                      <ChevronRight
                        className={`h-4 w-4 transition-transform ${
                          isExpanded ? "rotate-90" : ""
                        }`}
                      />
                    </Button>
                  </div>
                </SidebarContent.Item>
              );
            })
          )}
        </SidebarPanel>
      </SidebarScrollRegion>
    </Sidebar>
  );
}

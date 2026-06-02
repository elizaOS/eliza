import { ChevronRight } from "lucide-react";
import type { ReactNode, RefCallback, RefObject } from "react";
import { useAgentElement } from "../../agent-surface";
import type { PluginInfo } from "../../api";
import { SidebarContent } from "../composites/sidebar/sidebar-content";
import { SidebarHeader } from "../composites/sidebar/sidebar-header";
import { SidebarPanel } from "../composites/sidebar/sidebar-panel";
import { SidebarScrollRegion } from "../composites/sidebar/sidebar-scroll-region";
import { getBrandIcon } from "../conversations/brand-icons";
import { AppPageSidebar } from "../shared/AppPageSidebar";
import { Button } from "../ui/button";
import { Select, SelectContent, SelectItem, SelectValue } from "../ui/select";
import { SettingsControls } from "../ui/settings-controls";
import { Switch } from "../ui/switch";
import type {
  PluginsViewMode,
  SubgroupTag,
  TranslateFn,
} from "./plugin-list-utils";

type RenderResolvedIconOptions = {
  className?: string;
  emojiClassName?: string;
};

function mergeRefs<T>(
  ...refs: Array<RefCallback<T> | RefObject<T | null> | null>
): RefCallback<T> {
  return (node: T | null) => {
    for (const ref of refs) {
      if (typeof ref === "function") {
        ref(node);
      } else if (ref) {
        ref.current = node;
      }
    }
  };
}

function ConnectorRailItem({
  plugin,
  isSelected,
  railRef,
  icon,
  onSelect,
}: {
  plugin: PluginInfo;
  isSelected: boolean;
  railRef: RefCallback<HTMLElement>;
  icon: ReactNode;
  onSelect: (pluginId: string) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLElement>({
    id: `connector-rail-${plugin.id}`,
    role: "list-item",
    label: `${plugin.name} (collapsed rail)`,
    group: "connector-sidebar",
    status: isSelected ? "active" : "inactive",
    description: `Select the ${plugin.name} connector from the collapsed rail`,
    onActivate: () => onSelect(plugin.id),
  });
  return (
    <SidebarContent.RailItem
      ref={mergeRefs(railRef, ref)}
      aria-label={plugin.name}
      title={plugin.name}
      active={isSelected}
      aria-current={isSelected ? "true" : undefined}
      indicatorTone={plugin.enabled ? "accent" : undefined}
      onClick={() => onSelect(plugin.id)}
      {...agentProps}
    >
      <SidebarContent.RailMedia>{icon}</SidebarContent.RailMedia>
    </SidebarContent.RailItem>
  );
}

function ConnectorSidebarRow({
  plugin,
  isSelected,
  isExpanded,
  toggleDisabled,
  collapseLabel,
  expandLabel,
  icon,
  sidebarRef,
  t,
  onSelect,
  onSectionToggle,
  onTogglePlugin,
}: {
  plugin: PluginInfo;
  isSelected: boolean;
  isExpanded: boolean;
  toggleDisabled: boolean;
  collapseLabel: string;
  expandLabel: string;
  icon: ReactNode;
  sidebarRef: RefCallback<HTMLElement>;
  t: TranslateFn;
  onSelect: (pluginId: string) => void;
  onSectionToggle: (pluginId: string) => void;
  onTogglePlugin: (pluginId: string, enabled: boolean) => Promise<void>;
}) {
  const selectControl = useAgentElement<HTMLButtonElement>({
    id: `connector-sidebar-${plugin.id}-select`,
    role: "list-item",
    label: `Select ${plugin.name}`,
    group: "connector-sidebar",
    status: isSelected ? "active" : "inactive",
    description: `Open the ${plugin.name} connector`,
    onActivate: () => onSelect(plugin.id),
  });
  const toggleControl = useAgentElement<HTMLButtonElement>({
    id: `connector-sidebar-${plugin.id}-toggle`,
    role: "toggle",
    label: `Toggle ${plugin.name}`,
    group: "connector-sidebar",
    status: plugin.enabled ? "active" : "inactive",
    description: `Enable or disable the ${plugin.name} connector`,
    onActivate: () => void onTogglePlugin(plugin.id, !plugin.enabled),
  });
  const expandControl = useAgentElement<HTMLButtonElement>({
    id: `connector-sidebar-${plugin.id}-expand`,
    role: "button",
    label: `${isExpanded ? collapseLabel : expandLabel} ${plugin.name}`,
    group: "connector-sidebar",
    status: isExpanded ? "active" : "inactive",
    description: `Expand or collapse the ${plugin.name} connector in the sidebar`,
    onActivate: () => onSectionToggle(plugin.id),
  });
  return (
    <SidebarContent.Item
      as="div"
      active={isSelected}
      className="items-center gap-1.5 px-2.5 py-2 scroll-mt-3"
      ref={sidebarRef}
    >
      <SidebarContent.ItemButton
        ref={selectControl.ref}
        role="option"
        aria-selected={isSelected}
        onClick={() => onSelect(plugin.id)}
        aria-current={isSelected ? "page" : undefined}
        className="items-center gap-2"
        {...selectControl.agentProps}
      >
        <SidebarContent.ItemIcon
          active={isSelected}
          className="mt-0 h-8 w-8 shrink-0 p-1.5"
        >
          {icon}
        </SidebarContent.ItemIcon>
        <SidebarContent.ItemBody>
          <span className="block truncate text-sm font-semibold leading-5 text-txt">
            {plugin.name}
          </span>
        </SidebarContent.ItemBody>
      </SidebarContent.ItemButton>
      <div className="flex shrink-0 flex-row items-center gap-1">
        <Switch
          ref={toggleControl.ref}
          checked={plugin.enabled}
          disabled={toggleDisabled}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onCheckedChange={(checked) => {
            void onTogglePlugin(plugin.id, checked);
          }}
          aria-label={`${plugin.enabled ? t("common.off") : t("common.on")} ${plugin.name}`}
          {...toggleControl.agentProps}
        />
        <Button
          ref={expandControl.ref}
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 rounded-none border-0 bg-transparent text-muted transition-colors hover:bg-transparent hover:text-txt"
          aria-label={`${isExpanded ? collapseLabel : expandLabel} ${plugin.name} in sidebar`}
          onClick={(event) => {
            event.stopPropagation();
            onSectionToggle(plugin.id);
          }}
          {...expandControl.agentProps}
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
}

interface ConnectorDesktopSidebarProps {
  collapseLabel: string;
  connectorExpandedIds: Set<string>;
  connectorSelectedId: string | null;
  desktopConnectorLayout: boolean;
  expandLabel: string;
  hasPluginToggleInFlight: boolean;
  mode: PluginsViewMode;
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
  const filterSelectControl = useAgentElement<HTMLButtonElement>({
    id: "connector-sidebar-category-filter",
    role: "select",
    label: mode === "social" ? "Connector category" : "Plugin category",
    group: "connector-sidebar",
    description:
      mode === "social"
        ? "Filter connectors by category"
        : "Filter plugins by category",
    options: subgroupTags.map((tag) => tag.id),
    getValue: () => subgroupFilter,
    onFill: (value) => onSubgroupFilterChange(value),
  });

  if (!desktopConnectorLayout) return null;

  const sidebarSearchLabel =
    mode === "social" ? "Search connectors" : "Search plugins";
  const filterSelectLabel =
    subgroupTags.find((tag) => tag.id === subgroupFilter)?.label ?? "All";
  const hasActivePluginFilters =
    pluginSearch.trim().length > 0 || subgroupFilter !== "all";

  return (
    <AppPageSidebar
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
        const RailBrandIcon = getBrandIcon(plugin.id);
        return (
          <ConnectorRailItem
            key={plugin.id}
            plugin={plugin}
            isSelected={isSelected}
            railRef={registerConnectorRailItem(plugin.id)}
            icon={
              RailBrandIcon ? (
                <RailBrandIcon className="h-5 w-5 shrink-0" />
              ) : (
                renderResolvedIcon(plugin)
              )
            }
            onSelect={onConnectorSelect}
          />
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
                {...filterSelectControl.agentProps}
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
              const SidebarBrandIcon = getBrandIcon(plugin.id);

              return (
                <ConnectorSidebarRow
                  key={plugin.id}
                  plugin={plugin}
                  isSelected={isSelected}
                  isExpanded={isExpanded}
                  toggleDisabled={toggleDisabled}
                  collapseLabel={collapseLabel}
                  expandLabel={expandLabel}
                  sidebarRef={registerConnectorSidebarItem(plugin.id)}
                  t={t}
                  icon={
                    SidebarBrandIcon ? (
                      <SidebarBrandIcon className="h-4 w-4 shrink-0" />
                    ) : (
                      renderResolvedIcon(plugin, {
                        className: "h-4 w-4 shrink-0 rounded-sm object-contain",
                        emojiClassName: "text-sm",
                      })
                    )
                  }
                  onSelect={onConnectorSelect}
                  onSectionToggle={onConnectorSectionToggle}
                  onTogglePlugin={onTogglePlugin}
                />
              );
            })
          )}
        </SidebarPanel>
      </SidebarScrollRegion>
    </AppPageSidebar>
  );
}

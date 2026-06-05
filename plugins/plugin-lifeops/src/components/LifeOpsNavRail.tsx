import {
  Sidebar,
  SidebarContent,
  SidebarPanel,
  SidebarScrollRegion,
  TooltipHint,
  TooltipProvider,
} from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import type { LifeOpsSection } from "../hooks/useLifeOpsSection.js";
import {
  NAV_GROUPS,
  type NavGroup,
  type NavItem,
} from "./LifeOpsNavRail.helpers.js";

interface LifeOpsNavRailProps {
  activeSection: LifeOpsSection;
  onNavigate: (section: LifeOpsSection) => void;
  collapsible?: boolean;
  labelMode?: "all" | "active";
}

const NAV_ITEMS = NAV_GROUPS.flatMap((group: NavGroup) => group.items);

function LifeOpsNavRailItem({
  item,
  isActive,
  onNavigate,
  labelMode,
}: {
  item: NavItem;
  isActive: boolean;
  onNavigate: (section: LifeOpsSection) => void;
  labelMode: "all" | "active";
}) {
  const showLabel = labelMode === "all" || isActive;
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `nav-${item.id}`,
    role: "tab",
    label: item.label,
    group: "lifeops-nav",
    status: isActive ? "active" : "inactive",
    description: `Open the ${item.label} section`,
  });
  return (
    <TooltipHint content={item.label} side="right">
      <button
        ref={ref}
        type="button"
        aria-label={item.label}
        aria-current={isActive ? "page" : undefined}
        onClick={() => onNavigate(item.id)}
        data-sidebar-item
        {...agentProps}
        className={[
          "group relative flex w-full min-w-0 items-center rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left transition-colors",
          showLabel ? "gap-2.5" : "justify-center gap-0",
          isActive ? "bg-accent/15 text-txt" : "text-txt hover:bg-bg-muted/50",
        ].join(" ")}
      >
        <span
          className={[
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] transition-colors",
            isActive
              ? "bg-white/8 text-txt"
              : "bg-transparent text-muted/80 group-hover:text-txt",
          ].join(" ")}
        >
          {item.icon}
        </span>
        {showLabel ? (
          <span className="min-w-0 flex-1 truncate text-xs-tight font-medium">
            {item.label}
          </span>
        ) : null}
        <span
          aria-hidden
          className={[
            `h-1.5 w-1.5 rounded-full ${item.dotColor} opacity-60`,
            showLabel ? "" : "absolute right-2 top-2",
          ].join(" ")}
        />
      </button>
    </TooltipHint>
  );
}

function LifeOpsNavTabItem({
  item,
  isActive,
  onNavigate,
}: {
  item: NavItem;
  isActive: boolean;
  onNavigate: (section: LifeOpsSection) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `nav-${item.id}`,
    role: "tab",
    label: item.label,
    group: "lifeops-nav",
    status: isActive ? "active" : "inactive",
    description: `Open the ${item.label} section`,
  });
  return (
    <TooltipHint content={item.label} side="bottom">
      <button
        ref={ref}
        type="button"
        aria-label={item.label}
        aria-current={isActive ? "page" : undefined}
        onClick={() => onNavigate(item.id)}
        data-sidebar-item
        {...agentProps}
        className={[
          "group relative flex h-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] px-2 transition-colors",
          isActive ? "w-auto gap-1.5 pr-2.5" : "w-8",
          isActive ? "bg-accent/15 text-txt" : "text-txt hover:bg-bg-muted/50",
        ].join(" ")}
      >
        <span
          className={[
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-sm)] transition-colors",
            isActive
              ? "bg-white/8 text-txt"
              : "bg-transparent text-muted/80 group-hover:text-txt",
          ].join(" ")}
        >
          {item.icon}
        </span>
        {isActive ? (
          <span className="max-w-24 truncate text-xs-tight font-medium">
            {item.label}
          </span>
        ) : null}
        <span
          aria-hidden
          className={[
            `h-1.5 w-1.5 shrink-0 rounded-full ${item.dotColor} opacity-60`,
            isActive ? "" : "absolute right-1 top-1",
          ].join(" ")}
        />
      </button>
    </TooltipHint>
  );
}

/**
 * Horizontal variant of the LifeOps section nav. Renders the same
 * {@link NAV_GROUPS} items as a single scrollable tab strip so the workspace can
 * present one vertical content column with navigation pinned to the top instead
 * of a side rail.
 */
export function LifeOpsNavTabs({
  activeSection,
  onNavigate,
}: Pick<LifeOpsNavRailProps, "activeSection" | "onNavigate">) {
  return (
    <TooltipProvider delayDuration={320} skipDelayDuration={120}>
      <div
        role="tablist"
        aria-label="LifeOps sections"
        data-testid="lifeops-nav-tabs"
        className="flex min-w-0 items-center gap-1 overflow-x-auto"
      >
        {NAV_GROUPS.map((group, groupIndex) => (
          <div key={group.key} className="flex shrink-0 items-center gap-1">
            {groupIndex > 0 ? (
              <span
                aria-hidden
                className="mx-1 h-5 w-px shrink-0 bg-border/12"
              />
            ) : null}
            {group.items.map((item) => (
              <LifeOpsNavTabItem
                key={item.id}
                item={item}
                isActive={item.id === activeSection}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        ))}
      </div>
    </TooltipProvider>
  );
}

export function LifeOpsNavRail({
  activeSection,
  onNavigate,
  collapsible = true,
  labelMode = "all",
}: LifeOpsNavRailProps) {
  const collapsedRailItems = NAV_ITEMS.map((item) => {
    const isActive = item.id === activeSection;
    return (
      <SidebarContent.RailItem
        key={item.id}
        aria-label={item.label}
        title={item.label}
        active={isActive}
        onClick={() => onNavigate(item.id)}
      >
        {item.icon}
      </SidebarContent.RailItem>
    );
  });

  return (
    <TooltipProvider delayDuration={320} skipDelayDuration={120}>
      <Sidebar
        testId="lifeops-nav-rail"
        collapsible={collapsible}
        contentIdentity="lifeops"
        syncId="lifeops-sidebar"
        collapseButtonAriaLabel="Collapse LifeOps sidebar"
        expandButtonAriaLabel="Expand LifeOps sidebar"
        header={undefined}
        className="!mt-0 !h-full !w-full !min-w-0 xl:!w-full xl:!min-w-0 !bg-none !bg-transparent !rounded-none !border-0 !shadow-none !backdrop-blur-none !ring-0"
        headerClassName="!h-0 !min-h-0 !p-0 !m-0 !overflow-hidden"
        collapseButtonClassName="!h-7 !w-7 !border-0 !bg-transparent !shadow-none hover:!bg-bg-muted/60"
        aria-label="LifeOps sections"
        collapsedRailItems={collapsible ? collapsedRailItems : undefined}
      >
        <SidebarScrollRegion className="px-1 pb-3 pt-0">
          <SidebarPanel className="bg-transparent gap-0 p-0 shadow-none">
            <div className="space-y-3">
              {NAV_GROUPS.map((group, groupIndex) => (
                <div
                  key={group.key}
                  className={
                    groupIndex > 0 ? "border-t border-border/10 pt-3" : ""
                  }
                >
                  <div className="space-y-0.5 px-1">
                    {group.items.map((item) => (
                      <LifeOpsNavRailItem
                        key={item.id}
                        item={item}
                        isActive={item.id === activeSection}
                        onNavigate={onNavigate}
                        labelMode={labelMode}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </SidebarPanel>
        </SidebarScrollRegion>
      </Sidebar>
    </TooltipProvider>
  );
}

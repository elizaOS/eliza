import { TooltipHint } from "@elizaos/app-core";
import {
  Sidebar,
  SidebarContent,
  SidebarPanel,
  SidebarScrollRegion,
  TooltipProvider,
} from "@elizaos/ui";
import {
  Bell,
  CalendarDays,
  LayoutDashboard,
  MessageSquare,
  Settings2,
  Sparkles,
} from "lucide-react";
import type { ReactNode } from "react";
import type { LifeOpsSection } from "../hooks/useLifeOpsSection.js";

interface LifeOpsNavRailProps {
  activeSection: LifeOpsSection;
  onNavigate: (section: LifeOpsSection) => void;
  /** Optional live counts used to colour indicators next to nav rows. */
  counts?: Partial<
    Record<"overview" | "reminders" | "calendar" | "messages", number>
  >;
}

interface NavGroup {
  key: string;
  label: string;
  items: NavItem[];
}

interface NavItem {
  id: LifeOpsSection;
  label: string;
  icon: ReactNode;
  dotColor: string;
}

const NAV_GROUPS: NavGroup[] = [
  {
    key: "today",
    label: "Today",
    items: [
      {
        id: "overview",
        label: "Overview",
        icon: <LayoutDashboard className="h-4 w-4" aria-hidden />,
        dotColor: "bg-violet-400",
      },
      {
        id: "calendar",
        label: "Calendar",
        icon: <CalendarDays className="h-4 w-4" aria-hidden />,
        dotColor: "bg-blue-400",
      },
      {
        id: "reminders",
        label: "Reminders",
        icon: <Bell className="h-4 w-4" aria-hidden />,
        dotColor: "bg-amber-400",
      },
      {
        id: "messages",
        label: "Inbox",
        icon: <MessageSquare className="h-4 w-4" aria-hidden />,
        dotColor: "bg-emerald-400",
      },
    ],
  },
  {
    key: "config",
    label: "Configure",
    items: [
      {
        id: "setup",
        label: "Settings",
        icon: <Settings2 className="h-4 w-4" aria-hidden />,
        dotColor: "bg-rose-400",
      },
    ],
  },
];

export function LifeOpsNavRail({
  activeSection,
  onNavigate,
  counts,
}: LifeOpsNavRailProps) {
  const allItems = NAV_GROUPS.flatMap((group) => group.items);
  const collapsedRailItems = allItems.map((item) => {
    const isActive = item.id === activeSection;
    const count = counts?.[item.id as keyof typeof counts] ?? 0;
    return (
      <SidebarContent.RailItem
        key={item.id}
        aria-label={item.label}
        title={item.label}
        active={isActive}
        indicatorTone={count > 0 ? "accent" : undefined}
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
        collapsible
        contentIdentity="lifeops"
        syncId="lifeops-sidebar"
        collapseButtonAriaLabel="Collapse LifeOps sidebar"
        expandButtonAriaLabel="Expand LifeOps sidebar"
        header={undefined}
        className="!mt-0 !h-full !w-full !min-w-0 xl:!w-full xl:!min-w-0 !bg-none !bg-transparent !rounded-none !border-0 !shadow-none !backdrop-blur-none !ring-0"
        headerClassName="!h-0 !min-h-0 !p-0 !m-0 !overflow-hidden"
        collapseButtonClassName="!h-7 !w-7 !border-0 !bg-transparent !shadow-none hover:!bg-bg-muted/60"
        aria-label="LifeOps sections"
        collapsedRailItems={collapsedRailItems}
      >
      <SidebarScrollRegion className="px-1 pb-3 pt-0">
        <SidebarPanel className="bg-transparent gap-0 p-0 shadow-none">
          <div className="px-3 pb-2 pt-1">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500/30 via-blue-500/25 to-emerald-500/25 text-violet-200 ring-1 ring-inset ring-white/8">
                <Sparkles className="h-3.5 w-3.5" aria-hidden />
              </span>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-txt">
                  LifeOps
                </div>
                <div className="truncate text-[11px] text-muted">
                  Your week at a glance
                </div>
              </div>
            </div>
          </div>

          <div className="mt-1 space-y-3">
            {NAV_GROUPS.map((group) => (
              <div key={group.key}>
                <SidebarContent.SectionHeader className="px-3 !mb-1">
                  <SidebarContent.SectionLabel className="text-[0.625rem]">
                    {group.label}
                  </SidebarContent.SectionLabel>
                </SidebarContent.SectionHeader>
                <div className="space-y-0.5 px-1">
                  {group.items.map((item) => {
                    const isActive = item.id === activeSection;
                    const count = counts?.[item.id as keyof typeof counts] ?? 0;
                    return (
                      <TooltipHint
                        key={item.id}
                        content={item.label}
                        side="right"
                      >
                        <button
                          type="button"
                          aria-label={item.label}
                          aria-current={isActive ? "page" : undefined}
                          onClick={() => onNavigate(item.id)}
                          data-sidebar-item
                          className={[
                            "group flex w-full min-w-0 items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left transition-colors",
                            isActive
                              ? "bg-accent/15 text-txt"
                              : "text-txt hover:bg-bg-muted/50",
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
                          <span className="min-w-0 flex-1 truncate text-xs-tight font-medium">
                            {item.label}
                          </span>
                          {count > 0 ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-bg-muted/60 px-1.5 py-0.5 text-[10px] font-semibold text-muted">
                              <span
                                className={`h-1.5 w-1.5 rounded-full ${item.dotColor}`}
                              />
                              {count}
                            </span>
                          ) : (
                            <span
                              aria-hidden
                              className={`h-1.5 w-1.5 rounded-full ${item.dotColor} opacity-60`}
                            />
                          )}
                        </button>
                      </TooltipHint>
                    );
                  })}
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

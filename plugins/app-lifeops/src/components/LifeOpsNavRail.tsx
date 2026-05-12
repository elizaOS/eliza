import {
  Sidebar,
  SidebarContent,
  SidebarPanel,
  SidebarScrollRegion,
  TooltipHint,
  TooltipProvider,
} from "@elizaos/ui";
import {
  BriefcaseBusiness,
  CalendarDays,
  CreditCard,
  FileText,
  LayoutDashboard,
  Mail,
  MessageSquare,
  Monitor,
  Moon,
  Settings2,
} from "lucide-react";
import type { ReactNode } from "react";
import type { LifeOpsSection } from "../hooks/useLifeOpsSection.js";

interface LifeOpsNavRailProps {
  activeSection: LifeOpsSection;
  onNavigate: (section: LifeOpsSection) => void;
  collapsible?: boolean;
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
        id: "sleep",
        label: "Sleep",
        icon: <Moon className="h-4 w-4" aria-hidden />,
        dotColor: "bg-blue-300",
      },
      {
        id: "screen-time",
        label: "Screen Time",
        icon: <Monitor className="h-4 w-4" aria-hidden />,
        dotColor: "bg-amber-300",
      },
      {
        id: "messages",
        label: "Messages",
        icon: <MessageSquare className="h-4 w-4" aria-hidden />,
        dotColor: "bg-emerald-400",
      },
      {
        id: "mail",
        label: "Mail",
        icon: <Mail className="h-4 w-4" aria-hidden />,
        dotColor: "bg-rose-400",
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
        icon: <BriefcaseBusiness className="h-4 w-4" aria-hidden />,
        dotColor: "bg-amber-400",
      },
      {
        id: "money",
        label: "Money",
        icon: <CreditCard className="h-4 w-4" aria-hidden />,
        dotColor: "bg-green-400",
      },
      {
        id: "documents",
        label: "Documents",
        icon: <FileText className="h-4 w-4" aria-hidden />,
        dotColor: "bg-cyan-400",
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

const NAV_ITEMS = NAV_GROUPS.flatMap((group) => group.items);

export function LifeOpsNavRail({
  activeSection,
  onNavigate,
  collapsible = true,
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
                    {group.items.map((item) => {
                      const isActive = item.id === activeSection;
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
                            <span
                              aria-hidden
                              className={`h-1.5 w-1.5 rounded-full ${item.dotColor} opacity-60`}
                            />
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

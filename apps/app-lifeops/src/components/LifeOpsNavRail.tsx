import { TooltipHint } from "@elizaos/app-core";
import {
  Bell,
  CalendarDays,
  Inbox,
  LayoutDashboard,
  Settings2,
} from "lucide-react";
import type { LifeOpsSection } from "../hooks/useLifeOpsSection.js";

interface NavItem {
  id: LifeOpsSection;
  label: string;
  icon: React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    icon: <LayoutDashboard className="h-5 w-5" />,
  },
  {
    id: "calendar",
    label: "Calendar",
    icon: <CalendarDays className="h-5 w-5" />,
  },
  {
    id: "inbox",
    label: "Inbox",
    icon: <Inbox className="h-5 w-5" />,
  },
  {
    id: "reminders",
    label: "Reminders",
    icon: <Bell className="h-5 w-5" />,
  },
  {
    id: "settings",
    label: "Settings",
    icon: <Settings2 className="h-5 w-5" />,
  },
];

interface LifeOpsNavRailProps {
  activeSection: LifeOpsSection;
  onNavigate: (section: LifeOpsSection) => void;
}

export function LifeOpsNavRail({
  activeSection,
  onNavigate,
}: LifeOpsNavRailProps) {
  return (
    <nav
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border/12 bg-bg/60 py-3"
      aria-label="LifeOps sections"
      data-testid="lifeops-nav-rail"
    >
      {NAV_ITEMS.map((item) => {
        const isActive = item.id === activeSection;
        return (
          <TooltipHint key={item.id} content={item.label} side="right">
            <button
              type="button"
              aria-label={item.label}
              aria-current={isActive ? "page" : undefined}
              onClick={() => onNavigate(item.id)}
              className={[
                "flex h-10 w-10 items-center justify-center rounded-xl transition-colors",
                isActive
                  ? "bg-accent/12 text-accent"
                  : "text-muted hover:bg-bg/80 hover:text-txt",
              ].join(" ")}
            >
              {item.icon}
            </button>
          </TooltipHint>
        );
      })}
    </nav>
  );
}

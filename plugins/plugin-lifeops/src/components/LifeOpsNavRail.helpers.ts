// Nav-rail group/item data for the LifeOps workspace sidebar. Kept out of
// LifeOpsNavRail.tsx so that file exports only React components and stays
// Fast-Refresh-compatible in dev. Icons are built with `createElement` (rather
// than JSX) so this module can be a plain `.ts` sibling.

import {
  BriefcaseBusiness,
  CalendarDays,
  CreditCard,
  FileText,
  LayoutDashboard,
  Mail,
  MessageSquare,
  MessageSquareText,
  Settings2,
} from "lucide-react";
import { createElement, type ReactNode } from "react";
import type { LifeOpsSection } from "../hooks/useLifeOpsSection.js";

export interface NavGroup {
  key: string;
  label: string;
  items: NavItem[];
}

export interface NavItem {
  id: LifeOpsSection;
  label: string;
  icon: ReactNode;
  dotColor: string;
}

const iconProps = { className: "h-4 w-4", "aria-hidden": true } as const;

export const NAV_GROUPS: NavGroup[] = [
  {
    key: "today",
    label: "Assistant",
    items: [
      {
        id: "assistant",
        label: "Assistant",
        icon: createElement(MessageSquareText, iconProps),
        dotColor: "bg-amber-300",
      },
      {
        id: "overview",
        label: "Overview",
        icon: createElement(LayoutDashboard, iconProps),
        dotColor: "bg-violet-400",
      },
      {
        id: "messages",
        label: "Messages",
        icon: createElement(MessageSquare, iconProps),
        dotColor: "bg-emerald-400",
      },
      {
        id: "mail",
        label: "Mail",
        icon: createElement(Mail, iconProps),
        dotColor: "bg-rose-400",
      },
      {
        id: "calendar",
        label: "Calendar",
        icon: createElement(CalendarDays, iconProps),
        dotColor: "bg-blue-400",
      },
      {
        id: "reminders",
        label: "Reminders",
        icon: createElement(BriefcaseBusiness, iconProps),
        dotColor: "bg-amber-400",
      },
      {
        id: "money",
        label: "Money",
        icon: createElement(CreditCard, iconProps),
        dotColor: "bg-green-400",
      },
      {
        id: "documents",
        label: "Documents",
        icon: createElement(FileText, iconProps),
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
        icon: createElement(Settings2, iconProps),
        dotColor: "bg-rose-400",
      },
    ],
  },
];

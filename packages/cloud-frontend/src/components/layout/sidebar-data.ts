/**
 * Sidebar navigation configuration defining sidebar sections and items.
 * Includes navigation structure with icons, labels, badges, and permission settings.
 */
import { HomeIcon } from "@radix-ui/react-icons";
import {
  BarChart3,
  BookOpen,
  Bot,
  Boxes,
  Code,
  Coins,
  Grid3x3,
  KeyRound,
  Puzzle,
  Server,
  Settings,
  Shield,
  UserCircle,
  UserCog,
  Wallet,
} from "lucide-react";

import type { ComponentType } from "react";
import type { FeatureFlag } from "@/lib/config/feature-flags";

export interface SidebarItem {
  id: string;
  label: string;
  href: string;
  icon: ComponentType<{ className?: string }>;
  badge?: string | number;
  isNew?: boolean;
  freeAllowed?: boolean;
  featureFlag?: FeatureFlag;
  adminOnly?: boolean; // Only show for admin users
  superAdminOnly?: boolean; // Only show for super_admin role
  comingSoon?: boolean; // Show as disabled with "soon" tag
}

export interface SidebarSection {
  title?: string;
  items: SidebarItem[];
  adminOnly?: boolean; // Only show section for admin users
}

export const sidebarSections: SidebarSection[] = [
  {
    items: [
      {
        id: "dashboard",
        label: "Dashboard",
        href: "/dashboard",
        icon: HomeIcon,
      },
      {
        id: "my-agent",
        label: "My Agent",
        href: "/dashboard/my-agents",
        icon: Bot,
        freeAllowed: false, // Requires signup
      },
    ],
  },
  {
    title: "Runtime Dashboard",
    items: [
      {
        id: "api-explorer",
        label: "API Explorer",
        href: "/dashboard/api-explorer",
        icon: Code,
        freeAllowed: false, // Requires signup
      },
      {
        id: "api-keys",
        label: "API Keys",
        href: "/dashboard/api-keys",
        icon: KeyRound,
        freeAllowed: false,
      },
      {
        id: "docs",
        label: "Docs",
        href: "/docs",
        icon: BookOpen,
        freeAllowed: true,
      },
      {
        id: "agent",
        label: "Instances",
        href: "/dashboard/agents",
        icon: Boxes,
        freeAllowed: false,
      },
      {
        id: "mcps",
        label: "MCPs",
        href: "/dashboard/mcps",
        icon: Puzzle,
        freeAllowed: false,
        featureFlag: "mcp",
      },
      {
        id: "containers",
        label: "Containers",
        href: "/dashboard/containers",
        icon: Server,
        freeAllowed: false,
      },
    ],
  },
  {
    title: "Account",
    items: [
      {
        id: "settings",
        label: "Settings",
        href: "/dashboard/settings",
        icon: Settings,
        freeAllowed: false,
      },
      {
        id: "account",
        label: "Account",
        href: "/dashboard/account",
        icon: UserCircle,
        freeAllowed: false,
      },
    ],
  },
  {
    title: "Monetization",
    items: [
      {
        id: "apps",
        label: "My Apps",
        href: "/dashboard/apps",
        icon: Grid3x3,
        freeAllowed: false,
      },
      {
        id: "earnings",
        label: "Earnings",
        href: "/dashboard/earnings",
        icon: Coins,
        freeAllowed: false,
        isNew: true,
      },
      {
        id: "affiliates",
        label: "Affiliates",
        href: "/dashboard/affiliates",
        icon: UserCog,
        freeAllowed: false,
      },
      {
        id: "billing",
        label: "Billing",
        href: "/dashboard/billing",
        icon: Wallet,
        freeAllowed: false,
      },
      {
        id: "analytics",
        label: "Analytics",
        href: "/dashboard/analytics",
        icon: BarChart3,
        freeAllowed: false,
      },
    ],
  },
  {
    title: "Admin",
    adminOnly: true, // Only visible to admin users
    items: [
      {
        id: "admin-moderation",
        label: "Moderation",
        href: "/dashboard/admin",
        icon: Shield,
        freeAllowed: false,
        adminOnly: true,
      },
      {
        id: "admin-redemptions",
        label: "Redemptions",
        href: "/dashboard/admin/redemptions",
        icon: Coins,
        freeAllowed: false,
        adminOnly: true,
      },
      {
        id: "admin-metrics",
        label: "Metrics",
        href: "/dashboard/admin/metrics",
        icon: BarChart3,
        freeAllowed: false,
        adminOnly: true,
        superAdminOnly: true,
      },
      {
        id: "admin-infrastructure",
        label: "Infrastructure",
        href: "/dashboard/admin/infrastructure",
        icon: Server,
        freeAllowed: false,
        adminOnly: true,
        superAdminOnly: true,
      },
    ],
  },
];

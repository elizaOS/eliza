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

export type SidebarTranslator = (
  key: string,
  vars?: Record<string, unknown>,
) => string;

/**
 * Build the dashboard sidebar tree, translating section titles and item
 * labels through the supplied translator. Pass the result of `useT()` from
 * `@/providers/I18nProvider` so labels track the active UI language.
 */
export function getSidebarSections(t: SidebarTranslator): SidebarSection[] {
  return [
    {
      items: [
        {
          id: "dashboard",
          label: t("cloud.nav.dashboard", { defaultValue: "Dashboard" }),
          href: "/dashboard",
          icon: HomeIcon,
        },
        {
          id: "my-agent",
          label: t("cloud.nav.myAgent", { defaultValue: "My Agent" }),
          href: "/dashboard/my-agents",
          icon: Bot,
          freeAllowed: false,
        },
      ],
    },
    {
      title: t("cloud.nav.section.runtimeDashboard", {
        defaultValue: "Runtime Dashboard",
      }),
      items: [
        {
          id: "api-explorer",
          label: t("cloud.nav.apiExplorer", { defaultValue: "API Explorer" }),
          href: "/dashboard/api-explorer",
          icon: Code,
          freeAllowed: false,
        },
        {
          id: "api-keys",
          label: t("cloud.nav.apiKeys", { defaultValue: "API Keys" }),
          href: "/dashboard/api-keys",
          icon: KeyRound,
          freeAllowed: false,
        },
        {
          id: "docs",
          label: t("cloud.nav.docs", { defaultValue: "Docs" }),
          href: "/docs",
          icon: BookOpen,
          freeAllowed: true,
        },
        {
          id: "agent",
          label: t("cloud.nav.instances", { defaultValue: "Instances" }),
          href: "/dashboard/agents",
          icon: Boxes,
          freeAllowed: false,
        },
        {
          id: "mcps",
          label: t("cloud.nav.mcps", { defaultValue: "MCPs" }),
          href: "/dashboard/mcps",
          icon: Puzzle,
          freeAllowed: false,
          featureFlag: "mcp",
        },
        {
          id: "containers",
          label: t("cloud.nav.containers", { defaultValue: "Containers" }),
          href: "/dashboard/containers",
          icon: Server,
          freeAllowed: false,
        },
      ],
    },
    {
      title: t("cloud.nav.section.account", { defaultValue: "Account" }),
      items: [
        {
          id: "settings",
          label: t("cloud.nav.settings", { defaultValue: "Settings" }),
          href: "/dashboard/settings",
          icon: Settings,
          freeAllowed: false,
        },
        {
          id: "account",
          label: t("cloud.nav.account", { defaultValue: "Account" }),
          href: "/dashboard/account",
          icon: UserCircle,
          freeAllowed: false,
        },
        {
          id: "security",
          label: t("cloud.nav.security", { defaultValue: "Security" }),
          href: "/dashboard/security",
          icon: Shield,
          freeAllowed: false,
        },
      ],
    },
    {
      title: t("cloud.nav.section.monetization", {
        defaultValue: "Monetization",
      }),
      items: [
        {
          id: "apps",
          label: t("cloud.nav.myApps", { defaultValue: "My Apps" }),
          href: "/dashboard/apps",
          icon: Grid3x3,
          freeAllowed: false,
        },
        {
          id: "earnings",
          label: t("cloud.nav.earnings", { defaultValue: "Earnings" }),
          href: "/dashboard/earnings",
          icon: Coins,
          freeAllowed: false,
          isNew: true,
        },
        {
          id: "affiliates",
          label: t("cloud.nav.affiliates", { defaultValue: "Affiliates" }),
          href: "/dashboard/affiliates",
          icon: UserCog,
          freeAllowed: false,
        },
        {
          id: "billing",
          label: t("cloud.nav.billing", { defaultValue: "Billing" }),
          href: "/dashboard/billing",
          icon: Wallet,
          freeAllowed: false,
        },
        {
          id: "analytics",
          label: t("cloud.nav.analytics", { defaultValue: "Analytics" }),
          href: "/dashboard/analytics",
          icon: BarChart3,
          freeAllowed: false,
        },
      ],
    },
    {
      title: t("cloud.nav.section.admin", { defaultValue: "Admin" }),
      adminOnly: true,
      items: [
        {
          id: "admin-moderation",
          label: t("cloud.nav.moderation", { defaultValue: "Moderation" }),
          href: "/dashboard/admin",
          icon: Shield,
          freeAllowed: false,
          adminOnly: true,
        },
        {
          id: "admin-redemptions",
          label: t("cloud.nav.redemptions", { defaultValue: "Redemptions" }),
          href: "/dashboard/admin/redemptions",
          icon: Coins,
          freeAllowed: false,
          adminOnly: true,
        },
        {
          id: "admin-metrics",
          label: t("cloud.nav.metrics", { defaultValue: "Metrics" }),
          href: "/dashboard/admin/metrics",
          icon: BarChart3,
          freeAllowed: false,
          adminOnly: true,
          superAdminOnly: true,
        },
        {
          id: "admin-infrastructure",
          label: t("cloud.nav.infrastructure", {
            defaultValue: "Infrastructure",
          }),
          href: "/dashboard/admin/infrastructure",
          icon: Server,
          freeAllowed: false,
          adminOnly: true,
          superAdminOnly: true,
        },
      ],
    },
  ];
}

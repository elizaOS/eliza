/**
 * Storybook stories for a collapsible dashboard sidebar section.
 */
import type { Meta, StoryObj } from "@storybook/react";
import {
  BarChart3,
  Bot,
  CreditCard,
  Home,
  Key,
  Settings,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import { DashboardSidebarNavigationSection } from "./dashboard-sidebar-section";
import type { DashboardSidebarSection } from "./dashboard-sidebar-types";

const generalSection: DashboardSidebarSection = {
  title: "General",
  items: [
    { id: "home", label: "Home", href: "/dashboard", icon: Home },
    { id: "agents", label: "Agents", href: "/dashboard/agents", icon: Bot },
    {
      id: "analytics",
      label: "Analytics",
      href: "/dashboard/analytics",
      icon: BarChart3,
      badge: 12,
    },
  ],
};

const monetizationSection: DashboardSidebarSection = {
  title: "Monetization",
  items: [
    {
      id: "billing",
      label: "Billing",
      href: "/dashboard/billing",
      icon: CreditCard,
    },
    {
      id: "rewards",
      label: "Rewards",
      href: "/dashboard/rewards",
      icon: Sparkles,
      isNew: true,
    },
    {
      id: "team",
      label: "Team",
      href: "/dashboard/team",
      icon: Users,
      freeAllowed: false,
    },
  ],
};

const adminSection: DashboardSidebarSection = {
  title: "Admin",
  adminOnly: true,
  items: [
    {
      id: "keys",
      label: "API Keys",
      href: "/dashboard/admin/keys",
      icon: Key,
      adminOnly: true,
    },
    {
      id: "security",
      label: "Security",
      href: "/dashboard/admin/security",
      icon: ShieldCheck,
      superAdminOnly: true,
    },
    {
      id: "settings",
      label: "Settings",
      href: "/dashboard/admin/settings",
      icon: Settings,
      comingSoon: true,
    },
  ],
};

const SidebarFrame = ({ children }: { children: React.ReactNode }) => (
  <div
    className="w-72 bg-neutral-950 p-4"
    style={{ minHeight: 360, color: "white" }}
  >
    {children}
  </div>
);

const meta = {
  title: "CloudUI/Layout/DashboardSidebarSection",
  component: DashboardSidebarNavigationSection,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <SidebarFrame>
        <Story />
      </SidebarFrame>
    ),
  ],
  args: {
    section: generalSection,
    activePath: "/dashboard/agents",
    authenticated: true,
  },
} satisfies Meta<typeof DashboardSidebarNavigationSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Monetization: Story = {
  args: {
    section: monetizationSection,
    activePath: "/dashboard/billing",
  },
};

export const Collapsed: Story = {
  args: {
    section: generalSection,
    isCollapsed: true,
  },
  decorators: [
    (Story) => (
      <div
        className="w-16 bg-neutral-950 p-2"
        style={{ minHeight: 360, color: "white" }}
      >
        <Story />
      </div>
    ),
  ],
};

export const UnauthenticatedLocked: Story = {
  args: {
    section: monetizationSection,
    authenticated: false,
    activePath: "/dashboard",
  },
};

export const AdminWithSuperAdmin: Story = {
  args: {
    section: adminSection,
    activePath: "/dashboard/admin/keys",
    isAdmin: true,
    adminRole: "super_admin",
  },
};

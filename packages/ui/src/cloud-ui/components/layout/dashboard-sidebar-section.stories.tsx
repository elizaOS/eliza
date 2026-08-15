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
    { id: "home", label: "Home", href: "/cloud", icon: Home },
    { id: "agents", label: "Agents", href: "/cloud/agents", icon: Bot },
    {
      id: "analytics",
      label: "Analytics",
      href: "/cloud/analytics",
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
      href: "/cloud/billing",
      icon: CreditCard,
    },
    {
      id: "rewards",
      label: "Rewards",
      href: "/cloud/rewards",
      icon: Sparkles,
      isNew: true,
    },
    {
      id: "team",
      label: "Team",
      href: "/cloud/team",
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
      href: "/cloud/admin/keys",
      icon: Key,
      adminOnly: true,
    },
    {
      id: "security",
      label: "Security",
      href: "/cloud/admin/security",
      icon: ShieldCheck,
      superAdminOnly: true,
    },
    {
      id: "settings",
      label: "Settings",
      href: "/cloud/admin/settings",
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
    activePath: "/cloud/agents",
    authenticated: true,
  },
} satisfies Meta<typeof DashboardSidebarNavigationSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Monetization: Story = {
  args: {
    section: monetizationSection,
    activePath: "/cloud/billing",
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
    activePath: "/cloud",
  },
};

export const AdminWithSuperAdmin: Story = {
  args: {
    section: adminSection,
    activePath: "/cloud/admin/keys",
    isAdmin: true,
    adminRole: "super_admin",
  },
};

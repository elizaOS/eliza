import type { Meta, StoryObj } from "@storybook/react";
import { BarChart3, Bot, Home, Settings, Sparkles, Wallet } from "lucide-react";
import { TooltipProvider } from "../../../components/ui/tooltip";
import { DashboardSidebarNavigationItem } from "./dashboard-sidebar-item";
import type { DashboardSidebarItem } from "./dashboard-sidebar-types";

const baseItem: DashboardSidebarItem = {
  id: "agents",
  label: "Agents",
  href: "/dashboard/agents",
  icon: Bot,
};

const meta = {
  title: "CloudUI/Layout/DashboardSidebarItem",
  component: DashboardSidebarNavigationItem,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <TooltipProvider>
        <div
          style={{
            background: "#0a0a0a",
            padding: "16px",
            width: 260,
            fontFamily: "var(--font-roboto-mono, monospace)",
          }}
        >
          <Story />
        </div>
      </TooltipProvider>
    ),
  ],
  args: {
    item: baseItem,
    activePath: "/dashboard",
    authenticated: true,
    isCollapsed: false,
  },
} satisfies Meta<typeof DashboardSidebarNavigationItem>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Active: Story = {
  args: {
    item: {
      ...baseItem,
      id: "home",
      label: "Home",
      href: "/dashboard",
      icon: Home,
    },
    activePath: "/dashboard",
  },
};

export const WithNewBadge: Story = {
  args: {
    item: {
      id: "analytics",
      label: "Analytics",
      href: "/dashboard/analytics",
      icon: BarChart3,
      isNew: true,
    },
  },
};

export const WithCountBadge: Story = {
  args: {
    item: {
      id: "wallet",
      label: "Wallet",
      href: "/dashboard/wallet",
      icon: Wallet,
      badge: 3,
    },
  },
};

export const ComingSoon: Story = {
  args: {
    item: {
      id: "magic",
      label: "Magic Mode",
      href: "/dashboard/magic",
      icon: Sparkles,
      comingSoon: true,
    },
  },
};

export const LockedForGuest: Story = {
  args: {
    item: {
      id: "settings",
      label: "Settings",
      href: "/dashboard/settings",
      icon: Settings,
      freeAllowed: false,
    },
    authenticated: false,
  },
};

export const Collapsed: Story = {
  args: {
    isCollapsed: true,
  },
  decorators: [
    (Story) => (
      <TooltipProvider>
        <div
          style={{
            background: "#0a0a0a",
            padding: "16px",
            width: 64,
            fontFamily: "var(--font-roboto-mono, monospace)",
          }}
        >
          <Story />
        </div>
      </TooltipProvider>
    ),
  ],
};

export const CollapsedActive: Story = {
  args: {
    item: {
      ...baseItem,
      id: "home",
      label: "Home",
      href: "/dashboard",
      icon: Home,
    },
    activePath: "/dashboard",
    isCollapsed: true,
  },
  decorators: [
    (Story) => (
      <TooltipProvider>
        <div
          style={{
            background: "#0a0a0a",
            padding: "16px",
            width: 64,
            fontFamily: "var(--font-roboto-mono, monospace)",
          }}
        >
          <Story />
        </div>
      </TooltipProvider>
    ),
  ],
};

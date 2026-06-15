import type { Meta, StoryObj } from "@storybook/react";
import {
  BarChart3,
  Bot,
  Home,
  Lock,
  MessageSquare,
  Settings,
  Sparkles,
  Users,
  Wallet,
} from "lucide-react";
import { DashboardSidebar } from "./dashboard-sidebar";
import type { DashboardSidebarSection } from "./dashboard-sidebar-types";

const noop = () => {};

const sections: DashboardSidebarSection[] = [
  {
    items: [
      { id: "home", label: "Home", href: "/", icon: Home },
      {
        id: "agents",
        label: "Agents",
        href: "/agents",
        icon: Bot,
        badge: 3,
      },
      {
        id: "chat",
        label: "Chat",
        href: "/chat",
        icon: MessageSquare,
        isNew: true,
      },
    ],
  },
  {
    title: "Workspace",
    items: [
      { id: "team", label: "Team", href: "/team", icon: Users },
      { id: "wallet", label: "Wallet", href: "/wallet", icon: Wallet },
      {
        id: "analytics",
        label: "Analytics",
        href: "/analytics",
        icon: BarChart3,
        badge: "Beta",
      },
    ],
  },
  {
    title: "Admin",
    adminOnly: true,
    items: [
      {
        id: "settings",
        label: "Settings",
        href: "/admin/settings",
        icon: Settings,
        adminOnly: true,
      },
      {
        id: "secrets",
        label: "Secrets",
        href: "/admin/secrets",
        icon: Lock,
        superAdminOnly: true,
      },
    ],
  },
];

const Logo = () => (
  <div className="flex items-center gap-2 text-white">
    <Sparkles className="h-5 w-5 text-orange-400" />
    <span className="text-sm font-semibold tracking-wide">elizaOS</span>
  </div>
);

const Footer = () => (
  <div className="border-t border-white/10 px-4 py-3 text-xs text-white/60">
    <div className="flex items-center gap-2">
      <img
        src="https://placehold.co/24x24/orange/white?text=E"
        alt="avatar"
        className="h-6 w-6 rounded-full"
      />
      <div className="flex flex-col">
        <span className="text-white">jane@eliza.dev</span>
        <span className="text-white/40">Pro plan</span>
      </div>
    </div>
  </div>
);

const meta = {
  title: "CloudUI/Layout/DashboardSidebar",
  component: DashboardSidebar,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    backgrounds: { default: "dark" },
  },
  decorators: [
    (Story) => (
      <div className="flex min-h-dvh bg-neutral-950 text-white">
        <Story />
        <div className="flex-1 p-8 text-sm text-white/60">
          <p>Main content area (sidebar preview).</p>
        </div>
      </div>
    ),
  ],
  args: {
    sections,
    activePath: "/agents",
    authenticated: true,
    logo: <Logo />,
    footer: <Footer />,
  },
} satisfies Meta<typeof DashboardSidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Unauthenticated: Story = {
  args: {
    authenticated: false,
    activePath: "/",
  },
};

export const AdminView: Story = {
  args: {
    isAdmin: true,
    adminRole: "super-admin",
    activePath: "/admin/settings",
  },
};

export const MobileOpen: Story = {
  args: {
    isOpen: true,
    onToggle: noop,
  },
  parameters: {
    viewport: { defaultViewport: "mobile1" },
  },
};

export const Minimal: Story = {
  args: {
    sections: [
      {
        items: [
          { id: "home", label: "Home", href: "/", icon: Home },
          { id: "chat", label: "Chat", href: "/chat", icon: MessageSquare },
        ],
      },
    ],
    logo: undefined,
    footer: undefined,
    activePath: "/",
  },
};

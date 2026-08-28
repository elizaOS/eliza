/**
 * Storybook stories for the cloud DashboardHeader.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { Bell, Plus, Search } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { DashboardHeader } from "./dashboard-header";

const meta = {
  title: "CloudUI/Layout/DashboardHeader",
  component: DashboardHeader,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    backgrounds: { default: "dark" },
  },
  args: {
    onToggleSidebar: () => {},
  },
  decorators: [
    (Story) => (
      <div className="min-h-[200px] bg-black text-white">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DashboardHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    pageInfo: { title: "Overview" },
  },
};

export const WithActions: Story = {
  args: {
    pageInfo: {
      title: "Agents",
      actions: (
        <div className="flex items-center gap-2">
          <Button
            aria-label="Search"
            variant="ghost"
            size="icon"
            className="size-8"
          >
            <Search className="size-4" />
          </Button>
          <Button variant="default" className="h-8 gap-2 px-3">
            <Plus className="size-4" />
            <span>New Agent</span>
          </Button>
        </div>
      ),
    },
  },
};

export const Anonymous: Story = {
  args: {
    pageInfo: { title: "Explore" },
    isAnonymous: true,
    loginHref: "/login",
  },
};

export const AnonymousWithCustomCta: Story = {
  args: {
    pageInfo: { title: "Pricing" },
    isAnonymous: true,
    anonymousCta: (
      <Button variant="default" className="h-8 px-3 md:h-10 md:px-4">
        Get Started
      </Button>
    ),
  },
};

export const WithRightContent: Story = {
  args: {
    pageInfo: { title: "Dashboard" },
    rightContent: (
      <div className="flex items-center gap-2">
        <Button
          aria-label="Notifications"
          variant="ghost"
          size="icon"
          className="size-8"
        >
          <Bell className="size-4" />
        </Button>
        <div className="size-8 rounded-full bg-gradient-to-br from-orange-500 to-orange-700" />
      </div>
    ),
  },
};

export const LongTitle: Story = {
  args: {
    pageInfo: {
      title:
        "A really long page title that should truncate on smaller viewports",
      actions: (
        <Button variant="default" className="h-8 px-3">
          Save
        </Button>
      ),
    },
  },
};

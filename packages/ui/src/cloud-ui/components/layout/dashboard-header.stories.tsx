/**
 * Storybook stories for the cloud DashboardHeader.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { Bell, Plus, Search } from "lucide-react";
import { BrandButton } from "../brand";
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
          <BrandButton variant="ghost" size="icon" className="h-8 w-8">
            <Search className="h-4 w-4" />
          </BrandButton>
          <BrandButton variant="primary" className="h-8 gap-2 px-3">
            <Plus className="h-4 w-4" />
            <span>New Agent</span>
          </BrandButton>
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
      <BrandButton variant="primary" className="h-8 px-3 md:h-10 md:px-4">
        Get Started
      </BrandButton>
    ),
  },
};

export const WithRightContent: Story = {
  args: {
    pageInfo: { title: "Dashboard" },
    rightContent: (
      <div className="flex items-center gap-2">
        <BrandButton variant="ghost" size="icon" className="h-8 w-8">
          <Bell className="h-4 w-4" />
        </BrandButton>
        <div className="h-8 w-8 rounded-full bg-gradient-to-br from-orange-500 to-orange-700" />
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
        <BrandButton variant="primary" className="h-8 px-3">
          Save
        </BrandButton>
      ),
    },
  },
};

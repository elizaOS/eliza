import type { Meta, StoryObj } from "@storybook/react";
import { Bell, Inbox, MessageSquare, Sparkles, Zap } from "lucide-react";
import { PagePanelFeatureEmpty } from "./page-panel-feature-empty";

const meta = {
  title: "Composites/PagePanel/PagePanelFeatureEmpty",
  component: PagePanelFeatureEmpty,
  tags: ["autodocs"],
  argTypes: {
    title: { control: "text" },
    description: { control: "text" },
    iconTone: { control: "text" },
    variant: { control: "select", options: ["surface", "section", "inset"] },
  },
  args: {
    title: "No conversations yet",
    description:
      "Start a chat to see your message history here. Everything you send and receive will be collected in this panel.",
    icon: Inbox,
    variant: "surface",
  },
} satisfies Meta<typeof PagePanelFeatureEmpty>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithFeatures: Story = {
  args: {
    title: "Bring your workspace to life",
    description:
      "Connect a source and Eliza will start surfacing what matters most.",
    icon: Sparkles,
    features: [
      { id: "chat", label: "Continuous chat", icon: MessageSquare },
      { id: "alerts", label: "Smart alerts", icon: Bell },
      { id: "actions", label: "Quick actions", icon: Zap },
    ],
  },
};

export const TitleOnly: Story = {
  args: {
    title: "Nothing to show",
    description: undefined,
    icon: Inbox,
  },
};

export const SectionVariant: Story = {
  args: {
    title: "No alerts",
    description: "You're all caught up. New alerts will appear here.",
    icon: Bell,
    iconTone: "border-warning/25 bg-warning/12 text-warning",
    variant: "section",
  },
};

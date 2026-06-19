import type { Meta, StoryObj } from "@storybook/react";
import { SkillSidebarItem } from "./skill-sidebar-item";

const SparkIcon = () => (
  <span aria-hidden className="text-base leading-none">
    {"✨"}
  </span>
);

const meta = {
  title: "Composites/Skills/SkillSidebarItem",
  component: SkillSidebarItem,
  tags: ["autodocs"],
  argTypes: {
    active: { control: "boolean" },
    enabled: { control: "boolean" },
    name: { control: "text" },
    description: { control: "text" },
    onLabel: { control: "text" },
    offLabel: { control: "text" },
    attentionLabel: { control: "text" },
    onSelect: { action: "select" },
  },
  args: {
    active: false,
    enabled: true,
    name: "Daily Check-In",
    description: "Morning summary of your calendar, tasks, and energy.",
    onLabel: "ON",
    offLabel: "OFF",
    icon: <SparkIcon />,
    onSelect: () => {},
  },
  decorators: [
    (Story) => (
      <div
        style={{ width: 320 }}
        className="rounded-md border border-border bg-surface p-2"
      >
        <ul className="flex flex-col gap-1">
          <Story />
        </ul>
      </div>
    ),
  ],
} satisfies Meta<typeof SkillSidebarItem>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Active: Story = {
  args: {
    active: true,
    name: "Focus Mode",
    description: "Silences notifications and batches replies.",
  },
};

export const Disabled: Story = {
  args: {
    enabled: false,
    name: "Inbox Triage",
    description: "Sorts and labels incoming mail.",
  },
};

export const WithAttention: Story = {
  args: {
    enabled: true,
    active: false,
    name: "Calendar Sync",
    description: "Two-way sync with Google Calendar.",
    attentionLabel: "Action needed",
  },
};

export const NoDescription: Story = {
  args: {
    name: "Weather",
    description: undefined,
    enabled: true,
  },
};

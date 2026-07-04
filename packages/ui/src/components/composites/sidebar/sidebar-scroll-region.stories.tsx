/**
 * Storybook states for the Sidebar Scroll Region sidebar composite across
 * expanded, collapsed, and shell navigation layouts.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { SidebarScrollRegion } from "./sidebar-scroll-region";

const sampleItems = [
  "Design review",
  "Launch planning",
  "Standup notes",
  "Roadmap brainstorm",
  "Customer interviews",
  "Q3 OKR draft",
  "Hiring loop feedback",
  "Marketing copy review",
  "Pricing experiment",
  "Onboarding flow audit",
  "Support triage",
  "Engineering sync",
];

const ItemList = ({ count = sampleItems.length }: { count?: number }) => (
  <div className="flex flex-col gap-1">
    {sampleItems.slice(0, count).map((label) => (
      <button
        key={label}
        type="button"
        className="rounded-sm px-2 py-1.5 text-left text-sm text-txt hover:bg-black/10"
      >
        {label}
      </button>
    ))}
  </div>
);

const meta = {
  title: "Composites/Sidebar/SidebarScrollRegion",
  component: SidebarScrollRegion,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="flex h-80 w-64 flex-col rounded-md border border-black/10 bg-bg">
        <Story />
      </div>
    ),
  ],
  argTypes: {
    variant: {
      control: "inline-radio",
      options: ["default", "mobile", "game-modal"],
    },
    className: { control: "text" },
    children: { control: false },
  },
  args: {
    variant: "default",
    children: <ItemList />,
  },
} satisfies Meta<typeof SidebarScrollRegion>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Mobile: Story = {
  args: {
    variant: "mobile",
  },
};

export const GameModal: Story = {
  args: {
    variant: "game-modal",
  },
};

export const ShortContent: Story = {
  args: {
    children: <ItemList count={3} />,
  },
};

export const Empty: Story = {
  args: {
    children: (
      <p className="px-1 py-4 text-center text-sm text-txt/60">
        No items to display
      </p>
    ),
  },
};

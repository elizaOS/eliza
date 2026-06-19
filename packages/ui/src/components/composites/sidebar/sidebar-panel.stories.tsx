import type { Meta, StoryObj } from "@storybook/react";
import { SidebarPanel } from "./sidebar-panel";

const meta = {
  title: "Composites/Sidebar/SidebarPanel",
  component: SidebarPanel,
  tags: ["autodocs"],
  argTypes: {
    variant: {
      control: "inline-radio",
      options: ["default", "mobile", "game-modal"],
    },
    children: { control: false },
    className: { control: "text" },
  },
  args: {
    variant: "default",
    children: (
      <>
        <h2 className="px-1 text-sm font-medium text-txt">Conversations</h2>
        <button
          type="button"
          className="rounded-sm px-2 py-1.5 text-left text-sm text-txt hover:bg-black/10"
        >
          Design review
        </button>
        <button
          type="button"
          className="rounded-sm px-2 py-1.5 text-left text-sm text-txt hover:bg-black/10"
        >
          Launch planning
        </button>
        <button
          type="button"
          className="rounded-sm px-2 py-1.5 text-left text-sm text-txt hover:bg-black/10"
        >
          Standup notes
        </button>
      </>
    ),
  },
} satisfies Meta<typeof SidebarPanel>;

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

export const Empty: Story = {
  args: {
    children: (
      <p className="px-1 py-4 text-center text-sm text-txt/60">
        No conversations yet
      </p>
    ),
  },
};

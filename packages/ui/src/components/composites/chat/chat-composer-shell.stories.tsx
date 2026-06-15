import type { Meta, StoryObj } from "@storybook/react";
import { ChatComposerShell } from "./chat-composer-shell";

const meta = {
  title: "Composites/Chat/ChatComposerShell",
  component: ChatComposerShell,
  tags: ["autodocs"],
  argTypes: {
    variant: { control: "select", options: ["default", "game-modal"] },
  },
  args: {
    variant: "default",
    children: (
      <div className="flex h-12 w-full items-center rounded-sm border border-border bg-card px-3 text-sm text-muted">
        Composer placeholder
      </div>
    ),
  },
} satisfies Meta<typeof ChatComposerShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const GameModal: Story = {
  args: { variant: "game-modal" },
};

export const WithBeforeSlot: Story = {
  args: {
    before: (
      <div className="mb-2 rounded-sm bg-bg-accent px-3 py-1.5 text-xs text-muted">
        Quoted: &quot;Lock the menu by Friday&quot;
      </div>
    ),
  },
};

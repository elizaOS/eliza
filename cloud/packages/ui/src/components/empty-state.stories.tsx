import type { Meta, StoryObj } from "@storybook/react";
import { Image as ImageIcon, KeyRound, Mic, Plus } from "lucide-react";
import { EmptyState } from "./empty-state";

const meta: Meta<typeof EmptyState> = {
  title: "Components/EmptyState",
  component: EmptyState,
};
export default meta;
type Story = StoryObj<typeof EmptyState>;

export const Default: Story = {
  args: {
    title: "No items yet",
    description: "Create your first item to get started.",
  },
};

export const WithIcon: Story = {
  args: {
    icon: <KeyRound className="h-7 w-7 text-[#FF5800]" />,
    title: "No API keys yet",
    description: "Create your first API key to start authenticating requests.",
    action: (
      <button className="inline-flex items-center gap-2 bg-[#FF5800] text-white px-4 py-2 text-sm">
        <Plus className="h-4 w-4" /> Create API Key
      </button>
    ),
  },
};

export const Dashed: Story = {
  args: {
    variant: "dashed",
    icon: <ImageIcon className="h-6 w-6 text-[#FF5800]" />,
    title: "Enter a prompt to generate",
  },
};

export const Minimal: Story = {
  args: {
    variant: "minimal",
    icon: <Mic className="h-7 w-7 text-[#FF5800]" />,
    title: "Create a Voice Clone",
    action: <button className="bg-[#FF5800] text-white px-6 py-2 text-sm">Get Started</button>,
  },
};

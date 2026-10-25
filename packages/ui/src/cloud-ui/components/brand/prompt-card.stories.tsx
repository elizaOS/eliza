/**
 * Storybook stories for PromptCard / PromptCardGrid.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { PromptCard, PromptCardGrid } from "./prompt-card";

const meta = {
  title: "CloudUI/Brand/PromptCard",
  component: PromptCard,
  tags: ["autodocs"],
  argTypes: {
    prompt: { control: "text" },
    onClick: { action: "clicked" },
  },
  args: {
    prompt: "Draft a launch announcement for our new agent platform.",
  },
} satisfies Meta<typeof PromptCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const ShortPrompt: Story = {
  args: {
    prompt: "Summarize today's news.",
  },
};

export const LongPrompt: Story = {
  args: {
    prompt:
      "Walk me through how to design a multi-agent workflow that coordinates research, drafting, and review steps with clear handoffs and error recovery.",
  },
};

export const InGrid: Story = {
  render: () => (
    <div className="max-w-3xl">
      <PromptCardGrid
        prompts={[
          "Plan a product launch checklist for next quarter.",
          "Brainstorm names for a new developer tool.",
          "Explain vector databases to a junior engineer.",
          "Write a friendly cold outreach email.",
          "Compare React Server Components vs. SSR.",
          "Draft release notes from a list of PR titles.",
        ]}
        onPromptClick={() => {}}
      />
    </div>
  ),
};

export const CustomClassName: Story = {
  args: {
    prompt: "Card with a wider min-height for visual emphasis.",
    className: "min-h-[120px]",
  },
};

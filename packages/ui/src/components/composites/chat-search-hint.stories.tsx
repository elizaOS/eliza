/** Empty-query and active-query states for chat-routed search guidance. */
import type { Meta, StoryObj } from "@storybook/react";
import { ChatSearchHint } from "./chat-search-hint";

const meta = {
  title: "Composites/ChatSearchHint",
  component: ChatSearchHint,
  parameters: { layout: "padded" },
  args: { noun: "memories" },
} satisfies Meta<typeof ChatSearchHint>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Prompt: Story = {};
export const ActiveFilter: Story = { args: { query: "launch notes" } };

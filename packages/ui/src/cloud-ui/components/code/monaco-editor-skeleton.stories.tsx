/**
 * Storybook stories for the Monaco editor loading skeleton.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { MonacoEditorSkeleton } from "./monaco-editor-skeleton";

const meta = {
  title: "CloudUI/Code/MonacoEditorSkeleton",
  component: MonacoEditorSkeleton,
  tags: ["autodocs"],
  argTypes: {
    height: { control: "text" },
  },
  args: {
    height: "320px",
  },
  decorators: [
    (Story) => (
      <div style={{ width: "640px" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MonacoEditorSkeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Short: Story = {
  args: {
    height: "120px",
  },
};

export const Tall: Story = {
  args: {
    height: "560px",
  },
};

export const FullHeightContainer: Story = {
  args: {
    height: "100%",
  },
  decorators: [
    (Story) => (
      <div style={{ width: "640px", height: "400px" }}>
        <Story />
      </div>
    ),
  ],
};

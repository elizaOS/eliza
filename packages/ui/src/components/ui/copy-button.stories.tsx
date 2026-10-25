/** Storybook fixture exercising the CopyButton primitive (copy + copied-feedback state); also feeds the story-gate render check. */
import type { Meta, StoryObj } from "@storybook/react";
import { CopyButton } from "./copy-button";

const meta = {
  title: "Primitives/CopyButton",
  component: CopyButton,
  tags: ["autodocs"],
  argTypes: {
    value: { control: "text" },
    feedbackDuration: { control: "number" },
    copyLabel: { control: "text" },
    copiedLabel: { control: "text" },
    children: { control: "text" },
    disabled: { control: "boolean" },
  },
  args: { value: "npm install @elizaos/ui" },
} satisfies Meta<typeof CopyButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithLabel: Story = {
  args: { children: "Copy" },
};

export const CustomFeedbackDuration: Story = {
  args: { children: "Copy", feedbackDuration: 5000 },
};

export const CustomLabels: Story = {
  args: { copyLabel: "Copy command", copiedLabel: "Command copied" },
};

export const Disabled: Story = {
  args: { children: "Copy", disabled: true },
};

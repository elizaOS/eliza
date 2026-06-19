import type { Meta, StoryObj } from "@storybook/react";
import { Textarea } from "./textarea";

const meta = {
  title: "Primitives/Textarea",
  component: Textarea,
  tags: ["autodocs"],
  argTypes: {
    variant: { control: "select", options: ["default", "form", "config"] },
    density: {
      control: "select",
      options: ["default", "compact", "relaxed"],
    },
    hasError: { control: "boolean" },
    disabled: { control: "boolean" },
    placeholder: { control: "text" },
  },
  args: {
    variant: "default",
    density: "default",
    placeholder: "Type your message...",
  },
} satisfies Meta<typeof Textarea>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Form: Story = {
  args: { variant: "form", placeholder: "Tell us more" },
};
export const Config: Story = {
  args: { variant: "config", defaultValue: '{ "key": "value" }' },
};
export const Compact: Story = { args: { density: "compact" } };
export const Relaxed: Story = { args: { density: "relaxed" } };
export const ErrorState: Story = {
  args: { hasError: true, defaultValue: "This field has an error" },
};
export const Disabled: Story = {
  args: { disabled: true, defaultValue: "Cannot edit this" },
};

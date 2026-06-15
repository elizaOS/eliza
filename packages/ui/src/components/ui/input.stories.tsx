import type { Meta, StoryObj } from "@storybook/react";
import { Input } from "./input";

const meta = {
  title: "Primitives/Input",
  component: Input,
  tags: ["autodocs"],
  argTypes: {
    variant: { control: "select", options: ["default", "form", "config"] },
    density: { control: "select", options: ["default", "compact", "relaxed"] },
    type: { control: "text" },
    placeholder: { control: "text" },
    hasError: { control: "boolean" },
    disabled: { control: "boolean" },
  },
  args: {
    variant: "default",
    density: "default",
    type: "text",
    placeholder: "Enter text...",
  },
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Form: Story = {
  args: { variant: "form", placeholder: "you@example.com" },
};
export const Config: Story = {
  args: { variant: "config", placeholder: "0x0000..." },
};
export const Compact: Story = { args: { density: "compact" } };
export const ErrorState: Story = {
  args: { hasError: true, value: "invalid value", readOnly: true },
};
export const Disabled: Story = { args: { disabled: true } };

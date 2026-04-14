import type { Meta, StoryObj } from "@storybook/react";
import { CopyButton } from "../components/ui/copy-button";

const meta = {
  title: "UI/CopyButton",
  component: CopyButton,
  tags: ["autodocs"],
  argTypes: {
    value: { control: "text" },
    children: { control: "text" },
  },
} satisfies Meta<typeof CopyButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { value: "Hello World" },
};

export const WithLabel: Story = {
  args: {
    value: "Hello World",
    children: "Copy",
  },
};

export const LongValue: Story = {
  args: {
    value: "0x1234567890abcdef1234567890abcdef12345678",
    children: "Copy Address",
  },
};

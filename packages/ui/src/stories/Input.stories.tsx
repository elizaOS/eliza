import type { Meta, StoryObj } from "@storybook/react";
import { Input } from "../components/ui/input";

const meta = {
  title: "UI/Input",
  component: Input,
  tags: ["autodocs"],
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {},
};

export const WithPlaceholder: Story = {
  args: {
    placeholder: "Enter your name...",
  },
};

export const Disabled: Story = {
  args: {
    disabled: true,
    value: "Cannot edit this",
  },
};

export const Password: Story = {
  args: {
    type: "password",
    placeholder: "Enter password...",
  },
};

export const WithValue: Story = {
  args: {
    defaultValue: "Hello, world!",
  },
};

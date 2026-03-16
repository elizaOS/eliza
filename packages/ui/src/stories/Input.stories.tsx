import type { Meta, StoryObj } from "@storybook/react";
import { Input } from "../components/ui/input";

const meta: Meta<typeof Input> = { title: "Atoms/Input", component: Input };
export default meta;
type Story = StoryObj<typeof Input>;

export const Default: Story = { args: { placeholder: "Type something…" } };
export const Filled: Story = { args: { defaultValue: "Hello world" } };
export const Disabled: Story = {
  args: { placeholder: "Locked", disabled: true },
};

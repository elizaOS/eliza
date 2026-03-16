import type { Meta, StoryObj } from "@storybook/react";
import { Textarea } from "../components/ui/textarea";

const meta: Meta<typeof Textarea> = {
  title: "Atoms/Textarea",
  component: Textarea,
};
export default meta;

export const Default: StoryObj = {
  args: { placeholder: "Enter system prompt…" },
};
export const Disabled: StoryObj = {
  args: { placeholder: "Locked", disabled: true },
};

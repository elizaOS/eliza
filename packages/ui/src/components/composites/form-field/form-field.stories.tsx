import type { Meta, StoryObj } from "@storybook/react";
import { Input } from "../../ui/input";
import { FormField } from "./form-field";

const meta = {
  title: "Composites/FormField",
  component: FormField,
  tags: ["autodocs"],
  argTypes: {
    label: { control: "text" },
    description: { control: "text" },
    density: {
      control: "select",
      options: ["default", "compact", "relaxed"],
    },
  },
  args: {
    label: "Display name",
    description: "Shown to other people in your workspace.",
    density: "default",
    children: (
      <Input id="display-name" variant="form" placeholder="Ada Lovelace" />
    ),
  },
} satisfies Meta<typeof FormField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithoutDescription: Story = {
  args: { description: undefined },
};

export const ErrorState: Story = {
  args: {
    errors: ["Display name is required."],
    children: (
      <Input id="display-name" variant="form" hasError placeholder="" />
    ),
  },
};

export const Compact: Story = {
  args: {
    density: "compact",
    children: (
      <Input
        id="display-name"
        variant="form"
        density="compact"
        placeholder="Ada Lovelace"
      />
    ),
  },
};

export const Relaxed: Story = {
  args: {
    density: "relaxed",
    children: (
      <Input
        id="display-name"
        variant="form"
        density="relaxed"
        placeholder="Ada Lovelace"
      />
    ),
  },
};

import type { Meta, StoryObj } from "@storybook/react";
import { SaveFooter } from "../components/ui/save-footer";

const meta = {
  title: "UI/SaveFooter",
  component: SaveFooter,
  tags: ["autodocs"],
  argTypes: {
    dirty: { control: "boolean" },
    saving: { control: "boolean" },
    saveError: { control: "text" },
    saveSuccess: { control: "boolean" },
    onSave: { action: "onSave" },
  },
  args: {
    dirty: true,
    saving: false,
    saveError: null,
    saveSuccess: false,
  },
} satisfies Meta<typeof SaveFooter>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    dirty: true,
    saving: false,
    saveError: null,
    saveSuccess: false,
  },
};

export const Saving: Story = {
  args: {
    dirty: true,
    saving: true,
    saveError: null,
    saveSuccess: false,
  },
};

export const WithError: Story = {
  args: {
    dirty: true,
    saving: false,
    saveError: "Failed to save. Please try again.",
    saveSuccess: false,
  },
};

export const Success: Story = {
  args: {
    dirty: true,
    saving: false,
    saveError: null,
    saveSuccess: true,
  },
};

export const NotDirty: Story = {
  args: {
    dirty: false,
    saving: false,
    saveError: null,
    saveSuccess: false,
  },
};

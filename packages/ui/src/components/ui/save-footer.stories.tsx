import type { Meta, StoryObj } from "@storybook/react";
import { SaveFooter } from "./save-footer";

const meta = {
  title: "Primitives/SaveFooter",
  component: SaveFooter,
  tags: ["autodocs"],
  argTypes: {
    dirty: { control: "boolean" },
    saving: { control: "boolean" },
    saveSuccess: { control: "boolean" },
    saveError: { control: "text" },
    saveLabel: { control: "text" },
    savingLabel: { control: "text" },
    savedLabel: { control: "text" },
    onSave: { action: "save" },
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

export const Default: Story = {};

export const Saving: Story = { args: { saving: true } };

export const Saved: Story = { args: { saveSuccess: true } };

export const ErrorState: Story = {
  args: { saveError: "Could not save changes. Try again." },
};

/** Returns null when there are no unsaved changes. */
export const Clean: Story = { args: { dirty: false } };

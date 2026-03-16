import type { Meta, StoryObj } from "@storybook/react";
import React from "react";
import { SaveFooter } from "../components/ui/save-footer";

const meta: Meta<typeof SaveFooter> = {
  title: "Molecules/SaveFooter",
  component: SaveFooter,
};
export default meta;

export const Dirty: StoryObj = {
  args: {
    dirty: true,
    saving: false,
    saveError: null,
    saveSuccess: false,
    onSave: () => {},
  },
};
export const Saving: StoryObj = {
  args: {
    dirty: true,
    saving: true,
    saveError: null,
    saveSuccess: false,
    onSave: () => {},
  },
};
export const Error: StoryObj = {
  args: {
    dirty: true,
    saving: false,
    saveError: "Network error",
    saveSuccess: false,
    onSave: () => {},
  },
};

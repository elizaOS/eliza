/**
 * Storybook stories for the text input primitive.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { Input } from "./input";

const meta = {
  title: "Primitives/Input",
  component: Input,
  tags: ["autodocs"],
  argTypes: {
    variant: {
      control: "select",
      options: [
        "default",
        "form",
        "config",
        "embeddedToken",
        "nativeFileHidden",
        "nativeFileDisplayNone",
        "nativeRange",
        "nativeColor",
      ],
    },
    density: { control: "select", options: ["default", "compact", "relaxed"] },
    adornment: { control: "select", options: ["none", "leading"] },
    type: { control: "text" },
    placeholder: { control: "text" },
    hasError: { control: "boolean" },
    disabled: { control: "boolean" },
  },
  args: {
    variant: "default",
    density: "default",
    adornment: "none",
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
export const LeadingAdornment: Story = {
  args: { adornment: "leading", placeholder: "Search places" },
};
export const ErrorState: Story = {
  args: { hasError: true, value: "invalid value", readOnly: true },
};
export const Disabled: Story = { args: { disabled: true } };
export const NativeRange: Story = {
  args: {
    type: "range",
    variant: "nativeRange",
    min: 0,
    max: 100,
    defaultValue: 50,
    "aria-label": "Volume",
  },
};
export const NativeColor: Story = {
  args: {
    type: "color",
    variant: "nativeColor",
    defaultValue: "#ff7a1a",
    "aria-label": "Accent color",
  },
};
export const HiddenFileMachinery: Story = {
  args: {
    type: "file",
    variant: "nativeFileHidden",
    "aria-label": "Upload file",
  },
};

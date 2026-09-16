/**
 * Storybook stories for the text input primitive.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { useRef, useState } from "react";
import { Button } from "./button";
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
  render: () => (
    <div className="flex items-center gap-3">
      <Input
        id="hidden-file-story"
        type="file"
        variant="nativeFileHidden"
        aria-label="Upload file"
      />
      <Button asChild variant="outline">
        <label htmlFor="hidden-file-story">Upload file</label>
      </Button>
      <span className="text-sm text-muted">No file selected</span>
    </div>
  ),
};

export const DisplayNoneFileMachinery: Story = {
  render: () => {
    const inputRef = useRef<HTMLInputElement>(null);
    const [fileName, setFileName] = useState("No file selected");

    return (
      <div className="flex items-center gap-3">
        <Input
          ref={inputRef}
          type="file"
          variant="nativeFileDisplayNone"
          aria-label="Choose attachment"
          onChange={(event) =>
            setFileName(
              event.currentTarget.files?.[0]?.name ?? "No file selected",
            )
          }
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => inputRef.current?.click()}
        >
          Choose file
        </Button>
        <output className="text-sm text-muted" aria-live="polite">
          {fileName}
        </output>
      </div>
    );
  },
};

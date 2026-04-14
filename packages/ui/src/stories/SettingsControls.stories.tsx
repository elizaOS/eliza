import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectValue,
  SettingsControls,
} from "../index";

const meta = {
  title: "Composites/SettingsControls",
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div className="w-96 space-y-4 rounded-xl border border-border bg-card p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const InputCompact: Story = {
  render: () => (
    <SettingsControls.Field>
      <SettingsControls.FieldLabel>API Key</SettingsControls.FieldLabel>
      <SettingsControls.Input placeholder="sk-..." />
      <SettingsControls.FieldDescription>
        Your provider API key is stored locally.
      </SettingsControls.FieldDescription>
    </SettingsControls.Field>
  ),
};

export const InputFilter: Story = {
  render: () => (
    <SettingsControls.Field>
      <SettingsControls.FieldLabel>Search</SettingsControls.FieldLabel>
      <SettingsControls.Input
        variant="filter"
        placeholder="Search settings..."
      />
    </SettingsControls.Field>
  ),
};

export const TextareaStory: Story = {
  name: "Textarea",
  render: () => (
    <SettingsControls.Field>
      <SettingsControls.FieldLabel>System prompt</SettingsControls.FieldLabel>
      <SettingsControls.Textarea placeholder="You are a helpful assistant..." />
    </SettingsControls.Field>
  ),
};

function SelectDemo() {
  const [val, setVal] = useState("gpt4");
  return (
    <SettingsControls.Field>
      <SettingsControls.FieldLabel>Model</SettingsControls.FieldLabel>
      <Select value={val} onValueChange={setVal}>
        <SettingsControls.SelectTrigger>
          <SelectValue />
        </SettingsControls.SelectTrigger>
        <SelectContent>
          <SelectItem value="gpt4">GPT-4o</SelectItem>
          <SelectItem value="claude">Claude Sonnet</SelectItem>
        </SelectContent>
      </Select>
    </SettingsControls.Field>
  );
}

export const SelectCompact: Story = {
  render: () => <SelectDemo />,
};

export const MutedText: Story = {
  render: () => (
    <SettingsControls.MutedText>
      Changes take effect after restart.
    </SettingsControls.MutedText>
  ),
};

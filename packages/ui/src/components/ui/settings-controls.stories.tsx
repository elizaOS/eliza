/**
 * Storybook stories for the settings-controls primitives (input/textarea/segmented/muted-text).
 */
import type { Meta, StoryObj } from "@storybook/react";
import {
  SettingsControls,
  SettingsInput,
  SettingsMutedText,
  SettingsSegmentedGroup,
  SettingsTextarea,
} from "./settings-controls";

const meta = {
  title: "Primitives/SettingsControls",
  component: SettingsInput,
  tags: ["autodocs"],
  argTypes: {
    variant: { control: "select", options: ["compact", "filter"] },
    placeholder: { control: "text" },
    disabled: { control: "boolean" },
  },
  args: {
    variant: "compact",
    placeholder: "Agent display name",
    defaultValue: "Eliza",
  },
} satisfies Meta<typeof SettingsInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Filter: Story = {
  args: { variant: "filter", placeholder: "Search settings..." },
};

export const Textarea: Story = {
  render: () => (
    <SettingsTextarea
      className="min-h-24"
      defaultValue={'{\n  "model": "gpt-4o",\n  "temperature": 0.7\n}'}
    />
  ),
};

export const SegmentedGroup: Story = {
  render: () => (
    <SettingsSegmentedGroup>
      <button
        type="button"
        className="rounded-sm bg-accent px-2.5 py-1.5 text-xs text-accent-fg"
      >
        Day
      </button>
      <button type="button" className="rounded-sm px-2.5 py-1.5 text-xs">
        Week
      </button>
      <button type="button" className="rounded-sm px-2.5 py-1.5 text-xs">
        Month
      </button>
    </SettingsSegmentedGroup>
  ),
};

export const FieldComposition: Story = {
  render: () => (
    <SettingsControls.Field>
      <SettingsControls.FieldLabel htmlFor="settings-system-prompt">
        System prompt
      </SettingsControls.FieldLabel>
      <SettingsTextarea
        id="settings-system-prompt"
        className="min-h-20"
        defaultValue="You are a concise, helpful assistant."
      />
      <SettingsControls.FieldDescription>
        Shown to the model before every conversation turn.
      </SettingsControls.FieldDescription>
      <SettingsMutedText>Last edited 3 minutes ago.</SettingsMutedText>
    </SettingsControls.Field>
  ),
};

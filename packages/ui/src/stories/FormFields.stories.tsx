import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldMessage,
  FieldSwitch,
  FormSelect,
  FormSelectItem,
  NewActionButton,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectValue,
  SettingsControls,
} from "../index";

const meta = {
  title: "UI/FormFields",
  component: Field,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof Field>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [voice, setVoice] = useState("sarah");
    const [mode, setMode] = useState<"balanced" | "precise">("balanced");
    const [approvalsEnabled, setApprovalsEnabled] = useState(true);

    return (
      <div className="w-[min(100vw-2rem,30rem)] space-y-6">
        <Field>
          <FieldLabel>Name</FieldLabel>
          <input
            readOnly
            value="Eliza"
            className="h-11 w-full rounded-2xl border border-border/60 bg-bg/70 px-4 text-sm text-txt"
          />
          <FieldDescription>
            Public label shown in the character picker and activity feed.
          </FieldDescription>
          <FieldMessage tone="success">
            Synced with the default persona.
          </FieldMessage>
        </Field>

        <Field>
          <FieldLabel variant="form">Voice</FieldLabel>
          <FormSelect value={voice} onValueChange={setVoice}>
            <FormSelectItem value="sarah">Sarah</FormSelectItem>
            <FormSelectItem value="sage">Sage</FormSelectItem>
            <FormSelectItem value="ember">Ember</FormSelectItem>
          </FormSelect>
        </Field>

        <FieldSwitch
          checked={approvalsEnabled}
          label="Enable approval prompts for destructive tools"
          onCheckedChange={setApprovalsEnabled}
        />

        <Field>
          <FieldLabel variant="kicker">Response Mode</FieldLabel>
          <SegmentedControl
            className="grid w-full grid-cols-2"
            value={mode}
            onValueChange={setMode}
            items={[
              { value: "balanced", label: "Balanced" },
              { value: "precise", label: "Precise" },
            ]}
          />
        </Field>

        <SettingsControls.Field className="space-y-2">
          <SettingsControls.FieldLabel>
            Deployment Target
          </SettingsControls.FieldLabel>
          <Select defaultValue="cloud">
            <SettingsControls.SelectTrigger variant="toolbar">
              <SelectValue placeholder="Select environment" />
            </SettingsControls.SelectTrigger>
            <SelectContent>
              <SelectItem value="cloud">Eliza Cloud</SelectItem>
              <SelectItem value="desktop">Desktop local runtime</SelectItem>
              <SelectItem value="relay">Browser relay</SelectItem>
            </SelectContent>
          </Select>
          <SettingsControls.FieldDescription>
            Use the managed cloud path by default when the app is linked.
          </SettingsControls.FieldDescription>
        </SettingsControls.Field>

        <SettingsControls.Field className="space-y-2">
          <SettingsControls.FieldLabel>Webhook URL</SettingsControls.FieldLabel>
          <SettingsControls.Input
            readOnly
            variant="filter"
            value="https://eliza.cloud/apps/demo/hooks/deploy"
          />
          <SettingsControls.Textarea
            readOnly
            rows={4}
            value={`POST /hooks/deploy\nAuthorization: Bearer demo-token\nAccept: application/json`}
          />
          <div className="flex flex-wrap items-center gap-3">
            <SettingsControls.SegmentedGroup>
              <button
                type="button"
                className="rounded-lg bg-accent/15 px-3 py-1.5 text-xs font-semibold text-txt"
              >
                All
              </button>
              <button
                type="button"
                className="rounded-lg px-3 py-1.5 text-xs font-semibold text-muted"
              >
                Errors
              </button>
            </SettingsControls.SegmentedGroup>
            <SettingsControls.MutedText>
              Last synced 2 minutes ago
            </SettingsControls.MutedText>
          </div>
        </SettingsControls.Field>

        <NewActionButton>Create Automation</NewActionButton>
      </div>
    );
  },
};

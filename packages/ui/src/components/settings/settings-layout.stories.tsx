/** Grouped settings rows in static, controlled, navigation, and danger states. */

import type { Meta, StoryObj } from "@storybook/react";
import { Bell, Trash2 } from "lucide-react";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsGroup, SettingsRow, SettingsStack } from "./settings-layout";

const meta = {
  title: "Settings/SettingsLayout",
  component: SettingsGroup,
  parameters: { layout: "padded" },
} satisfies Meta<typeof SettingsGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const GroupedRows: Story = {
  render: () => (
    <SettingsStack className="max-w-xl">
      <SettingsGroup
        title="Notifications"
        description="Choose how the agent gets your attention."
        action={<Button size="sm">Test</Button>}
        footer="Critical alerts may still appear when summaries are disabled."
      >
        <SettingsRow
          icon={Bell}
          label="Push notifications"
          description="Receive alerts on this device."
          control={<Switch aria-label="Push notifications" />}
        />
        <SettingsRow
          label="Quiet hours"
          description="10 PM to 7 AM"
          onClick={() => {}}
        />
        <SettingsRow
          icon={Trash2}
          label="Clear notification history"
          tone="danger"
          onClick={() => {}}
        />
      </SettingsGroup>
    </SettingsStack>
  ),
};

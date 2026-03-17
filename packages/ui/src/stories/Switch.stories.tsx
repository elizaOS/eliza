import type { Meta, StoryObj } from "@storybook/react";
import React from "react";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";

const meta: Meta<typeof Switch> = { title: "Atoms/Switch", component: Switch };
export default meta;

export const Default: StoryObj = {
  render: () => (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Switch id="voice" defaultChecked />
        <Label htmlFor="voice">Voice mode</Label>
      </div>
      <div className="flex items-center gap-3">
        <Switch id="notify" />
        <Label htmlFor="notify">Notifications</Label>
      </div>
      <div className="flex items-center gap-3">
        <Switch id="locked" disabled />
        <Label htmlFor="locked" className="opacity-50">
          Premium
        </Label>
      </div>
    </div>
  ),
};

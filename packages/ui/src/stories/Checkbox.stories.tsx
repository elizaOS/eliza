import type { Meta, StoryObj } from "@storybook/react";
import React from "react";
import { Checkbox } from "../components/ui/checkbox";
import { Label } from "../components/ui/label";

const meta: Meta<typeof Checkbox> = {
  title: "Atoms/Checkbox",
  component: Checkbox,
};
export default meta;

export const Default: StoryObj = {
  render: () => (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Checkbox id="auto" defaultChecked />
        <Label htmlFor="auto">Auto-respond</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="stream" />
        <Label htmlFor="stream">Stream responses</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="locked" disabled />
        <Label htmlFor="locked" className="opacity-50">
          Premium only
        </Label>
      </div>
    </div>
  ),
};

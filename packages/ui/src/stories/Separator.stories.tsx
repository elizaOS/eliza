import type { Meta, StoryObj } from "@storybook/react";
import React from "react";
import { Separator } from "../components/ui/separator";

const meta: Meta<typeof Separator> = {
  title: "Atoms/Separator",
  component: Separator,
};
export default meta;

export const Default: StoryObj = {
  render: () => (
    <div className="flex items-center gap-4">
      <span className="text-sm">Stats</span>
      <Separator orientation="vertical" className="h-5" />
      <span className="text-sm">Logs</span>
      <Separator orientation="vertical" className="h-5" />
      <span className="text-sm">Settings</span>
    </div>
  ),
};

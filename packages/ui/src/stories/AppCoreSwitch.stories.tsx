import { Switch } from "@elizaos/app-core/components";
import type { Meta, StoryObj } from "@storybook/react";
import React, { useState } from "react";

const meta: Meta<typeof Switch> = {
  title: "App Core/Switch",
  component: Switch,
};
export default meta;

export const Default: StoryObj = {
  render: () => {
    const [on, setOn] = useState(false);
    return (
      <div className="flex items-center gap-3">
        <Switch checked={on} onChange={setOn} />
        <span className="text-sm">{on ? "On" : "Off"}</span>
      </div>
    );
  },
};

export const Compact: StoryObj = {
  render: () => {
    const [on, setOn] = useState(true);
    return (
      <div className="flex items-center gap-3">
        <Switch checked={on} onChange={setOn} size="compact" />
        <span className="text-sm">Compact · {on ? "On" : "Off"}</span>
      </div>
    );
  },
};

export const Disabled: StoryObj = {
  render: () => (
    <div className="flex items-center gap-6">
      <div className="flex items-center gap-2">
        <Switch checked={false} onChange={() => {}} disabled />
        <span className="text-sm text-muted">Disabled Off</span>
      </div>
      <div className="flex items-center gap-2">
        <Switch checked onChange={() => {}} disabled />
        <span className="text-sm text-muted">Disabled On</span>
      </div>
    </div>
  ),
};

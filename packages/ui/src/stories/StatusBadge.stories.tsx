import type { Meta, StoryObj } from "@storybook/react";
import React from "react";
import {
  StatCard,
  StatusBadge,
  StatusDot,
} from "../components/ui/status-badge";

const meta: Meta<typeof StatusBadge> = {
  title: "Atoms/StatusBadge",
  component: StatusBadge,
};
export default meta;

export const Badges: StoryObj = {
  render: () => (
    <div className="flex items-center gap-3">
      <StatusBadge label="Online" tone="success" withDot />
      <StatusBadge label="Warming up" tone="warning" withDot />
      <StatusBadge label="Down" tone="danger" withDot />
      <StatusBadge label="Idle" tone="muted" />
    </div>
  ),
};

export const Stats: StoryObj = {
  render: () => (
    <div className="flex gap-4">
      <StatCard label="Agents" value="12" accent />
      <StatCard label="Uptime" value="99.9%" />
      <StatCard label="Errors" value="0" />
    </div>
  ),
};

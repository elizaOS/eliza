import { StatCard, StatusBadge, StatusDot } from "@milady/app-core/components";
import type { Meta, StoryObj } from "@storybook/react";
import React from "react";

const meta: Meta<typeof StatusBadge> = {
  title: "App Core/UiBadges",
  component: StatusBadge,
};
export default meta;

export const Badges: StoryObj = {
  render: () => (
    <div className="flex items-center gap-3">
      <StatusBadge label="Online" tone="success" withDot />
      <StatusBadge label="Warming Up" tone="warning" withDot />
      <StatusBadge label="Offline" tone="danger" withDot />
      <StatusBadge label="Idle" tone="muted" />
    </div>
  ),
};

export const Dots: StoryObj = {
  render: () => (
    <div className="flex items-center gap-4">
      <div className="flex items-center gap-2">
        <StatusDot status="connected" />
        <span className="text-xs">Connected</span>
      </div>
      <div className="flex items-center gap-2">
        <StatusDot status="error" />
        <span className="text-xs">Error</span>
      </div>
      <div className="flex items-center gap-2">
        <StatusDot status="unknown" />
        <span className="text-xs">Unknown</span>
      </div>
    </div>
  ),
};

export const Stats: StoryObj = {
  render: () => (
    <div className="flex gap-4">
      <StatCard label="Agents" value="12" accent />
      <StatCard label="Uptime" value="99.9%" />
      <StatCard label="Errors" value="0" />
      <StatCard label="Messages" value="1,247" accent />
    </div>
  ),
};

/** Storybook stories for CloudStatusBadge — low/critical credits, large-balance-low, auth-rejected, credits-error, and shell-appearance states. */

import type { Meta, StoryObj } from "@storybook/react";
import { CloudStatusBadge } from "./CloudStatusBadge";

const t = (key: string): string => {
  const dictionary: Record<string, string> = {
    "common.error": "Error",
    "logsview.Warn": "Warn",
    "header.elizaCloudAuthRejected": "Eliza Cloud auth rejected",
    "header.CloudCreditsBalanc": "Cloud credits balance",
  };
  return dictionary[key] ?? key;
};

const meta = {
  title: "Cloud/CloudStatusBadge",
  component: CloudStatusBadge,
  tags: ["autodocs"],
  argTypes: {
    appearance: { control: "select", options: ["default", "shell"] },
    compactOnMobile: { control: "boolean" },
    connected: { control: "boolean" },
    credits: { control: "number" },
    creditsLow: { control: "boolean" },
    creditsCritical: { control: "boolean" },
    authRejected: { control: "boolean" },
    creditsError: { control: "text" },
  },
  args: {
    connected: true,
    credits: 4.25,
    creditsLow: true,
    creditsCritical: false,
    authRejected: false,
    creditsError: null,
    compactOnMobile: false,
    appearance: "default",
    t,
    onClick: () => {},
  },
} satisfies Meta<typeof CloudStatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LowCredits: Story = {};

export const CriticalCredits: Story = {
  args: {
    credits: 0.42,
    creditsLow: false,
    creditsCritical: true,
  },
};

export const LargeBalanceLow: Story = {
  args: {
    credits: 1250,
    creditsLow: true,
  },
};

export const AuthRejected: Story = {
  args: {
    authRejected: true,
    credits: null,
    creditsLow: false,
    creditsCritical: false,
  },
};

export const CreditsErrorWarning: Story = {
  args: {
    credits: null,
    creditsLow: false,
    creditsCritical: false,
    creditsError: "Failed to fetch credits balance",
  },
};

export const ShellAppearance: Story = {
  args: {
    appearance: "shell",
    credits: 2.8,
    creditsLow: true,
  },
};

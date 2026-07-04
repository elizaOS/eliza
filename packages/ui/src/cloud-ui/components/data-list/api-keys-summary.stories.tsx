/**
 * Storybook stories for ApiKeysSummary.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { ApiKeysSummary } from "./api-keys-summary";

const meta = {
  title: "CloudUI/DataList/ApiKeysSummary",
  component: ApiKeysSummary,
  tags: ["autodocs"],
} satisfies Meta<typeof ApiKeysSummary>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    summary: {
      totalKeys: 8,
      activeKeys: 6,
      monthlyUsage: 12480,
      rateLimit: 600,
      lastGeneratedAt: "2026-05-21T14:32:00Z",
    },
  },
};

export const EmptyAccount: Story = {
  args: {
    summary: {
      totalKeys: 0,
      activeKeys: 0,
      monthlyUsage: 0,
      rateLimit: 60,
      lastGeneratedAt: null,
    },
  },
};

export const HighVolume: Story = {
  args: {
    summary: {
      totalKeys: 42,
      activeKeys: 38,
      monthlyUsage: 2_450_000,
      rateLimit: 10000,
      lastGeneratedAt: "2026-06-04T09:15:00Z",
    },
  },
};

export const RecentlyRotated: Story = {
  args: {
    summary: {
      totalKeys: 3,
      activeKeys: 3,
      monthlyUsage: 875,
      rateLimit: 120,
      lastGeneratedAt: new Date().toISOString(),
    },
  },
};

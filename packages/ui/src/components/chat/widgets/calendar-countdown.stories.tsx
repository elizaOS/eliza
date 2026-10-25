/** Deterministic near-term and day-scale calendar countdown states. */
import type { Meta, StoryObj } from "@storybook/react";
import { CalendarCountdown } from "./calendar-countdown";

const NOW = Date.UTC(2026, 7, 2, 18, 0, 0);

const meta = {
  title: "Chat/Widgets/CalendarCountdown",
  component: CalendarCountdown,
  parameters: { layout: "centered" },
  args: { now: NOW },
} satisfies Meta<typeof CalendarCountdown>;

export default meta;
type Story = StoryObj<typeof meta>;

export const StartingNow: Story = {
  args: { date: new Date(NOW).toISOString() },
};

export const InFortyMinutes: Story = {
  args: { date: new Date(NOW + 40 * 60_000).toISOString() },
};

export const Tomorrow: Story = {
  args: { date: new Date(NOW + 24 * 60 * 60_000).toISOString() },
};

/** Full and compact renderings of the minute-ticking relative-time leaf. */
import type { Meta, StoryObj } from "@storybook/react";
import { RelativeTime } from "./RelativeTime";

const fixedTimestamp = new Date("2026-07-31T11:45:00.000Z");

const meta = {
  title: "Shell/RelativeTime",
  component: RelativeTime,
  parameters: { layout: "centered" },
  args: { ts: fixedTimestamp },
} satisfies Meta<typeof RelativeTime>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Full: Story = {};
export const Compact: Story = { args: { short: true } };
export const InvalidTimestamp: Story = { args: { ts: "not-a-date" } };

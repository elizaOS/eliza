import type { Meta, StoryObj } from "@storybook/react";
import { MiniStatCard } from "./mini-stat-card";

const meta: Meta<typeof MiniStatCard> = {
  title: "Brand/MiniStatCard",
  component: MiniStatCard,
  parameters: { backgrounds: { default: "dark" } },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 200, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof MiniStatCard>;

export const Default: Story = {
  args: { label: "Page Views", value: "12,456" },
};

export const WithColor: Story = {
  args: { label: "API Requests", value: "3,456", color: "text-[#FF5800]" },
};

export const Grid: Story = {
  render: () => (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 12,
        maxWidth: 400,
      }}
    >
      <MiniStatCard label="Page Views" value="12,456" color="text-emerald-400" />
      <MiniStatCard label="API Calls" value="3,456" color="text-[#FF5800]" />
      <MiniStatCard label="Unique Visitors" value="891" color="text-white" />
      <MiniStatCard label="Avg Response" value="234ms" color="text-white" />
    </div>
  ),
};

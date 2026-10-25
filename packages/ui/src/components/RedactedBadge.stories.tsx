/** Visual states for the shared server-redaction marker. */
import type { Meta, StoryObj } from "@storybook/react";
import { RedactedBadge } from "./RedactedBadge";

const meta = {
  title: "Components/RedactedBadge",
  component: RedactedBadge,
  parameters: { layout: "centered" },
} satisfies Meta<typeof RedactedBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const InMetadataRow: Story = {
  render: () => (
    <div className="flex items-center gap-2 text-sm text-muted">
      <span>Meeting transcript</span>
      <RedactedBadge />
    </div>
  ),
};

/** Size and color states for the reusable elizaOS brand mark. */
import type { Meta, StoryObj } from "@storybook/react";
import { ElizaMark } from "./eliza-mark";

const meta = {
  title: "Brand/ElizaMark",
  component: ElizaMark,
  parameters: { layout: "centered" },
  args: { className: "h-32 w-32 text-accent" },
} satisfies Meta<typeof ElizaMark>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const OnBrandSurface: Story = {
  render: () => (
    <div className="rounded-3xl bg-accent p-8 text-accent-fg">
      <ElizaMark className="h-24 w-24" />
    </div>
  ),
};

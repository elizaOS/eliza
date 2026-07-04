/**
 * Storybook stories for the Eliza Cloud wordmark lockup.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { ElizaCloudLockup } from "./eliza-cloud-lockup";

const meta = {
  title: "CloudUI/Brand/ElizaCloudLockup",
  component: ElizaCloudLockup,
  tags: ["autodocs"],
  argTypes: {
    className: { control: "text" },
    logoClassName: { control: "text" },
    textClassName: { control: "text" },
  },
} satisfies Meta<typeof ElizaCloudLockup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Large: Story = {
  args: {
    textClassName: "text-5xl",
  },
};

export const Small: Story = {
  args: {
    textClassName: "text-sm",
  },
};

export const AccentColor: Story = {
  args: {
    textClassName: "text-orange-500",
  },
};

export const OnDarkBackground: Story = {
  decorators: [
    (Story) => (
      <div className="flex min-h-32 items-center justify-center bg-neutral-900 p-8 text-white">
        <Story />
      </div>
    ),
  ],
  args: {
    textClassName: "text-3xl",
  },
};

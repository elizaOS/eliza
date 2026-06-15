import type { Meta, StoryObj } from "@storybook/react";
import { MilestoneCard, MilestoneProgress } from "./milestone-progress";

const meta = {
  title: "CloudUI/Monetization/MilestoneProgress",
  component: MilestoneProgress,
  tags: ["autodocs"],
  argTypes: {
    current: { control: { type: "number", min: 0, step: 1 } },
    target: { control: { type: "number", min: 1, step: 1 } },
    label: { control: "text" },
    showAmount: { control: "boolean" },
  },
  args: {
    current: 32.5,
    target: 100,
    label: "Withdrawal Threshold",
    showAmount: true,
  },
  decorators: [
    (Story) => (
      <div className="bg-neutral-950 p-6 w-[420px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MilestoneProgress>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const JustStarted: Story = {
  args: {
    current: 4.2,
    target: 100,
  },
};

export const NearComplete: Story = {
  args: {
    current: 92.75,
    target: 100,
  },
};

export const Complete: Story = {
  args: {
    current: 120,
    target: 100,
  },
};

export const WithoutAmount: Story = {
  args: {
    current: 45,
    target: 100,
    showAmount: false,
    label: "Subscriber Goal",
  },
};

export const AsCard: Story = {
  render: (args) => <MilestoneCard {...args} title="Withdrawal Progress" />,
  args: {
    current: 67.4,
    target: 100,
  },
};

export const AsCardComplete: Story = {
  render: (args) => <MilestoneCard {...args} title="Milestone Reached" />,
  args: {
    current: 150,
    target: 100,
  },
};

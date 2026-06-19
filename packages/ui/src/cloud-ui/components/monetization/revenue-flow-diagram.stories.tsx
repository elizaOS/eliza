import type { Meta, StoryObj } from "@storybook/react";
import { RevenueFlowDiagram } from "./revenue-flow-diagram";

const meta = {
  title: "CloudUI/Monetization/RevenueFlowDiagram",
  component: RevenueFlowDiagram,
  tags: ["autodocs"],
  argTypes: {
    markupPercentage: {
      control: { type: "number", min: 0, max: 500, step: 5 },
    },
    purchaseSharePercentage: {
      control: { type: "number", min: 0, max: 100, step: 1 },
    },
  },
  args: {
    markupPercentage: 30,
    purchaseSharePercentage: 10,
  },
  decorators: [
    (Story) => (
      <div
        style={{
          width: 560,
          minHeight: 360,
          background: "#0a0a0a",
          padding: 16,
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RevenueFlowDiagram>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const LowMarkup: Story = {
  args: {
    markupPercentage: 10,
    purchaseSharePercentage: 5,
  },
};

export const HighMarkup: Story = {
  args: {
    markupPercentage: 100,
    purchaseSharePercentage: 25,
  },
};

export const PremiumTier: Story = {
  args: {
    markupPercentage: 250,
    purchaseSharePercentage: 50,
  },
};

export const NoMarkup: Story = {
  args: {
    markupPercentage: 0,
    purchaseSharePercentage: 0,
  },
};

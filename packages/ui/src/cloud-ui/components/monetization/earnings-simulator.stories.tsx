import type { Meta, StoryObj } from "@storybook/react";
import { EarningsSimulator } from "./earnings-simulator";

const meta = {
  title: "CloudUI/Monetization/EarningsSimulator",
  component: EarningsSimulator,
  tags: ["autodocs"],
  argTypes: {
    markupPercentage: { control: { type: "range", min: 0, max: 100, step: 1 } },
    purchaseSharePercentage: {
      control: { type: "range", min: 0, max: 100, step: 1 },
    },
    className: { control: "text" },
  },
  args: {
    markupPercentage: 20,
    purchaseSharePercentage: 10,
  },
  decorators: [
    (Story) => (
      <div className="bg-black p-6" style={{ maxWidth: 420 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof EarningsSimulator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const ConservativeMarkup: Story = {
  args: {
    markupPercentage: 5,
    purchaseSharePercentage: 2,
  },
};

export const AggressiveMarkup: Story = {
  args: {
    markupPercentage: 50,
    purchaseSharePercentage: 25,
  },
};

export const InferenceOnly: Story = {
  args: {
    markupPercentage: 30,
    purchaseSharePercentage: 0,
  },
};

export const PurchaseShareOnly: Story = {
  args: {
    markupPercentage: 0,
    purchaseSharePercentage: 40,
  },
};

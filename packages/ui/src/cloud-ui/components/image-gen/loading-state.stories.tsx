import type { Meta, StoryObj } from "@storybook/react";
import { LoadingState } from "./loading-state";

const meta: Meta<typeof LoadingState> = {
  title: "CloudUI/ImageGen/LoadingState",
  component: LoadingState,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
    backgrounds: {
      default: "dark",
      values: [{ name: "dark", value: "#000000" }],
    },
  },
  decorators: [
    (Story) => (
      <div className="w-[480px] p-6 bg-black text-white">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Narrow: Story = {
  decorators: [
    (Story) => (
      <div className="w-[320px] p-4 bg-black text-white">
        <Story />
      </div>
    ),
  ],
};

export const Wide: Story = {
  decorators: [
    (Story) => (
      <div className="w-[720px] p-8 bg-black text-white">
        <Story />
      </div>
    ),
  ],
};

export const InCard: Story = {
  decorators: [
    (Story) => (
      <div className="w-[520px] p-6 bg-zinc-950 border border-white/10 rounded-lg text-white">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-white/70 mb-4">
          Generating Preview
        </h3>
        <Story />
      </div>
    ),
  ],
};

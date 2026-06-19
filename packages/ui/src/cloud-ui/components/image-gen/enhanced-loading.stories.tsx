import type { Meta, StoryObj } from "@storybook/react";
import { EnhancedLoading } from "./enhanced-loading";

const meta = {
  title: "CloudUI/ImageGen/EnhancedLoading",
  component: EnhancedLoading,
  tags: ["autodocs"],
  argTypes: {
    message: { control: "text" },
    progress: { control: { type: "range", min: 0, max: 100, step: 1 } },
  },
  decorators: [
    (Story) => (
      <div style={{ width: 640, background: "#0a0a0a", padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof EnhancedLoading>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithCustomMessage: Story = {
  args: {
    message: "Rendering your masterpiece...",
  },
};

export const WithProgress: Story = {
  args: {
    message: "Generating image...",
    progress: 42,
  },
};

export const NearlyComplete: Story = {
  args: {
    message: "Almost there...",
    progress: 92,
  },
};

export const JustStarted: Story = {
  args: {
    message: "Warming up the model...",
    progress: 3,
  },
};

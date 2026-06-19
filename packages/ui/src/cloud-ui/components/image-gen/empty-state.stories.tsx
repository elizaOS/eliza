import type { Meta, StoryObj } from "@storybook/react";
import { ImageEmptyState } from "./empty-state";

const meta = {
  title: "CloudUI/ImageGen/EmptyState",
  component: ImageEmptyState,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof ImageEmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const InNarrowPanel: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 320, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
};

export const InWidePanel: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 720, padding: 24 }}>
        <Story />
      </div>
    ),
  ],
};

export const OnDarkBackground: Story = {
  decorators: [
    (Story) => (
      <div
        style={{
          width: 480,
          padding: 24,
          background: "#0a0a0a",
          borderRadius: 8,
        }}
      >
        <Story />
      </div>
    ),
  ],
};

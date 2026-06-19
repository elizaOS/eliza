import type { Meta, StoryObj } from "@storybook/react";
import { ApiKeyEmptyState } from "./api-key-empty-state";

const meta = {
  title: "CloudUI/Components/ApiKeyEmptyState",
  component: ApiKeyEmptyState,
  tags: ["autodocs"],
  args: {
    onCreateKey: () => {
      // no-op for stories
    },
  },
} satisfies Meta<typeof ApiKeyEmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithoutHandler: Story = {
  args: {
    onCreateKey: undefined,
  },
};

export const InCard: Story = {
  decorators: [
    (Story) => (
      <div className="max-w-2xl rounded-lg border border-border bg-card p-8">
        <Story />
      </div>
    ),
  ],
};

export const NarrowContainer: Story = {
  decorators: [
    (Story) => (
      <div className="max-w-sm">
        <Story />
      </div>
    ),
  ],
};

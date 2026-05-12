import type { Meta, StoryObj } from "@storybook/react";
import { InferenceCloudAlertButton } from "./InferenceCloudAlertButton";

const meta = {
  title: "Companion/InferenceCloudAlertButton",
  component: InferenceCloudAlertButton,
  tags: ["autodocs"],
  args: {
    notice: {
      kind: "settings",
      variant: "warn",
      tooltip: "Cloud inference unavailable — using local fallback",
    },
    onClick: () => {},
  },
} satisfies Meta<typeof InferenceCloudAlertButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Warning: Story = {};

export const Danger: Story = {
  args: {
    notice: {
      kind: "cloud",
      variant: "danger",
      tooltip: "No inference provider configured",
    },
  },
};

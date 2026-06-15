import type { Meta, StoryObj } from "@storybook/react";
import { Banner } from "./banner";
import { Button } from "./button";

const meta = {
  title: "Primitives/Banner",
  component: Banner,
  tags: ["autodocs"],
  argTypes: {
    variant: { control: "select", options: ["error", "warning", "info"] },
    dismissible: { control: "boolean" },
    dismissLabel: { control: "text" },
    children: { control: "text" },
  },
  args: {
    variant: "info",
    children: "A new version is available. Refresh to update.",
  },
} satisfies Meta<typeof Banner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Warning: Story = {
  args: {
    variant: "warning",
    children: "Your session will expire soon.",
  },
};

export const ErrorState: Story = {
  args: {
    variant: "error",
    children: "Failed to connect to the agent runtime.",
  },
};

export const Dismissible: Story = {
  args: {
    variant: "warning",
    dismissible: true,
    children: "Heads up — this banner can be dismissed.",
  },
};

export const WithAction: Story = {
  args: {
    variant: "info",
    children: "Updates are ready to install.",
    action: (
      <Button variant="outline" size="sm">
        Refresh
      </Button>
    ),
  },
};

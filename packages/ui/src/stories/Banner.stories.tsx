import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import { Banner } from "../components/ui/banner";

const meta = {
  title: "UI/Banner",
  component: Banner,
  tags: ["autodocs"],
  argTypes: {
    variant: {
      control: "select",
      options: ["info", "warning", "error"],
    },
    dismissible: { control: "boolean" },
    children: { control: "text" },
  },
  args: {
    children: "This is a banner message.",
    onDismiss: fn(),
  },
} satisfies Meta<typeof Banner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Info: Story = {
  args: { variant: "info", children: "Informational message." },
};

export const Warning: Story = {
  args: { variant: "warning", children: "Warning: proceed with caution." },
};

export const ErrorState: Story = {
  args: { variant: "error", children: "An error has occurred." },
};

export const Dismissible: Story = {
  args: {
    variant: "info",
    dismissible: true,
    children: "You can dismiss this banner.",
  },
};

export const WithAction: Story = {
  args: {
    variant: "warning",
    children: "Update available.",
    action: (
      <button
        type="button"
        className="rounded-md border border-current px-2 py-0.5 text-[10px] font-medium hover:opacity-80"
      >
        Update
      </button>
    ),
  },
};

export const DismissibleWithAction: Story = {
  args: {
    variant: "error",
    dismissible: true,
    children: "Something went wrong.",
    action: (
      <button
        type="button"
        className="rounded-md border border-current px-2 py-0.5 text-[10px] font-medium hover:opacity-80"
      >
        Retry
      </button>
    ),
  },
};

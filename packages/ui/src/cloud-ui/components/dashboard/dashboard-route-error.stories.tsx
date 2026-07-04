/**
 * Storybook stories for the dashboard route error boundary UI.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { MemoryRouter } from "react-router-dom";
import { DashboardRouteError } from "./dashboard-route-error";

const meta = {
  title: "CloudUI/Dashboard/DashboardRouteError",
  component: DashboardRouteError,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    backgrounds: { default: "dark" },
  },
  decorators: [
    (Story) => (
      <MemoryRouter>
        <div className="min-h-screen bg-black p-6">
          <Story />
        </div>
      </MemoryRouter>
    ),
  ],
  argTypes: {
    message: { control: "text" },
  },
  args: {
    message: "Failed to load this dashboard route. Please try again.",
  },
} satisfies Meta<typeof DashboardRouteError>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const NetworkError: Story = {
  args: {
    message:
      "We could not reach the cloud API. Check your connection and try again.",
  },
};

export const ShortMessage: Story = {
  args: {
    message: "Unexpected error.",
  },
};

export const LongMessage: Story = {
  args: {
    message:
      "An unexpected error occurred while rendering this route. This usually means a downstream service is temporarily unavailable or a recent deploy introduced a regression. Retrying often resolves it; if not, head back to the dashboard and try a different page while we look into it.",
  },
};

export const PermissionDenied: Story = {
  args: {
    message:
      "You do not have permission to view this resource. Switch to an account with access, or return to the dashboard.",
  },
};

import type { Meta, StoryObj } from "@storybook/react";
import {
  DashboardErrorState,
  DashboardLoadingState,
} from "./route-placeholders";

const loadingMeta = {
  title: "CloudUI/Dashboard/RoutePlaceholders",
  component: DashboardLoadingState,
  tags: ["autodocs"],
  args: {
    label: "Loading",
  },
} satisfies Meta<typeof DashboardLoadingState>;

export default loadingMeta;
type LoadingStory = StoryObj<typeof loadingMeta>;

export const Loading: LoadingStory = {};

export const LoadingCustomLabel: LoadingStory = {
  args: {
    label: "Loading workspace overview",
  },
};

type ErrorStory = StoryObj<typeof DashboardErrorState>;

export const ErrorState_: ErrorStory = {
  render: (args) => <DashboardErrorState {...args} />,
  args: {
    message: "Failed to load dashboard data. Please try again.",
  },
};

export const ErrorLongMessage: ErrorStory = {
  render: (args) => <DashboardErrorState {...args} />,
  args: {
    message:
      "We could not reach the cloud API to load this page. This usually means the network is offline or the service is temporarily unavailable. Please retry in a moment, and contact support if the issue persists.",
  },
};

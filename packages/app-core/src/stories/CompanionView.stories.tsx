import type { Meta, StoryObj } from "@storybook/react";
import { CompanionView } from "../components/CompanionView";
import { withAppMock } from "./AppMockProvider";

const meta = {
  title: "Companion/CompanionView",
  component: CompanionView,
  decorators: [withAppMock],
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof CompanionView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const MobileView: Story = {
  parameters: {
    viewport: {
      defaultViewport: "iphonex",
    },
  },
};

export const TabletView: Story = {
  parameters: {
    viewport: {
      defaultViewport: "ipad",
    },
  },
};

import type { Meta, StoryObj } from "@storybook/react";
import { WorkspaceLayout } from "../index";
import {
  fullLayoutArgs,
  LayoutStoryContent,
  LayoutStoryFooter,
  LayoutStoryFrame,
  LayoutStoryHeader,
} from "./layout-story-fixtures";

const meta = {
  title: "Layouts/WorkspaceLayout",
  component: WorkspaceLayout,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  argTypes: {
    children: { control: false },
    contentHeader: { control: false },
    footer: { control: false },
    sidebar: { control: false },
  },
  render: (args) => (
    <LayoutStoryFrame>
      <WorkspaceLayout {...args}>
        <LayoutStoryContent />
      </WorkspaceLayout>
    </LayoutStoryFrame>
  ),
} satisfies Meta<typeof WorkspaceLayout>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Desktop: Story = {
  args: fullLayoutArgs,
  parameters: {
    viewport: { defaultViewport: "desktopWide" },
  },
};

export const MobilePortrait: Story = {
  args: fullLayoutArgs,
  parameters: {
    viewport: { defaultViewport: "mobilePortrait" },
  },
};

export const MobileLandscape: Story = {
  args: fullLayoutArgs,
  parameters: {
    viewport: { defaultViewport: "mobileLandscape" },
  },
};

export const IPadPortrait: Story = {
  args: fullLayoutArgs,
  parameters: {
    viewport: { defaultViewport: "ipadPortrait" },
  },
};

export const SinglePane: Story = {
  args: {
    contentHeader: <LayoutStoryHeader />,
    footer: <LayoutStoryFooter />,
  },
  parameters: {
    viewport: { defaultViewport: "desktopWide" },
  },
};

import type { Meta, StoryObj } from "@storybook/react";

import { PageLayout } from "../index";
import {
  fullLayoutArgs,
  LayoutStoryContent,
  LayoutStoryFrame,
} from "./layout-story-fixtures";

const meta = {
  title: "Layouts/PageLayout",
  component: PageLayout,
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
      <PageLayout {...args}>
        <LayoutStoryContent />
      </PageLayout>
    </LayoutStoryFrame>
  ),
} satisfies Meta<typeof PageLayout>;

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

export const WithoutFooter: Story = {
  args: {
    contentHeader: fullLayoutArgs.contentHeader,
    sidebar: fullLayoutArgs.sidebar,
  },
  parameters: {
    viewport: { defaultViewport: "desktopWide" },
  },
};

import type { Meta, StoryObj } from "@storybook/react";

import { ContentLayout } from "../index";
import {
  LayoutStoryContent,
  LayoutStoryFrame,
  LayoutStoryHeader,
} from "./layout-story-fixtures";

const meta = {
  title: "Layouts/ContentLayout",
  component: ContentLayout,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  argTypes: {
    children: { control: false },
    contentHeader: { control: false },
  },
  render: (args) => (
    <LayoutStoryFrame>
      <ContentLayout {...args}>
        <LayoutStoryContent />
      </ContentLayout>
    </LayoutStoryFrame>
  ),
} satisfies Meta<typeof ContentLayout>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    contentHeader: <LayoutStoryHeader />,
  },
  parameters: {
    viewport: { defaultViewport: "desktopWide" },
  },
};

export const InModal: Story = {
  args: {
    contentHeader: <LayoutStoryHeader />,
    inModal: true,
  },
  parameters: {
    viewport: { defaultViewport: "desktopWide" },
  },
  render: (args) => (
    <div className="flex min-h-screen items-center justify-center bg-bg p-6">
      <div className="flex h-[42rem] w-full max-w-5xl overflow-hidden rounded-[2rem] border border-border/40 bg-card/80 shadow-xl">
        <ContentLayout {...args}>
          <LayoutStoryContent />
        </ContentLayout>
      </div>
    </div>
  ),
};

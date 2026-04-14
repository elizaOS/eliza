import type { Meta, StoryObj } from "@storybook/react";
import {
  Skeleton,
  SkeletonCard,
  SkeletonChat,
  SkeletonLine,
  SkeletonMessage,
  SkeletonSidebar,
  SkeletonText,
} from "../components/ui/skeleton";

const meta = {
  title: "UI/Skeleton",
  component: Skeleton,
  tags: ["autodocs"],
} satisfies Meta<typeof Skeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <Skeleton className="h-12 w-48 rounded-md" />,
};

export const Line: Story = {
  render: () => <SkeletonLine width="75%" />,
};

export const TextBlock: Story = {
  render: () => <SkeletonText lines={4} />,
};

export const Message: Story = {
  render: () => <SkeletonMessage />,
};

export const UserMessage: Story = {
  render: () => <SkeletonMessage isUser />,
};

export const Card: Story = {
  render: () => <SkeletonCard />,
};

export const Sidebar: Story = {
  render: () => <SkeletonSidebar />,
};

export const Chat: Story = {
  render: () => <SkeletonChat />,
};

import {
  SkeletonCard,
  SkeletonChat,
  SkeletonLine,
  SkeletonMessage,
  SkeletonSidebar,
  SkeletonText,
} from "@milady/app-core/components";
import type { Meta, StoryObj } from "@storybook/react";
import React from "react";

const meta: Meta = { title: "App Core/Skeletons" };
export default meta;

export const Line: StoryObj = {
  render: () => (
    <div className="w-80 space-y-3">
      <SkeletonLine />
      <SkeletonLine width="75%" />
      <SkeletonLine width="50%" />
    </div>
  ),
};

export const Text: StoryObj = {
  render: () => (
    <div className="w-80">
      <SkeletonText lines={4} />
    </div>
  ),
};

export const Message: StoryObj = {
  render: () => (
    <div className="w-96">
      <SkeletonMessage />
      <SkeletonMessage isUser />
    </div>
  ),
};

export const CardSkeleton: StoryObj = {
  name: "Card",
  render: () => (
    <div className="w-80">
      <SkeletonCard />
    </div>
  ),
};

export const Sidebar: StoryObj = {
  render: () => <SkeletonSidebar />,
};

export const Chat: StoryObj = {
  render: () => (
    <div className="w-96">
      <SkeletonChat />
    </div>
  ),
};

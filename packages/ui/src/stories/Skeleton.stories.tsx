import type { Meta, StoryObj } from "@storybook/react";
import React from "react";
import {
  Skeleton,
  SkeletonCard,
  SkeletonChat,
  SkeletonMessage,
} from "../components/ui/skeleton";

const meta: Meta<typeof Skeleton> = {
  title: "Atoms/Skeleton",
  component: Skeleton,
};
export default meta;

export const Chat: StoryObj = {
  render: () => (
    <div className="w-96">
      <SkeletonChat />
    </div>
  ),
};

export const Card: StoryObj = {
  render: () => (
    <div className="w-80">
      <SkeletonCard />
    </div>
  ),
};

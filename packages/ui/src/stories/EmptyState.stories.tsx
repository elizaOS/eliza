import type { Meta, StoryObj } from "@storybook/react";
import { Inbox } from "lucide-react";
import React from "react";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";

const meta: Meta<typeof EmptyState> = {
  title: "Molecules/EmptyState",
  component: EmptyState,
};
export default meta;

export const Default: StoryObj = {
  args: {
    icon: <Inbox className="h-8 w-8" />,
    title: "No agents yet",
    action: <Button size="sm">Create Agent</Button>,
  },
};

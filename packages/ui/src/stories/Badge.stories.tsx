import type { Meta, StoryObj } from "@storybook/react";
import React from "react";
import { Badge } from "../components/ui/badge";

const meta: Meta<typeof Badge> = { title: "Atoms/Badge", component: Badge };
export default meta;

export const AllVariants: StoryObj = {
  render: () => (
    <div className="flex gap-2 items-center">
      <Badge>Active</Badge>
      <Badge variant="secondary">Idle</Badge>
      <Badge variant="destructive">Banned</Badge>
      <Badge variant="outline">Pending</Badge>
    </div>
  ),
};

import type { Meta, StoryObj } from "@storybook/react";
import React from "react";
import { Button } from "../components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";

const meta: Meta = { title: "Molecules/Popover" };
export default meta;

export const Default: StoryObj = {
  render: () => (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          Options
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-48 text-xs space-y-1">
        <p className="font-semibold">Quick Actions</p>
        <p className="text-muted">Restart • Pause • Clone</p>
      </PopoverContent>
    </Popover>
  ),
};

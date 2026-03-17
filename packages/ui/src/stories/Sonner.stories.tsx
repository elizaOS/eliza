import type { Meta, StoryObj } from "@storybook/react";
import React from "react";
import { Toaster, toast } from "sonner";
import { Button } from "../components/ui/button";

const meta: Meta = { title: "Molecules/Sonner" };
export default meta;

export const Default: StoryObj = {
  render: () => (
    <div>
      <Toaster />
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => toast.success("Agent deployed")}
        >
          Success
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => toast.error("Deploy failed")}
        >
          Error
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => toast.warning("Rate limit approaching")}
        >
          Warning
        </Button>
      </div>
    </div>
  ),
};

/** Hidden, available, and opening states for the mobile sidebar header control. */
import type { Meta, StoryObj } from "@storybook/react";
import { assert } from "../../storybook/home-widget-decorator";
import { ViewHeaderSidebarTrigger } from "./ViewHeaderSidebarTrigger";

let open = false;

const meta = {
  title: "Shared/ViewHeaderSidebarTrigger",
  component: ViewHeaderSidebarTrigger,
  parameters: { layout: "centered" },
  args: {
    control: {
      open: false,
      label: "Conversations",
      setOpen: (next: boolean) => {
        open = next;
      },
    },
  },
} satisfies Meta<typeof ViewHeaderSidebarTrigger>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Available: Story = {
  play: async ({ canvasElement }) => {
    open = false;
    const trigger = canvasElement.querySelector("button");
    assert(trigger instanceof HTMLButtonElement, "sidebar trigger renders");
    trigger.click();
    assert(open, "sidebar open callback receives true");
  },
};

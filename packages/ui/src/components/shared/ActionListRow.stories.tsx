/** Storybook coverage for button, link, static, selected, and disabled rows. */
import type { Meta, StoryObj } from "@storybook/react";
import { Check, Package } from "lucide-react";
import { ActionListRow } from "./ActionListRow";

const meta = {
  title: "Shared/ActionListRow",
  component: ActionListRow,
  tags: ["autodocs"],
  args: {
    element: "button",
    title: "Calendar sync",
    description: "Keep events synchronized across connected calendars.",
    leading: <Package className="size-5" aria-hidden />,
  },
} satisfies Meta<typeof ActionListRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ButtonRow: Story = {};

export const Selected: Story = {
  args: {
    selected: true,
    trailing: <Check className="size-4 text-accent" aria-hidden />,
  },
};

export const Disabled: Story = {
  args: { disabled: true },
};

export const LinkRow: Story = {
  args: {
    element: "link",
    href: "#calendar-sync",
    metadata: "Opens settings",
  },
};

export const StaticRow: Story = {
  args: {
    element: "static",
    metadata: "Connected",
  },
};

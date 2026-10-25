/**
 * Storybook stories for the icon-tooltip primitive (tooltip wrapping an icon trigger).
 */
import type { Meta, StoryObj } from "@storybook/react";
import { IconTooltip } from "./tooltip-extended";

const Trigger = ({ label }: { label: string }) => (
  <button
    type="button"
    className="rounded-sm border border-border bg-bg-elevated px-3 py-1.5 text-sm text-txt-strong"
  >
    {label}
  </button>
);

const meta = {
  title: "Primitives/TooltipExtended",
  component: IconTooltip,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Hover or focus the trigger to reveal the tooltip (CSS group-hover/group-focus-within).",
      },
    },
  },
  argTypes: {
    label: { control: "text" },
    shortcut: { control: "text" },
    position: { control: "inline-radio", options: ["top", "bottom"] },
    multiline: { control: "boolean" },
  },
  args: {
    label: "Settings",
    position: "top",
    multiline: false,
    children: <Trigger label="Hover me" />,
  },
  decorators: [
    (Story) => (
      <div className="flex min-h-32 items-center justify-center p-12">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof IconTooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithShortcut: Story = {
  args: { label: "Open command palette", shortcut: "Cmd K" },
};

export const Bottom: Story = {
  args: { position: "bottom", label: "Appears below" },
};

export const Multiline: Story = {
  args: {
    label: "Send the current draft to the agent and start a new turn",
    shortcut: "Enter",
    multiline: true,
  },
};

import type { Meta, StoryObj } from "@storybook/react";
import { PermissionIcon } from "./PermissionIcon";

const ICON_KEYS = [
  "cursor",
  "monitor",
  "mic",
  "camera",
  "terminal",
  "shield-ban",
  "list-todo",
  "calendar",
  "heart-pulse",
  "hourglass",
  "contact",
  "notebook-tabs",
  "bell",
  "hard-drive",
  "workflow",
];

const meta = {
  title: "Permissions/PermissionIcon",
  component: PermissionIcon,
  tags: ["autodocs"],
  argTypes: {
    icon: { control: "select", options: ICON_KEYS },
  },
  args: { icon: "mic" },
} satisfies Meta<typeof PermissionIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Camera: Story = { args: { icon: "camera" } };
export const Terminal: Story = { args: { icon: "terminal" } };

/** Unknown keys fall back to the Settings gear. */
export const UnknownFallback: Story = { args: { icon: "does-not-exist" } };

/** Every mapped icon in one view. */
export const AllIcons: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      {ICON_KEYS.map((key) => (
        <PermissionIcon key={key} icon={key} />
      ))}
    </div>
  ),
};

/**
 * Storybook stories for the per-row ListActionMenu.
 */
import type { Meta, StoryObj } from "@storybook/react";
import {
  Archive,
  Copy,
  ExternalLink,
  Pencil,
  Share2,
  Trash2,
} from "lucide-react";
import { ListActionMenu } from "./list-action-menu";

const noop = () => {};

const meta = {
  title: "CloudUI/DataList/ListActionMenu",
  component: ListActionMenu,
  tags: ["autodocs"],
  argTypes: {
    align: { control: "select", options: ["start", "center", "end"] },
    label: { control: "text" },
  },
  args: {
    align: "end",
    items: [
      { key: "edit", label: "Edit", icon: Pencil, onSelect: noop },
      { key: "duplicate", label: "Duplicate", icon: Copy, onSelect: noop },
      { key: "share", label: "Share", icon: Share2, onSelect: noop },
    ],
  },
  decorators: [
    (Story) => (
      <div
        style={{ padding: "4rem", display: "flex", justifyContent: "center" }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ListActionMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithLabel: Story = {
  args: {
    label: "Item actions",
    items: [
      { key: "edit", label: "Edit", icon: Pencil, onSelect: noop },
      { key: "duplicate", label: "Duplicate", icon: Copy, onSelect: noop },
      { key: "share", label: "Share", icon: Share2, onSelect: noop },
    ],
  },
};

export const WithSeparatorAndDestructive: Story = {
  args: {
    label: "Manage",
    items: [
      { key: "edit", label: "Edit", icon: Pencil, onSelect: noop },
      { key: "archive", label: "Archive", icon: Archive, onSelect: noop },
      { type: "separator", key: "sep" },
      {
        key: "delete",
        label: "Delete",
        icon: Trash2,
        destructive: true,
        onSelect: noop,
      },
    ],
  },
};

export const WithDisabled: Story = {
  args: {
    items: [
      { key: "edit", label: "Edit", icon: Pencil, onSelect: noop },
      {
        key: "share",
        label: "Share (unavailable)",
        icon: Share2,
        disabled: true,
        onSelect: noop,
      },
      { type: "separator", key: "sep" },
      {
        key: "delete",
        label: "Delete",
        icon: Trash2,
        destructive: true,
        onSelect: noop,
      },
    ],
  },
};

export const WithLinkChild: Story = {
  args: {
    label: "Open",
    items: [
      {
        key: "external",
        label: "Open in new tab",
        icon: ExternalLink,
        asChild: true,
        child: (
          <a href="https://placehold.co/" target="_blank" rel="noreferrer">
            <ExternalLink className="mr-2 h-4 w-4" />
            Open in new tab
          </a>
        ),
      },
      { key: "copy", label: "Copy link", icon: Copy, onSelect: noop },
    ],
  },
};

export const AlignStart: Story = {
  args: {
    align: "start",
    items: [
      { key: "edit", label: "Edit", icon: Pencil, onSelect: noop },
      { key: "duplicate", label: "Duplicate", icon: Copy, onSelect: noop },
    ],
  },
};

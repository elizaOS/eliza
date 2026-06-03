import type { Meta, StoryObj } from "@storybook/react";
import { SidebarHeader } from "./sidebar-header";

const meta = {
  title: "Composites/Sidebar/SidebarHeader",
  component: SidebarHeader,
  tags: ["autodocs"],
  argTypes: {
    children: { control: false },
    search: { control: false },
    searchClassName: { control: "text" },
  },
} satisfies Meta<typeof SidebarHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: (
      <h2 className="px-1 text-sm font-medium text-txt">Conversations</h2>
    ),
  },
};

export const WithSearch: Story = {
  args: {
    search: {
      placeholder: "Search conversations",
      value: "",
      onChange: () => {},
    },
    children: (
      <h2 className="px-1 text-sm font-medium text-txt">Conversations</h2>
    ),
  },
};

export const SearchWithValue: Story = {
  args: {
    search: {
      placeholder: "Search conversations",
      value: "design review",
      onChange: () => {},
      onClear: () => {},
    },
  },
};

export const SearchLoading: Story = {
  args: {
    search: {
      placeholder: "Search conversations",
      value: "design review",
      onChange: () => {},
      loading: true,
    },
  },
};

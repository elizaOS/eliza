import type { Meta, StoryObj } from "@storybook/react";
import { SidebarFilterBar } from "./sidebar-filter-bar";

const FILTER_OPTIONS = [
  { value: "all", label: "All conversations" },
  { value: "unread", label: "Unread" },
  { value: "starred", label: "Starred" },
  { value: "archived", label: "Archived" },
];

const meta = {
  title: "Composites/Sidebar/SidebarFilterBar",
  component: SidebarFilterBar,
  tags: ["autodocs"],
  argTypes: {
    sortDirection: { control: "inline-radio", options: ["asc", "desc"] },
    selectValue: {
      control: "select",
      options: ["all", "unread", "starred", "archived"],
    },
    onSelectValueChange: { action: "selectValueChange" },
    onSortDirectionToggle: { action: "sortDirectionToggle" },
    onRefresh: { action: "refresh" },
  },
  args: {
    selectValue: "all",
    selectOptions: FILTER_OPTIONS,
    selectAriaLabel: "Filter conversations",
    sortDirection: "desc",
  },
  decorators: [
    (Story) => (
      <div className="w-80 rounded-md border border-border/60 bg-card/40 p-3">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SidebarFilterBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Ascending: Story = {
  args: { sortDirection: "asc" },
};

export const FilteredToUnread: Story = {
  args: { selectValue: "unread" },
};

export const WithTestIds: Story = {
  args: {
    selectTestId: "sidebar-filter-select",
    sortDirectionButtonTestId: "sidebar-filter-sort",
    refreshButtonTestId: "sidebar-filter-refresh",
    sortAscendingLabel: "Oldest first",
    sortDescendingLabel: "Newest first",
    refreshLabel: "Reload list",
  },
};

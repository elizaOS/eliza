import type { Meta, StoryObj } from "@storybook/react";
import { SearchBar } from "./searchbar";

const meta = {
  title: "Composites/Search/Searchbar",
  component: SearchBar,
  tags: ["autodocs"],
  argTypes: {
    searching: { control: "boolean" },
    placeholder: { control: "text" },
    searchLabel: { control: "text" },
    searchingLabel: { control: "text" },
    onSearch: { action: "search" },
  },
  args: {
    placeholder: "Search...",
    searchLabel: "Search",
    searchingLabel: "Searching...",
    searching: false,
  },
} satisfies Meta<typeof SearchBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Searching: Story = {
  args: { searching: true },
};

export const CustomPlaceholder: Story = {
  args: { placeholder: "Search agents, plugins, and skills..." },
};

export const CustomLabels: Story = {
  args: { searchLabel: "Go", searchingLabel: "Working..." },
};

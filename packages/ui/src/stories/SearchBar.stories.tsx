import type { Meta, StoryObj } from "@storybook/react";
import { SearchBar } from "../components/composites/search";

const meta = {
  title: "UI/SearchBar",
  component: SearchBar,
  tags: ["autodocs"],
  argTypes: {
    onSearch: { action: "onSearch" },
    placeholder: { control: "text" },
    searching: { control: "boolean" },
    searchLabel: { control: "text" },
    searchingLabel: { control: "text" },
  },
  args: {
    placeholder: "Search...",
    searching: false,
  },
} satisfies Meta<typeof SearchBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    placeholder: "Search...",
    searching: false,
  },
};

export const CustomPlaceholder: Story = {
  args: {
    placeholder: "Search plugins...",
    searching: false,
  },
};

export const Searching: Story = {
  args: {
    placeholder: "Search...",
    searching: true,
  },
};

export const CustomLabels: Story = {
  args: {
    placeholder: "Find agents...",
    searching: false,
    searchLabel: "Find",
    searchingLabel: "Finding...",
  },
};

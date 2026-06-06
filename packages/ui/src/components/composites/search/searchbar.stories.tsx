import type { Meta, StoryObj } from "@storybook/react";
import { SidebarSearchBar } from "./searchbar";

const meta = {
  title: "Composites/Search/SidebarSearchBar",
  component: SidebarSearchBar,
  tags: ["autodocs"],
  argTypes: {
    placeholder: { control: "text" },
    value: { control: "text" },
    loading: { control: "boolean" },
    disabled: { control: "boolean" },
    clearLabel: { control: "text" },
  },
  args: {
    placeholder: "Search conversations",
    value: "",
    loading: false,
    disabled: false,
    onChange: () => {},
    onClear: () => {},
  },
  decorators: [
    (Story) => (
      <div style={{ width: 320, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SidebarSearchBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithValue: Story = {
  args: {
    value: "weekly recap",
  },
};

export const Loading: Story = {
  args: {
    value: "fetching results",
    loading: true,
  },
};

export const Disabled: Story = {
  args: {
    disabled: true,
    placeholder: "Search disabled",
  },
};

export const CustomPlaceholder: Story = {
  args: {
    placeholder: "Find a contact or thread",
  },
};

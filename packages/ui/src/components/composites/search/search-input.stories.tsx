import type { Meta, StoryObj } from "@storybook/react";
import * as React from "react";
import { SearchInput } from "./search-input";

const meta = {
  title: "Composites/Search/SearchInput",
  component: SearchInput,
  tags: ["autodocs"],
  argTypes: {
    placeholder: { control: "text" },
    value: { control: "text" },
    loading: { control: "boolean" },
    disabled: { control: "boolean" },
    clearLabel: { control: "text" },
  },
  args: { placeholder: "Search agents…" },
  decorators: [
    (Story) => (
      <div className="w-64">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SearchInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithValue: Story = {
  args: { value: "memory leak", onClear: () => {}, readOnly: true },
};

export const Loading: Story = {
  args: { value: "indexing", loading: true, readOnly: true },
};

export const Disabled: Story = {
  args: { value: "archived", disabled: true, onClear: () => {}, readOnly: true },
};

/** Controlled input wired to local state so the clear button works live. */
export const Interactive: Story = {
  render: (args) => {
    const [value, setValue] = React.useState("autonomous agent");
    return (
      <SearchInput
        {...args}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onClear={() => setValue("")}
      />
    );
  },
};

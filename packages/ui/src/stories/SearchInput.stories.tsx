import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { SearchInput } from "../components/composites/search";

const meta = {
  title: "UI/SearchInput",
  component: SearchInput,
  tags: ["autodocs"],
  argTypes: {
    value: { control: "text" },
    placeholder: { control: "text" },
    loading: { control: "boolean" },
    onChange: { action: "onChange" },
    onClear: { action: "onClear" },
  },
  args: {
    placeholder: "Search...",
    value: "",
    loading: false,
  },
} satisfies Meta<typeof SearchInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    placeholder: "Search...",
    value: "",
  },
};

export const WithValue: Story = {
  args: {
    value: "hello world",
    placeholder: "Search...",
  },
};

export const Loading: Story = {
  args: {
    value: "loading query",
    placeholder: "Search...",
    loading: true,
  },
};

export const WithClearButton: Story = {
  args: {
    value: "clearable text",
    placeholder: "Search...",
  },
};

export const Interactive: Story = {
  render: () => {
    const [value, setValue] = useState("editable text");
    return (
      <SearchInput
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onClear={() => setValue("")}
        placeholder="Type to search..."
      />
    );
  },
};

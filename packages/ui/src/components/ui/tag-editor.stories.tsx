import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { TagEditor } from "./tag-editor";

const meta = {
  title: "Primitives/TagEditor",
  component: TagEditor,
  tags: ["autodocs"],
  argTypes: {
    label: { control: "text" },
    placeholder: { control: "text" },
    maxItems: { control: "number" },
    addLabel: { control: "text" },
    removeLabel: { control: "text" },
  },
  args: {
    items: ["typescript", "react", "elizaos"],
    label: "Tags",
    placeholder: "Add a tag...",
  },
  render: ({ items, onChange, ...args }) => {
    const [value, setValue] = useState(items);
    return (
      <TagEditor
        {...args}
        items={value}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
      />
    );
  },
} satisfies Meta<typeof TagEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: { items: [], label: "Skills" },
};

export const WithMaxItems: Story = {
  args: { items: ["alpha", "beta"], maxItems: 3, label: "Up to 3 tags" },
};

export const WithoutLabel: Story = {
  args: { label: undefined, placeholder: "Type and press Enter" },
};

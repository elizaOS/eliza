import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { TagEditor } from "../components/ui/tag-editor";

const meta = {
  title: "UI/TagEditor",
  component: TagEditor,
  tags: ["autodocs"],
  argTypes: {
    label: { control: "text" },
    placeholder: { control: "text" },
  },
} satisfies Meta<typeof TagEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [items, setItems] = useState<string[]>([]);
    return (
      <TagEditor
        label="Tags"
        items={items}
        onChange={setItems}
        placeholder="Add a tag..."
        className="w-80"
      />
    );
  },
};

export const WithItems: Story = {
  render: () => {
    const [items, setItems] = useState(["react", "typescript", "storybook"]);
    return (
      <TagEditor
        label="Technologies"
        items={items}
        onChange={setItems}
        placeholder="Add technology..."
        className="w-80"
      />
    );
  },
};

export const CustomLabels: Story = {
  render: () => {
    const [items, setItems] = useState(["admin", "editor"]);
    return (
      <TagEditor
        label="Roles"
        items={items}
        onChange={setItems}
        addLabel="Add"
        removeLabel="Remove"
        placeholder="Add role..."
        className="w-80"
      />
    );
  },
};

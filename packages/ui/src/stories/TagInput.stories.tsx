import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { TagInput } from "../components/ui/tag-input";

const meta = {
  title: "UI/TagInput",
  component: TagInput,
  tags: ["autodocs"],
  argTypes: {
    label: { control: "text" },
    placeholder: { control: "text" },
    maxItems: { control: "number" },
  },
} satisfies Meta<typeof TagInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [items, setItems] = useState<string[]>([]);
    return (
      <TagInput
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
    const [items, setItems] = useState(["node", "bun", "deno"]);
    return (
      <TagInput
        label="Runtimes"
        items={items}
        onChange={setItems}
        className="w-80"
      />
    );
  },
};

export const MaxItems: Story = {
  render: () => {
    const [items, setItems] = useState(["alpha", "beta"]);
    return (
      <TagInput
        label="Limited (max 3)"
        items={items}
        onChange={setItems}
        maxItems={3}
        className="w-80"
      />
    );
  },
};

import type { Meta, StoryObj } from "@storybook/react";
import React, { useState } from "react";
import { TagEditor } from "../components/ui/tag-editor";

const meta: Meta<typeof TagEditor> = {
  title: "Molecules/TagEditor",
  component: TagEditor,
};
export default meta;

export const Default: StoryObj = {
  render: () => {
    const [items, setItems] = useState(["react", "typescript", "storybook"]);
    return (
      <div className="w-80">
        <TagEditor label="Technologies" items={items} onChange={setItems} />
      </div>
    );
  },
};

export const Empty: StoryObj = {
  render: () => {
    const [items, setItems] = useState<string[]>([]);
    return (
      <div className="w-80">
        <TagEditor
          label="Interests"
          items={items}
          onChange={setItems}
          placeholder="Type an interest…"
        />
      </div>
    );
  },
};

export const CustomLabels: StoryObj = {
  render: () => {
    const [items, setItems] = useState(["english", "spanish"]);
    return (
      <div className="w-80">
        <TagEditor
          label="Languages"
          items={items}
          onChange={setItems}
          addLabel="+ Add"
          removeLabel="✕"
        />
      </div>
    );
  },
};

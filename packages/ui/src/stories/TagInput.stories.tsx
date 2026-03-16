import type { Meta, StoryObj } from "@storybook/react";
import React, { useState } from "react";
import { TagInput } from "../components/ui/tag-input";

const meta: Meta<typeof TagInput> = {
  title: "Molecules/TagInput",
  component: TagInput,
};
export default meta;

export const Default: StoryObj = {
  render: () => {
    const [items, setItems] = useState(["twitter", "discord", "telegram"]);
    return (
      <TagInput
        items={items}
        onChange={setItems}
        placeholder="Add plugin…"
        className="w-80"
      />
    );
  },
};

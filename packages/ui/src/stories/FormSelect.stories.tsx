import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

import { FormSelect, FormSelectItem } from "../index";

const meta = {
  title: "Composites/FormSelect",
  component: FormSelect,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof FormSelect>;

export default meta;
type Story = StoryObj<typeof meta>;

function SelectDemo() {
  const [value, setValue] = useState("");
  return (
    <FormSelect
      value={value}
      onValueChange={setValue}
      placeholder="Choose a model"
    >
      <FormSelectItem value="gpt-4o">GPT-4o</FormSelectItem>
      <FormSelectItem value="claude-sonnet">Claude Sonnet</FormSelectItem>
      <FormSelectItem value="claude-opus">Claude Opus</FormSelectItem>
      <FormSelectItem value="llama-3">Llama 3</FormSelectItem>
    </FormSelect>
  );
}

export const Default: Story = {
  render: () => <SelectDemo />,
};

export const WithSelection: Story = {
  render: () => (
    <FormSelect value="claude-sonnet" placeholder="Choose a model">
      <FormSelectItem value="gpt-4o">GPT-4o</FormSelectItem>
      <FormSelectItem value="claude-sonnet">Claude Sonnet</FormSelectItem>
      <FormSelectItem value="claude-opus">Claude Opus</FormSelectItem>
    </FormSelect>
  ),
};

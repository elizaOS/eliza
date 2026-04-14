import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { ThemedSelect } from "../components/ui/themed-select";

const meta = {
  title: "UI/ThemedSelect",
  component: ThemedSelect,
  tags: ["autodocs"],
} satisfies Meta<typeof ThemedSelect>;

export default meta;
type Story = StoryObj<typeof meta>;

const sampleGroups = [
  {
    label: "Models",
    items: [
      { id: "gpt-4", text: "GPT-4", hint: "Most capable" },
      { id: "gpt-3.5", text: "GPT-3.5", hint: "Fast" },
      { id: "claude", text: "Claude", hint: "Anthropic" },
    ],
  },
  {
    label: "Local",
    items: [
      { id: "llama", text: "Llama 3", hint: "Meta" },
      { id: "mistral", text: "Mistral", hint: "Open source" },
    ],
  },
];

export const Default: Story = {
  render: () => {
    const [value, setValue] = useState<string | null>(null);
    return (
      <ThemedSelect
        value={value}
        groups={sampleGroups}
        onChange={setValue}
        placeholder="Select a model..."
        className="w-80"
      />
    );
  },
};

export const WithValue: Story = {
  render: () => {
    const [value, setValue] = useState<string | null>("claude");
    return (
      <ThemedSelect
        value={value}
        groups={sampleGroups}
        onChange={setValue}
        className="w-80"
      />
    );
  },
};

export const MenuTop: Story = {
  render: () => {
    const [value, setValue] = useState<string | null>(null);
    return (
      <div className="pt-64">
        <ThemedSelect
          value={value}
          groups={sampleGroups}
          onChange={setValue}
          menuPlacement="top"
          placeholder="Opens upward..."
          className="w-80"
        />
      </div>
    );
  },
};

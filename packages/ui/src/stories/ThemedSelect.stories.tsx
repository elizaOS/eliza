import type { Meta, StoryObj } from "@storybook/react";
import React, { useState } from "react";
import {
  ThemedSelect,
  type ThemedSelectGroup,
} from "../components/ui/themed-select";

const meta: Meta<typeof ThemedSelect> = {
  title: "Molecules/ThemedSelect",
  component: ThemedSelect,
};
export default meta;

const sampleGroups: ThemedSelectGroup[] = [
  {
    label: "OpenAI",
    items: [
      { id: "gpt-4o", text: "GPT-4o", hint: "Latest multimodal" },
      { id: "gpt-4o-mini", text: "GPT-4o Mini", hint: "Fast & cheap" },
      { id: "o1", text: "o1", hint: "Reasoning" },
    ],
  },
  {
    label: "Anthropic",
    items: [
      {
        id: "claude-3.5-sonnet",
        text: "Claude 3.5 Sonnet",
        hint: "Best overall",
      },
      { id: "claude-3-haiku", text: "Claude 3 Haiku", hint: "Fastest" },
    ],
  },
  {
    label: "Google",
    items: [
      { id: "gemini-pro", text: "Gemini Pro" },
      { id: "gemini-flash", text: "Gemini Flash", hint: "Speed optimised" },
    ],
  },
];

export const Default: StoryObj = {
  render: () => {
    const [value, setValue] = useState<string | null>(null);
    return (
      <div className="w-72">
        <ThemedSelect
          value={value}
          groups={sampleGroups}
          onChange={setValue}
          placeholder="Choose a model…"
        />
      </div>
    );
  },
};

export const WithSelection: StoryObj = {
  render: () => {
    const [value, setValue] = useState<string | null>("claude-3.5-sonnet");
    return (
      <div className="w-72">
        <ThemedSelect value={value} groups={sampleGroups} onChange={setValue} />
      </div>
    );
  },
};

export const SingleGroup: StoryObj = {
  render: () => {
    const [value, setValue] = useState<string | null>(null);
    const groups: ThemedSelectGroup[] = [
      {
        label: "Chains",
        items: [
          { id: "eth", text: "Ethereum" },
          { id: "bsc", text: "BSC" },
          { id: "sol", text: "Solana" },
        ],
      },
    ];
    return (
      <div className="w-56">
        <ThemedSelect
          value={value}
          groups={groups}
          onChange={setValue}
          placeholder="Select chain…"
        />
      </div>
    );
  },
};

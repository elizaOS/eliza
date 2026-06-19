import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { ApiParameterSelect } from "./api-parameter-select";

const modelOptions = [
  { value: "gpt-4o", label: "gpt-4o" },
  { value: "claude-opus-4", label: "claude-opus-4" },
  { value: "gemini-2.5-pro", label: "gemini-2.5-pro" },
  { value: "llama-3.1-70b", label: "llama-3.1-70b" },
];

const formatOptions = [
  { value: "json", label: "JSON" },
  { value: "text", label: "Plain text" },
  { value: "markdown", label: "Markdown" },
  { value: "sse", label: "Server-Sent Events" },
];

const meta = {
  title: "CloudUI/Docs/ApiParameterSelect",
  component: ApiParameterSelect,
  tags: ["autodocs"],
  args: {
    options: modelOptions,
    placeholder: "Select a model",
    onValueChange: () => {},
  },
  parameters: {
    layout: "centered",
  },
  decorators: [
    (Story) => (
      <div style={{ width: 320 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ApiParameterSelect>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithSelectedValue: Story = {
  args: {
    value: "claude-opus-4",
  },
};

export const ResponseFormat: Story = {
  args: {
    options: formatOptions,
    placeholder: "Select a format",
    value: "json",
  },
};

export const FewOptions: Story = {
  args: {
    options: [
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
    ],
    placeholder: "Reasoning effort",
  },
};

export const Interactive: Story = {
  render: (args) => {
    const [value, setValue] = useState<string | undefined>(undefined);
    return (
      <div className="space-y-2">
        <ApiParameterSelect {...args} value={value} onValueChange={setValue} />
        <div className="text-xs text-muted-foreground">
          Selected: {value ?? "(none)"}
        </div>
      </div>
    );
  },
  args: {
    options: modelOptions,
    placeholder: "Pick a model",
  },
};

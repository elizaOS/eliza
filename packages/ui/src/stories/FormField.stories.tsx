import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

import { FormField, Input, Switch, Textarea } from "../index";

const meta = {
  title: "Composites/FormField",
  component: FormField,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof FormField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    label: "Display name",
    description: "The name shown in conversations.",
    children: <Input placeholder="Enter name" />,
  },
};

export const Compact: Story = {
  args: {
    label: "API Key",
    description: "Your provider API key.",
    density: "compact",
    children: <Input density="compact" placeholder="sk-..." type="password" />,
  },
};

export const WithErrors: Story = {
  args: {
    label: "Webhook URL",
    errors: ["URL must start with https://", "URL is required"],
    children: <Input hasError placeholder="https://..." />,
  },
};

export const WithTextarea: Story = {
  args: {
    label: "System prompt",
    description: "Instructions for the agent.",
    children: <Textarea placeholder="You are a helpful assistant..." />,
  },
};

function SwitchFieldDemo() {
  const [enabled, setEnabled] = useState(false);
  return (
    <FormField label="Dark mode" description="Toggle the dark color scheme.">
      <Switch checked={enabled} onCheckedChange={setEnabled} />
    </FormField>
  );
}

export const WithSwitch: Story = {
  render: () => <SwitchFieldDemo />,
};

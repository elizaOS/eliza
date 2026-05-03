import type { Meta, StoryObj } from "@storybook/react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

const meta: Meta = {
  title: "Primitives/Select",
  parameters: { backgrounds: { default: "dark" } },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 280, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;

export const Default: StoryObj = {
  render: () => (
    <Select defaultValue="daily">
      <SelectTrigger>
        <SelectValue placeholder="Select period" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="hourly">Hourly</SelectItem>
        <SelectItem value="daily">Daily</SelectItem>
        <SelectItem value="weekly">Weekly</SelectItem>
        <SelectItem value="monthly">Monthly</SelectItem>
      </SelectContent>
    </Select>
  ),
};

export const WithPlaceholder: StoryObj = {
  render: () => (
    <Select>
      <SelectTrigger>
        <SelectValue placeholder="Choose a plan..." />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="free">Free</SelectItem>
        <SelectItem value="pro">Pro — $29/mo</SelectItem>
        <SelectItem value="enterprise">Enterprise — Custom</SelectItem>
      </SelectContent>
    </Select>
  ),
};

import type { Meta, StoryObj } from "@storybook/react";
import { Progress } from "./progress";

const meta: Meta<typeof Progress> = {
  title: "Primitives/Progress",
  component: Progress,
  parameters: { backgrounds: { default: "dark" } },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 400, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof Progress>;

export const Empty: Story = { args: { value: 0 } };

export const Quarter: Story = { args: { value: 25 } };

export const Half: Story = { args: { value: 50 } };

export const ThreeQuarter: Story = { args: { value: 75 } };

export const Full: Story = { args: { value: 100 } };

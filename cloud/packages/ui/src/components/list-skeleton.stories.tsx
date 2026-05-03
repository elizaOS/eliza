import type { Meta, StoryObj } from "@storybook/react";
import { ListSkeleton } from "./list-skeleton";

const meta: Meta<typeof ListSkeleton> = {
  title: "Components/ListSkeleton",
  component: ListSkeleton,
  parameters: { backgrounds: { default: "dark" } },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 600, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof ListSkeleton>;

export const CardVariant: Story = {
  args: { rows: 3, variant: "card" },
};

export const TableVariant: Story = {
  args: { rows: 5, variant: "table" },
};

export const ListVariant: Story = {
  args: { rows: 4, variant: "list" },
};

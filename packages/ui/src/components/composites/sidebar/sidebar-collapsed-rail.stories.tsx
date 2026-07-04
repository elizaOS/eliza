/**
 * Storybook states for the Sidebar Collapsed Rail sidebar composite across
 * expanded, collapsed, and shell navigation layouts.
 */
import type { Meta, StoryObj } from "@storybook/react";
import {
  SidebarCollapsedActionButton,
  SidebarCollapsedRail,
} from "./sidebar-collapsed-rail";

const railItems = ["A", "B", "C", "D", "E"];

const RailItem = ({ label }: { label: string }) => (
  <div className="flex h-11 w-11 items-center justify-center rounded-sm border border-border/60 bg-card/40 text-sm font-medium">
    {label}
  </div>
);

const meta = {
  title: "Composites/Sidebar/SidebarCollapsedRail",
  component: SidebarCollapsedRail,
  tags: ["autodocs"],
  argTypes: {
    action: { control: false },
    children: { control: false },
    className: { control: "text" },
    listClassName: { control: "text" },
  },
  args: {
    children: railItems.map((label) => <RailItem key={label} label={label} />),
  },
  decorators: [
    (Story) => (
      <div className="h-96 w-16 rounded-md border border-border/60 bg-card/40 py-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SidebarCollapsedRail>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithAction: Story = {
  args: {
    action: (
      <SidebarCollapsedActionButton aria-label="New conversation">
        +
      </SidebarCollapsedActionButton>
    ),
  },
};

export const Empty: Story = {
  args: {
    children: null,
  },
};

export const ManyItems: Story = {
  args: {
    children: Array.from({ length: 20 }, (_, index) => {
      const label = String(index + 1);
      return <RailItem key={label} label={label} />;
    }),
  },
};

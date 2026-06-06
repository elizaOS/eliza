import type { Meta, StoryObj } from "@storybook/react";
import { SidebarHeaderStack } from "./sidebar-header-stack";

const meta = {
  title: "Composites/Sidebar/SidebarHeaderStack",
  component: SidebarHeaderStack,
  tags: ["autodocs"],
  argTypes: {
    className: { control: "text" },
  },
  args: {
    className: "",
  },
  decorators: [
    (Story) => (
      <div
        style={{ width: 280, padding: 16, background: "#111", color: "#eee" }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SidebarHeaderStack>;

export default meta;
type Story = StoryObj<typeof meta>;

const StackRow = ({ label, value }: { label: string; value: string }) => (
  <div
    style={{
      display: "flex",
      justifyContent: "space-between",
      fontSize: 13,
      opacity: 0.85,
    }}
  >
    <span>{label}</span>
    <span>{value}</span>
  </div>
);

export const Default: Story = {
  args: {
    children: (
      <>
        <StackRow label="Workspace" value="Eliza HQ" />
        <StackRow label="Agent" value="Otto" />
        <StackRow label="Status" value="Online" />
      </>
    ),
  },
};

export const SingleItem: Story = {
  args: {
    children: <StackRow label="Workspace" value="Eliza HQ" />,
  },
};

export const Empty: Story = {
  args: {
    children: null,
  },
};

export const WithHeading: Story = {
  args: {
    children: (
      <>
        <div style={{ fontWeight: 600, fontSize: 14 }}>Quick info</div>
        <StackRow label="Plan" value="Pro" />
        <StackRow label="Seats" value="12 / 20" />
        <StackRow label="Region" value="us-east" />
      </>
    ),
  },
};

export const CustomClassName: Story = {
  args: {
    className: "rounded-md border border-white/10 p-3",
    children: (
      <>
        <StackRow label="Build" value="2026.06.05" />
        <StackRow label="Branch" value="develop" />
      </>
    ),
  },
};

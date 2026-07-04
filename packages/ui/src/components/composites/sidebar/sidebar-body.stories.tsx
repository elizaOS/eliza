/**
 * Storybook states for the Sidebar Body sidebar composite across expanded,
 * collapsed, and shell navigation layouts.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { SidebarBody } from "./sidebar-body";

const THREAD_ROWS = Array.from({ length: 20 }, (_, i) => ({
  id: `thread-${i + 1}`,
  label: `Thread ${i + 1}`,
}));

const meta = {
  title: "Composites/Sidebar/SidebarBody",
  component: SidebarBody,
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
        style={{
          display: "flex",
          width: 280,
          height: 360,
          border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: 8,
          background: "rgba(0,0,0,0.2)",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SidebarBody>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: (
      <div style={{ padding: 16, color: "#fff" }}>
        <p style={{ margin: 0, fontWeight: 600 }}>Recent threads</p>
        <p style={{ marginTop: 8, opacity: 0.7, fontSize: 13 }}>
          Sidebar body content fills the available vertical space.
        </p>
      </div>
    ),
  },
};

export const WithScrollableList: Story = {
  args: {
    children: (
      <div style={{ overflowY: "auto", padding: 12, color: "#fff" }}>
        {THREAD_ROWS.map((row) => (
          <div
            key={row.id}
            style={{
              padding: "8px 12px",
              borderRadius: 6,
              marginBottom: 4,
              background: "rgba(255,255,255,0.04)",
              fontSize: 13,
            }}
          >
            {row.label}
          </div>
        ))}
      </div>
    ),
  },
};

export const Empty: Story = {
  args: {
    children: (
      <div
        style={{
          display: "flex",
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          color: "rgba(255,255,255,0.5)",
          fontSize: 13,
        }}
      >
        No items yet
      </div>
    ),
  },
};

export const CustomClassName: Story = {
  args: {
    className: "bg-black/40",
    children: (
      <div style={{ padding: 16, color: "#fff" }}>
        Custom class merged via cn(). The body still flexes and clips overflow.
      </div>
    ),
  },
};

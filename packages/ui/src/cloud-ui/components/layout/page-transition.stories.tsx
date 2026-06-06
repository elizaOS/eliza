import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { PageTransition } from "./page-transition";

const SamplePanel = ({ title, body }: { title: string; body: string }) => (
  <div
    style={{
      padding: 24,
      borderRadius: 12,
      border: "1px solid #e5e7eb",
      background: "#ffffff",
      maxWidth: 480,
      boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
    }}
  >
    <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{title}</h2>
    <p style={{ marginTop: 8, marginBottom: 0, color: "#4b5563" }}>{body}</p>
  </div>
);

const meta = {
  title: "CloudUI/Layout/PageTransition",
  component: PageTransition,
  tags: ["autodocs"],
  argTypes: {
    variant: {
      control: "select",
      options: ["fade", "slide", "scale"],
    },
    pathname: { control: "text" },
    className: { control: "text" },
  },
  args: {
    variant: "slide",
    pathname: "/dashboard",
  },
} satisfies Meta<typeof PageTransition>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Slide: Story = {
  args: {
    variant: "slide",
    pathname: "/dashboard",
    children: (
      <SamplePanel
        title="Dashboard"
        body="The default slide transition: gentle vertical motion paired with a fade."
      />
    ),
  },
};

export const Fade: Story = {
  args: {
    variant: "fade",
    pathname: "/settings",
    children: (
      <SamplePanel
        title="Settings"
        body="A pure opacity fade — use this for subtle route changes within the same view."
      />
    ),
  },
};

export const Scale: Story = {
  args: {
    variant: "scale",
    pathname: "/billing",
    children: (
      <SamplePanel
        title="Billing"
        body="A gentle scale-in effect — emphasizes new content entering the viewport."
      />
    ),
  },
};

export const Interactive: Story = {
  args: {
    variant: "slide",
  },
  render: (args) => {
    const pages = [
      { path: "/overview", title: "Overview", body: "Your account overview." },
      { path: "/agents", title: "Agents", body: "Manage running agents." },
      { path: "/logs", title: "Logs", body: "Inspect recent activity." },
    ];
    const [index, setIndex] = useState(0);
    const current = pages[index];
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", gap: 8 }}>
          {pages.map((p, i) => (
            <button
              key={p.path}
              type="button"
              onClick={() => setIndex(i)}
              style={{
                padding: "6px 12px",
                borderRadius: 6,
                border: "1px solid #d1d5db",
                background: i === index ? "#111827" : "#ffffff",
                color: i === index ? "#ffffff" : "#111827",
                cursor: "pointer",
              }}
            >
              {p.title}
            </button>
          ))}
        </div>
        <PageTransition {...args} pathname={current.path}>
          <SamplePanel title={current.title} body={current.body} />
        </PageTransition>
      </div>
    );
  },
};

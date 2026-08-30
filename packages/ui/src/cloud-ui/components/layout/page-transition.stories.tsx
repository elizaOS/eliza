/**
 * Storybook stories for the route PageTransition.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { Button } from "../../../components/ui/button";
import { PageTransition } from "./page-transition";

const SamplePanel = ({ title, body }: { title: string; body: string }) => (
  <div
    style={{
      padding: 24,
      borderRadius: 12,
      border: "1px solid #e5e7eb",
      background: "#ffffff",
      color: "#111827",
      maxWidth: 480,
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
    pathname: "/cloud",
  },
} satisfies Meta<typeof PageTransition>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Slide: Story = {
  args: {
    variant: "slide",
    pathname: "/cloud",
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
    pathname: "/cloud/account",
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
    pathname: "/cloud/billing",
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
      { path: "/cloud", title: "Overview", body: "Your account overview." },
      {
        path: "/cloud/agents",
        title: "Agents",
        body: "Manage running agents.",
      },
      {
        path: "/cloud/agents/demo/logs",
        title: "Logs",
        body: "Inspect recent activity.",
      },
    ];
    const [index, setIndex] = useState(0);
    const current = pages[index];
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", gap: 8 }}>
          {pages.map((p, i) => (
            <Button
              key={p.path}
              type="button"
              onClick={() => setIndex(i)}
              variant={i === index ? "default" : "outline"}
              size="regularCompact"
            >
              {p.title}
            </Button>
          ))}
        </div>
        <PageTransition {...args} pathname={current.path}>
          <SamplePanel title={current.title} body={current.body} />
        </PageTransition>
      </div>
    );
  },
};

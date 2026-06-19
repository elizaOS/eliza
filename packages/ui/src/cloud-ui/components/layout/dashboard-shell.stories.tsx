import type { Meta, StoryObj } from "@storybook/react";
import { DashboardShellLayout } from "./dashboard-shell";

const Sidebar = ({ items }: { items: string[] }) => (
  <aside className="hidden w-60 shrink-0 flex-col border-r border-white/10 bg-neutral-950 p-4 md:flex">
    <div className="mb-6 text-sm font-semibold tracking-wide text-orange-400">
      elizaOS Cloud
    </div>
    <nav className="flex flex-col gap-1 text-sm text-white/80">
      {items.map((label, i) => (
        <button
          type="button"
          key={label}
          className={`rounded px-3 py-2 text-left hover:bg-white/5 ${
            i === 0 ? "bg-white/10 text-white" : ""
          }`}
        >
          {label}
        </button>
      ))}
    </nav>
  </aside>
);

const Header = ({ title }: { title: string }) => (
  <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/10 bg-neutral-950 px-4 md:px-6">
    <div className="text-sm font-medium text-white">{title}</div>
    <div className="flex items-center gap-3 text-xs text-white/60">
      <span>v1.4.2</span>
      <div className="h-7 w-7 rounded-full bg-orange-500" />
    </div>
  </header>
);

const SampleContent = () => (
  <div className="grid gap-4 md:grid-cols-3">
    {[
      { label: "Active agents", value: "12" },
      { label: "Messages today", value: "4,218" },
      { label: "Spend (MTD)", value: "$184.20" },
    ].map((card) => (
      <div
        key={card.label}
        className="rounded-lg border border-white/10 bg-neutral-900 p-4"
      >
        <div className="text-xs uppercase tracking-wide text-white/50">
          {card.label}
        </div>
        <div className="mt-2 text-2xl font-semibold text-white">
          {card.value}
        </div>
      </div>
    ))}
  </div>
);

const DEFAULT_NAV = [
  "Overview",
  "Agents",
  "Brands",
  "Usage",
  "Billing",
  "Settings",
];

const meta = {
  title: "CloudUI/Layout/DashboardShellLayout",
  component: DashboardShellLayout,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof DashboardShellLayout>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    sidebar: <Sidebar items={DEFAULT_NAV} />,
    header: <Header title="Overview" />,
    children: <SampleContent />,
  },
};

export const EmptyContent: Story = {
  args: {
    sidebar: <Sidebar items={DEFAULT_NAV} />,
    header: <Header title="Agents" />,
    children: (
      <div className="flex h-full min-h-[60vh] flex-col items-center justify-center text-center">
        <img
          src="https://placehold.co/120x120/0a0a0a/f97316?text=%2B"
          alt=""
          className="mb-4 h-24 w-24 rounded-full"
        />
        <div className="text-lg font-medium text-white">No agents yet</div>
        <div className="mt-1 text-sm text-white/60">
          Create your first agent to get started.
        </div>
        <button
          type="button"
          className="mt-4 rounded-md bg-orange-500 px-4 py-2 text-sm font-medium text-black hover:bg-orange-600"
        >
          New agent
        </button>
      </div>
    ),
  },
};

export const MinimalShell: Story = {
  args: {
    sidebar: (
      <aside className="hidden w-14 shrink-0 flex-col items-center gap-2 border-r border-white/10 bg-neutral-950 py-4 md:flex">
        {["O", "A", "B", "U", "S"].map((letter, i) => (
          <div
            key={letter}
            className={`flex h-9 w-9 items-center justify-center rounded-md text-xs ${
              i === 0
                ? "bg-orange-500 text-black"
                : "bg-white/5 text-white/70 hover:bg-white/10"
            }`}
          >
            {letter}
          </div>
        ))}
      </aside>
    ),
    header: <Header title="Compact view" />,
    children: <SampleContent />,
  },
};

export const NoSidebar: Story = {
  args: {
    sidebar: null,
    header: <Header title="Full-width" />,
    children: (
      <div className="rounded-lg border border-white/10 bg-neutral-900 p-6">
        <div className="text-sm text-white/80">
          The shell renders header + main when no sidebar is provided.
        </div>
      </div>
    ),
  },
};

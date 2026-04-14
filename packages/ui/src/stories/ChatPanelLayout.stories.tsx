import type { Meta, StoryObj } from "@storybook/react";

import { ChatPanelLayout } from "../index";

function SidebarCard({ title }: { title: string }) {
  return (
    <div className="flex h-full flex-col rounded-[26px] border border-white/10 bg-black/30 p-4 text-white/90 backdrop-blur-xl">
      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">
        Sidebar
      </div>
      <div className="mt-2 text-lg font-semibold">{title}</div>
      <div className="mt-3 space-y-2 text-sm text-white/70">
        <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3">
          Character
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3">
          Wallet
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3">
          Browser
        </div>
      </div>
    </div>
  );
}

function ThreadCard({ label }: { label: string }) {
  return (
    <div className="flex h-full flex-col rounded-[30px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.08),rgba(255,255,255,0.03))] p-5 text-white backdrop-blur-2xl">
      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">
        Thread
      </div>
      <div className="mt-2 text-xl font-semibold">{label}</div>
      <div className="mt-5 flex-1 space-y-3">
        <div className="max-w-[22rem] rounded-2xl rounded-bl-md bg-white/10 px-4 py-3 text-sm text-white/90">
          Need a quick sync on the current approval queue.
        </div>
        <div className="ml-auto max-w-[24rem] rounded-2xl rounded-br-md bg-accent/25 px-4 py-3 text-sm text-white">
          Three requests are pending and one wallet send is blocked on review.
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: "Layouts/ChatPanelLayout",
  component: ChatPanelLayout,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof ChatPanelLayout>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FullOverlay: Story = {
  render: () => (
    <div className="relative min-h-screen overflow-hidden bg-slate-950">
      <ChatPanelLayout
        showSidebar
        sidebar={<SidebarCard title="Full overlay shell" />}
        thread={<ThreadCard label="Overlay thread" />}
      />
    </div>
  ),
};

export const CompanionDock: Story = {
  render: () => (
    <div className="relative min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top,rgba(59,130,246,0.18),transparent_42%),linear-gradient(180deg,#04111f,#091827)]">
      <ChatPanelLayout
        variant="companion-dock"
        showSidebar
        sidebar={<SidebarCard title="Docked sidebar" />}
        mobileSidebar={<SidebarCard title="Mobile sheet" />}
        thread={<ThreadCard label="Companion dock" />}
      />
    </div>
  ),
};
